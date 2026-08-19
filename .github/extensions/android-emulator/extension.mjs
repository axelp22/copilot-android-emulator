import path from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { CanvasBindingStore } from "./lib/canvas-binding-store.mjs";
import { createCanvasServer } from "./lib/canvas-server.mjs";
import { DeviceSessionManager } from "./lib/device-session-manager.mjs";
import { AppError } from "./lib/errors.mjs";
import { actionSchemas, openInputSchema } from "./lib/schemas.mjs";

const CANVAS_ID = "android-emulator";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "web");
const instances = new Map();

let copilotSession;
let canvasBindings = null;

function diagnostic(message) {
    void copilotSession?.log?.(`[android-emulator] ${message}`, { level: "warning", ephemeral: true })?.catch?.(() => {});
}

const manager = new DeviceSessionManager({ onDiagnostic: diagnostic });

function toCanvasError(error) {
    if (error instanceof CanvasError) {
        return error;
    }
    if (error instanceof AppError) {
        return new CanvasError(error.code, error.message);
    }
    return new CanvasError("internal_error", error instanceof Error ? error.message : String(error));
}

async function withCanvasError(fn) {
    try {
        return await fn();
    } catch (error) {
        throw toCanvasError(error);
    }
}

async function closeInstance(instanceId) {
    const entry = instances.get(instanceId);
    if (!entry) {
        return;
    }
    instances.delete(instanceId);
    if (entry.deviceId) {
        manager.detachInstance(entry.deviceId, instanceId);
    }
    await entry.server.close();
}

function deviceInstanceId(deviceId) {
    return `${CANVAS_ID}-${String(deviceId).toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`;
}

function openCanvases() {
    const snapshot = copilotSession?.openCanvases;
    return Array.isArray(snapshot) ? snapshot : [];
}

function openCanvasMatchesDevice(canvasInstance, deviceId) {
    return canvasInstance?.canvasId === CANVAS_ID && canvasInstance.input?.deviceId === deviceId;
}

async function openDeviceCanvas({ deviceId, instanceId = deviceInstanceId(deviceId) }) {
    await manager.assertDeviceAvailable(deviceId);
    manager.assertNoActiveLease(deviceId);
    const canvasRpc = copilotSession?.rpc?.canvas;
    if (!canvasRpc?.open) {
        throw new AppError(
            "canvas_open_unavailable",
            "This Copilot runtime does not expose session canvas opening.",
            501,
        );
    }

    const existing = openCanvases().find((canvasInstance) => openCanvasMatchesDevice(canvasInstance, deviceId));
    const targetInstanceId = existing?.instanceId ?? instanceId;
    const openInput = {
        canvasId: CANVAS_ID,
        instanceId: targetInstanceId,
        input: { deviceId, autoBoot: false, bootAfterOpen: true },
    };

    if (!existing) {
        // Opening synchronously would deadlock: the runtime calls back into this provider.
        queueMicrotask(() => {
            void canvasRpc.open(openInput).catch((error) => {
                diagnostic(`Failed to open the Android Emulator canvas: ${error.message ?? String(error)}`);
            });
        });
        return { deviceId, instanceId: targetInstanceId, focusedExisting: false, opening: true };
    }

    const opened = await canvasRpc.open(openInput);
    return { deviceId, instanceId: opened.instanceId, focusedExisting: true };
}

async function switchDeviceCanvas({ instanceId, fromDeviceId, toDeviceId }) {
    const resolvedId = await manager.resolveDeviceId(toDeviceId);
    const target = await manager.assertDeviceAvailable(resolvedId);
    if (fromDeviceId) {
        manager.assertNoActiveLease(fromDeviceId);
    }
    manager.assertNoActiveLease(resolvedId);

    const entry = instances.get(instanceId);
    if (!entry) {
        throw new AppError("canvas_instance_missing", "The device canvas is no longer available.", 404);
    }

    const needsBoot = target.state !== "Booted" && target.kind === "emulator";
    if (needsBoot) {
        manager.prepareBoot(resolvedId);
    }

    await canvasBindings?.set(instanceId, resolvedId);
    if (fromDeviceId) {
        manager.detachInstance(fromDeviceId, instanceId);
    }
    manager.attachInstance(resolvedId, instanceId);
    await entry.server.rebindDevice(resolvedId);
    entry.deviceId = resolvedId;

    if (needsBoot) {
        queueMicrotask(() => {
            void manager.completePreparedBoot(resolvedId).catch((error) => {
                diagnostic(`Failed to boot the switched emulator: ${error.message ?? String(error)}`);
            });
        });
    }

    return {
        deviceId: resolvedId,
        switching: fromDeviceId !== resolvedId,
        opening: false,
        state: needsBoot ? "Booting" : target.state,
    };
}

function ensureString(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}

function canvasTitleForDevice(device, deviceId) {
    return device?.name || `Android ${deviceId}`;
}

/** Wraps an action so it runs inside the caller's control lease and reports progress. */
function leasedAction({ name, description, inputSchema, operation, run }) {
    return {
        name,
        description,
        inputSchema,
        handler: async (ctx) =>
            withCanvasError(async () => {
                const operationLabel = typeof operation === "function" ? operation(ctx) : operation;
                return await manager.withLeaseOperation(
                    {
                        deviceId: ctx.input.deviceId,
                        leaseId: ctx.input.leaseId,
                        operation: operationLabel,
                    },
                    async () => run(ctx),
                );
            }),
    };
}

const leasedActions = [
    {
        name: "start_video_recording",
        description: "Start a lease-bound screen recording and return immediately so inputs can continue.",
        inputSchema: actionSchemas.startVideoRecording,
        operation: "Starting video recording",
        run: (ctx) =>
            manager.startVideoRecording({
                ...ctx.input,
                maxDurationSeconds: ctx.input.maxDurationSeconds ?? 120,
            }),
    },
    {
        name: "boot_device",
        description: "Boot an Android emulator and wait until sys.boot_completed. Emulators only.",
        inputSchema: actionSchemas.bootDevice,
        operation: "Booting emulator",
        run: (ctx) => manager.bootDevice(ctx.input.deviceId),
    },
    {
        name: "shutdown_device",
        description: "Shut down a running Android emulator. Physical devices are never shut down.",
        inputSchema: actionSchemas.shutdownDevice,
        operation: "Shutting down emulator",
        run: (ctx) => manager.shutdownDevice(ctx.input.deviceId),
    },
    {
        name: "restart_device",
        description: "Restart an Android emulator by shutting it down and booting it again.",
        inputSchema: actionSchemas.restartDevice,
        operation: "Restarting emulator",
        run: (ctx) => manager.restartDevice(ctx.input.deviceId),
    },
    {
        name: "rotate_device",
        description: "Rotate the device left or right. Apps that pin their orientation may refuse the change.",
        inputSchema: actionSchemas.rotateDevice,
        operation: (ctx) => `Rotating ${ctx.input.direction}`,
        run: (ctx) => manager.rotateDevice({ deviceId: ctx.input.deviceId, direction: ctx.input.direction }),
    },
    {
        name: "press_button",
        description: "Press a hardware or navigation button: home, back, recents, power, volume up, or volume down.",
        inputSchema: actionSchemas.pressButton,
        operation: (ctx) => `Pressing ${ctx.input.button}`,
        run: (ctx) => manager.pressButton({ deviceId: ctx.input.deviceId, button: ctx.input.button }),
    },
    {
        name: "tap",
        description: "Tap the screen at normalized (0-1) coordinates by default, or explicit point coordinates.",
        inputSchema: actionSchemas.tap,
        operation: "Sending tap",
        run: (ctx) => manager.tap(ctx.input),
    },
    {
        name: "swipe",
        description: "Swipe between two points using normalized coordinates by default.",
        inputSchema: actionSchemas.swipe,
        operation: "Sending swipe",
        run: (ctx) => manager.swipe(ctx.input),
    },
    {
        name: "send_key",
        description: "Send an Android key event by keycode number, KEYCODE_* name, or browser key code.",
        inputSchema: actionSchemas.sendKey,
        operation: (ctx) => `Sending key ${ctx.input.code}`,
        run: (ctx) => manager.sendKey(ctx.input),
    },
    {
        name: "send_text",
        description: "Type text into the focused field.",
        inputSchema: actionSchemas.sendText,
        operation: "Sending text",
        run: (ctx) => manager.sendText(ctx.input),
    },
    {
        name: "perform_inputs",
        description: "Execute an ordered input sequence (tap, swipe, key, text, button, wait) under a single lease.",
        inputSchema: actionSchemas.performInputs,
        operation: "Running input sequence",
        run: (ctx) => manager.performInputs(ctx.input),
    },
    {
        name: "install_apk",
        description: "Install an APK from this machine onto the selected device.",
        inputSchema: actionSchemas.installApk,
        operation: "Installing APK",
        run: (ctx) => manager.installApk(ctx.input),
    },
    {
        name: "launch_app",
        description: "Launch an installed package, optionally targeting a specific activity.",
        inputSchema: actionSchemas.launchApp,
        operation: (ctx) => `Launching ${ctx.input.packageName}`,
        run: (ctx) => manager.launchApp(ctx.input),
    },
].map(leasedAction);

const canvas = createCanvas({
    id: CANVAS_ID,
    displayName: "Android Emulator",
    description: "Embedded Android emulator and device canvas with lifecycle, screenshots, and agent-control leasing.",
    inputSchema: openInputSchema,
    actions: [
        {
            name: "diagnose_adb",
            description: "Validate the Android SDK, the adb server, attached devices, and available AVDs.",
            handler: async () => withCanvasError(() => manager.diagnoseAdb()),
        },
        {
            name: "list_devices",
            description: "List AVDs, running emulators, and connected Android devices.",
            handler: async () =>
                withCanvasError(async () => ({ devices: await manager.listDevices() })),
        },
        {
            name: "get_device_state",
            description: "Get current state, lease, screen metrics, and metadata for one device.",
            inputSchema: actionSchemas.getDeviceState,
            handler: async (ctx) => withCanvasError(() => manager.getDeviceState(ctx.input.deviceId)),
        },
        {
            name: "capture_screen",
            description: "Capture a PNG screenshot as a session artifact. Does not require a control lease.",
            inputSchema: actionSchemas.captureScreen,
            handler: async (ctx) => withCanvasError(() => manager.captureScreen(ctx.input.deviceId)),
        },
        {
            name: "acquire_control",
            description: "Acquire an exclusive, time-limited lease so the agent can drive the device safely.",
            inputSchema: actionSchemas.acquireControl,
            handler: async (ctx) =>
                withCanvasError(() =>
                    manager.acquireLease({
                        deviceId: ctx.input.deviceId,
                        reason: ensureString(ctx.input.reason, "Agent sequence"),
                        ownerInstanceId: ctx.instanceId,
                        ttlSeconds: ctx.input.ttlSeconds,
                    }),
                ),
        },
        {
            name: "renew_control",
            description: "Renew an existing control lease before it expires.",
            inputSchema: actionSchemas.renewControl,
            handler: async (ctx) =>
                withCanvasError(() =>
                    manager.renewLease({
                        deviceId: ctx.input.deviceId,
                        leaseId: ctx.input.leaseId,
                        ttlSeconds: ctx.input.ttlSeconds,
                    }),
                ),
        },
        {
            name: "release_control",
            description: "Release an active control lease.",
            inputSchema: actionSchemas.releaseControl,
            handler: async (ctx) =>
                withCanvasError(() =>
                    manager.releaseLease({
                        deviceId: ctx.input.deviceId,
                        leaseId: ctx.input.leaseId,
                        reason: ensureString(ctx.input.reason, "Released by agent"),
                    }),
                ),
        },
        {
            name: "stop_video_recording",
            description: "Stop an active recording, or retrieve one that was finalized automatically for this lease.",
            inputSchema: actionSchemas.stopVideoRecording,
            handler: async (ctx) => withCanvasError(() => manager.stopVideoRecording(ctx.input)),
        },
        ...leasedActions,
    ],
    open: async (ctx) =>
        withCanvasError(async () => {
            const existing = instances.get(ctx.instanceId);
            const savedDeviceId = existing ? undefined : await canvasBindings?.get(ctx.instanceId);
            const preferred = savedDeviceId !== undefined ? savedDeviceId : (ctx.input?.deviceId ?? null);
            const deviceId = preferred ? await manager.resolveDeviceId(preferred) : null;
            const autoBoot = Boolean(deviceId) && ctx.input?.autoBoot !== false && ctx.input?.bootAfterOpen !== true;

            // Resolve real screen metrics up front so the frame paints at the right
            // aspect ratio instead of briefly using the placeholder geometry.
            if (deviceId && manager.getCachedDeviceState(deviceId).state === "Booted") {
                await manager.refreshDeviceGeometry(deviceId).catch(() => {});
            }

            if (existing && existing.deviceId !== deviceId) {
                await closeInstance(ctx.instanceId);
            }

            let entry = instances.get(ctx.instanceId);
            if (!entry) {
                const server = await createCanvasServer({
                    manager,
                    instanceId: ctx.instanceId,
                    deviceId,
                    webRoot,
                    openDeviceCanvas,
                    switchDeviceCanvas,
                    bootAfterOpen: ctx.input?.bootAfterOpen === true,
                    onDiagnostic: diagnostic,
                });
                if (deviceId) {
                    manager.attachInstance(deviceId, ctx.instanceId);
                }
                entry = { deviceId, server };
                instances.set(ctx.instanceId, entry);
            }
            await canvasBindings?.set(ctx.instanceId, deviceId);
            if (autoBoot) {
                await manager.ensureBooted(deviceId);
            }

            const device = deviceId ? manager.getCachedDeviceState(deviceId) : null;
            return {
                title: deviceId ? canvasTitleForDevice(device, deviceId) : "Android Emulator",
                status: deviceId ? (device?.state === "Booted" ? "Ready" : "Starting") : "Choose a device",
                url: entry.server.url,
            };
        }),
    onClose: async (ctx) => {
        await closeInstance(ctx.instanceId);
        await canvasBindings?.delete(ctx.instanceId);
    },
});

copilotSession = await joinSession({ canvases: [canvas] });

const workspacePath = copilotSession.workspacePath;
if (workspacePath) {
    const extensionFilesRoot = path.join(workspacePath, "files", "android-emulator");
    canvasBindings = new CanvasBindingStore(path.join(extensionFilesRoot, "canvas-bindings"));
    manager.setArtifactsRoot(extensionFilesRoot);
}

await copilotSession.log("Android Emulator extension loaded.");

copilotSession.on("session.shutdown", async () => {
    await Promise.allSettled(Array.from(instances.keys(), (instanceId) => closeInstance(instanceId)));
    await manager.dispose();
});

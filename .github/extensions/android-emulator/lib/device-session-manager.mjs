import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { AppError } from "./errors.mjs";
import {
    adb,
    adbShell,
    adbVersion,
    emulatorAvdName,
    getDisplayRotation,
    getProps,
    getWmDensity,
    getWmSize,
    listAttached,
    listAvds,
    listForeignCaptures,
    requireEmulatorBinary,
    resolveToolchain,
    startAdbServer,
} from "./adb.mjs";
import {
    DEVICE_STATES,
    androidVersionLabel,
    humanizeAvdName,
    orientationFromRotation,
} from "./device-model.mjs";
import { DeviceClaimStore } from "./device-claims.mjs";
import { DeviceQueue } from "./device-queue.mjs";
import { DeviceRegistry } from "./device-registry.mjs";
import { InputDispatcher } from "./input-dispatcher.mjs";
import { ScreenService } from "./screen-service.mjs";
import { VideoRecordingService } from "./video-recording-service.mjs";

const BOOT_TIMEOUT_MS = 180_000;
/**
 * Discovery spawns several adb/emulator processes. Refresh runs on many paths, so
 * results are shared for a short window and concurrent callers are deduplicated.
 */
const DISCOVERY_TTL_MS = 750;
const AVD_LIST_TTL_MS = 10_000;
/** Probing the device for foreign capture costs adb calls, so reuse it briefly. */
const FOREIGN_CAPTURE_TTL_MS = 5_000;
const BOOT_POLL_INTERVAL_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = 45_000;

function isEmulatorSerial(serial) {
    return /^emulator-\d+$/.test(serial) || serial.startsWith("emulator");
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Orchestrates discovery, lifecycle, leasing and I/O for every Android target.
 * Physical devices are first-class for screen, input and screenshots, but the
 * extension never boots or shuts them down.
 */
export class DeviceSessionManager {
    constructor({ onDiagnostic } = {}) {
        this.state = new DeviceRegistry();
        this.artifactsRoot = null;
        this.manualInputStops = new Map();
        this.deviceMetaCache = new Map();
        this.discoveryInFlight = null;
        this.bootOperations = new Map();
        // Shared with other Copilot sessions so they can see, and avoid, a device
        // this session is already driving.
        this.claims = new DeviceClaimStore({});
        // Exclusion and turn-taking across sessions; the claim store only reports.
        this.queue = new DeviceQueue({});
        this.foreignClaimCache = new Map();
        this.foreignCaptureCache = new Map();
        this.foreignCaptureCheckedAt = 0;
        this.discoveryCompletedAt = 0;
        this.lastDiscovery = null;
        this.avdListCache = null;
        this.avdListFetchedAt = 0;
        this.onDiagnostic = onDiagnostic ?? (() => {});
        this.screen = new ScreenService({
            state: this.state,
            artifactsRoot: () => this.artifactsRoot,
            ensureBooted: (deviceId) => this.ensureBooted(deviceId),
            onDiagnostic: this.onDiagnostic,
        });
        this.video = new VideoRecordingService({
            state: this.state,
            artifactsRoot: () => this.artifactsRoot,
            ensureBooted: (deviceId) => this.ensureBooted(deviceId),
        });
        this.input = new InputDispatcher({
            state: this.state,
            ensureBooted: (deviceId) => this.ensureBooted(deviceId),
            screenSize: (deviceId) => this.screen.screenSize(deviceId),
            refreshScreenMetrics: (deviceId) => this.screen.refreshScreenMetrics(deviceId),
        });
    }

    setArtifactsRoot(artifactsRoot) {
        this.artifactsRoot = artifactsRoot;
    }

    /** Identifies this session in the records other sessions read. */
    setSessionIdentity(identity) {
        this.claims.setOwner(identity);
        this.queue.setOwner({
            sessionId: identity.sessionId,
            sessionLabel: identity.workingDirectory ? identity.workingDirectory.split("/").pop() : undefined,
        });
    }

    /** Devices a request for "any" may be satisfied by. */
    availableDeviceIds() {
        return Array.from(this.state.devices.values())
            .filter((device) => device.isAvailable !== false && device.state === DEVICE_STATES.booted)
            .map((device) => device.id);
    }

    async queueStatus() {
        await this.refreshDevices();
        const deviceIds = Array.from(this.state.devices.keys());
        return { devices: await this.queue.status(deviceIds) };
    }

    async refreshForeignClaims() {
        this.foreignClaimCache = await this.claims.foreignClaims().catch(() => new Map());
        return this.foreignClaimCache;
    }

    foreignClaimFor(deviceId) {
        return this.foreignClaimCache.get(deviceId) ?? null;
    }

    /**
     * Detects capture started outside this extension entirely. Claims only reveal
     * sessions that publish one; this catches everything else.
     */
    async refreshForeignCaptures(devices) {
        if (Date.now() - this.foreignCaptureCheckedAt < FOREIGN_CAPTURE_TTL_MS) {
            return this.foreignCaptureCache;
        }
        const running = devices.filter((device) => device.serial && device.state === DEVICE_STATES.booted);
        const results = await Promise.all(
            running.map(async (device) => {
                const foreign = await listForeignCaptures(device.serial).catch(() => []);
                return [device.id, foreign.length > 0];
            }),
        );
        this.foreignCaptureCache = new Map(results);
        this.foreignCaptureCheckedAt = Date.now();
        return this.foreignCaptureCache;
    }

    setDiagnosticSink(onDiagnostic) {
        this.onDiagnostic = onDiagnostic;
        this.screen.onDiagnostic = onDiagnostic;
    }

    subscribe(deviceId, handler) {
        return this.state.subscribe(deviceId, handler);
    }

    snapshot(deviceId) {
        return this.state.snapshot(deviceId);
    }

    getCachedDeviceState(deviceId) {
        return this.state.snapshot(deviceId);
    }

    attachInstance(deviceId, instanceId) {
        this.state.attachInstance(deviceId, instanceId);
        void this.claims.claim(deviceId, { mode: "open" }).catch(() => {});
    }

    detachInstance(deviceId, instanceId) {
        this.state.detachInstance(deviceId, instanceId);
        const device = this.state.devices.get(deviceId);
        if (!device || device.instanceIds.size === 0) {
            void this.claims.release(deviceId).catch(() => {});
        }
    }

    registerManualInputStop(deviceId, handler) {
        let handlers = this.manualInputStops.get(deviceId);
        if (!handlers) {
            handlers = new Set();
            this.manualInputStops.set(deviceId, handlers);
        }
        handlers.add(handler);
        return () => {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.manualInputStops.delete(deviceId);
            }
        };
    }

    async stopManualInput(deviceId) {
        const handlers = Array.from(this.manualInputStops.get(deviceId) ?? []);
        await Promise.all(handlers.map((handler) => handler()));
        this.input.clearTouchSessions(deviceId);
    }

    // --- Discovery ---------------------------------------------------------

    async deviceMetadata(serial) {
        const cached = this.deviceMetaCache.get(serial);
        if (cached) {
            return cached;
        }
        const props = await getProps(serial, [
            "ro.build.version.sdk",
            "ro.build.version.release",
            "ro.product.model",
            "ro.product.manufacturer",
        ]);
        const meta = {
            apiLevel: props["ro.build.version.sdk"] ? Number(props["ro.build.version.sdk"]) : null,
            androidVersion: props["ro.build.version.release"] || null,
            model: props["ro.product.model"] || null,
            manufacturer: props["ro.product.manufacturer"] || null,
        };
        this.deviceMetaCache.set(serial, meta);
        return meta;
    }

    async listAvdsCached() {
        if (this.avdListCache && Date.now() - this.avdListFetchedAt < AVD_LIST_TTL_MS) {
            return this.avdListCache;
        }
        const avds = await listAvds().catch((error) => {
            this.onDiagnostic(`AVD listing unavailable: ${error.message}`);
            return this.avdListCache ?? [];
        });
        this.avdListCache = avds;
        this.avdListFetchedAt = Date.now();
        return avds;
    }

    async discoverDevices() {
        const [attached, avds] = await Promise.all([listAttached(), this.listAvdsCached()]);

        const discovered = [];
        const bootedAvdNames = new Set();

        await Promise.all(
            attached.map(async (entry) => {
                const online = entry.state === "device";
                const emulator = isEmulatorSerial(entry.serial);
                const avdName = emulator && online ? await emulatorAvdName(entry.serial) : null;
                const meta = online ? await this.deviceMetadata(entry.serial) : {};
                if (avdName) {
                    bootedAvdNames.add(avdName);
                }

                const id = emulator ? (avdName ?? entry.serial) : entry.serial;
                const name = emulator
                    ? humanizeAvdName(avdName) || entry.serial
                    : [meta.manufacturer, meta.model].filter(Boolean).join(" ") ||
                      entry.properties.model?.replaceAll("_", " ") ||
                      entry.serial;

                discovered.push({
                    id,
                    serial: entry.serial,
                    avdName,
                    kind: emulator ? "emulator" : "device",
                    name,
                    state: online
                        ? DEVICE_STATES.booted
                        : entry.state === "unauthorized"
                          ? DEVICE_STATES.unauthorized
                          : DEVICE_STATES.offline,
                    isAvailable: entry.state !== "unauthorized",
                    apiLevel: meta.apiLevel ?? null,
                    androidVersion: meta.androidVersion ?? null,
                });
            }),
        );

        for (const avdName of avds) {
            if (bootedAvdNames.has(avdName)) {
                continue;
            }
            discovered.push({
                id: avdName,
                serial: null,
                avdName,
                kind: "emulator",
                name: humanizeAvdName(avdName),
                state: DEVICE_STATES.shutdown,
                isAvailable: true,
                apiLevel: null,
                androidVersion: null,
            });
        }

        return discovered;
    }

    /**
     * Deduplicates concurrent refreshes and serves a very recent result rather than
     * re-running discovery. Concurrent refreshes could also apply out of order.
     */
    async refreshDevices({ force = false } = {}) {
        if (!force && this.lastDiscovery && Date.now() - this.discoveryCompletedAt < DISCOVERY_TTL_MS) {
            return this.lastDiscovery;
        }
        if (this.discoveryInFlight) {
            return await this.discoveryInFlight;
        }

        this.discoveryInFlight = (async () => {
            const discovered = await this.discoverDevices();
            this.state.updateFromList(discovered);
            this.lastDiscovery = discovered;
            this.discoveryCompletedAt = Date.now();
            return discovered;
        })();

        try {
            return await this.discoveryInFlight;
        } finally {
            this.discoveryInFlight = null;
        }
    }

    /** Lifecycle changes must observe the device immediately, not a cached list. */
    refreshDevicesNow() {
        return this.refreshDevices({ force: true });
    }

    async listDevices() {
        const devices = await this.refreshDevices();
        return devices.map((device) => ({
            deviceId: device.id,
            serial: device.serial,
            avdName: device.avdName,
            kind: device.kind,
            name: device.name,
            state: device.state,
            isAvailable: device.isAvailable,
            apiLevel: device.apiLevel,
            androidVersion: device.androidVersion,
            versionLabel: androidVersionLabel(device),
            canManageLifecycle: device.kind === "emulator",
        }));
    }

    async listDevicePicker(currentDeviceId) {
        const [picker] = await Promise.all([
            this.refreshDevices().then(() => this.state.listDevicePicker(currentDeviceId)),
            this.refreshForeignClaims(),
        ]);
        await this.refreshForeignCaptures(Array.from(this.state.devices.values())).catch(() => {});

        const deviceIds = Object.values(picker.groups).flatMap((group) => group.map((item) => item.deviceId));
        const queueByDevice = new Map(
            (await this.queue.status(deviceIds).catch(() => [])).map((entry) => [entry.deviceId, entry]),
        );

        for (const group of Object.values(picker.groups)) {
            for (const item of group) {
                const claim = this.foreignClaimFor(item.deviceId);
                item.foreignUse = claim
                    ? { sessionLabel: claim.sessionLabel, mode: claim.mode, reason: claim.reason }
                    : null;
                // Capture we did not start, by something that publishes no claim.
                item.foreignCapture = this.foreignCaptureCache.get(item.deviceId) === true;

                const queued = queueByDevice.get(item.deviceId);
                item.queue = queued
                    ? {
                          holder: queued.holder
                              ? {
                                    sessionLabel: queued.holder.sessionLabel,
                                    reason: queued.holder.reason,
                                    isMine: queued.holder.isMine,
                                }
                              : null,
                          waiting: queued.waiting.length,
                          myPosition: queued.waiting.find((waiter) => waiter.isMine)?.position ?? null,
                      }
                    : null;
            }
        }
        return picker;
    }

    /** Accepts an AVD name or a serial and returns the canonical device id. */
    async resolveDeviceId(preferred) {
        const devices = await this.refreshDevices();
        if (devices.length === 0) {
            throw new AppError(
                "no_devices",
                "No Android emulators or devices were found. Create an AVD or connect a device with USB debugging enabled.",
                404,
            );
        }

        if (preferred) {
            const found =
                devices.find((device) => device.id === preferred) ??
                devices.find((device) => device.serial === preferred) ??
                devices.find((device) => device.avdName === preferred);
            if (!found) {
                throw new AppError("unknown_device", `Android device not found: ${preferred}`, 404);
            }
            if (found.isAvailable === false) {
                throw new AppError(
                    "device_unavailable",
                    `${found.name} is unauthorized. Accept the USB debugging prompt on the device.`,
                    409,
                );
            }
            return found.id;
        }

        const booted = devices.find((device) => device.state === DEVICE_STATES.booted && device.isAvailable);
        if (booted) {
            return booted.id;
        }
        const available = devices.find((device) => device.isAvailable);
        if (available) {
            return available.id;
        }
        throw new AppError("no_available_device", "No available Android device could be selected.", 404);
    }

    async assertDeviceAvailable(deviceId) {
        await this.refreshDevices();
        const device = this.state.getDeviceOrThrow(deviceId);
        if (device.isAvailable === false) {
            throw new AppError("device_unavailable", `Android device is unavailable: ${device.name}`, 409);
        }
        return device;
    }

    assertLifecycleAllowed(deviceId) {
        const device = this.state.getDeviceOrThrow(deviceId);
        if (device.kind !== "emulator") {
            throw new AppError(
                "lifecycle_not_supported",
                `${device.name} is a physical device. This extension never boots or shuts down physical devices.`,
                409,
            );
        }
        return device;
    }

    // --- Lifecycle ---------------------------------------------------------

    async getDeviceState(deviceId) {
        await this.refreshDevices();
        const device = this.state.getDeviceOrThrow(deviceId);
        if (device.state === DEVICE_STATES.booted && device.serial) {
            await this.refreshDeviceGeometry(deviceId).catch((error) =>
                this.onDiagnostic(`geometry refresh failed for ${deviceId}: ${error.message}`),
            );
        }
        return this.state.snapshot(deviceId);
    }

    /** Reconcile the cached screen metrics and orientation with the live device. */
    async refreshDeviceGeometry(deviceId) {
        const serial = this.state.requireSerial(deviceId);
        const [rotation, size, density] = await Promise.all([
            getDisplayRotation(serial),
            getWmSize(serial),
            getWmDensity(serial),
        ]);
        this.state.setOrientation(deviceId, orientationFromRotation(rotation));
        if (size) {
            const landscape = rotation === 1 || rotation === 3;
            const oriented = landscape
                ? { width: Math.max(size.width, size.height), height: Math.min(size.width, size.height) }
                : { width: Math.min(size.width, size.height), height: Math.max(size.width, size.height) };
            this.state.updateScreenMetrics(deviceId, { ...oriented, density: density ?? undefined }, "wm");
        }
        this.state.notify(deviceId);
        return this.state.snapshot(deviceId);
    }

    async ensureBooted(deviceId) {
        const device = this.state.devices.get(deviceId);
        if (device?.state === DEVICE_STATES.booted && device.serial) {
            return this.state.snapshot(deviceId);
        }
        await this.refreshDevices();
        const refreshed = this.state.getDeviceOrThrow(deviceId);
        if (refreshed.state === DEVICE_STATES.booted && refreshed.serial) {
            return this.state.snapshot(deviceId);
        }
        if (refreshed.kind !== "emulator") {
            throw new AppError(
                "device_not_connected",
                `${refreshed.name} is not connected. Reconnect it and accept the USB debugging prompt.`,
                409,
            );
        }
        this.prepareBoot(deviceId);
        return await this.completePreparedBoot(deviceId);
    }

    prepareBoot(deviceId) {
        return this.state.setDeviceState(deviceId, DEVICE_STATES.booting);
    }

    async bootDevice(deviceId) {
        await this.refreshDevicesNow();
        this.assertLifecycleAllowed(deviceId);
        const device = this.state.getDeviceOrThrow(deviceId);
        if (device.state === DEVICE_STATES.booted && device.serial) {
            return this.state.snapshot(deviceId);
        }
        this.prepareBoot(deviceId);
        return await this.completePreparedBoot(deviceId);
    }

    /**
     * Two canvases, or a canvas and an agent action, can ask for the same AVD at
     * once. Without this they would each spawn `emulator -avd`, producing a second
     * instance of the same device.
     */
    completePreparedBoot(deviceId) {
        const pending = this.bootOperations.get(deviceId);
        if (pending) {
            return pending;
        }
        const promise = this.runBoot(deviceId).finally(() => {
            if (this.bootOperations.get(deviceId) === promise) {
                this.bootOperations.delete(deviceId);
            }
        });
        this.bootOperations.set(deviceId, promise);
        return promise;
    }

    async runBoot(deviceId) {
        const device = this.assertLifecycleAllowed(deviceId);
        if (!device.avdName) {
            throw new AppError("unknown_avd", `No AVD is associated with ${deviceId}.`, 409);
        }

        try {
            const emulatorPath = await requireEmulatorBinary();
            const before = new Set((await listAttached()).map((entry) => entry.serial));
            const child = spawn(emulatorPath, ["-avd", device.avdName, "-no-snapshot-save"], {
                detached: true,
                stdio: "ignore",
            });
            child.unref();

            const serial = await this.waitForNewEmulatorSerial(device.avdName, before);
            this.state.setSerial(deviceId, serial);
            await this.waitForBootCompleted(serial);
            this.deviceMetaCache.delete(serial);
        } catch (error) {
            await this.refreshDevices();
            throw error;
        }

        await this.refreshDevicesNow();
        await this.refreshDeviceGeometry(deviceId).catch(() => {});
        this.state.notify(deviceId);
        return this.state.snapshot(deviceId);
    }

    async waitForNewEmulatorSerial(avdName, beforeSerials) {
        const deadline = Date.now() + BOOT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const attached = await listAttached().catch(() => []);
            const candidates = attached.filter(
                (entry) => isEmulatorSerial(entry.serial) && entry.state === "device",
            );
            for (const candidate of candidates) {
                if (!beforeSerials.has(candidate.serial)) {
                    return candidate.serial;
                }
                if ((await emulatorAvdName(candidate.serial)) === avdName) {
                    return candidate.serial;
                }
            }
            await delay(BOOT_POLL_INTERVAL_MS);
        }
        throw new AppError("boot_timeout", `Timed out waiting for ${avdName} to appear in adb.`, 504);
    }

    async waitForBootCompleted(serial) {
        const deadline = Date.now() + BOOT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            try {
                const value = await adbShell(serial, ["getprop", "sys.boot_completed"], { timeout: 10_000 });
                if (value.trim() === "1") {
                    return true;
                }
            } catch {
                // The device may still be coming up; keep polling.
            }
            await delay(BOOT_POLL_INTERVAL_MS);
        }
        throw new AppError("boot_timeout", `Timed out waiting for ${serial} to finish booting.`, 504);
    }

    async shutdownDevice(deviceId) {
        await this.refreshDevicesNow();
        const device = this.assertLifecycleAllowed(deviceId);
        if (!device.serial) {
            return this.state.snapshot(deviceId);
        }

        const serial = device.serial;
        this.state.setDeviceState(deviceId, DEVICE_STATES.shuttingDown);
        try {
            await adb(["-s", serial, "emu", "kill"], { timeout: 30_000 });
        } catch (error) {
            this.onDiagnostic(`emu kill failed for ${serial}: ${error.message}`);
        }

        const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const attached = await listAttached().catch(() => []);
            if (!attached.some((entry) => entry.serial === serial)) {
                break;
            }
            await delay(1_000);
        }

        this.deviceMetaCache.delete(serial);
        await this.refreshDevicesNow();
        this.state.setDeviceState(deviceId, DEVICE_STATES.shutdown);
        this.state.setSerial(deviceId, null);
        return this.state.snapshot(deviceId);
    }

    async restartDevice(deviceId) {
        this.assertLifecycleAllowed(deviceId);
        await this.shutdownDevice(deviceId);
        this.state.setDeviceState(deviceId, DEVICE_STATES.booting);
        return await this.completePreparedBoot(deviceId);
    }

    // --- Leases ------------------------------------------------------------

    assertNoActiveLease(deviceId) {
        this.state.assertNoActiveLease(deviceId);
    }

    hasActiveLease(deviceId) {
        return this.state.hasActiveLease(deviceId);
    }

    /**
     * Takes the device for this session, queueing behind other sessions when asked.
     * `deviceId` may be "any" to accept whichever device becomes free first.
     */
    async acquireLease(input) {
        await this.refreshDevices();

        const wantsAny = input.deviceId === "any";
        const candidates = wantsAny ? this.availableDeviceIds() : [input.deviceId];
        if (candidates.length === 0) {
            throw new AppError("no_available_device", "No booted device is available to take.", 409);
        }

        const granted = await this.queue.acquire(candidates, {
            reason: input.reason ?? null,
            timeoutMs: Math.max(0, Math.round((input.waitSeconds ?? 0) * 1000)),
        });
        if (!granted) {
            const [status] = await this.queue.status(candidates);
            throw new AppError(
                "device_busy",
                status?.holder
                    ? `${status.holder.sessionLabel} is using this device` +
                      `${status.holder.reason ? ` (${status.holder.reason})` : ""}.` +
                      ` ${status.waiting.length} session(s) waiting. Pass waitSeconds to queue for it.`
                    : "The device could not be taken. Pass waitSeconds to queue for it.",
                409,
                { queue: status ?? null },
            );
        }

        const deviceId = granted.deviceId;
        const leaseInput = { ...input, deviceId };
        try {
            this.state.reserveLease(leaseInput);
        } catch (error) {
            await this.queue.release(deviceId);
            throw error;
        }

        try {
            await this.stopManualInput(deviceId);
            const snapshot = this.state.acquireLease(leaseInput);
            await this.claims.claim(deviceId, { mode: "control", reason: input.reason ?? null }).catch(() => {});
            return { ...snapshot, waitedMs: granted.waitedMs };
        } catch (error) {
            this.state.cancelLeaseReservation(deviceId, input.ownerInstanceId);
            await this.queue.release(deviceId);
            throw error;
        }
    }

    /** Drops the shared claim back to "open" once the agent is done. */
    async downgradeClaim(deviceId) {
        const device = this.state.devices.get(deviceId);
        if (device && device.instanceIds.size > 0) {
            await this.claims.claim(deviceId, { mode: "open" }).catch(() => {});
        } else {
            await this.claims.release(deviceId).catch(() => {});
        }
    }

    async renewLease(input) {
        return this.state.renewLease(input);
    }

    async releaseLease(input) {
        const snapshot = this.state.releaseLease(input);
        await this.downgradeClaim(input.deviceId);
        // Hand the device to whoever is next in line.
        await this.queue.release(input.deviceId).catch(() => {});
        return snapshot;
    }

    async revokeLease(deviceId) {
        // Drop the lease first so nothing new can start, then wait for work already
        // in flight before handing the device back to the user.
        const snapshot = this.state.revokeLease(deviceId);
        await this.state.settleActiveOperations(deviceId);
        await this.downgradeClaim(deviceId);
        await this.queue.release(deviceId).catch(() => {});
        return snapshot;
    }

    async withLeaseOperation(input, fn) {
        return await this.state.withLeaseOperation(input, fn);
    }

    // --- Diagnostics -------------------------------------------------------

    async diagnoseAdb() {
        const toolchain = await resolveToolchain({ refresh: true });
        const problems = [];
        const report = {
            platform: process.platform,
            sdkSearchPaths: toolchain.sdkRoots,
            adbPath: toolchain.adbPath,
            emulatorPath: toolchain.emulatorPath,
            adbVersion: null,
            adbServerRunning: false,
            attachedDevices: [],
            avds: [],
            environment: {
                ANDROID_HOME: process.env.ANDROID_HOME ?? null,
                ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT ?? null,
            },
        };

        if (!toolchain.adbPath) {
            problems.push("adb was not found. Install Android SDK platform-tools and set ANDROID_HOME.");
            return { ok: false, problems, ...report };
        }

        try {
            report.adbVersion = await adbVersion();
        } catch (error) {
            problems.push(`Could not run adb: ${error.message}`);
        }

        try {
            await startAdbServer();
            report.adbServerRunning = true;
        } catch (error) {
            problems.push(`adb server could not be started: ${error.message}`);
        }

        try {
            report.attachedDevices = (await listAttached()).map((entry) => ({
                serial: entry.serial,
                state: entry.state,
                model: entry.properties.model ?? null,
            }));
        } catch (error) {
            problems.push(`Could not list attached devices: ${error.message}`);
        }

        if (!toolchain.emulatorPath) {
            problems.push("The Android `emulator` binary was not found. Emulator lifecycle controls are disabled.");
        } else {
            try {
                report.avds = await listAvds();
            } catch (error) {
                problems.push(`Could not list AVDs: ${error.message}`);
            }
        }

        if (report.attachedDevices.length === 0 && report.avds.length === 0) {
            problems.push("No AVDs and no attached devices were found.");
        }
        for (const device of report.attachedDevices) {
            if (device.state === "unauthorized") {
                problems.push(`${device.serial} is unauthorized. Accept the USB debugging prompt on the device.`);
            }
        }

        return { ok: problems.length === 0, problems, ...report };
    }

    // --- Screen / input pass-throughs --------------------------------------

    captureScreen(deviceId) {
        return this.screen.captureScreen(deviceId);
    }

    getFramePng(deviceId) {
        return this.screen.getFramePng(deviceId);
    }

    refreshScreenMetrics(deviceId) {
        return this.screen.refreshScreenMetrics(deviceId);
    }

    createH264Stream(input) {
        return this.screen.createH264Stream(input);
    }

    setStreamPreferences(deviceId, preferences) {
        return this.state.setStreamPreferences(deviceId, preferences);
    }

    startVideoRecording(input) {
        return this.video.start(input);
    }

    stopVideoRecording(input) {
        return this.video.stop(input);
    }

    async rotateDevice(input, maybeDirection) {
        const deviceId = typeof input === "string" ? input : input?.deviceId;
        const result = await this.input.rotateDevice(input, maybeDirection);
        // Apps may pin their orientation, so report what the window manager actually did.
        await delay(600);
        const snapshot = await this.refreshDeviceGeometry(deviceId).catch(() => this.state.snapshot(deviceId));
        return {
            ...result,
            applied: snapshot.orientation === result.requestedOrientation,
            orientation: snapshot.orientation,
            screen: snapshot.screen,
        };
    }

    goHome(input) {
        return this.input.goHome(input);
    }

    pressButton(input, maybeButton) {
        return this.input.pressButton(input, maybeButton);
    }

    tap(input) {
        return this.input.tap(input);
    }

    swipe(input) {
        return this.input.swipe(input);
    }

    touch(input) {
        return this.input.touch(input);
    }

    prepareTouchStream(deviceId) {
        return this.input.prepareTouchStream(deviceId);
    }

    notifyTouch(input) {
        return this.input.notifyTouch(input);
    }

    sendKey(input) {
        return this.input.sendKey(input);
    }

    sendText(input) {
        return this.input.sendText(input);
    }

    performInputs(input) {
        return this.input.performInputs(input);
    }

    // --- Android specific tools --------------------------------------------

    async installApk({ deviceId, apkPath, reinstall = true, grantPermissions = false }) {
        await this.ensureBooted(deviceId);
        const serial = this.state.requireSerial(deviceId);
        try {
            await access(apkPath, constants.R_OK);
        } catch {
            throw new AppError("apk_not_found", `APK not found or unreadable: ${apkPath}`, 404);
        }

        const args = ["-s", serial, "install"];
        if (reinstall) {
            args.push("-r");
        }
        if (grantPermissions) {
            args.push("-g");
        }
        args.push(apkPath);

        const stdout = await adb(args, { timeout: 300_000 });
        if (/Failure|Error:/i.test(stdout)) {
            throw new AppError("install_failed", stdout.trim(), 502);
        }
        return { deviceId, apkPath, output: stdout.trim() };
    }

    async launchApp({ deviceId, packageName, activity }) {
        await this.ensureBooted(deviceId);
        const serial = this.state.requireSerial(deviceId);
        if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(String(packageName))) {
            throw new AppError("invalid_package", `Invalid package name: ${packageName}`, 400);
        }

        const stdout = activity
            ? await adbShell(serial, ["am", "start", "-n", `${packageName}/${activity}`], { timeout: 60_000 })
            : await adbShell(
                  serial,
                  ["monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
                  { timeout: 60_000 },
              );

        if (/Error:|No activities found|aborted/i.test(stdout)) {
            throw new AppError("launch_failed", stdout.trim(), 502);
        }
        return { deviceId, packageName, activity: activity ?? null, output: stdout.trim() };
    }

    async dispose() {
        await this.video.stopAll().catch(() => {});
        this.input.clearTouchSessions();
        // Never leave a device taken, or a queue blocked, by a session that has exited.
        await this.claims.releaseAll().catch(() => {});
        await this.queue.releaseAll().catch(() => {});
    }
}

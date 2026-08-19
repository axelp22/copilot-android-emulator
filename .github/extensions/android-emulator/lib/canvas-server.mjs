import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { AppError, asAppError } from "./errors.mjs";
import { assertLoopbackRequest, json, readJsonBody, text } from "./http-utils.mjs";
import { loadWebAssets, serveWebAsset } from "./web-assets.mjs";
import { parseWebSocketFrames, websocketAcceptKey, websocketCloseFrame } from "./websocket-utils.mjs";

function formatPublicState(state) {
    if (!state) {
        return null;
    }
    const lease = state.lease?.active
        ? { ...state.lease, expiresInMs: Math.max(0, new Date(state.lease.expiresAt).getTime() - Date.now()) }
        : { active: false };
    return { ...state, lease };
}

function unassignedState() {
    return {
        deviceId: null,
        serial: null,
        avdName: null,
        kind: "emulator",
        name: "Android Emulator",
        state: "Unassigned",
        isAvailable: true,
        apiLevel: null,
        androidVersion: null,
        versionLabel: "",
        canManageLifecycle: false,
        deviceFamily: "phone",
        screen: { width: 1080, height: 2400, density: 420 },
        orientation: "portrait",
        stream: { codec: "h264", fps: 60, resolution: 100 },
        controlPending: false,
        lease: { active: false },
    };
}

function enforceNoAgentLease(state) {
    if (state?.lease?.active || state?.controlPending) {
        throw new AppError(
            "lease_active",
            "Agent control is active. Use 'Take back control' to continue with manual interaction.",
            423,
        );
    }
}

function streamFpsFrom(value, fallback = 60) {
    const parsed = Number(value ?? fallback);
    return parsed === 30 ? 30 : 60;
}

function streamResolutionFrom(value, fallback = 100) {
    const parsed = Number(value ?? fallback);
    return parsed === 25 || parsed === 50 ? parsed : 100;
}

const EXPECTED_SOCKET_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"]);

function safeWrite(stream, chunk) {
    if (stream.destroyed || stream.writableEnded) {
        return false;
    }
    stream.write(chunk);
    return true;
}

export async function createCanvasServer({
    manager,
    instanceId,
    deviceId,
    webRoot,
    openDeviceCanvas,
    switchDeviceCanvas,
    bootAfterOpen = false,
    onDiagnostic,
}) {
    const webAssets = await loadWebAssets(webRoot);
    const token = randomBytes(18).toString("hex");
    const basePath = `/${token}`;
    const sseClients = new Set();
    const streamChildren = new Set();
    const touchConnections = new Set();
    const manualOperations = new Set();

    let streamGeneration = 0;
    let unsub = null;
    let unregisterManualInputStop = null;
    let bootAfterOpenStarted = false;
    let fallbackTouchActive = false;
    let acceptingManualInput = true;

    function handleConnectionError(error, context) {
        if (EXPECTED_SOCKET_ERROR_CODES.has(error?.code)) {
            return;
        }
        onDiagnostic?.(`${context}: ${error?.message ?? String(error)}`);
    }

    function writeStateEvent() {
        const state = deviceId ? formatPublicState(manager.snapshot(deviceId)) : unassignedState();
        const payload = `data: ${JSON.stringify(state)}\n\n`;
        for (const client of sseClients) {
            safeWrite(client, payload);
        }
    }

    function subscribeToDevice() {
        unsub?.();
        unsub = null;
        unregisterManualInputStop?.();
        unregisterManualInputStop = null;
        if (!deviceId) {
            return;
        }
        unsub = manager.subscribe(deviceId, () => {
            const state = manager.snapshot(deviceId);
            if (!state.lease?.active && !state.controlPending) {
                acceptingManualInput = true;
            }
            writeStateEvent();
        });
        unregisterManualInputStop = manager.registerManualInputStop(deviceId, stopManualInput);
    }

    subscribeToDevice();

    // Another session taking or freeing the device happens outside this process,
    // so it can only be noticed by looking. Cheap: one small file read.
    const sharingTimer = setInterval(() => {
        void manager.refreshSharing(deviceId).catch(() => {});
    }, 6_000);
    sharingTimer.unref?.();
    void manager.refreshSharing(deviceId).catch(() => {});

    async function cancelPointer() {
        if (!deviceId) {
            return;
        }
        await manager.notifyTouch({ deviceId, phase: "cancel" }).catch((error) => {
            handleConnectionError(error, "pointer cancellation failed");
        });
    }

    function closeTouchConnection(connection) {
        if (connection.closePromise) {
            return connection.closePromise;
        }
        connection.blocked = true;
        connection.closePromise = connection.queue
            .catch(() => {})
            .then(() => cancelPointer())
            .finally(() => connection.socket.end());
        return connection.closePromise;
    }

    function stopManualTouches() {
        const pending = [];
        for (const connection of touchConnections) {
            pending.push(closeTouchConnection(connection));
        }
        touchConnections.clear();
        return Promise.allSettled(pending).then(async () => {
            if (!fallbackTouchActive) {
                return;
            }
            fallbackTouchActive = false;
            await cancelPointer();
        });
    }

    async function runManualOperation(operation) {
        if (!acceptingManualInput) {
            throw new AppError("manual_input_stopped", "Manual device input is no longer active.", 409);
        }
        const pending = Promise.resolve().then(operation);
        manualOperations.add(pending);
        try {
            return await pending;
        } finally {
            manualOperations.delete(pending);
        }
    }

    async function stopManualInput() {
        acceptingManualInput = false;
        await Promise.allSettled(Array.from(manualOperations));
        await stopManualTouches();
    }

    async function stopActiveConnections({ blockManualInput = false } = {}) {
        if (blockManualInput) {
            acceptingManualInput = false;
        }
        streamGeneration += 1;
        const reaped = [];
        for (const child of streamChildren) {
            if (!child.killed) {
                child.kill();
            }
            // Wait for the device-side recorder to be signalled: abandoning it leaves
            // an orphan that holds an encoder slot on the device.
            reaped.push(child.whenReaped?.() ?? Promise.resolve());
        }
        streamChildren.clear();
        await (blockManualInput ? stopManualInput() : stopManualTouches());
        await Promise.allSettled(reaped);
    }

    function startBootAfterOpen() {
        if (!deviceId || !bootAfterOpen || bootAfterOpenStarted) {
            return;
        }
        bootAfterOpenStarted = true;
        queueMicrotask(() => {
            void manager.ensureBooted(deviceId).catch((error) => {
                handleConnectionError(error, "deferred emulator boot failed");
                try {
                    writeStateEvent();
                } catch (writeError) {
                    handleConnectionError(writeError, "deferred boot state update failed");
                }
            });
        });
    }

    function requireDevice() {
        if (!deviceId) {
            throw new AppError("no_device_selected", "Pick an emulator or device first.", 409);
        }
        return deviceId;
    }

    const server = createServer(async (req, res) => {
        try {
            const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
            const { pathname } = requestUrl;
            if (!(pathname === basePath || pathname.startsWith(`${basePath}/`))) {
                text(res, 404, "Not found");
                return;
            }

            const route = pathname.slice(basePath.length) || "/";
            assertLoopbackRequest(req);

            if (req.method === "GET" && serveWebAsset(webAssets, route, res)) {
                if (route === "/" || route === "/index.html") {
                    startBootAfterOpen();
                }
                return;
            }

            if (req.method === "GET" && route === "/api/state") {
                const state = deviceId ? formatPublicState(await manager.getDeviceState(deviceId)) : unassignedState();
                json(res, 200, state);
                return;
            }

            if (req.method === "GET" && route === "/api/devices") {
                json(res, 200, await manager.listDevicePicker(deviceId));
                return;
            }

            if (req.method === "GET" && route === "/api/events") {
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
                res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
                res.setHeader("Connection", "keep-alive");
                res.setHeader("X-Accel-Buffering", "no");
                sseClients.add(res);
                res.on("error", (error) => handleConnectionError(error, "SSE response error"));
                req.on("error", (error) => handleConnectionError(error, "SSE request error"));
                res.write("\n");
                writeStateEvent();
                const heartbeat = setInterval(() => {
                    if (!safeWrite(res, ": ping\n\n")) {
                        clearInterval(heartbeat);
                        sseClients.delete(res);
                    }
                }, 15_000);
                heartbeat.unref?.();
                const cleanup = () => {
                    clearInterval(heartbeat);
                    sseClients.delete(res);
                };
                req.on("close", cleanup);
                res.on("close", cleanup);
                return;
            }

            if (req.method === "GET" && route === "/api/frame.png") {
                const png = await manager.getFramePng(requireDevice());
                res.statusCode = 200;
                res.setHeader("Content-Type", "image/png");
                res.setHeader("Cache-Control", "no-store");
                res.end(png);
                return;
            }

            if (req.method === "GET" && route === "/api/stream.h264") {
                const target = requireDevice();
                const fps = streamFpsFrom(requestUrl.searchParams.get("fps"));
                const resolution = streamResolutionFrom(requestUrl.searchParams.get("resolution"));
                const generation = ++streamGeneration;
                for (const existing of streamChildren) {
                    if (!existing.killed) {
                        existing.kill();
                    }
                }
                streamChildren.clear();

                const child = await manager.createH264Stream({ deviceId: target, fps, resolution });
                if (generation !== streamGeneration) {
                    child.kill();
                    res.statusCode = 409;
                    res.end();
                    return;
                }
                streamChildren.add(child);
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/vnd.copilot-android-emulator.avcc");
                res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
                res.setHeader("Connection", "close");

                res.on("error", (error) => handleConnectionError(error, "stream response error"));
                req.on("error", (error) => handleConnectionError(error, "stream request error"));
                child.stdout.on("error", (error) => handleConnectionError(error, "stream stdout error"));
                child.stdout.pipe(res);
                child.on("error", (error) => {
                    if (!res.headersSent) {
                        json(res, 502, { error: { code: "stream_failed", message: error.message } });
                    } else {
                        res.destroy(error);
                    }
                });
                child.on("exit", (code, signal) => {
                    streamChildren.delete(child);
                    if (!res.destroyed && code !== 0 && signal == null) {
                        res.destroy(new Error(child.stderrText() || `Device stream exited with code ${code}`));
                    } else if (!res.destroyed) {
                        res.end();
                    }
                });
                req.on("close", () => {
                    if (!child.killed) {
                        child.kill();
                    }
                });
                return;
            }

            if (req.method !== "POST" || !route.startsWith("/api/")) {
                text(res, 404, "Not found");
                return;
            }

            const body = await readJsonBody(req);

            if (route === "/api/device/switch") {
                if (!switchDeviceCanvas) {
                    throw new AppError(
                        "device_switch_unavailable",
                        "Device switching is not available in this session.",
                        501,
                    );
                }
                json(
                    res,
                    200,
                    await switchDeviceCanvas({ instanceId, fromDeviceId: deviceId, toDeviceId: body?.deviceId }),
                );
                return;
            }

            if (route === "/api/device/open") {
                if (!openDeviceCanvas) {
                    throw new AppError(
                        "device_open_unavailable",
                        "Opening a new device tab is not available in this session.",
                        501,
                    );
                }
                json(res, 200, await openDeviceCanvas({ deviceId: body?.deviceId }));
                return;
            }

            if (route === "/api/control/revoke") {
                json(res, 200, formatPublicState(await manager.revokeLease(requireDevice())));
                return;
            }

            const target = requireDevice();
            enforceNoAgentLease(manager.getCachedDeviceState(target));

            const toolbarRoutes = {
                "/api/toolbar/boot": () => manager.bootDevice(target),
                "/api/toolbar/shutdown": () => manager.shutdownDevice(target),
                "/api/toolbar/restart": () => manager.restartDevice(target),
            };
            if (Object.hasOwn(toolbarRoutes, route)) {
                json(res, 200, formatPublicState(await runManualOperation(toolbarRoutes[route])));
                return;
            }

            if (route === "/api/stream/preferences") {
                const next = await runManualOperation(() =>
                    manager.setStreamPreferences(target, { fps: body?.fps, resolution: body?.resolution }),
                );
                json(res, 200, formatPublicState(next));
                return;
            }

            if (route === "/api/toolbar/button") {
                await runManualOperation(() => manager.pressButton({ deviceId: target, button: body?.button }));
                json(res, 200, formatPublicState(manager.snapshot(target)));
                return;
            }

            if (route === "/api/install") {
                // Deliberately not awaited: a Gradle build can take minutes, and the
                // canvas follows its progress over SSE rather than a hanging request.
                const target = requireDevice();
                void manager
                    .buildInstallLaunch({ deviceId: target, task: body?.task })
                    .catch((error) => diagnostic(`install failed: ${error.message}`));
                json(res, 202, { started: true });
                return;
            }

            if (route === "/api/toolbar/rotate") {
                const result = await runManualOperation(() =>
                    manager.rotateDevice({ deviceId: target, direction: body?.direction }),
                );
                json(res, 200, result);
                return;
            }

            const inputRoutes = {
                "/api/input/tap": () => manager.tap({ deviceId: target, ...body }),
                "/api/input/swipe": () => manager.swipe({ deviceId: target, ...body }),
                "/api/input/key": () => manager.sendKey({ deviceId: target, ...body }),
                "/api/input/text": () => manager.sendText({ deviceId: target, ...body }),
            };
            if (Object.hasOwn(inputRoutes, route)) {
                json(res, 200, await runManualOperation(inputRoutes[route]));
                return;
            }

            if (route === "/api/input/touch") {
                const result = await runManualOperation(async () => {
                    const outcome = await manager.touch({ deviceId: target, ...body });
                    fallbackTouchActive = !(body?.phase === "up" || body?.phase === "cancel");
                    const currentState = manager.getCachedDeviceState(target);
                    if (!acceptingManualInput || currentState.lease?.active || currentState.controlPending) {
                        fallbackTouchActive = false;
                        await cancelPointer();
                    }
                    return outcome;
                });
                json(res, 200, result);
                return;
            }

            text(res, 404, "Not found");
        } catch (error) {
            const appError = asAppError(error);
            if (res.headersSent) {
                res.destroy();
                return;
            }
            json(res, appError.status ?? 500, {
                error: { code: appError.code, message: appError.message, details: appError.details },
            });
        }
    });

    server.on("connection", (socket) => {
        socket.on("error", (error) => handleConnectionError(error, "client socket error"));
    });

    server.on("clientError", (error, socket) => {
        handleConnectionError(error, "client protocol error");
        socket.destroy();
    });

    server.on("upgrade", (req, socket) => {
        socket.on("error", (error) => handleConnectionError(error, "touch websocket error"));
        void (async () => {
            try {
                const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
                const { pathname } = requestUrl;
                const route = pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : "";
                if (route !== "/api/input/touch-ws") {
                    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                    socket.destroy();
                    return;
                }
                assertLoopbackRequest(req);
                if (!acceptingManualInput) {
                    throw new AppError("manual_input_stopped", "Manual device input is no longer active.", 409);
                }
                const target = requireDevice();
                enforceNoAgentLease(manager.getCachedDeviceState(target));
                await manager.prepareTouchStream(target);

                const key = req.headers["sec-websocket-key"];
                if (typeof key !== "string" || !key) {
                    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                    socket.destroy();
                    return;
                }
                socket.write(
                    [
                        "HTTP/1.1 101 Switching Protocols",
                        "Upgrade: websocket",
                        "Connection: Upgrade",
                        `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
                        "\r\n",
                    ].join("\r\n"),
                );

                const connection = {
                    deviceId: target,
                    socket,
                    buffer: Buffer.alloc(0),
                    queue: Promise.resolve(),
                    blocked: false,
                    closePromise: null,
                };
                touchConnections.add(connection);
                socket.on("close", () => {
                    touchConnections.delete(connection);
                    void closeTouchConnection(connection);
                });
                socket.on("data", (chunk) => {
                    connection.queue = connection.queue
                        .then(async () => {
                            if (connection.blocked) {
                                return;
                            }
                            if (!acceptingManualInput) {
                                connection.blocked = true;
                                await cancelPointer();
                                socket.end();
                                return;
                            }
                            connection.buffer = Buffer.concat([connection.buffer, chunk]);
                            const parsed = parseWebSocketFrames(connection.buffer);
                            connection.buffer = parsed.remaining;
                            for (const wsFrame of parsed.messages) {
                                if (wsFrame.opcode === 0x8) {
                                    socket.write(websocketCloseFrame());
                                    socket.end();
                                    return;
                                }
                                if (wsFrame.opcode !== 0x1) {
                                    continue;
                                }
                                const currentState = manager.getCachedDeviceState(connection.deviceId);
                                if (currentState.lease?.active || currentState.controlPending) {
                                    connection.blocked = true;
                                    await cancelPointer();
                                    socket.end();
                                    return;
                                }
                                const event = JSON.parse(wsFrame.payload.toString("utf8"));
                                await manager.notifyTouch({
                                    deviceId: connection.deviceId,
                                    phase: event?.phase,
                                    x: event?.x,
                                    y: event?.y,
                                    coordinateSpace: event?.coordinateSpace,
                                });
                            }
                        })
                        .catch((error) => {
                            handleConnectionError(error, "touch websocket dispatch failed");
                            socket.destroy();
                        });
                });
            } catch {
                socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
                socket.destroy();
            }
        })();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    function bootstrapQuery() {
        const bootstrap = new URLSearchParams();
        if (deviceId) {
            const state = manager.snapshot(deviceId);
            bootstrap.set("family", state.deviceFamily ?? "phone");
            bootstrap.set("width", String(state.screen?.width ?? ""));
            bootstrap.set("height", String(state.screen?.height ?? ""));
        }
        return bootstrap.size > 0 ? `?${bootstrap}` : "";
    }

    return {
        url: `http://127.0.0.1:${port}${basePath}/${bootstrapQuery()}`,
        async rebindDevice(nextDeviceId) {
            await stopActiveConnections({ blockManualInput: true });
            deviceId = nextDeviceId;
            acceptingManualInput = true;
            subscribeToDevice();

    // Another session taking or freeing the device happens outside this process,
    // so it can only be noticed by looking. Cheap: one small file read.
    const sharingTimer = setInterval(() => {
        void manager.refreshSharing(deviceId).catch(() => {});
    }, 6_000);
    sharingTimer.unref?.();
    void manager.refreshSharing(deviceId).catch(() => {});
            writeStateEvent();
        },
        async close() {
            clearInterval(sharingTimer);
            unsub?.();
            unsub = null;
            unregisterManualInputStop?.();
            unregisterManualInputStop = null;
            for (const client of sseClients) {
                client.end();
            }
            sseClients.clear();
            await stopActiveConnections({ blockManualInput: true });
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

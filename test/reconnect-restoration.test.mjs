/**
 * Reconnect and session restoration without real devices: emulator restarts
 * and unplugs are simulated by changing what discovery reports, gRPC by fake
 * connections, and time by an injected clock.
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { extensionModule, extensionRoot, tempDir } from "./helpers.mjs";

const { EmulatorControlPool } = await extensionModule("lib", "emulator-control-pool.mjs");
const { CanvasBindingStore } = await extensionModule("lib", "canvas-binding-store.mjs");
const { DeviceRegistry } = await extensionModule("lib", "device-registry.mjs");
const { ScreenService, isConnectionFailure } = await extensionModule("lib", "screen-service.mjs");
const { KeyedLock, resolveCanvasDevice } = await extensionModule("lib", "canvas-open.mjs");
const { AppError } = await extensionModule("lib", "errors.mjs");
const { GRPC_STATUS } = await extensionModule("lib", "grpc-client.mjs");
const { InputDispatcher } = await extensionModule("lib", "input-dispatcher.mjs");
const { CanvasInstanceController } = await extensionModule("lib", "canvas-instances.mjs");
const { DeviceSessionManager } = await extensionModule("lib", "device-session-manager.mjs");

function grpcError(status, message = `status ${status}`) {
    return Object.assign(new Error(message), { grpcStatus: status });
}

/** A pool over a scripted emulator table and a scripted handshake. */
function fakePool({ emulators = {}, failures = [], ...options } = {}) {
    let clock = 1_000;
    const opened = [];
    const table = new Map(Object.entries(emulators));
    const pool = new EmulatorControlPool({
        now: () => clock,
        findEmulator: async (serial) => table.get(serial) ?? null,
        connect: async (emulator) => {
            const failure = failures.shift();
            if (failure) {
                throw failure;
            }
            const connection = {
                controller: { id: `${emulator.pid}:${emulator.grpcPort}` },
                channel: { closed: false, close() { this.closed = true; } },
                tokens: { disposed: false, dispose() { this.disposed = true; } },
            };
            opened.push(connection);
            return connection;
        },
        ...options,
    });
    return {
        pool,
        opened,
        table,
        advance: (ms) => {
            clock += ms;
        },
    };
}

test("control pool reuses one connection per serial", async () => {
    const { pool, opened } = fakePool({ emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 } } });
    const [a, b] = await Promise.all([pool.get("emulator-5554"), pool.get("emulator-5554")]);
    assert.equal(a, b);
    assert.equal(opened.length, 1);
    assert.equal(a.controller.id, "1:8554");
});

test("control pool reconnects after an emulator restart under the same serial", async () => {
    const { pool, opened, table } = fakePool({ emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 } } });
    const first = await pool.get("emulator-5554");
    table.set("emulator-5554", { pid: 2, grpcPort: 8556 });
    await pool.invalidateIfReplaced("emulator-5554");
    assert.equal(opened[0].channel.closed, true, "stale channel closed");
    assert.equal(opened[0].tokens.disposed, true, "stale tokens disposed");
    const second = await pool.get("emulator-5554");
    assert.notEqual(second, first);
    assert.equal(second.controller.id, "2:8556");
});

test("control pool keeps a connection whose emulator is unchanged", async () => {
    const { pool, opened } = fakePool({ emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 } } });
    const first = await pool.get("emulator-5554");
    await pool.invalidateIfReplaced("emulator-5554");
    assert.equal(await pool.get("emulator-5554"), first);
    assert.equal(opened[0].channel.closed, false);
});

test("control pool backs off transient failures exponentially and resets on success", async () => {
    const { pool, opened, advance } = fakePool({
        emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 } },
        failures: [grpcError(GRPC_STATUS.deadlineExceeded), grpcError(GRPC_STATUS.unavailable)],
        retryBackoffMs: 100,
        maxRetryBackoffMs: 1_000,
    });
    assert.equal(await pool.get("emulator-5554"), null);
    advance(99);
    assert.equal(await pool.get("emulator-5554"), null, "still inside the first backoff");
    advance(1);
    assert.equal(await pool.get("emulator-5554"), null, "second failure");
    advance(199);
    assert.equal(await pool.get("emulator-5554"), null, "backoff doubled");
    advance(1);
    const entry = await pool.get("emulator-5554");
    assert.ok(entry?.controller);
    assert.equal(opened.length, 1);
    assert.equal(pool.failureCounts.has("emulator-5554"), false, "failure count reset");
});

test("control pool caps the backoff", async () => {
    const failures = Array.from({ length: 6 }, () => grpcError(GRPC_STATUS.unavailable));
    const { pool, advance } = fakePool({
        emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 } },
        failures,
        retryBackoffMs: 100,
        maxRetryBackoffMs: 250,
    });
    for (let i = 0; i < 6; i += 1) {
        assert.equal(await pool.get("emulator-5554"), null);
        const wait = pool.unavailableUntil.get("emulator-5554") - pool.now();
        assert.ok(wait <= 250, `attempt ${i} waited ${wait}`);
        advance(wait);
    }
    assert.ok(await pool.get("emulator-5554"));
});

test("control pool treats refused credentials as permanent until the emulator is replaced", async () => {
    const { pool, table, advance } = fakePool({
        emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 } },
        failures: [grpcError(GRPC_STATUS.unauthenticated)],
    });
    assert.equal(await pool.get("emulator-5554"), null);
    advance(10 * 60_000);
    assert.equal(await pool.get("emulator-5554"), null);
    await pool.invalidateIfReplaced("emulator-5554");
    assert.equal(await pool.get("emulator-5554"), null, "same emulator stays refused");
    table.set("emulator-5554", { pid: 2, grpcPort: 8556 });
    await pool.invalidateIfReplaced("emulator-5554");
    assert.ok(await pool.get("emulator-5554"), "restarted emulator is retried");
});

test("control pool picks up a gRPC endpoint that appears after a cold boot", async () => {
    const { pool, table } = fakePool();
    assert.equal(await pool.get("emulator-5554"), null, "no discovery file yet");
    table.set("emulator-5554", { pid: 3, grpcPort: 8554 });
    await pool.invalidateIfReplaced("emulator-5554");
    assert.ok(await pool.get("emulator-5554"));
});

test("control pool drops a connection reported as failed and reconnects", async () => {
    const { pool, opened } = fakePool({ emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 } } });
    const first = await pool.get("emulator-5554");
    await pool.reportFailure("emulator-5554", grpcError(GRPC_STATUS.unavailable));
    assert.equal(opened[0].channel.closed, true);
    const second = await pool.get("emulator-5554");
    assert.notEqual(second, first);
    assert.equal(opened.length, 2);
});

test("a stale release cannot close a connection that was reopened", async () => {
    const { pool, opened } = fakePool({ emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 } } });
    await pool.get("emulator-5554");
    const stale = pool.entries.get("emulator-5554");
    await pool.release("emulator-5554");
    await pool.get("emulator-5554");
    await pool.release("emulator-5554", stale);
    assert.equal(opened[1].channel.closed, false);
});

test("control pool disposeAll closes connections, including one finishing mid-handshake", async () => {
    let finish;
    const gate = new Promise((resolve) => {
        finish = resolve;
    });
    const closed = [];
    const pool = new EmulatorControlPool({
        findEmulator: async (serial) => ({ pid: 1, grpcPort: serial === "a" ? 1 : 2 }),
        connect: async (emulator) => {
            if (emulator.grpcPort === 2) {
                await gate;
            }
            return { controller: {}, channel: { close: () => closed.push(emulator.grpcPort) }, tokens: { dispose() {} } };
        },
    });
    await pool.get("a");
    const pending = pool.get("b");
    await pool.disposeAll();
    assert.deepEqual(closed, [1]);
    finish();
    assert.equal(await pending, null);
    assert.deepEqual(closed, [1, 2], "late connection closed, not leaked");
    assert.equal(await pool.get("a"), null, "disposed pool hands out nothing");
});

test("control pool reports serials with negative verdicts for cleanup", async () => {
    const { pool } = fakePool({
        emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 } },
        failures: [grpcError(GRPC_STATUS.unavailable)],
    });
    await pool.get("emulator-5554");
    assert.deepEqual(pool.serials(), ["emulator-5554"]);
    await pool.release("emulator-5554");
    assert.deepEqual(pool.serials(), []);
    assert.equal(pool.unavailableUntil.size, 0);
});

test("registry clears a stale serial when an emulator shuts down or a device is unplugged", () => {
    const registry = new DeviceRegistry();
    registry.updateFromList([{ id: "avd:Pixel", serial: "emulator-5554", avdName: "Pixel", kind: "emulator", name: "Pixel", state: "Booted" }]);
    assert.equal(registry.requireSerial("avd:Pixel"), "emulator-5554");
    registry.updateFromList([{ id: "avd:Pixel", serial: null, avdName: "Pixel", kind: "emulator", name: "Pixel", state: "Shutdown" }]);
    assert.throws(() => registry.requireSerial("avd:Pixel"), { code: "device_not_running" });

    registry.updateFromList([{ id: "usb:abc", serial: "abc", kind: "physical", name: "Phone", state: "Booted" }]);
    registry.updateFromList([]);
    assert.throws(() => registry.requireSerial("usb:abc"), { code: "device_not_running" });
    registry.updateFromList([{ id: "usb:abc", serial: "abc", kind: "physical", name: "Phone", state: "Booted" }]);
    assert.equal(registry.requireSerial("usb:abc"), "abc", "replug restores the serial");
});

test("registry keeps the serial of a boot in flight", () => {
    const registry = new DeviceRegistry();
    registry.updateFromList([{ id: "avd:Pixel", serial: "emulator-5554", avdName: "Pixel", kind: "emulator", name: "Pixel", state: "Booted" }]);
    registry.getDeviceOrThrow("avd:Pixel").state = "Booting";
    registry.updateFromList([{ id: "avd:Pixel", serial: null, avdName: "Pixel", kind: "emulator", name: "Pixel", state: "Shutdown" }]);
    assert.equal(registry.getDeviceOrThrow("avd:Pixel").serial, "emulator-5554");
});

function screenServiceWith({ pool, createFrameStream }) {
    const registry = new DeviceRegistry();
    registry.updateFromList([
        { id: "avd:A", serial: "emulator-5554", avdName: "A", kind: "emulator", name: "A", state: "Booted" },
        { id: "avd:B", serial: "emulator-5556", avdName: "B", kind: "emulator", name: "B", state: "Booted" },
    ]);
    const service = new ScreenService({
        state: registry,
        artifactsRoot: () => null,
        ensureBooted: async () => {},
        controlPool: pool,
        createFrameStream,
    });
    return { service, registry };
}

test("screen service drops a stale gRPC connection so the next stream reconnects", async (t) => {
    const { pool, opened } = fakePool({
        emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 }, "emulator-5556": { pid: 2, grpcPort: 8556 } },
    });
    let failNext = true;
    const { service } = screenServiceWith({
        pool,
        createFrameStream: async ({ controller }) => {
            if (failNext) {
                failNext = false;
                throw grpcError(GRPC_STATUS.unavailable, "connection reset");
            }
            return { controller };
        },
    });
    // The mirror fallback needs adb; probe the private path through the
    // required transport instead.
    await assert.rejects(service.createVideoStream({ deviceId: "avd:A", fps: 30, resolution: "half", transport: "grpc" }));
    assert.equal(opened[0].channel.closed, true, "failed connection released");
    const stream = await service.createVideoStream({ deviceId: "avd:A", fps: 30, resolution: "half", transport: "grpc" });
    assert.equal(opened.length, 2);
    assert.equal(stream.controller, opened[1].controller);
    t.after(() => pool.disposeAll());
});

test("screen service keeps the connection for errors that are not connection failures", async () => {
    const { pool, opened } = fakePool({ emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 } } });
    const { service } = screenServiceWith({
        pool,
        createFrameStream: async () => {
            throw grpcError(GRPC_STATUS.invalidArgument, "bad size");
        },
    });
    await assert.rejects(service.createVideoStream({ deviceId: "avd:A", fps: 30, resolution: "half", transport: "grpc" }));
    assert.equal(opened[0].channel.closed, false);
});

test("isConnectionFailure separates transport failures from refusals", () => {
    assert.equal(isConnectionFailure(new Error("socket hang up")), true);
    assert.equal(isConnectionFailure(grpcError(GRPC_STATUS.unavailable)), true);
    assert.equal(isConnectionFailure(grpcError(GRPC_STATUS.deadlineExceeded)), true);
    assert.equal(isConnectionFailure(grpcError(GRPC_STATUS.unimplemented)), false);
    assert.equal(isConnectionFailure(new AppError("grpc_unavailable", "x")), false);
});

test("binding store round-trips, writes atomically and recovers from a corrupt file", async (t) => {
    const root = await tempDir(t);
    const store = new CanvasBindingStore(root);
    assert.equal(await store.get("canvas-1"), undefined);
    await store.set("canvas-1", "avd:Pixel");
    assert.equal(await store.get("canvas-1"), "avd:Pixel");
    await store.set("canvas-1", null);
    assert.equal(await store.get("canvas-1"), null);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), [], "no temp files left");

    await Promise.all(Array.from({ length: 20 }, (_, i) => store.set("canvas-2", `dev-${i}`)));
    assert.match(await store.get("canvas-2"), /^dev-\d+$/, "concurrent writes leave a whole binding");

    await writeFile(store.filePath("canvas-3"), "{\"deviceId\":", "utf8");
    assert.equal(await store.get("canvas-3"), undefined);
    await assert.rejects(readFile(store.filePath("canvas-3")), { code: "ENOENT" }, "corrupt binding removed");

    await store.delete("canvas-1");
    await store.delete("canvas-1");
    assert.equal(await store.get("canvas-1"), undefined);
});

test("binding store survives a session reopen with a fresh instance", async (t) => {
    const root = path.join(await tempDir(t), "nested", "bindings");
    await new CanvasBindingStore(root).set("android-emulator-avd-pixel", "avd:Pixel");
    await mkdir(root, { recursive: true });
    assert.equal(await new CanvasBindingStore(root).get("android-emulator-avd-pixel"), "avd:Pixel");
});

function resolverFor(available) {
    return async (preferred) => {
        if (available.length === 0) {
            throw new AppError("no_devices", "none", 404);
        }
        if (!available.includes(preferred)) {
            throw new AppError("unknown_device", `missing ${preferred}`, 404);
        }
        return preferred;
    };
}

test("reopen restores a saved binding", async () => {
    const result = await resolveCanvasDevice({
        savedDeviceId: "usb:abc",
        requestedDeviceId: null,
        resolveDeviceId: resolverFor(["usb:abc"]),
    });
    assert.deepEqual(result, { deviceId: "usb:abc", persist: true });
});

test("reopen with an unplugged saved device opens unbound and keeps the binding", async () => {
    const messages = [];
    const result = await resolveCanvasDevice({
        savedDeviceId: "usb:abc",
        requestedDeviceId: "usb:abc",
        resolveDeviceId: resolverFor([]),
        onDiagnostic: (message) => messages.push(message),
    });
    assert.deepEqual(result, { deviceId: null, persist: false });
    assert.match(messages[0], /usb:abc.*no_devices/);
});

test("reopen with a stale saved device falls back to the requested device", async () => {
    const result = await resolveCanvasDevice({
        savedDeviceId: "avd:Deleted",
        requestedDeviceId: "avd:Pixel",
        resolveDeviceId: resolverFor(["avd:Pixel"]),
    });
    // The fallback is temporary: only an explicit switch replaces the saved device.
    assert.deepEqual(result, { deviceId: "avd:Pixel", persist: false });
});

test("reopen surfaces unexpected resolution errors", async () => {
    await assert.rejects(
        resolveCanvasDevice({
            savedDeviceId: "avd:Pixel",
            requestedDeviceId: null,
            resolveDeviceId: async () => {
                throw new Error("adb exploded");
            },
        }),
        /adb exploded/,
    );
});

test("a fresh open still fails for an unknown requested device", async () => {
    await assert.rejects(
        resolveCanvasDevice({ savedDeviceId: undefined, requestedDeviceId: "nope", resolveDeviceId: resolverFor(["avd:Pixel"]) }),
        { code: "unknown_device" },
    );
});

test("keyed lock serializes work per key and releases on failure", async () => {
    const lock = new KeyedLock();
    const order = [];
    let releaseFirst;
    const first = lock.run("canvas", async () => {
        order.push("first:start");
        await new Promise((resolve) => {
            releaseFirst = resolve;
        });
        order.push("first:end");
        throw new Error("boom");
    });
    const second = lock.run("canvas", async () => {
        order.push("second");
        return 2;
    });
    const other = lock.run("other", async () => {
        order.push("other");
    });
    await other;
    assert.deepEqual(order, ["first:start", "other"]);
    releaseFirst();
    await assert.rejects(first, /boom/);
    assert.equal(await second, 2);
    assert.deepEqual(order, ["first:start", "other", "first:end", "second"]);
    assert.equal(lock.has("canvas"), false, "no lock state retained");
});

// --- Review regressions (PR #9) -------------------------------------------

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const TWO_EMULATORS = { "emulator-5554": { pid: 1, grpcPort: 8554 }, "emulator-5556": { pid: 2, grpcPort: 8556 } };

test("F1: a failing video stream does not close the connection an active touch is using", async (t) => {
    const pressures = [];
    const { pool } = fakePool({
        emulators: TWO_EMULATORS,
        connect: async () => {
            const channel = { closed: false, close() { this.closed = true; } };
            return {
                channel,
                tokens: { dispose() {} },
                controller: {
                    sendTouch: async ({ touches }) => {
                        if (channel.closed) {
                            throw new Error("channel closed");
                        }
                        pressures.push(touches[0].pressure);
                    },
                },
            };
        },
    });
    const { service, registry } = screenServiceWith({
        pool,
        createFrameStream: async () => {
            throw grpcError(GRPC_STATUS.deadlineExceeded);
        },
    });
    const input = new InputDispatcher({
        state: registry,
        ensureBooted: async () => {},
        screenSize: async () => ({ width: 1080, height: 1920 }),
        refreshScreenMetrics: async () => {},
        controlPool: pool,
    });
    const touch = { deviceId: "avd:A", x: 0.5, y: 0.5 };
    await input.notifyTouch({ ...touch, phase: "down" });
    await assert.rejects(service.createVideoStream({ deviceId: "avd:A", fps: 30, resolution: 50, transport: "grpc" }));
    await input.notifyTouch({ ...touch, phase: "up" });
    assert.deepEqual(pressures, [1, 0], "release delivered on the held connection");
    t.after(() => pool.disposeAll());
});

test("F2: a delayed failure on an old stream does not close its replacement", async (t) => {
    const { pool, opened, table } = fakePool({ emulators: TWO_EMULATORS });
    const gate = deferred();
    let calls = 0;
    const { service } = screenServiceWith({
        pool,
        createFrameStream: async ({ controller }) => {
            calls += 1;
            if (calls === 1) {
                await gate.promise;
            }
            return { controller };
        },
    });
    const old = service.createVideoStream({ deviceId: "avd:A", fps: 30, resolution: 50, transport: "grpc" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened.length, 1);
    await pool.release("emulator-5554");
    table.set("emulator-5554", { pid: 9, grpcPort: 8600 });
    const fresh = await service.createVideoStream({ deviceId: "avd:A", fps: 30, resolution: 50, transport: "grpc" });
    assert.equal(fresh.controller, opened[1].controller);
    gate.reject(grpcError(GRPC_STATUS.unavailable));
    await assert.rejects(old);
    assert.equal(opened[1].channel.closed, false, "replacement kept open");
    assert.equal((await pool.get("emulator-5554")).controller, opened[1].controller);
    t.after(() => pool.disposeAll());
});

test("F3: an obsolete failed handshake does not poison its replacement", async (t) => {
    const handshakes = [];
    const { pool } = fakePool({
        emulators: TWO_EMULATORS,
        connect: () => {
            const gate = deferred();
            handshakes.push(gate);
            return gate.promise;
        },
    });
    const stale = pool.get("emulator-5554");
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.race([pool.release("emulator-5554"), new Promise((resolve) => setImmediate(resolve))]);
    const replacement = pool.get("emulator-5554");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handshakes.length, 2);
    const channel = { closed: false, close() { this.closed = true; } };
    handshakes[1].resolve({ controller: { id: "new" }, channel, tokens: { dispose() {} } });
    assert.equal((await replacement).controller.id, "new");
    handshakes[0].reject(grpcError(GRPC_STATUS.unauthenticated));
    assert.equal(await stale, null);
    assert.equal(pool.unavailableUntil.size, 0, "no negative verdict recorded");
    assert.equal(pool.failureCounts.size, 0, "no failure counted");
    assert.equal(channel.closed, false);
    assert.equal((await pool.get("emulator-5554")).controller.id, "new");
    t.after(() => pool.disposeAll());
});

test("F4: wrapped transport AppErrors without a gRPC status invalidate the connection", async (t) => {
    assert.equal(isConnectionFailure(new AppError("grpc_transport_error", "http2 session broken")), true);
    assert.equal(isConnectionFailure(new AppError("grpc_closed", "closed")), true);
    const { pool, opened } = fakePool({ emulators: TWO_EMULATORS });
    const { service } = screenServiceWith({
        pool,
        createFrameStream: async () => {
            throw new AppError("grpc_transport_error", "http2 session broken", 502);
        },
    });
    await assert.rejects(service.createVideoStream({ deviceId: "avd:A", fps: 30, resolution: 50, transport: "grpc" }));
    assert.equal(opened[0].channel.closed, true, "broken session not reused");
    t.after(() => pool.disposeAll());
});

test("F5: a fatal error after the first frame invalidates the pooled connection", async (t) => {
    const { EventEmitter } = await import("node:events");
    const { pool, opened } = fakePool({ emulators: TWO_EMULATORS });
    let stream;
    const { service } = screenServiceWith({
        pool,
        createFrameStream: async ({ controller }) => {
            stream = Object.assign(new EventEmitter(), { controller });
            return stream;
        },
    });
    await service.createVideoStream({ deviceId: "avd:A", fps: 30, resolution: 50, transport: "grpc" });
    stream.on("error", () => {});
    stream.emit("error", grpcError(GRPC_STATUS.unavailable, "reset after first frame"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened[0].channel.closed, true);
    const next = await service.createVideoStream({ deviceId: "avd:A", fps: 30, resolution: 50, transport: "grpc" });
    assert.equal(next.controller, opened[1].controller, "next stream reconnects");
    t.after(() => pool.disposeAll());
});

test("F6: a handshake settling at the disposal boundary is closed, not handed out", async () => {
    const handshake = deferred();
    let connectStarted;
    const started = new Promise((resolve) => {
        connectStarted = resolve;
    });
    const { pool } = fakePool({
        emulators: { s: { pid: 1, grpcPort: 1 } },
        connect: () => {
            connectStarted();
            return handshake.promise;
        },
    });
    const acquiring = pool.get("s");
    await started;
    const channel = { closed: false, close() { this.closed = true; } };
    const tokens = { disposed: false, dispose() { this.disposed = true; } };
    handshake.resolve({ controller: {}, channel, tokens });
    let disposing;
    queueMicrotask(() => {
        disposing = pool.disposeAll();
    });
    const result = await acquiring;
    await disposing;
    assert.equal(result, null);
    assert.equal(channel.closed, true);
    assert.equal(tokens.disposed, true);
});

/** An in-memory manager, server factory and binding store for the controller. */
function instanceHarness({ devices = {}, saved = {}, gates = {} } = {}) {
    const events = [];
    const servers = [];
    const deviceTable = new Map(Object.entries(devices));
    const store = new Map(Object.entries(saved));
    const manager = {
        attached: new Map(),
        async resolveDeviceId(preferred) {
            if (deviceTable.size === 0) {
                throw new AppError("no_devices", "none", 404);
            }
            const id = preferred ?? deviceTable.keys().next().value;
            if (!deviceTable.has(id)) {
                throw new AppError("unknown_device", `missing ${id}`, 404);
            }
            return id;
        },
        getCachedDeviceState: (id) => deviceTable.get(id) ?? { kind: "emulator", state: "Shutdown", name: id },
        async refreshDeviceGeometry() {},
        attachInstance(deviceId, instanceId) {
            events.push(`attach:${deviceId}`);
            manager.attached.set(instanceId, deviceId);
        },
        detachInstance(deviceId, instanceId) {
            events.push(`detach:${deviceId}`);
            if (manager.attached.get(instanceId) === deviceId) {
                manager.attached.delete(instanceId);
            }
        },
        async assertDeviceAvailable(id) {
            return deviceTable.get(id);
        },
        assertNoActiveLease() {},
        prepareBoot: (id) => events.push(`prepare:${id}`),
        completePreparedBoot: async (id) => events.push(`boot:${id}`),
        async ensureBooted(id) {
            events.push(`ensureBooted:${id}`);
            await gates.boot?.promise;
        },
    };
    const bindings = {
        writes: [],
        async get(id) {
            await gates.get?.promise;
            return store.get(id);
        },
        async set(id, deviceId) {
            bindings.writes.push(deviceId);
            await gates.set?.promise;
            store.set(id, deviceId);
        },
        async delete(id) {
            store.delete(id);
        },
    };
    const controller = new CanvasInstanceController({
        manager,
        getBindings: () => bindings,
        webRoot: "/web",
        openDeviceCanvas: async () => {},
        createCanvasServer: async ({ deviceId }) => {
            await gates.server?.promise;
            const server = {
                deviceId,
                closed: false,
                rebinds: [],
                url: `http://127.0.0.1/${servers.length}`,
                async close() {
                    server.closed = true;
                },
                async rebindDevice(next) {
                    if (server.closed) {
                        throw new AppError("canvas_closed", "closing", 409);
                    }
                    server.rebinds.push(next);
                },
            };
            servers.push(server);
            return server;
        },
    });
    return { controller, manager, servers, store, bindings, events, deviceTable };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("F7: open and close complete without waiting for an emulator boot", async () => {
    const boot = deferred();
    const { controller, servers } = instanceHarness({
        devices: { slow: { kind: "emulator", state: "Shutdown", name: "Slow" } },
        gates: { boot },
    });
    const opened = await controller.open({ instanceId: "c", input: { deviceId: "slow" } });
    assert.equal(opened.status, "Starting");
    await controller.close("c");
    assert.equal(servers[0].closed, true);
    assert.equal(controller.instances.size, 0);
    boot.resolve();
});

test("F8: opens queued behind a slow open do not outlive session shutdown", async () => {
    const server = deferred();
    const { controller, servers } = instanceHarness({
        devices: { A: { kind: "emulator", state: "Booted", name: "A" } },
        gates: { server },
    });
    const first = controller.open({ instanceId: "c", input: { deviceId: "A" } });
    const second = controller.open({ instanceId: "c", input: { deviceId: "A" } });
    const other = controller.open({ instanceId: "d", input: { deviceId: "A" } });
    await tick();
    const shutdown = controller.shutdown();
    server.resolve();
    await Promise.allSettled([first, second, other]);
    await shutdown;
    await assert.rejects(controller.open({ instanceId: "e", input: {} }), { code: "session_shutting_down" });
    assert.equal(servers.filter((s) => !s.closed).length, 0, "no live servers remain");
    assert.equal(controller.instances.size, 0);
});

test("F9: a close issued while a switch's binding write is pending leaves nothing behind", async () => {
    const set = deferred();
    const { controller, servers, store, manager } = instanceHarness({
        devices: {
            A: { kind: "emulator", state: "Booted", name: "A" },
            B: { kind: "emulator", state: "Booted", name: "B" },
        },
        saved: { c: "A" },
    });
    await controller.open({ instanceId: "c", input: {} });
    const bindings = controller.getBindings();
    const write = bindings.set.bind(bindings);
    bindings.set = async (...args) => {
        await set.promise;
        return write(...args);
    };
    const switching = controller.switch({ instanceId: "c", fromDeviceId: "A", toDeviceId: "B" });
    await tick();
    const closing = controller.close("c");
    set.resolve();
    // Switch and close are serialized per instance: the switch commits, then
    // the close tears it down -- the late write cannot outlive the close.
    await Promise.allSettled([switching]);
    await closing;
    assert.equal(store.has("c"), false, "no binding left behind");
    assert.equal(manager.attached.has("c"), false, "no B attachment");
    assert.equal(servers[0].closed, true);
    assert.equal(controller.instances.size, 0);
});

test("F9: a switch queued behind a close is rejected without writing a binding", async () => {
    const { controller, servers, store, manager, bindings } = instanceHarness({
        devices: {
            A: { kind: "emulator", state: "Booted", name: "A" },
            B: { kind: "emulator", state: "Booted", name: "B" },
        },
        saved: { c: "A" },
    });
    await controller.open({ instanceId: "c", input: {} });
    const closing = controller.close("c");
    const switching = controller.switch({ instanceId: "c", fromDeviceId: "A", toDeviceId: "B" });
    await assert.rejects(switching, { code: "canvas_instance_missing" });
    await closing;
    assert.equal(bindings.writes.includes("B"), false);
    assert.equal(store.has("c"), false);
    assert.equal(manager.attached.has("c"), false);
    assert.deepEqual(servers[0].rebinds, []);
});

test("F9: a closing canvas server refuses to rebind", async () => {
    const { createCanvasServer } = await extensionModule("lib", "canvas-server.mjs");
    const subscribed = [];
    const manager = {
        refreshSharing: async () => {},
        subscribe: (id) => {
            subscribed.push(id);
            return () => {};
        },
        registerManualInputStop: () => () => {},
        snapshot: () => ({}),
    };
    const server = await createCanvasServer({
        manager,
        instanceId: "c",
        deviceId: null,
        webRoot: path.join(extensionRoot, "web"),
    });
    const closing = server.close();
    await assert.rejects(server.rebindDevice("B"), { code: "canvas_closed" });
    await closing;
    await assert.rejects(server.rebindDevice("B"), { code: "canvas_closed" });
    assert.deepEqual(subscribed, [], "a closed server is never resubscribed");
});

test("F10/F11: a missing saved device is retained and restored when it returns", async () => {
    const { controller, store, bindings, deviceTable } = instanceHarness({
        devices: { A: { kind: "emulator", state: "Booted", name: "A" } },
        saved: { c: "B" },
    });
    const first = await controller.open({ instanceId: "c", input: {} });
    assert.equal(first.deviceId, null, "B missing opens unbound");
    assert.equal(store.get("c"), "B");
    deviceTable.set("B", { kind: "emulator", state: "Booted", name: "B" });
    const second = await controller.open({ instanceId: "c", input: {} });
    assert.equal(second.deviceId, "B", "restored once B returns");
    assert.equal(store.get("c"), "B");
    assert.equal(bindings.writes.includes(null), false, "never erased");
});

test("F11: a replayed original device is a temporary fallback, not a new saved choice", async () => {
    const { controller, store, deviceTable } = instanceHarness({
        devices: { A: { kind: "emulator", state: "Booted", name: "A" } },
        saved: { c: "B" },
    });
    const first = await controller.open({ instanceId: "c", input: { deviceId: "A" } });
    assert.equal(first.deviceId, "A");
    assert.equal(store.get("c"), "B", "last switched device kept");
    await controller.close("c");
    store.set("c", "B");
    deviceTable.set("B", { kind: "emulator", state: "Booted", name: "B" });
    assert.equal((await controller.open({ instanceId: "c", input: { deviceId: "A" } })).deviceId, "B");
});

test("F12: an offline physical device opens a recoverable canvas without booting", async () => {
    const { controller, servers, events } = instanceHarness({
        devices: { "usb:abc": { kind: "physical", state: "Offline", name: "Phone" } },
    });
    const opened = await controller.open({ instanceId: "c", input: { deviceId: "usb:abc" } });
    await tick();
    assert.equal(opened.deviceId, "usb:abc");
    assert.equal(servers.length, 1);
    assert.equal(events.some((event) => event.startsWith("ensureBooted")), false);
});

test("F13: removing an emulator with a pending handshake does not stall discovery", async () => {
    const handshake = deferred();
    const { pool } = fakePool({
        emulators: { "emulator-5554": { pid: 1, grpcPort: 8554 } },
        connect: () => handshake.promise,
    });
    const pending = pool.get("emulator-5554");
    await tick();
    const manager = Object.create(DeviceSessionManager.prototype);
    Object.assign(manager, {
        state: new DeviceRegistry(),
        controlPool: pool,
        discoveryInFlight: null,
        lastDiscovery: null,
        discoveryCompletedAt: 0,
        discoverDevices: async () => [],
    });
    const result = await Promise.race([
        manager.refreshDevices({ force: true }).then(() => "done"),
        new Promise((resolve) => setTimeout(() => resolve("stalled"), 200)),
    ]);
    assert.equal(result, "done");
    assert.deepEqual(pool.serials(), [], "cache cleared immediately");
    const channel = { closed: false, close() { this.closed = true; } };
    handshake.resolve({ controller: {}, channel, tokens: { dispose() {} } });
    assert.equal(await pending, null, "stale completion not handed out");
    await tick();
    assert.equal(channel.closed, true, "late connection closed on settlement");
});

test("R1: a boot queued behind discovery never starts once the manager is disposed", async () => {
    const discovery = deferred();
    const manager = new DeviceSessionManager({});
    manager.state.updateFromList([
        { id: "avd:A", serial: null, avdName: "A", kind: "emulator", name: "A", state: "Shutdown" },
    ]);
    const spawned = [];
    manager.discoverDevices = async () => {
        await discovery.promise;
        return [{ id: "avd:A", serial: null, avdName: "A", kind: "emulator", name: "A", state: "Shutdown" }];
    };
    manager.withDeviceHold = async (_deviceId, _reason, fn) => fn();
    manager.runBoot = async (deviceId) => {
        spawned.push(deviceId);
    };
    const booting = manager.ensureBooted("avd:A");
    await tick();
    let disposed = false;
    const disposing = manager.dispose().then(() => {
        disposed = true;
    });
    await tick();
    assert.equal(disposed, false, "dispose drains boot work before releasing ownership");
    discovery.resolve();
    await assert.rejects(booting, { code: "session_shutting_down" });
    await disposing;
    assert.deepEqual(spawned, [], "no emulator spawned after dispose");
    await assert.rejects(manager.ensureBooted("avd:A"), { code: "session_shutting_down" });
    await assert.rejects(manager.completePreparedBoot("avd:A"), { code: "session_shutting_down" });
});

function leasingHarness(options) {
    const harness = instanceHarness(options);
    const leases = new Set();
    harness.manager.assertNoActiveLease = (deviceId) => {
        if (leases.has(deviceId)) {
            throw new AppError("device_leased", `${deviceId} is leased`, 409);
        }
    };
    return { ...harness, leases };
}

const THREE_BOOTED = {
    A: { kind: "emulator", state: "Booted", name: "A" },
    B: { kind: "emulator", state: "Booted", name: "B" },
    C: { kind: "emulator", state: "Booted", name: "C" },
};

test("R2: a queued switch from a stale source cannot detach a device leased meanwhile", async () => {
    const set = deferred();
    const { controller, manager, leases, store, events } = leasingHarness({ devices: THREE_BOOTED, saved: { c: "A" } });
    await controller.open({ instanceId: "c", input: {} });
    const bindings = controller.getBindings();
    const write = bindings.set.bind(bindings);
    let gated = true;
    bindings.set = async (...args) => {
        if (gated) {
            gated = false;
            await set.promise;
        }
        return write(...args);
    };
    const toB = controller.switch({ instanceId: "c", fromDeviceId: "A", toDeviceId: "B" });
    const toC = controller.switch({ instanceId: "c", fromDeviceId: "A", toDeviceId: "C" });
    await tick();
    set.resolve();
    await toB;
    leases.add("B");
    await assert.rejects(toC, { code: "canvas_switch_stale" });
    assert.equal(manager.attached.get("c"), "B", "B stays attached");
    assert.equal(leases.has("B"), true, "the agent keeps B's lease");
    assert.equal(events.includes("detach:B"), false);
    assert.equal(store.get("c"), "B");
});

test("R2: a lease taken while the switch's binding write is pending aborts it and restores the binding", async () => {
    const set = deferred();
    const { controller, manager, leases, store } = leasingHarness({ devices: THREE_BOOTED, saved: { c: "A" } });
    await controller.open({ instanceId: "c", input: {} });
    const bindings = controller.getBindings();
    const write = bindings.set.bind(bindings);
    let gated = true;
    bindings.set = async (...args) => {
        if (gated) {
            gated = false;
            await set.promise;
        }
        return write(...args);
    };
    const switching = controller.switch({ instanceId: "c", fromDeviceId: "A", toDeviceId: "B" });
    await tick();
    leases.add("A");
    set.resolve();
    await assert.rejects(switching, { code: "device_leased" });
    assert.equal(manager.attached.get("c"), "A", "A stays attached under its lease");
    assert.equal(store.get("c"), "A", "binding restored");
});

test("R3: a failed touch-up retries through the retired connection before it closes", async (t) => {
    const pressures = [];
    const attempts = [];
    let failNextUp = false;
    const channels = [];
    const { pool } = fakePool({
        emulators: TWO_EMULATORS,
        connect: async () => {
            const channel = { closed: false, close() { this.closed = true; } };
            channels.push(channel);
            return {
                channel,
                tokens: { dispose() {} },
                controller: {
                    sendTouch: async ({ touches }) => {
                        attempts.push(touches[0].pressure);
                        if (channel.closed) {
                            throw new Error("channel closed");
                        }
                        if (touches[0].pressure === 0 && failNextUp) {
                            failNextUp = false;
                            throw grpcError(GRPC_STATUS.unavailable);
                        }
                        pressures.push(touches[0].pressure);
                    },
                },
            };
        },
    });
    const { registry } = screenServiceWith({ pool, createFrameStream: async () => ({}) });
    const input = new InputDispatcher({
        state: registry,
        ensureBooted: async () => {},
        screenSize: async () => ({ width: 1080, height: 1920 }),
        refreshScreenMetrics: async () => {},
        controlPool: pool,
    });
    t.after(() => pool.disposeAll());
    const touch = { deviceId: "avd:A", x: 0.5, y: 0.5 };
    await input.notifyTouch({ ...touch, phase: "down" });
    await pool.reportFailure("emulator-5554", grpcError(GRPC_STATUS.unavailable));
    assert.equal(channels[0].closed, false, "held for the gesture");
    failNextUp = true;
    await input.notifyTouch({ ...touch, phase: "up" });
    assert.deepEqual(attempts, [1, 0, 0], "the release was retried");
    assert.deepEqual(pressures, [1, 0], "the retry reached the transport");
    await tick();
    assert.equal(channels[0].closed, true, "closed once the gesture let go");
});

function gatedTokens() {
    const gate = deferred();
    const tokens = { disposed: false, async dispose() { await gate.promise; tokens.disposed = true; } };
    return { gate, tokens };
}

test("R5: disposeAll waits for the cleanup its settlement hook started", async () => {
    const { gate, tokens } = gatedTokens();
    const channel = { closed: false, close() { this.closed = true; } };
    const { pool } = fakePool({
        emulators: { s: { pid: 1, grpcPort: 1 } },
        connect: async () => ({ controller: {}, channel, tokens }),
    });
    assert.ok(await pool.get("s"));
    let settled = false;
    const disposing = pool.disposeAll().then(() => {
        settled = true;
    });
    await tick();
    assert.equal(channel.closed, true);
    assert.equal(settled, false, "disposeAll still waits for token disposal");
    gate.resolve();
    await disposing;
    assert.equal(tokens.disposed, true);
});

test("R5: overlapping closes share one cleanup, and disposeAll waits for a hold's close", async () => {
    const { gate, tokens } = gatedTokens();
    let disposals = 0;
    const dispose = tokens.dispose;
    tokens.dispose = async () => {
        disposals += 1;
        return dispose();
    };
    const channel = { closed: false, close() { this.closed = true; } };
    const { pool } = fakePool({
        emulators: { s: { pid: 1, grpcPort: 1 } },
        connect: async () => ({ controller: {}, channel, tokens }),
    });
    const connection = await pool.get("s");
    const releaseHold = pool.hold(connection.controller ?? connection);
    await pool.reportFailure("s", new Error("broken"));
    releaseHold();
    let settled = false;
    const disposing = pool.disposeAll().then(() => {
        settled = true;
    });
    const releasing = pool.release("s");
    await tick();
    assert.equal(settled, false, "disposeAll waits for the hold's in-progress close");
    gate.resolve();
    await Promise.all([disposing, releasing]);
    assert.equal(tokens.disposed, true);
    assert.equal(disposals, 1, "closed once");
});

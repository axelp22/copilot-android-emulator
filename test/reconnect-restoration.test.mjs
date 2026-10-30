/**
 * Reconnect and session restoration without real devices: emulator restarts
 * and unplugs are simulated by changing what discovery reports, gRPC by fake
 * connections, and time by an injected clock.
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { extensionModule, tempDir } from "./helpers.mjs";

const { EmulatorControlPool } = await extensionModule("lib", "emulator-control-pool.mjs");
const { CanvasBindingStore } = await extensionModule("lib", "canvas-binding-store.mjs");
const { DeviceRegistry } = await extensionModule("lib", "device-registry.mjs");
const { ScreenService, isConnectionFailure } = await extensionModule("lib", "screen-service.mjs");
const { KeyedLock, resolveCanvasDevice } = await extensionModule("lib", "canvas-open.mjs");
const { AppError } = await extensionModule("lib", "errors.mjs");
const { GRPC_STATUS } = await extensionModule("lib", "grpc-client.mjs");

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
    assert.deepEqual(result, { deviceId: "avd:Pixel", persist: true });
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

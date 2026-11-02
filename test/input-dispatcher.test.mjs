/**
 * Agent and keyboard input on a local emulator goes over its gRPC controller,
 * which acts in milliseconds where each `adb shell input` costs a device-side
 * process. adb stays the path for anything gRPC cannot express, and the switch
 * between them must never reorder input or replay something that already landed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionModule } from "./helpers.mjs";

const { InputDispatcher } = await extensionModule("lib", "input-dispatcher.mjs");
const { GRPC_STATUS } = await extensionModule("lib", "grpc-client.mjs");

const DEVICE = "avd:A";

function grpcError(status) {
    const error = new Error(`grpc status ${status}`);
    error.grpcStatus = status;
    return error;
}

/**
 * A dispatcher whose emulator controller and adb shell both record into one
 * log, so a test can assert on transport and on order together.
 */
function harness({ kind = "emulator", sendKey, sendTouch } = {}) {
    const log = [];
    const holds = { taken: 0, released: 0 };
    const controller = {
        sendKey:
            sendKey ??
            (async (event) => {
                log.push({ grpc: "key", event });
            }),
        sendTouch:
            sendTouch ??
            (async ({ touches }) => {
                const [{ x, y, pressure }] = touches;
                log.push({ grpc: "touch", x, y, pressure });
            }),
    };
    const pool = {
        gets: 0,
        async get() {
            pool.gets += 1;
            return { controller };
        },
        hold() {
            holds.taken += 1;
            let released = false;
            return () => {
                if (!released) {
                    released = true;
                    holds.released += 1;
                }
            };
        },
    };
    const device = {
        id: DEVICE,
        kind,
        serial: "emulator-5554",
        state: "Booted",
        screen: { width: 1000, height: 2000, source: "live" },
    };
    const input = new InputDispatcher({
        state: {
            getDeviceOrThrow: () => device,
            requireSerial: () => device.serial,
            updateScreenMetrics() {},
        },
        ensureBooted: async () => {},
        screenSize: async () => ({ width: device.screen.width, height: device.screen.height }),
        refreshScreenMetrics: async () => {},
        controlPool: pool,
    });
    input.shell = async (deviceId, command) => {
        log.push({ adb: command.join(" ") });
        return "";
    };
    return { input, log, pool, holds, controller };
}

test("emulator keys, buttons and text go over gRPC, never adb", async () => {
    const { input, log, holds } = harness();

    const results = [
        await input.sendKey({ deviceId: DEVICE, code: "Enter" }),
        await input.pressButton({ deviceId: DEVICE, button: "home" }),
        await input.pressButton(DEVICE, "volume_up"),
        await input.sendText({ deviceId: DEVICE, text: "it's a test" }),
    ];

    assert.deepEqual(
        results.map((result) => result.transport),
        ["grpc", "grpc", "grpc", "grpc"],
    );
    assert.deepEqual(log, [
        { grpc: "key", event: { eventType: 2, key: "Enter" } },
        { grpc: "key", event: { eventType: 2, key: "GoHome" } },
        { grpc: "key", event: { eventType: 2, key: "AudioVolumeUp" } },
        // Raw text: the `%s` and quoting are adb shell syntax, not something to type.
        { grpc: "key", event: { text: "it's a test" } },
    ]);
    assert.deepEqual(holds, { taken: 4, released: 4 }, "every action releases its hold on the connection");
});

test("keys with no gRPC name and text the emulator cannot type stay on adb", async () => {
    const { input, log, pool } = harness();

    await input.sendKey({ deviceId: DEVICE, code: "KeyA" });
    await input.pressButton({ deviceId: DEVICE, button: "menu" });
    await input.sendText({ deviceId: DEVICE, text: "héllo" });
    const long = await input.sendText({ deviceId: DEVICE, text: "a".repeat(257) });

    assert.equal(long.transport, "adb");
    assert.deepEqual(
        log.map((entry) => entry.adb?.split(" ").slice(0, 2).join(" ")),
        ["input keyevent", "input keyevent", "input text", "input text"],
    );
    assert.equal(log[0].adb, "input keyevent KEYCODE_A");
    assert.equal(log[1].adb, "input keyevent 82");
    assert.equal(pool.gets, 0, "no connection is opened for input gRPC cannot carry");
});

test("an agent tap is one press and release at the mapped pixel", async () => {
    const { input, log } = harness();

    const result = await input.tap({ deviceId: DEVICE, x: 0.25, y: 0.5 });

    assert.equal(result.transport, "grpc");
    assert.deepEqual(log, [
        { grpc: "touch", x: 250, y: 1000, pressure: 1 },
        { grpc: "touch", x: 250, y: 1000, pressure: 0 },
    ]);
});

test("an agent swipe moves through evenly spaced samples over its duration, then lifts", async () => {
    const { input, log } = harness();

    const startedAt = Date.now();
    const result = await input.swipe({
        deviceId: DEVICE,
        startX: 100,
        startY: 1000,
        endX: 900,
        endY: 1000,
        durationMs: 64,
        coordinateSpace: "point",
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(result.transport, "grpc");
    assert.deepEqual(
        log.map(({ x, pressure }) => [x, pressure]),
        [
            [100, 1],
            [300, 1],
            [500, 1],
            [700, 1],
            [900, 1],
            [900, 0],
        ],
    );
    assert.ok(elapsed >= 60, `the gesture takes its requested duration (${elapsed}ms)`);
});

test("input refused by the emulator is sent over adb, and adb is used during the backoff", async () => {
    let grpcCalls = 0;
    const { input, log } = harness({
        sendKey: async () => {
            grpcCalls += 1;
            throw grpcError(GRPC_STATUS.unimplemented);
        },
    });

    const first = await input.sendKey({ deviceId: DEVICE, code: "Enter" });
    const second = await input.sendKey({ deviceId: DEVICE, code: "Escape" });

    assert.deepEqual([first.transport, second.transport], ["adb", "adb"]);
    assert.deepEqual(log, [{ adb: "input keyevent 66" }, { adb: "input keyevent 111" }]);
    assert.equal(grpcCalls, 1, "the failed connection is not retried on every key");
});

test("a gRPC failure that may have delivered the input is reported, not replayed", async () => {
    const { input, log, holds } = harness({
        sendKey: async () => {
            throw grpcError(GRPC_STATUS.deadlineExceeded);
        },
    });

    await assert.rejects(input.sendText({ deviceId: DEVICE, text: "hello" }), /grpc status 4/);
    assert.deepEqual(log, [], "the text is not typed a second time over adb");
    assert.deepEqual(holds, { taken: 1, released: 1 });
});

test("a gesture that fails part-way lifts the finger and is not replayed over adb", async () => {
    let samples = 0;
    const { input, log } = harness({
        sendTouch: async ({ touches }) => {
            samples += 1;
            if (samples === 2) {
                throw grpcError(GRPC_STATUS.unavailable);
            }
            log.push({ grpc: "touch", pressure: touches[0].pressure });
        },
    });

    await assert.rejects(
        input.swipe({ deviceId: DEVICE, startX: 0, startY: 0, endX: 1, endY: 1, durationMs: 48 }),
        /grpc status 14/,
    );
    assert.deepEqual(log, [
        { grpc: "touch", pressure: 1 },
        { grpc: "touch", pressure: 0 },
    ]);
});

test("physical devices keep using adb without asking for a gRPC connection", async () => {
    const { input, log, pool } = harness({ kind: "physical" });

    const tap = await input.tap({ deviceId: DEVICE, x: 0.5, y: 0.5 });
    const key = await input.sendKey({ deviceId: DEVICE, code: "Enter" });

    assert.deepEqual([tap.transport, key.transport], ["adb", "adb"]);
    assert.deepEqual(log, [{ adb: "input tap 500 1000" }, { adb: "input keyevent 66" }]);
    assert.equal(pool.gets, 0);
});

test("input issued together reaches the device in order, whichever transport each takes", async () => {
    const { input, log } = harness();

    await Promise.all([
        input.sendText({ deviceId: DEVICE, text: "ab" }),
        input.sendKey({ deviceId: DEVICE, code: "KeyC" }),
        input.sendText({ deviceId: DEVICE, text: "d" }),
        input.pressButton({ deviceId: DEVICE, button: "camera" }),
    ]);

    assert.deepEqual(
        log.map((entry) => entry.adb ?? entry.event.text),
        ["ab", "input keyevent KEYCODE_C", "d", "input keyevent 27"],
    );
});

/**
 * The gRPC still-frame source. On an idle screen the last frame sent is what
 * stays on the canvas, so the newest frame must always arrive eventually --
 * whether it was held back by the FPS cap or by a slow reader.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionModule, sleep, waitUntil } from "./helpers.mjs";

const { createGrpcFrameStream } = await extensionModule("lib", "grpc-frame-stream.mjs");

function fakeController({ first = Buffer.from("seed"), streamOutcome } = {}) {
    const controller = {
        onImage: null,
        streams: 0,
        statusCalls: 0,
        getScreenshot: async () => ({ pixels: first }),
        streamScreenshot(format, { onImage, signal }) {
            controller.onImage = onImage;
            controller.streams += 1;
            if (streamOutcome) {
                return streamOutcome();
            }
            return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
        getStatus: async () => {
            controller.statusCalls += 1;
            return {};
        },
    };
    return controller;
}

/** Collects decoded frames from the stream as they are read. */
function collect(stdout) {
    const frames = [];
    let buffer = Buffer.alloc(0);
    stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 5) {
            const length = buffer.readUInt32BE(0);
            if (buffer.length < 4 + length) {
                break;
            }
            frames.push({ tag: buffer[4], payload: buffer.subarray(5, 4 + length).toString() });
            buffer = buffer.subarray(4 + length);
        }
    });
    return frames;
}

const image = (text) => ({ pixels: Buffer.from(text) });

test("the final frame of a burst arrives even when it lands inside the FPS interval", async (t) => {
    const controller = fakeController();
    const stream = await createGrpcFrameStream({ controller, size: { width: 10, height: 10 }, fps: 10 });
    t.after(() => stream.kill());
    const frames = collect(stream.stdout);

    await sleep(150);
    // Same millisecond, more than one interval after the seed: the first goes out
    // at once, and the second must follow rather than be dropped.
    controller.onImage(image("intermediate"));
    controller.onImage(image("final"));
    await waitUntil(() => frames.length === 3, { message: "the final frame", timeoutMs: 1_000 });
    await sleep(300);
    assert.deepEqual(frames.map((frame) => frame.payload), ["seed", "intermediate", "final"]);
});

test("frames inside one interval collapse to the newest, delivered at the deadline", async (t) => {
    const controller = fakeController();
    const stream = await createGrpcFrameStream({ controller, size: { width: 10, height: 10 }, fps: 10 });
    t.after(() => stream.kill());
    const frames = collect(stream.stdout);

    for (let index = 1; index <= 5; index += 1) {
        controller.onImage(image(`frame-${index}`));
    }
    await sleep(20);
    assert.deepEqual(frames.map((frame) => frame.payload), ["seed"], "the cap still holds");
    await waitUntil(() => frames.length === 2, { message: "the deadline flush", timeoutMs: 1_000 });
    await sleep(250);
    assert.deepEqual(frames.map((frame) => frame.payload), ["seed", "frame-5"]);
});

test("a slow reader gets the newest frame once it drains, not a backlog", async (t) => {
    const controller = fakeController();
    const stream = await createGrpcFrameStream({ controller, size: { width: 10, height: 10 }, fps: 0 });
    t.after(() => stream.kill());

    const big = (label) => ({ pixels: Buffer.concat([Buffer.from(label), Buffer.alloc(1_200_000)]) });
    controller.onImage(big("one"));
    controller.onImage(big("two")); // fills both sides of the 1MB stream buffer
    controller.onImage(big("three"));
    controller.onImage(big("four")); // supersedes "three" while the reader is stalled

    const frames = collect(stream.stdout);
    await waitUntil(() => frames.some((frame) => frame.payload.startsWith("four")), {
        message: "the newest frame after drain",
        timeoutMs: 2_000,
    });
    await sleep(50);
    const labels = frames.map((frame) => frame.payload.replace(/\0+$/, ""));
    // How many fit before the buffer filled depends on stream internals; what
    // matters is that the superseded frame never arrives and the newest does, last.
    assert.equal(labels[0], "seed");
    assert.equal(labels.at(-1), "four");
    assert.ok(!labels.includes("three"), labels.join(","));
});

test("nothing is emitted after the stream is killed, including a pending frame", async () => {
    const controller = fakeController();
    const stream = await createGrpcFrameStream({ controller, size: { width: 10, height: 10 }, fps: 10 });
    const frames = collect(stream.stdout);
    const exits = [];
    stream.on("exit", (code, signal) => exits.push([code, signal]));

    controller.onImage(image("pending"));
    stream.kill();
    controller.onImage(image("after-kill"));
    await sleep(250);
    assert.deepEqual(frames.map((frame) => frame.payload), ["seed"]);
    assert.deepEqual(exits, [[0, "SIGTERM"]]);
    assert.equal(stream.killed, true);
});

test("a stream that keeps failing gives up with an error and drops its pending frame", async () => {
    let runs = 0;
    const controller = fakeController({
        streamOutcome: () => {
            runs += 1;
            if (runs === 1) {
                // Held back by the 2s FPS interval; the stream fails before it elapses.
                controller.onImage(image("pending"));
            }
            return Promise.reject(new Error("display reconfigured"));
        },
    });
    const stream = await createGrpcFrameStream({ controller, size: { width: 10, height: 10 }, fps: 0.5 });
    const frames = collect(stream.stdout);
    const errors = [];
    stream.on("error", (error) => errors.push(error));

    await waitUntil(() => errors.length === 1, { message: "the stream to give up", timeoutMs: 5_000 });
    assert.equal(controller.streams, 4, "restarted up to the limit before failing");
    assert.match(errors[0].message, /display reconfigured/);
    assert.equal(stream.killed, true);
    await sleep(1_200);
    assert.deepEqual(frames.map((frame) => frame.payload), ["seed"], "no frame after failure");
});

test("frames keep a flapping stream counted as healthy", async (t) => {
    let runs = 0;
    const controller = fakeController({
        streamOutcome: () => {
            runs += 1;
            // Each run delivers a frame before ending, so it is not flapping.
            queueMicrotask(() => controller.onImage(image(`run-${runs}`)));
            return new Promise((_, reject) => setTimeout(() => reject(new Error("ended")), 20));
        },
    });
    const stream = await createGrpcFrameStream({ controller, size: { width: 10, height: 10 }, fps: 0 });
    t.after(() => stream.kill());
    const errors = [];
    stream.on("error", (error) => errors.push(error));
    await waitUntil(() => runs >= 6, { message: "several restarts", timeoutMs: 5_000 });
    assert.equal(errors.length, 0);
});

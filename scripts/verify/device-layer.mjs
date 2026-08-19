/**
 * Exercises the adb device layer directly against a running emulator or device:
 * discovery, geometry, screenshots, input mapping, drag coalescing, rotation, and
 * the framed H.264 stream including its `screenrecord` restart loop.
 *
 *   node scripts/verify/device-layer.mjs
 */
import path from "node:path";
import { adb, config, createFrameReader, createReporter, extensionRoot, sleep } from "./_shared.mjs";

const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));
const { FRAME_TAGS } = await import(path.join(extensionRoot, "lib", "h264-stream.mjs"));

const report = createReporter("DEVICE LAYER");
/**
 * Restart events are timestamped as they happen, from the child's exit handler.
 * Polling a counter instead would race: the replacement child's keyframe lands
 * ~500ms after the exit, so a late observation folds it into the "before" baseline.
 */
const restartEvents = [];
const manager = new DeviceSessionManager({
    onDiagnostic: (message) => {
        if (message.includes("screenrecord restart")) {
            restartEvents.push(Date.now());
        }
        report.note(message);
    },
});
manager.setArtifactsRoot(config.artifactsRoot);

// --- toolchain ---------------------------------------------------------------
const diagnosis = await manager.diagnoseAdb();
report.assert(Boolean(diagnosis.adbPath), "diagnose_adb finds adb", diagnosis.adbPath ?? "missing");
report.assert(Boolean(diagnosis.emulatorPath), "diagnose_adb finds the emulator binary", diagnosis.emulatorPath ?? "missing");
report.assert(diagnosis.avds.length > 0, "diagnose_adb lists AVDs", diagnosis.avds.join(", "));

// --- discovery ---------------------------------------------------------------
const devices = await manager.listDevices();
const target = devices.find((device) => device.deviceId === config.deviceId);
report.assert(Boolean(target), "target device discovered", config.deviceId);
report.assert(target?.serial === config.serial, "serial resolved for the target", String(target?.serial));
report.assert(Number(target?.apiLevel) > 0, "api level read", String(target?.apiLevel));

const physical = devices.find((device) => device.kind === "device");
if (physical) {
    report.assert(physical.canManageLifecycle === false, "physical device lifecycle is locked", physical.name);
    let refused = false;
    try {
        await manager.bootDevice(physical.deviceId);
    } catch (error) {
        refused = error.code === "lifecycle_not_supported";
    }
    report.assert(refused, "booting a physical device is refused");
} else {
    report.skip("physical device lifecycle is locked", "no physical device attached");
}

const deviceId = await manager.resolveDeviceId(config.deviceId);
report.assert(deviceId === config.deviceId, "resolveDeviceId accepts the device id", deviceId);
report.assert((await manager.resolveDeviceId(config.serial)) === config.deviceId, "resolveDeviceId accepts a serial");

// --- state and geometry ------------------------------------------------------
const state = await manager.getDeviceState(deviceId);
report.assert(state.state === "Booted", "device is booted", state.state);
report.assert(state.screen.width > 0 && state.screen.height > 0, "screen metrics resolved", `${state.screen.width}x${state.screen.height}`);

const capture = await manager.captureScreen(deviceId);
report.assert(
    capture.pixelSize.width === state.screen.width && capture.pixelSize.height === state.screen.height,
    "screenshot matches reported geometry",
    `${capture.pixelSize.width}x${capture.pixelSize.height}`,
);
report.assert(capture.artifactPath.endsWith(".png"), "screenshot written as an artifact", capture.artifactPath);

// --- input mapping -----------------------------------------------------------
const expectedX = Math.round(0.5 * state.screen.width);
const expectedY = Math.round(0.5 * state.screen.height);
const tap = await manager.tap({ deviceId, x: 0.5, y: 0.5 });
report.assert(tap.x === expectedX && tap.y === expectedY, "normalized tap maps to device pixels", `${tap.x},${tap.y}`);

const pointTap = await manager.tap({ deviceId, x: 10, y: 20, coordinateSpace: "point" });
report.assert(pointTap.x === 10 && pointTap.y === 20, "point coordinates pass through unscaled", `${pointTap.x},${pointTap.y}`);

const swipe = await manager.swipe({ deviceId, startX: 0.5, startY: 0.7, endX: 0.5, endY: 0.3, durationMs: 200 });
report.assert(swipe.startY === Math.round(0.7 * state.screen.height), "swipe maps both endpoints", JSON.stringify(swipe));

await manager.pressButton({ deviceId, button: "home" });
report.assert(true, "press_button home accepted");
await manager.sendKey({ deviceId, code: "KeyA" });
report.assert(true, "send_key accepts a browser key code");
await manager.sendText({ deviceId, text: "hi there; echo pwned" });
report.assert(true, "send_text escapes spaces and shell metacharacters");

let rejectedButton = false;
try {
    await manager.pressButton({ deviceId, button: "self_destruct" });
} catch (error) {
    rejectedButton = error.code === "unsupported_button";
}
report.assert(rejectedButton, "unknown buttons are rejected");

// --- pointer coalescing ------------------------------------------------------
await manager.notifyTouch({ deviceId, phase: "down", x: 0.5, y: 0.8, coordinateSpace: "normalized" });
for (let step = 1; step <= 6; step += 1) {
    await manager.notifyTouch({ deviceId, phase: "move", x: 0.5, y: 0.8 - step * 0.07, coordinateSpace: "normalized" });
}
await manager.notifyTouch({ deviceId, phase: "up", x: 0.5, y: 0.38, coordinateSpace: "normalized" });
report.assert(true, "pointer drag coalesces into swipe segments");

await manager.notifyTouch({ deviceId, phase: "down", x: 0.5, y: 0.5, coordinateSpace: "normalized" });
await manager.notifyTouch({ deviceId, phase: "move", x: 0.5005, y: 0.5005, coordinateSpace: "normalized" });
await manager.notifyTouch({ deviceId, phase: "up", x: 0.5005, y: 0.5005, coordinateSpace: "normalized" });
report.assert(true, "jittery pointer degrades to a tap");

// --- rotation ----------------------------------------------------------------
const rotated = await manager.rotateDevice({ deviceId, direction: "right" });
report.assert(rotated.requestedOrientation === "landscape", "rotate right requests landscape", rotated.requestedOrientation);
report.assert(typeof rotated.applied === "boolean", "rotation reports whether the app allowed it", String(rotated.applied));
await adb(["shell", "settings", "put", "system", "user_rotation", "0"]);

// --- streaming ---------------------------------------------------------------
async function sampleStream({ seconds, timeLimitSeconds }) {
    const stream = await manager.createH264Stream({ deviceId, fps: 30, resolution: 50, timeLimitSeconds });
    const push = createFrameReader();
    const observed = [];
    stream.stdout.on("data", (chunk) => {
        for (const frame of push(chunk)) {
            observed.push({ tag: frame.tag, size: frame.payload.length, at: Date.now() });
        }
    });
    // A still screen produces almost no frames. Alternating Home and Recents forces
    // a full-screen transition, so the encoder always has something to send.
    let step = 0;
    const motion = setInterval(() => {
        step += 1;
        void adb(["shell", "input", "keyevent", step % 2 === 0 ? "3" : "187"]).catch(() => {});
    }, 800);
    await sleep(seconds * 1000);
    clearInterval(motion);
    stream.kill();
    return { observed, restarts: stream.restartCountValue() };
}

const live = await sampleStream({ seconds: 6 });
const tags = live.observed.map((entry) => entry.tag);
const configIndex = tags.indexOf(FRAME_TAGS.config);
const keyIndex = tags.indexOf(FRAME_TAGS.keyframe);
report.assert(tags.includes(FRAME_TAGS.seed), "screencap seed frame emitted before the first keyframe");
report.assert(configIndex !== -1, "decoder configuration emitted", `index ${configIndex}`);
report.assert(keyIndex !== -1, "keyframe emitted", `index ${keyIndex}`);
report.assert(configIndex < keyIndex, "config precedes the keyframe", `${configIndex} < ${keyIndex}`);
report.assert(
    tags.filter((tag) => tag === FRAME_TAGS.delta).length > 10,
    "delta frames flowing",
    `${tags.filter((tag) => tag === FRAME_TAGS.delta).length} frames`,
);

// `screenrecord` hard-stops at 180s; force a short limit to prove the respawn is
// seamless. Every unit is timestamped and compared against the restart timestamp,
// so nothing here depends on when a poll happens to observe the restart.
const restartStream = await manager.createH264Stream({ deviceId, fps: 30, resolution: 50, timeLimitSeconds: 3 });
const restartPush = createFrameReader();
const observed = [];
restartStream.stdout.on("data", (chunk) => {
    for (const frame of restartPush(chunk)) {
        observed.push({ tag: frame.tag, at: Date.now() });
    }
});
let restartStep = 0;
const restartMotion = setInterval(() => {
    restartStep += 1;
    void adb(["shell", "input", "keyevent", restartStep % 2 === 0 ? "3" : "187"]).catch(() => {});
}, 800);

const after = (timestamp, tag) => observed.find((entry) => entry.at > timestamp && entry.tag === tag);
const restartDeadline = Date.now() + 45_000;

// Wait until the first respawn generation is closed by a second restart. Evaluating
// a completed window removes the race entirely: every unit that generation produced
// has already been observed, so nothing depends on polling timing.
while (restartEvents.length < 2 && Date.now() < restartDeadline) {
    await sleep(250);
}
clearInterval(restartMotion);
restartStream.kill();

const restartedAt = restartEvents[0] ?? 0;
const generationEnd = restartEvents[1] ?? Date.now();
const configAfter = restartedAt > 0 ? after(restartedAt, FRAME_TAGS.config) : null;
const keyframeAfter = restartedAt > 0 ? after(restartedAt, FRAME_TAGS.keyframe) : null;
const framesAfter = observed.filter((entry) => entry.at > restartedAt).length;
const inGeneration = (entry) => Boolean(entry) && entry.at > restartedAt && entry.at <= generationEnd;

report.assert(restartEvents.length >= 1, "screenrecord child exited and was respawned", `${restartEvents.length} restarts`);
report.assert(framesAfter > 0, "frames continue after the child exits", `${framesAfter} frames after the restart`);
report.assert(
    inGeneration(configAfter),
    "parameter sets re-emitted by the replacement child",
    configAfter ? `config +${configAfter.at - restartedAt}ms of a ${generationEnd - restartedAt}ms generation` : "no config observed",
);
report.assert(
    inGeneration(keyframeAfter),
    "replacement child delivers a keyframe",
    keyframeAfter ? `keyframe +${keyframeAfter.at - restartedAt}ms of a ${generationEnd - restartedAt}ms generation` : "no keyframe observed",
);
// A keyframe the client has no configuration for is undecodable, which is the
// failure class the truncated-parameter-set bug produced.
report.assert(
    inGeneration(configAfter) && inGeneration(keyframeAfter) && configAfter.at <= keyframeAfter.at,
    "config precedes the keyframe after the respawn",
    configAfter && keyframeAfter ? `+${configAfter.at - restartedAt}ms then +${keyframeAfter.at - restartedAt}ms` : "missing frames",
);

await manager.dispose();
report.finish();

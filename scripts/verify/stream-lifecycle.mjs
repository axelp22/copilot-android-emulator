/**
 * Repeatedly starting and stopping streams must not leave orphaned device-side
 * `screenrecord` processes behind. Killing the local adb process does not reliably
 * stop the one on the device, and each orphan holds an encoder slot: enough of them
 * wedge the device, after which every stream silently returns no video at all.
 *
 *   node scripts/verify/stream-lifecycle.mjs
 */
import path from "node:path";
import { adb, config, createReporter, extensionRoot, sleep } from "./_shared.mjs";

const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));

const report = createReporter("STREAM LIFECYCLE");
const manager = new DeviceSessionManager({ onDiagnostic: (message) => report.note(message) });
manager.setArtifactsRoot(config.artifactsRoot);

/** Counts real recorder processes, not the wrapper shell whose args mention one. */
async function recorderCount() {
    const output = await adb(["shell", "ps", "-A"], {}).catch(() => "");
    return output
        .split("\n")
        .filter((line) => line.trim().split(/\s+/).at(-1) === "screenrecord").length;
}

const deviceId = await manager.resolveDeviceId(config.deviceId);
await manager.getDeviceState(deviceId);

const before = await recorderCount();
report.note(`device-side recorders at start: ${before}`);

let cyclesWithVideo = 0;
// `screenrecord` only encodes when the screen changes, so keep the display busy or
// a healthy stream would look indistinguishable from a wedged one.
let motionStep = 0;
const motion = setInterval(() => {
    motionStep += 1;
    void adb(["shell", "input", "keyevent", motionStep % 2 === 0 ? "3" : "187"]).catch(() => {});
}, 700);

for (let cycle = 1; cycle <= 5; cycle += 1) {
    const stream = await manager.createH264Stream({ deviceId, fps: 30, resolution: 25 });
    let bytes = 0;
    stream.stdout.on("data", (chunk) => {
        bytes += chunk.length;
    });
    await sleep(2500);
    stream.kill();
    // Teardown signals the device-side recorder asynchronously.
    await stream.whenReaped();
    await sleep(500);
    if (bytes > 0) {
        cyclesWithVideo += 1;
    }
    report.note(`cycle ${cycle}: ${bytes} bytes, recorders now ${await recorderCount()}`);
}

clearInterval(motion);
await sleep(1500);
const after = await recorderCount();
report.assert(cyclesWithVideo === 5, "every start/stop cycle produced video", `${cyclesWithVideo}/5`);
report.assert(after <= before, "no device-side recorders leaked", `${before} -> ${after}`);

// A wedged encoder exits cleanly having written nothing, so prove video still flows.
const finalStream = await manager.createH264Stream({ deviceId, fps: 30, resolution: 25 });
let finalBytes = 0;
finalStream.stdout.on("data", (chunk) => {
    finalBytes += chunk.length;
});
let finalStep = 0;
const finalMotion = setInterval(() => {
    finalStep += 1;
    void adb(["shell", "input", "keyevent", finalStep % 2 === 0 ? "3" : "187"]).catch(() => {});
}, 700);
await sleep(3000);
clearInterval(finalMotion);
finalStream.kill();
await finalStream.whenReaped();
report.assert(finalBytes > 0, "encoder still healthy after repeated cycles", `${finalBytes} bytes`);

await manager.dispose();
report.finish();

/**
 * Stopping an MP4 recording must not disturb the live canvas video. Both use
 * `screenrecord`, so signalling by process name would stop the canvas stream —
 * and any other recording on the same device — as well as the intended one.
 *
 *   node scripts/verify/recording-coexistence.mjs
 */
import path from "node:path";
import { adb, config, createReporter, extensionRoot, sleep } from "./_shared.mjs";

const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));

const report = createReporter("RECORDING COEXISTENCE");
const manager = new DeviceSessionManager({ onDiagnostic: (message) => report.note(message) });
manager.setArtifactsRoot(config.artifactsRoot);

const deviceId = await manager.resolveDeviceId(config.deviceId);
await manager.getDeviceState(deviceId);

const stream = await manager.createH264Stream({ deviceId, fps: 30, resolution: 25 });
let chunks = 0;
stream.stdout.on("data", () => {
    chunks += 1;
});

await sleep(2500);
const chunksBefore = chunks;
const restartsBefore = stream.restartCountValue();
report.assert(chunksBefore > 0, "live stream is running before the recording starts", `${chunksBefore} chunks`);

const lease = await manager.acquireLease({
    deviceId,
    reason: "recording coexistence check",
    ownerInstanceId: "verify-coexistence",
    ttlSeconds: 120,
});
const recording = await manager.startVideoRecording({
    deviceId,
    leaseId: lease.lease.leaseId,
    maxDurationSeconds: 20,
});
// `screenrecord` only encodes when the screen changes, so a recording of a still
// screen can legitimately contain nothing. Keep the display busy.
let step = 0;
const motion = setInterval(() => {
    step += 1;
    void adb(["shell", "input", "keyevent", step % 2 === 0 ? "3" : "187"]).catch(() => {});
}, 800);
await sleep(6000);
clearInterval(motion);

const metadata = await manager.stopVideoRecording({
    deviceId,
    leaseId: lease.lease.leaseId,
    recordingId: recording.recordingId,
});
await sleep(2500);

report.assert(metadata.byteSize > 0, "recording finalized with content", `${metadata.byteSize} bytes`);
report.assert(
    stream.restartCountValue() === restartsBefore,
    "stopping the recording left the live stream's child alone",
    `${restartsBefore} -> ${stream.restartCountValue()} restarts`,
);
report.assert(chunks > chunksBefore, "live stream kept flowing across the recording", `${chunksBefore} -> ${chunks} chunks`);

stream.kill();
await manager.releaseLease({ deviceId, leaseId: lease.lease.leaseId });
await manager.dispose();
report.finish();

/**
 * Proves the framed stream is genuinely decodable, not merely well-shaped: the
 * AVCC samples are rebuilt into an Annex-B elementary stream and handed to ffprobe.
 * Also checks that the encoder clamp preserves the device aspect ratio.
 *
 *   node scripts/verify/stream-decode.mjs
 */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { adb, avccToAnnexB, config, createFrameReader, createReporter, extensionRoot, sleep } from "./_shared.mjs";

const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));
const { streamSizeFor } = await import(path.join(extensionRoot, "lib", "device-model.mjs"));

const report = createReporter("STREAM DECODE");
const manager = new DeviceSessionManager({ onDiagnostic: (message) => report.note(message) });
manager.setArtifactsRoot(config.artifactsRoot);

const deviceId = await manager.resolveDeviceId(config.deviceId);
const state = await manager.getDeviceState(deviceId);
const deviceAspect = state.screen.width / state.screen.height;

// The clamp must scale both axes together or tall phones come out squashed.
for (const resolution of [100, 50, 25]) {
    const size = streamSizeFor(state.screen, resolution);
    const aspect = size.width / size.height;
    report.assert(
        Math.abs(aspect - deviceAspect) < 0.005,
        `${resolution}% stream keeps the device aspect ratio`,
        `${size.width}x${size.height} (${aspect.toFixed(4)} vs ${deviceAspect.toFixed(4)})`,
    );
    report.assert(size.width % 2 === 0 && size.height % 2 === 0, `${resolution}% stream uses even dimensions`);
}

const expected = streamSizeFor(state.screen, 50);
const stream = await manager.createH264Stream({ deviceId, fps: 30, resolution: 50 });
const push = createFrameReader();
const samples = [];
let configFrame = null;
let seedFrame = null;

stream.stdout.on("data", (chunk) => {
    for (const frame of push(chunk)) {
        if (frame.tag === 0x01) configFrame = frame.payload;
        else if (frame.tag === 0x04) seedFrame = frame.payload;
        else if (frame.tag === 0x02 || frame.tag === 0x03) samples.push(frame.payload);
    }
});

const motion = setInterval(() => {
    void adb([
        "shell",
        "input",
        "swipe",
        String(Math.round(state.screen.width / 2)),
        String(Math.round(state.screen.height * 0.75)),
        String(Math.round(state.screen.width / 2)),
        String(Math.round(state.screen.height * 0.3)),
        "200",
    ]).catch(() => {});
}, 800);
await sleep(6000);
clearInterval(motion);
stream.kill();

report.assert(Boolean(seedFrame) && seedFrame[0] === 0x89, "seed frame is a PNG", `${seedFrame?.length ?? 0} bytes`);
report.assert(Boolean(configFrame), "avcC configuration received");
report.assert(configFrame?.[0] === 0x01, "avcC configurationVersion is 1");
report.assert((configFrame?.[4] & 0x03) === 3, "avcC declares 4-byte NAL lengths");

const codec = `avc1.${[configFrame[1], configFrame[2], configFrame[3]].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
report.assert(/^avc1\.[0-9a-f]{6}$/.test(codec), "WebCodecs codec string derived from avcC", codec);

const elementary = Buffer.concat(samples.map(avccToAnnexB));
const streamPath = path.join("/tmp", "android-emulator-verify-stream.h264");
await writeFile(streamPath, elementary);

const probeJson = await new Promise((resolve) => {
    execFile(
        "ffprobe",
        ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "json", streamPath],
        (error, stdout) => resolve(error ? "" : stdout),
    );
});
if (!probeJson) {
    report.skip("ffprobe decodes the stream", "ffprobe is not installed");
} else {
    const probed = JSON.parse(probeJson)?.streams?.[0] ?? {};
    report.assert(probed.codec_name === "h264", "ffprobe decodes the stream as H.264", String(probed.codec_name));
    report.assert(
        Number(probed.width) === expected.width && Number(probed.height) === expected.height,
        "decoded resolution matches the request",
        `${probed.width}x${probed.height} (expected ${expected.width}x${expected.height})`,
    );
    report.assert(Number(probed.nb_read_frames) > 20, "ffprobe fully decoded the frames", `${probed.nb_read_frames} frames`);
}

await manager.dispose();
report.finish();

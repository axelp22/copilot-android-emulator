/**
 * Exercises the emulator gRPC transport: protobuf codec, discovery, JWT
 * handshake, and the frame source, plus the fallback to H.264 mirroring.
 *
 *   node scripts/verify/grpc-stream.mjs
 */
import path from "node:path";
import { config, createFrameReader, createReporter, extensionRoot, sleep } from "./_shared.mjs";

const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));
const { FRAME_TAGS } = await import(path.join(extensionRoot, "lib", "h264-stream.mjs"));
const { Writer, decodeFields, readMessage } = await import(path.join(extensionRoot, "lib", "protobuf.mjs"));
const { createGrpcMessageParser, encodeGrpcMessage } = await import(path.join(extensionRoot, "lib", "grpc-client.mjs"));
const { decodeImage, encodeImageFormat, encodeTouchEvent, IMG_FORMAT } = await import(
    path.join(extensionRoot, "lib", "emulator-controller.mjs")
);
const { findEmulatorBySerial, listRunningEmulators, parseDiscoveryIni } = await import(
    path.join(extensionRoot, "lib", "emulator-discovery.mjs")
);
const { issuerForEmulator } = await import(path.join(extensionRoot, "lib", "emulator-access.mjs"));
const { signEmulatorJwt } = await import(path.join(extensionRoot, "lib", "emulator-jwt.mjs"));

const report = createReporter("GRPC STREAM");

// --- protobuf codec (no device required) -------------------------------------
{
    const encoded = new Writer().varint(1, 2).varint(3, 336).varint(4, 748).finish();
    const fields = decodeFields(encoded, { 1: "format", 3: "width", 4: "height" });
    report.assert(
        fields.format === 2 && fields.width === 336 && fields.height === 748,
        "protobuf varint round-trip",
        JSON.stringify(fields),
    );

    // Proto3 default elision: a zero must not appear on the wire.
    report.assert(new Writer().varint(5, 0).finish().length === 0, "protobuf omits proto3 defaults");

    // ImageFormat.width is field 3; encoding it as field 2 silently disables scaling.
    const imageFormat = encodeImageFormat({ format: IMG_FORMAT.rgb888, width: 336, height: 748 });
    const seen = [];
    readMessage(imageFormat, (fieldNo) => seen.push(fieldNo));
    report.assert(seen.includes(3) && seen.includes(4) && !seen.includes(2), "ImageFormat uses fields 3/4 for size", seen.join(","));

    // A 64-bit timestamp must survive as an exact integer.
    const big = new Writer().varint(6, 1787188510221154n).finish();
    report.assert(decodeFields(big, { 6: "ts" }).ts === 1787188510221154, "protobuf decodes 64-bit timestamps");

    const touch = encodeTouchEvent({ touches: [{ x: 10, y: 20, identifier: 0, pressure: 0 }], display: 0 });
    report.assert(touch.length > 0, "TouchEvent encodes a release (pressure 0)", `${touch.length} bytes`);

    // Every field of a release at the origin is a proto3 default, so the nested
    // Touch encodes to an empty body. Eliding it would send a TouchEvent with no
    // touches at all, and the emulator would hold the slot for 120 seconds.
    const originRelease = encodeTouchEvent({ touches: [{ x: 0, y: 0, identifier: 0, pressure: 0 }], display: 0 });
    const originTouches = [];
    readMessage(originRelease, (fieldNo, value) => {
        if (fieldNo === 1) {
            originTouches.push(value);
        }
    });
    report.assert(
        originTouches.length === 1 && originTouches[0].length === 0,
        "release at (0,0) still carries one (empty) Touch",
        originRelease.toString("hex") || "(empty)",
    );

    const image = decodeImage(new Writer().message(1, new Writer().varint(1, 0).varint(3, 336).varint(4, 748)).bytes(4, Buffer.from("png")).varint(5, 7).finish());
    report.assert(
        image.format.width === 336 && image.format.height === 748 && image.seq === 7 && image.pixels.toString() === "png",
        "Image decodes nested format, payload and sequence",
    );
}

// --- gRPC framing -------------------------------------------------------------
{
    const messages = [];
    const parse = createGrpcMessageParser((message) => messages.push(message));
    const wire = Buffer.concat([encodeGrpcMessage(Buffer.from("alpha")), encodeGrpcMessage(Buffer.from("beta"))]);
    // Feed one byte at a time: real frames always straddle DATA boundaries.
    for (const byte of wire) {
        parse(Buffer.from([byte]));
    }
    report.assert(
        messages.length === 2 && messages[0].toString() === "alpha" && messages[1].toString() === "beta",
        "gRPC parser reassembles split messages",
        messages.map(String).join(","),
    );
}

// --- discovery ----------------------------------------------------------------
{
    const parsed = parseDiscoveryIni('grpc.port=8554\ncmdline="a" "-b=c"\navd.name=Pixel 10\n');
    report.assert(parsed["grpc.port"] === "8554", "discovery ini parses simple keys");
    report.assert(parsed.cmdline === '"a" "-b=c"', "discovery ini keeps '=' inside cmdline", parsed.cmdline);

    report.assert(
        issuerForEmulator({ cmdline: "emulator -avd X" }) === "android-studio",
        "foreign emulators use the android-studio issuer",
    );
    report.assert(
        issuerForEmulator({ cmdline: `emulator -grpc-allowlist ${path.join(extensionRoot, "assets", "emulator-access.json")}` }) ===
            "copilot-android-emulator",
        "self-launched emulators use the extension's own issuer",
    );
}

// --- JWT ----------------------------------------------------------------------
{
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const { token } = signEmulatorJwt({ privateKey, kid: "k1", issuer: "android-studio" });
    const [header, payload, signature] = token.split(".");
    const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString());
    const decodedPayload = JSON.parse(Buffer.from(payload, "base64url").toString());
    // The emulator rejects a token whose header carries `typ`.
    report.assert(decodedHeader.typ === undefined, "JWT header omits typ");
    report.assert(decodedHeader.alg === "ES256" && decodedHeader.kid === "k1", "JWT header carries alg and kid");
    report.assert(decodedPayload.iss === "android-studio", "JWT carries the requested issuer");
    report.assert(decodedPayload.iat < decodedPayload.exp, "JWT is valid at issue time");
    // ES256 must be raw r||s, not DER; DER would be variable length and ~70 bytes.
    report.assert(Buffer.from(signature, "base64url").length === 64, "JWT signature is raw P-1363", `${Buffer.from(signature, "base64url").length} bytes`);
}

// --- live emulator ------------------------------------------------------------
const running = await listRunningEmulators();
report.note(`discovered ${running.length} running emulator(s): ${running.map((r) => `${r.serial}@${r.grpcPort}`).join(", ")}`);

const manager = new DeviceSessionManager({ onDiagnostic: (message) => report.note(message) });
manager.setArtifactsRoot(config.artifactsRoot);
await manager.listDevices();

const emulator = await findEmulatorBySerial(config.serial);
if (!emulator) {
    report.skip("live gRPC checks", `no discovery record for ${config.serial}`);
    report.finish();
}

report.assert(Boolean(emulator.grpcPort), "discovery resolves a gRPC port", String(emulator.grpcPort));
report.assert(emulator.serial === config.serial, "discovery maps console port to adb serial", emulator.serial);
report.assert(Number.isInteger(emulator.pid) && emulator.pid > 0, "discovery records the emulator pid", String(emulator.pid));

/** Collects framed output until `count` frames arrive or the timeout elapses. */
async function collectFrames(stream, { count, timeoutMs }) {
    const read = createFrameReader();
    const frames = [];
    const onData = (chunk) => frames.push(...read(chunk));
    stream.stdout.on("data", onData);
    const deadline = Date.now() + timeoutMs;
    while (frames.length < count && Date.now() < deadline) {
        await sleep(50);
    }
    stream.stdout.off("data", onData);
    return frames;
}

// gRPC transport, explicitly requested so a silent fallback cannot mask a failure.
{
    const stream = await manager.createVideoStream({
        deviceId: config.deviceId,
        fps: 30,
        resolution: 50,
        transport: "grpc",
    });
    try {
        const frames = await collectFrames(stream, { count: 5, timeoutMs: 8_000 });
        report.assert(frames.length >= 1, "gRPC stream emits an immediate first frame", `${frames.length} frames`);
        report.assert(
            frames.every((frame) => frame.tag === FRAME_TAGS.seed),
            "gRPC stream emits only PNG seed frames",
            [...new Set(frames.map((f) => f.tag))].join(","),
        );
        report.assert(
            frames.every((frame) => frame.payload.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))),
            "gRPC frames carry PNG payloads",
        );
        report.assert(stream.restartCountValue() === 0, "gRPC stream runs without restarts", String(stream.restartCountValue()));
        // The transport must be visible in state: an emulator that quietly fell
        // back to mirroring looks exactly like one that is simply slow.
        const grpcState = await manager.getDeviceState(config.deviceId);
        report.assert(grpcState.stream.transport === "grpc", "state records the gRPC transport", JSON.stringify(grpcState.stream));
    } finally {
        stream.kill();
    }
}

// Forcing the mirror must still yield a decodable H.264 stream.
{
    const stream = await manager.createVideoStream({
        deviceId: config.deviceId,
        fps: 30,
        resolution: 25,
        transport: "mirror",
    });
    try {
        const frames = await collectFrames(stream, { count: 3, timeoutMs: 15_000 });
        report.assert(
            frames.some((frame) => frame.tag === FRAME_TAGS.config || frame.tag === FRAME_TAGS.keyframe),
            "mirror transport still produces H.264 config/keyframes",
            [...new Set(frames.map((f) => f.tag))].join(","),
        );
        const mirrorState = await manager.getDeviceState(config.deviceId);
        report.assert(mirrorState.stream.transport === "mirror", "state records the mirror transport", JSON.stringify(mirrorState.stream));
    } finally {
        stream.kill();
    }
}

// A cached connection must not outlive the emulator process it points at: adb
// reuses a serial when an AVD restarts, but the pid and gRPC port change.
{
    const pool = manager.controlPool;
    const before = await pool.get(config.serial);
    report.assert(Boolean(before?.controller), "pool opens a connection", before ? `pid ${before.pid}` : "none");
    await pool.invalidateIfReplaced(config.serial);
    const after = await pool.get(config.serial);
    report.assert(after === before, "unchanged emulator keeps its pooled connection");

    // Simulate a replacement by corrupting the recorded identity.
    const entry = await pool.entries.get(config.serial);
    entry.pid = -1;
    await pool.invalidateIfReplaced(config.serial);
    const replaced = await pool.get(config.serial);
    report.assert(
        Boolean(replaced?.controller) && replaced !== before,
        "replaced emulator gets a fresh connection",
        replaced ? `pid ${replaced.pid}` : "none",
    );
}

// A physical device has no gRPC endpoint, so auto-selection must mirror.
{
    const devices = await manager.listDevices();
    const physical = devices.find((device) => device.kind === "device");
    if (!physical) {
        report.skip("physical devices mirror", "no physical device attached");
    } else {
        const stream = await manager.createVideoStream({ deviceId: physical.deviceId, fps: 30, resolution: 25 });
        try {
            const frames = await collectFrames(stream, { count: 3, timeoutMs: 15_000 });
            report.assert(
                frames.some((frame) => frame.tag !== FRAME_TAGS.seed),
                "physical device auto-selects the H.264 mirror",
            );
        } finally {
            stream.kill();
        }
    }
}

// Pointer input must travel over gRPC for an emulator, giving a true
// down/move/up gesture rather than chained adb swipes.
{
    const down = await manager.notifyTouch({ deviceId: config.deviceId, phase: "down", x: 0.5, y: 0.6 });
    report.assert(down.transport === "grpc", "touch down uses the gRPC transport", JSON.stringify(down));

    const move = await manager.notifyTouch({ deviceId: config.deviceId, phase: "move", x: 0.5, y: 0.35 });
    report.assert(move.transport === "grpc", "touch move uses the gRPC transport", JSON.stringify(move));
    report.assert(
        move.coalesced === undefined,
        "gRPC moves bypass the adb tap-slop coalescing",
        JSON.stringify(move),
    );

    const up = await manager.notifyTouch({ deviceId: config.deviceId, phase: "up", x: 0.5, y: 0.35 });
    report.assert(up.transport === "grpc", "touch up uses the gRPC transport", JSON.stringify(up));
    report.assert(manager.input.touchSession(config.deviceId) === null, "gRPC gesture releases its touch slot");

    // A cancel must also lift: the emulator holds an unreleased slot for 120s.
    await manager.notifyTouch({ deviceId: config.deviceId, phase: "down", x: 0.5, y: 0.5 });
    await manager.notifyTouch({ deviceId: config.deviceId, phase: "cancel" });
    report.assert(manager.input.touchSession(config.deviceId) === null, "cancelled gRPC gesture releases its slot");

    // The device must stay responsive, which it would not be if a slot were held.
    const tap = await manager.tap({ deviceId: config.deviceId, x: 0.5, y: 0.95 });
    report.assert(tap.action === "tap", "device still accepts input after gRPC gestures", JSON.stringify(tap));

    // Tearing down mid-gesture must lift the finger rather than orphan the slot,
    // and must leave the shared connection usable for the video stream.
    await manager.notifyTouch({ deviceId: config.deviceId, phase: "down", x: 0.5, y: 0.5 });
    manager.input.clearTouchSessions(config.deviceId);
    report.assert(manager.input.touchSession(config.deviceId) === null, "clearTouchSessions drops the gRPC session");
    await sleep(500);
    const afterClear = await manager.createVideoStream({
        deviceId: config.deviceId,
        fps: 30,
        resolution: 25,
        transport: "grpc",
    });
    try {
        const frames = await collectFrames(afterClear, { count: 1, timeoutMs: 8_000 });
        report.assert(frames.length >= 1, "shared gRPC connection survives input teardown", `${frames.length} frames`);
    } finally {
        afterClear.kill();
    }
}

report.finish();

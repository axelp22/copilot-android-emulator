/**
 * Starts a canvas server in-process and drives it over HTTP: the security posture,
 * static assets, SSE, the live stream, manual input routes, and lease gating.
 *
 *   node scripts/verify/canvas-server.mjs
 */
import net from "node:net";
import path from "node:path";
import { config, createFrameReader, createReporter, extensionRoot, sleep } from "./_shared.mjs";

const { createCanvasServer } = await import(path.join(extensionRoot, "lib", "canvas-server.mjs"));
const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));

const report = createReporter("CANVAS SERVER");
const manager = new DeviceSessionManager({ onDiagnostic: (message) => report.note(message) });
manager.setArtifactsRoot(config.artifactsRoot);

const deviceId = await manager.resolveDeviceId(config.deviceId);
const state = await manager.getDeviceState(deviceId);

const server = await createCanvasServer({
    manager,
    instanceId: "verify-instance",
    deviceId,
    webRoot: path.join(extensionRoot, "web"),
    onDiagnostic: (message) => report.note(message),
});
const base = new URL(server.url);
const root = `${base.origin}${base.pathname}`;
report.note(server.url);

// --- security ----------------------------------------------------------------
report.assert(base.hostname === "127.0.0.1", "server binds loopback only", base.hostname);
report.assert(base.pathname.split("/")[1]?.length === 36, "path is guarded by a random token");
report.assert((await fetch(`${base.origin}/0000000000/api/state`)).status === 404, "unknown path token rejected");
report.assert(
    (await fetch(`${root}api/state`, { headers: { Origin: "https://evil.example.com" } })).status === 403,
    "cross-origin request rejected",
);

// `fetch` refuses to set Host, so forge it on a raw socket.
const forgedHost = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(base.port), "127.0.0.1", () => {
        socket.write(`GET ${base.pathname}api/state HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    socket.on("data", (chunk) => (raw += chunk.toString("utf8")));
    socket.on("end", () => resolve(raw.split("\r\n")[0]));
    socket.on("error", reject);
});
report.assert(forgedHost.includes("403"), "non-loopback Host rejected", forgedHost);

// --- assets and state --------------------------------------------------------
const indexHtml = await (await fetch(root)).text();
report.assert(indexHtml.includes('src="./app.js"'), "index.html served");
for (const asset of ["app.js", "api-client.js", "device-frame.js", "device-picker.js", "h264-stream.js", "icons.js", "input-controller.js", "styles.css"]) {
    report.assert((await fetch(`${root}${asset}`)).ok, `asset ${asset} served`);
}

const apiState = await (await fetch(`${root}api/state`)).json();
report.assert(apiState.deviceId === deviceId, "api/state reports the bound device", apiState.deviceId);
report.assert(apiState.screen.width === state.screen.width, "api/state reports real geometry", `${apiState.screen.width}x${apiState.screen.height}`);

const picker = await (await fetch(`${root}api/devices`)).json();
report.assert(picker.groups.booted.length >= 1, "api/devices groups running targets", String(picker.groups.booted.length));

const sse = await fetch(`${root}api/events`);
const sseReader = sse.body.getReader();
let sseText = "";
for (let read = 0; read < 2 && !sseText.includes("data:"); read += 1) {
    sseText += new TextDecoder().decode((await sseReader.read()).value ?? new Uint8Array());
}
report.assert(sseText.includes("data:") && sseText.includes(deviceId), "SSE pushes the initial state");
void sseReader.cancel();

const framePng = await fetch(`${root}api/frame.png`);
const frameBytes = new Uint8Array(await framePng.arrayBuffer());
report.assert(frameBytes[0] === 0x89 && frameBytes[1] === 0x50, "api/frame.png returns a PNG");

// --- live stream -------------------------------------------------------------
const streamResponse = await fetch(`${root}api/stream.h264?fps=30&resolution=25`);
report.assert(streamResponse.ok, "stream endpoint opens", String(streamResponse.status));
const reader = streamResponse.body.getReader();
const push = createFrameReader();
const tags = [];
const deadline = Date.now() + 5000;
const motion = setInterval(() => {
    void fetch(`${root}api/input/swipe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startX: 0.5, startY: 0.75, endX: 0.5, endY: 0.3, durationMs: 200 }),
    }).catch(() => {});
}, 900);
while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const frame of push(value)) {
        tags.push(frame.tag);
    }
}
clearInterval(motion);
void reader.cancel();
report.assert(tags.includes(0x04), "seed frame delivered");
report.assert(tags.indexOf(0x01) !== -1 && tags.indexOf(0x01) < tags.indexOf(0x02), "config precedes the keyframe");
report.assert(tags.filter((tag) => tag === 0x03).length > 10, "delta frames delivered", String(tags.filter((tag) => tag === 0x03).length));

// --- manual input ------------------------------------------------------------
const tap = await (await fetch(`${root}api/input/tap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: 0.5, y: 0.5 }),
})).json();
report.assert(tap.x === Math.round(0.5 * state.screen.width), "manual tap route maps coordinates", JSON.stringify(tap));
report.assert(
    (await fetch(`${root}api/toolbar/button`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ button: "home" }),
    })).ok,
    "manual navigation button route",
);
report.assert(
    (await fetch(`${root}api/toolbar/button`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ button: "self_destruct" }),
    })).status === 400,
    "unknown button rejected",
);

// --- lease gating ------------------------------------------------------------
const lease = await manager.acquireLease({ deviceId, reason: "verification", ownerInstanceId: "verify-instance", ttlSeconds: 60 });
report.assert(lease.lease.active === true, "agent lease acquired");

const blocked = await fetch(`${root}api/input/tap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: 0.5, y: 0.5 }),
});
report.assert(blocked.status === 423, "manual input blocked while leased", String(blocked.status));

const leasedTap = await manager.withLeaseOperation(
    { deviceId, leaseId: lease.lease.leaseId, operation: "Sending tap" },
    () => manager.tap({ deviceId, leaseId: lease.lease.leaseId, x: 0.5, y: 0.9 }),
);
report.assert(leasedTap.y === Math.round(0.9 * state.screen.height), "agent input works under the lease", JSON.stringify(leasedTap));
report.assert(Boolean((await manager.captureScreen(deviceId)).artifactPath), "capture_screen needs no lease");

const revoked = await (await fetch(`${root}api/control/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
})).json();
report.assert(revoked.lease.active === false, "take back control revokes the lease");
await sleep(200);
report.assert(
    (await fetch(`${root}api/input/tap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: 0.5, y: 0.5 }),
    })).ok,
    "manual input restored after revoke",
);

// --- stream preferences ------------------------------------------------------
const prefs = await (await fetch(`${root}api/stream/preferences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fps: 30, resolution: 50 }),
})).json();
report.assert(prefs.stream.fps === 30 && prefs.stream.resolution === 50, "stream preferences applied", JSON.stringify(prefs.stream));
report.assert(
    (await fetch(`${root}api/stream/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fps: 144 }),
    })).status === 400,
    "invalid fps rejected",
);

await server.close();
await manager.dispose();
report.finish();

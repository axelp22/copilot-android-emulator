/**
 * Control leases are per-process, so they only coordinate one Copilot session.
 * These checks cover the shared claim that makes another session's use visible,
 * and stops two agents driving one device at once.
 *
 *   node scripts/verify/cross-session-claims.mjs
 */
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config, createReporter, extensionRoot } from "./_shared.mjs";

const { DeviceClaimStore } = await import(path.join(extensionRoot, "lib", "device-claims.mjs"));
const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));

const report = createReporter("CROSS-SESSION CLAIMS");
const root = await mkdtemp(path.join(os.tmpdir(), "android-claims-"));

const manager = new DeviceSessionManager({ onDiagnostic: () => {} });
manager.setArtifactsRoot(config.artifactsRoot);
manager.claims = new DeviceClaimStore({ root, owner: { sessionId: "session-A", workingDirectory: "/work/repo-a" } });

// Stands in for a second Copilot session sharing the same devices.
const otherSession = new DeviceClaimStore({
    root,
    owner: { sessionId: "session-B", workingDirectory: "/work/repo-b" },
});

const deviceId = await manager.resolveDeviceId(config.deviceId);

// --- nothing claimed ---------------------------------------------------------
await manager.refreshForeignClaims();
report.assert(manager.foreignClaimFor(deviceId) === null, "a free device shows no foreign claim");
await manager.acquireLease({ deviceId, reason: "first", ownerInstanceId: "a", ttlSeconds: 60 }).then(
    (snapshot) => report.assert(snapshot.lease.active, "control can be taken when the device is free"),
    (error) => report.assert(false, "control can be taken when the device is free", error.message),
);

// This session's own control must be published for others to see.
const publishedToOthers = await otherSession.foreignClaims();
report.assert(
    publishedToOthers.get(deviceId)?.mode === "control",
    "this session's control is visible to other sessions",
    publishedToOthers.get(deviceId)?.sessionLabel ?? "not published",
);

await manager.revokeLease(deviceId);

// --- another session is driving it -------------------------------------------
await otherSession.claim(deviceId, { mode: "control", reason: "running a test suite" });
await manager.refreshForeignClaims();
const foreign = manager.foreignClaimFor(deviceId);
report.assert(foreign?.mode === "control", "another session's control is detected", foreign?.sessionLabel ?? "none");
report.assert(foreign?.sessionLabel === "repo-b", "the other session is identified", String(foreign?.sessionLabel));

let refused = null;
await manager
    .acquireLease({ deviceId, reason: "second", ownerInstanceId: "a", ttlSeconds: 60 })
    .catch((error) => {
        refused = error;
    });
report.assert(refused?.code === "device_claimed_elsewhere", "control is refused while another session drives it", refused?.code ?? "not refused");
report.assert(
    String(refused?.message).includes("repo-b"),
    "the refusal names the other session",
    String(refused?.message).slice(0, 80),
);

// The picker must surface it rather than only the tools.
const picker = await manager.listDevicePicker(deviceId);
const row = Object.values(picker.groups).flat().find((item) => item.deviceId === deviceId);
report.assert(row?.foreignUse?.mode === "control", "the device picker reports the other session", JSON.stringify(row?.foreignUse ?? null));

// --- the other session goes away ---------------------------------------------
await otherSession.releaseAll();
await manager.refreshForeignClaims();
report.assert(manager.foreignClaimFor(deviceId) === null, "releasing frees the device for others");
const afterRelease = await manager.acquireLease({ deviceId, reason: "third", ownerInstanceId: "a", ttlSeconds: 60 });
report.assert(afterRelease.lease.active, "control can be taken again once released");
await manager.revokeLease(deviceId);

// --- a crashed session must not hold a device forever -------------------------
const deadSession = new DeviceClaimStore({
    root,
    owner: { sessionId: "session-dead", workingDirectory: "/work/crashed", pid: 999_999 },
});
await deadSession.claim(deviceId, { mode: "control", reason: "crashed mid-run" });
await manager.refreshForeignClaims();
report.assert(
    manager.foreignClaimFor(deviceId) === null,
    "a claim from a dead process is ignored",
    "stale claim discarded",
);
const remaining = (await readdir(root)).filter((name) => name.includes("session-dead"));
report.assert(remaining.length === 0, "the stale claim file is cleaned up", `${remaining.length} left`);

await manager.dispose();
report.finish();

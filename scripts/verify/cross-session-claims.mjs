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
const { DeviceQueue } = await import(path.join(extensionRoot, "lib", "device-queue.mjs"));
const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));

const report = createReporter("CROSS-SESSION CLAIMS");
const root = await mkdtemp(path.join(os.tmpdir(), "android-claims-"));

const manager = new DeviceSessionManager({ onDiagnostic: () => {} });
manager.setArtifactsRoot(config.artifactsRoot);
manager.claims = new DeviceClaimStore({ root, owner: { sessionId: "session-A", workingDirectory: "/work/repo-a" } });
// Point the queue at the same scratch root so the suite never touches real state.
manager.queue = new DeviceQueue({ root: path.join(root, "queue"), owner: { sessionId: "session-A", sessionLabel: "repo-a" } });

// Stands in for a second Copilot session sharing the same devices.
const otherSession = new DeviceClaimStore({
    root,
    owner: { sessionId: "session-B", workingDirectory: "/work/repo-b" },
});
const otherQueue = new DeviceQueue({
    root: path.join(root, "queue"),
    owner: { sessionId: "session-B", sessionLabel: "repo-b" },
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
await otherQueue.acquire(deviceId, { reason: "running a test suite", timeoutMs: 0 });
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
report.assert(refused?.code === "device_busy", "control is refused while another session drives it", refused?.code ?? "not refused");
report.assert(
    String(refused?.message).includes("repo-b"),
    "the refusal names the other session",
    String(refused?.message).slice(0, 80),
);

// The picker must surface it rather than only the tools.
const picker = await manager.listDevicePicker(deviceId);
const row = Object.values(picker.groups).flat().find((item) => item.deviceId === deviceId);
report.assert(row?.foreignUse?.mode === "control", "the device picker reports the other session", JSON.stringify(row?.foreignUse ?? null));
report.assert(row?.queue?.holder?.sessionLabel === "repo-b", "the picker names the session holding the device", String(row?.queue?.holder?.sessionLabel));

// --- waiting for a busy device rather than failing ----------------------------
// The point of the queue: a second session can line up instead of interrupting.
const queuedAcquire = manager.acquireLease({
    deviceId,
    reason: "queued run",
    ownerInstanceId: "a",
    ttlSeconds: 60,
    waitSeconds: 30,
});
await new Promise((resolve) => setTimeout(resolve, 1_200));

const waitingStatus = await manager.queueStatus();
const waitingRow = waitingStatus.devices.find((entry) => entry.deviceId === deviceId);
report.assert(waitingRow?.waiting.length === 1, "a queued session is listed as waiting", `${waitingRow?.waiting.length ?? 0} waiting`);
report.assert(waitingRow?.waiting[0]?.isMine === true, "the waiting session recognises itself in the queue");

const waitingPicker = await manager.listDevicePicker(deviceId);
const waitingPickerRow = Object.values(waitingPicker.groups).flat().find((item) => item.deviceId === deviceId);
report.assert(waitingPickerRow?.queue?.myPosition === 1, "the picker shows our place in line", String(waitingPickerRow?.queue?.myPosition));

await otherQueue.release(deviceId);
const grantedAfterWait = await queuedAcquire;
report.assert(grantedAfterWait.lease.active, "the queued session gets the device once it is free");
report.assert(grantedAfterWait.waitedMs > 0, "the grant reports how long it waited", `${grantedAfterWait.waitedMs}ms`);
await manager.revokeLease(deviceId);

const afterRevoke = await manager.queueStatus();
const freedRow = afterRevoke.devices.find((entry) => entry.deviceId === deviceId);
report.assert(!freedRow?.holder, "releasing control frees the device in the queue", JSON.stringify(freedRow?.holder ?? null));

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

// --- a lease that simply lapses must free the device --------------------------
// Leases are designed to expire without being released, so expiry has to give up
// the cross-session hold too. Otherwise letting a lease run out blocks every
// other session for as long as this process lives.
const lapsing = await manager.acquireLease({ deviceId, reason: "will lapse", ownerInstanceId: "a", ttlSeconds: 2 });
const ttlMs = new Date(lapsing.lease.expiresAt).getTime() - Date.now();
report.assert(ttlMs < 20_000, "the lease is short enough to observe expiring", `${Math.round(ttlMs / 1000)}s`);

const heldWhileLeased = (await manager.queue.status([deviceId]))[0];
report.assert(heldWhileLeased.holder?.isMine === true, "the device is held while the lease is active");

await new Promise((resolve) => setTimeout(resolve, ttlMs + 2_000));
report.assert(manager.snapshot(deviceId).lease.active === false, "the lease has lapsed");
const afterLapse = (await manager.queue.status([deviceId]))[0];
report.assert(!afterLapse.holder, "a lapsed lease releases the device for other sessions", JSON.stringify(afterLapse.holder ?? null));

const takenAfterLapse = await otherQueue.acquire(deviceId, { reason: "after lapse", timeoutMs: 2_000 });
report.assert(takenAfterLapse?.deviceId === deviceId, "another session can take the device after a lease lapses");
await otherQueue.releaseAll();

// --- capture started outside the extension entirely ---------------------------
// Claims only reveal sessions that publish one. Android Studio, scrcpy or a plain
// adb command publish nothing, which is exactly when "is it free?" matters.
const { listForeignCaptures } = await import(path.join(extensionRoot, "lib", "adb.mjs"));
const { adb } = await import("./_shared.mjs");

const before = await listForeignCaptures(config.serial).catch(() => []);
report.assert(before.length === 0, "no foreign capture on an idle device", `${before.length} found`);

await adb(["shell", "screenrecord --time-limit 30 /sdcard/verify-foreign.mp4 >/dev/null 2>&1 &"]).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 3500));
const during = await listForeignCaptures(config.serial).catch(() => []);
report.assert(during.length > 0, "capture started outside the extension is detected", `pids ${during.join(",")}`);

// Foreign-capture probing is cached briefly to keep adb calls off the hot path,
// so wait out that window rather than reading a stale answer.
await new Promise((resolve) => setTimeout(resolve, 5_500));
const capturePicker = await manager.listDevicePicker(config.deviceId);
const flagged = Object.values(capturePicker.groups)
    .flat()
    .find((item) => item.deviceId === config.deviceId);
report.assert(flagged?.foreignCapture === true, "the picker flags the device as in use elsewhere", String(flagged?.foreignCapture));

for (const pid of during) {
    await adb(["shell", "kill", "-INT", pid]).catch(() => {});
}
await adb(["shell", "rm", "-f", "/sdcard/verify-foreign.mp4"]).catch(() => {});

await manager.dispose();
const strandedHolders = (await readdir(path.join(root, "queue", "holders")).catch(() => [])).length;
report.assert(strandedHolders === 0, "a session that exits leaves no device held", `${strandedHolders} left`);

report.finish();

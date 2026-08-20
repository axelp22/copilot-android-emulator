/**
 * How a control lease and the cross-session queue hold fit together.
 *
 * The lease says who may drive a device inside this session; the queue hold says
 * this session owns the device at all. They are separate lifetimes, and every bug
 * this suite covers was a case of one outliving or releasing the other: a device
 * handed to another session while an agent was still driving it, or one left
 * locked after the agent had gone.
 *
 * No device is needed: discovery is stubbed and nothing here talks to adb.
 *
 *   node scripts/verify/lease-holds.mjs
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReporter, extensionRoot, sleep } from "./_shared.mjs";

const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));
const { DeviceClaimStore } = await import(path.join(extensionRoot, "lib", "device-claims.mjs"));
const { DeviceQueue } = await import(path.join(extensionRoot, "lib", "device-queue.mjs"));

const report = createReporter("LEASE HOLDS");
const root = await mkdtemp(path.join(os.tmpdir(), "lease-holds-"));
const claimsRoot = path.join(root, "claims");
const queueRoot = path.join(root, "queue");

const DEVICE = "Pixel_Test";
const OTHER = "Pixel_Other";

function bootedDevice(id) {
    return {
        id,
        serial: `emulator-${id}`,
        avdName: id,
        kind: "emulator",
        name: id,
        state: "Booted",
        isAvailable: true,
        apiLevel: 34,
        androidVersion: "14",
        screen: { width: 1080, height: 2400, density: 420 },
    };
}

/** A manager wired to temporary coordination roots, with discovery stubbed out. */
function createManager(sessionId, { onDiagnostic } = {}) {
    const manager = new DeviceSessionManager({ onDiagnostic });
    manager.claims = new DeviceClaimStore({ root: claimsRoot });
    manager.queue = new DeviceQueue({ root: queueRoot });
    manager.discoverDevices = async () => [bootedDevice(DEVICE), bootedDevice(OTHER)];
    manager.setSessionIdentity({ sessionId, workingDirectory: `/tmp/${sessionId}` });
    return manager;
}

async function holderLabel(manager, deviceId) {
    const [status] = await manager.queue.status([deviceId]);
    return status.holder ? `${status.holder.sessionLabel}${status.holder.isMine ? " (mine)" : ""}` : "none";
}

// --- a failed second acquire must not release the live lease's device ----------
// Both acquisitions used to share one hold key, so they collapsed into a single
// entry: the second one failing dropped the hold the first still depended on, and
// the device was handed to another session mid-sequence.
const one = createManager("session-one");
await one.acquireLease({ deviceId: DEVICE, ownerInstanceId: "instance-a", reason: "first sequence" });
report.assert((await holderLabel(one, DEVICE)).endsWith("(mine)"), "acquiring a lease takes the device");

let refused = null;
try {
    await one.acquireLease({ deviceId: DEVICE, ownerInstanceId: "instance-b", reason: "second sequence" });
} catch (error) {
    refused = error;
}
report.assert(refused?.code === "device_busy", "a second lease on the same device is refused", String(refused?.code));
report.assert(
    (await holderLabel(one, DEVICE)).endsWith("(mine)"),
    "a refused acquire leaves the live lease holding the device",
    await holderLabel(one, DEVICE),
);

const intruder = createManager("session-intruder");
const stolen = await intruder.queue.acquire(DEVICE, { reason: "intrusion", timeoutMs: 0 });
report.assert(stolen === null, "another session still cannot take the leased device");

// --- an operation must outlive the lease that started it -----------------------
// A boot can run for three minutes under a two minute lease. When the lease
// lapsed, the hold went with it and the next session was handed a device that was
// still mid-boot.
let releaseOperation;
const operationDone = new Promise((resolve) => {
    releaseOperation = resolve;
});
const leaseId = one.state.snapshot(DEVICE).lease.leaseId;
const operation = one.withLeaseOperation(
    { deviceId: DEVICE, leaseId, operation: "Booting emulator" },
    () => operationDone,
);

// Force the lease to lapse while the operation is still running.
const leased = one.state.devices.get(DEVICE);
leased.lease.expiresAt = new Date(Date.now() - 1_000).toISOString();
one.state.clearExpiredLease(leased);
await sleep(50);

report.assert(!one.state.devices.get(DEVICE).lease, "the lease lapses mid-operation");
report.assert(
    (await holderLabel(one, DEVICE)).endsWith("(mine)"),
    "the device is still held while the operation runs",
    await holderLabel(one, DEVICE),
);

releaseOperation("done");
await operation;
await sleep(50);
report.assert(
    (await holderLabel(one, DEVICE)) === "none",
    "the device is released once the operation finishes",
    await holderLabel(one, DEVICE),
);

// --- closing the owning canvas must release the device -------------------------
// detachInstance dropped the lease without telling anything outside the process,
// so the queue hold survived until the session exited and no other session could
// use the device in the meantime.
await one.acquireLease({ deviceId: DEVICE, ownerInstanceId: "instance-c", reason: "canvas sequence" });
one.state.attachInstance(DEVICE, "instance-c");
report.assert((await holderLabel(one, DEVICE)).endsWith("(mine)"), "the lease takes the device again");

one.detachInstance(DEVICE, "instance-c");
await sleep(50);
report.assert(!one.state.devices.get(DEVICE).lease, "closing the owning canvas drops its lease");
report.assert(
    (await holderLabel(one, DEVICE)) === "none",
    "closing the owning canvas also releases the device",
    await holderLabel(one, DEVICE),
);
const reclaimed = await intruder.queue.acquire(DEVICE, { reason: "after detach", timeoutMs: 0 });
report.assert(reclaimed?.deviceId === DEVICE, "another session can then take the device");
await intruder.queue.release(DEVICE);

// --- releasing and revoking give the device back -------------------------------
const released = await one.acquireLease({ deviceId: DEVICE, ownerInstanceId: "instance-d", reason: "release path" });
await one.releaseLease({ deviceId: DEVICE, leaseId: released.lease.leaseId });
report.assert(
    (await holderLabel(one, DEVICE)) === "none",
    "releasing a lease gives the device back",
    await holderLabel(one, DEVICE),
);

await one.acquireLease({ deviceId: DEVICE, ownerInstanceId: "instance-e", reason: "revoke path" });
await one.revokeLease(DEVICE);
report.assert(
    (await holderLabel(one, DEVICE)) === "none",
    "revoking a lease gives the device back",
    await holderLabel(one, DEVICE),
);

// --- diagnostics reach the services built in the constructor -------------------
// The build service captured its sink before the manager had one, and silently
// dropped every Gradle diagnostic for the life of the process.
const messages = [];
const wired = createManager("session-diagnostics", { onDiagnostic: (message) => messages.push(message) });
wired.build.onDiagnostic("build says hello");
report.assert(messages.includes("build says hello"), "the build service reports through the manager's sink");

const later = [];
wired.setDiagnosticSink((message) => later.push(message));
wired.build.onDiagnostic("after rewiring");
report.assert(later.includes("after rewiring"), "a sink installed later still reaches the build service");

await Promise.all([one.dispose(), intruder.dispose(), wired.dispose()]);
report.finish();

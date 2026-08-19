/**
 * The cross-session device queue. These checks matter because the queue is the
 * thing standing between two sessions and a corrupted test run, and because its
 * failure modes (a lost race, a jumped queue, a crashed holder) are all silent.
 *
 * No device is needed: the queue is pure coordination.
 *
 *   node scripts/verify/device-queue.mjs
 */
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReporter, extensionRoot, sleep } from "./_shared.mjs";

const { DeviceQueue } = await import(path.join(extensionRoot, "lib", "device-queue.mjs"));

const report = createReporter("DEVICE QUEUE");
const root = await mkdtemp(path.join(os.tmpdir(), "device-queue-"));
const session = (id, label, pid) => new DeviceQueue({ root, owner: { sessionId: id, sessionLabel: label, pid } });

const a = session("A", "repo-a");
const b = session("B", "repo-b");
const c = session("C", "repo-c");
const DEVICE = "Pixel_10_Pro_XL";

// --- a free device is taken immediately --------------------------------------
const first = await a.acquire(DEVICE, { reason: "suite one", timeoutMs: 0 });
report.assert(first?.deviceId === DEVICE, "a free device is granted at once", String(first?.deviceId));
report.assert(first?.waited === false, "no waiting when the device is free");

// --- a second session cannot take it -----------------------------------------
const blocked = await b.acquire(DEVICE, { reason: "suite two", timeoutMs: 0 });
report.assert(blocked === null, "a held device is not granted to another session");
const heldStatus = (await b.status([DEVICE]))[0];
report.assert(heldStatus.holder?.sessionLabel === "repo-a", "the holder is visible to others", String(heldStatus.holder?.sessionLabel));
report.assert(heldStatus.holder?.isMine === false, "the holder is correctly not the asker");

// --- waiters are served in the order they asked -------------------------------
const order = [];
const bWait = b.acquire(DEVICE, { reason: "suite two", timeoutMs: 15_000 }).then((r) => {
    order.push("B");
    return r;
});
await sleep(600); // ensure B's ticket is strictly older than C's
const cWait = c.acquire(DEVICE, { reason: "suite three", timeoutMs: 15_000 }).then((r) => {
    order.push("C");
    return r;
});
await sleep(600);

const queued = (await a.status([DEVICE]))[0];
report.assert(queued.waiting.length === 2, "both waiters are queued", `${queued.waiting.length} waiting`);
report.assert(
    queued.waiting[0].sessionLabel === "repo-b" && queued.waiting[1].sessionLabel === "repo-c",
    "the queue is ordered by when each session asked",
    queued.waiting.map((w) => `${w.position}:${w.sessionLabel}`).join(" "),
);

// A newcomer must not jump the queue while waiters exist.
const jumper = session("D", "repo-d");
const jumped = await jumper.acquire(DEVICE, { reason: "queue jump", timeoutMs: 0 });
report.assert(jumped === null, "a newcomer cannot jump ahead of existing waiters");

await a.release(DEVICE);
const bResult = await bWait;
report.assert(bResult?.deviceId === DEVICE, "the device passes to the first waiter", String(bResult?.deviceId));
report.assert(bResult?.waited === true, "that waiter reports having waited");
report.assert(order[0] === "B", "the first to ask is served first", order.join(" then "));

await b.release(DEVICE);
const cResult = await cWait;
report.assert(cResult?.deviceId === DEVICE, "the device then passes to the next waiter");
await c.release(DEVICE);

// --- two sessions racing for a free device: exactly one wins -------------------
const racers = Array.from({ length: 6 }, (_, index) => session(`R${index}`, `racer-${index}`));
const results = await Promise.all(racers.map((racer) => racer.acquire(DEVICE, { reason: "race", timeoutMs: 0 })));
const winners = results.filter(Boolean);
report.assert(winners.length === 1, "exactly one session wins a race for a free device", `${winners.length} winners`);
await Promise.all(racers.map((racer) => racer.release(DEVICE)));

// --- a crashed holder must not block the queue for ever ------------------------
const crashed = session("CRASHED", "crashed-session", 999_999);
await crashed.acquire(DEVICE, { reason: "will crash", timeoutMs: 0 });
const afterCrash = await a.acquire(DEVICE, { reason: "after crash", timeoutMs: 3_000 });
report.assert(afterCrash?.deviceId === DEVICE, "a device held by a dead session is reclaimed", String(afterCrash?.deviceId));
await a.release(DEVICE);

// --- asking for any of several devices ----------------------------------------
const POOL = ["emulator-one", "emulator-two"];
const holderOne = session("H1", "holder-one");
await holderOne.acquire("emulator-one", { reason: "busy", timeoutMs: 0 });

const pooled = await a.acquire(POOL, { reason: "any free emulator", timeoutMs: 5_000 });
report.assert(pooled?.deviceId === "emulator-two", "asking for any device picks a free one", String(pooled?.deviceId));
await a.release("emulator-two");

// With every device busy, the waiter takes whichever frees first.
const holderTwo = session("H2", "holder-two");
await holderTwo.acquire("emulator-two", { reason: "busy", timeoutMs: 0 });
const pooledWait = a.acquire(POOL, { reason: "any free emulator", timeoutMs: 15_000 });
await sleep(1200);
await holderTwo.release("emulator-two");
const pooledResult = await pooledWait;
report.assert(pooledResult?.deviceId === "emulator-two", "a pooled waiter takes whichever frees first", String(pooledResult?.deviceId));
await a.release("emulator-two");
await holderOne.release("emulator-one");

// --- a renewal in flight must not resurrect a hold we gave up --------------------
// The heartbeat rewrites the holder file. If it can write after a release, it
// recreates a hold nobody owns, and the device is blocked until that process exits.
const beater = session("BEAT", "beating");
await beater.acquire(DEVICE, { reason: "will release mid-beat", timeoutMs: 0 });
const inFlight = beater.beat();
await beater.release(DEVICE);
await inFlight;
await beater.beat();
const afterBeat = (await a.status([DEVICE]))[0];
report.assert(!afterBeat.holder, "a renewal after release does not recreate the hold", JSON.stringify(afterBeat.holder ?? null));

// And a renewal must not overwrite the record of whoever took the device next.
const firstHolder = session("FIRST", "first-holder");
const secondHolder = session("SECOND", "second-holder");
await firstHolder.acquire(DEVICE, { reason: "first", timeoutMs: 0 });
const staleRecord = firstHolder.held.get(DEVICE);
await firstHolder.release(DEVICE);
await secondHolder.acquire(DEVICE, { reason: "second", timeoutMs: 0 });
firstHolder.held.set(DEVICE, staleRecord); // as if a beat were still queued from before
await firstHolder.beat();
const afterStale = (await a.status([DEVICE]))[0];
report.assert(
    afterStale.holder?.sessionLabel === "second-holder",
    "a stale renewal does not overwrite the new holder",
    String(afterStale.holder?.sessionLabel),
);

// The same stale owner must not be able to release somebody else's hold.
await firstHolder.release(DEVICE);
const afterStaleRelease = (await a.status([DEVICE]))[0];
report.assert(
    afterStaleRelease.holder?.sessionLabel === "second-holder",
    "a stale owner cannot release the new holder's device",
    String(afterStaleRelease.holder?.sessionLabel),
);
await secondHolder.release(DEVICE);

// --- nothing is left behind ----------------------------------------------------
await Promise.all([
    a.releaseAll(),
    b.releaseAll(),
    c.releaseAll(),
    jumper.releaseAll(),
    holderOne.releaseAll(),
    holderTwo.releaseAll(),
    beater.releaseAll(),
    firstHolder.releaseAll(),
    secondHolder.releaseAll(),
]);
const leftoverTickets = (await readdir(path.join(root, "tickets")).catch(() => [])).length;
report.assert(leftoverTickets === 0, "no waiting tickets are left behind", `${leftoverTickets} left`);

report.finish();

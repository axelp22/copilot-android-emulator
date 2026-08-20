import { randomUUID } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultQueueRoot } from "./device-claims.mjs";
import { isLive, readRecord, safeName, writeRecordAtomic } from "./fs-coordination.mjs";

/**
 * A cross-session FIFO for devices.
 *
 * Refusing a busy device tells a session it cannot work, but not when it can.
 * This lets sessions queue instead: the holder owns the device exclusively, and
 * waiters are granted it in the order they asked.
 *
 * There is no daemon. Ownership is an exclusively-created file, so two sessions
 * racing for the same free device cannot both win, and order is decided purely by
 * the timestamps on the waiting tickets. Every record carries a process id and a
 * heartbeat, so a session that crashes mid-turn is reclaimed rather than blocking
 * the queue forever.
 */

const HOLDER_TTL_MS = 60_000;
const TICKET_TTL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 1_000;

/** Two reads of the same acquisition, rather than a replacement. */
function sameRecord(a, b) {
    return a.token && b.token ? a.token === b.token : a.acquiredAt === b.acquiredAt && a.sessionId === b.sessionId;
}

export class DeviceQueue {
    constructor({ root = defaultQueueRoot(), owner = {} } = {}) {
        this.root = root;
        this.holdersDir = path.join(root, "holders");
        this.ticketsDir = path.join(root, "tickets");
        // Built field by field: spreading the caller's object last would let an
        // explicit `pid: undefined` erase the real one, and every record this
        // session wrote would then look like it came from a dead process.
        this.owner = {
            sessionId: owner.sessionId ?? `pid-${process.pid}`,
            sessionLabel: owner.sessionLabel ?? "session",
            pid: Number.isInteger(owner.pid) ? owner.pid : process.pid,
        };
        this.held = new Map();
        this.tickets = new Map();
        this.heartbeat = null;
    }

    setOwner(owner = {}) {
        this.owner = {
            sessionId: owner.sessionId ?? this.owner.sessionId,
            sessionLabel: owner.sessionLabel ?? this.owner.sessionLabel,
            pid: Number.isInteger(owner.pid) ? owner.pid : this.owner.pid,
        };
    }

    holderPath(deviceId) {
        return path.join(this.holdersDir, `${safeName(deviceId)}.json`);
    }

    ticketPath(deviceId, ticketId) {
        return path.join(this.ticketsDir, `${safeName(deviceId)}__${ticketId}.json`);
    }

    async ensureDirs() {
        await mkdir(this.holdersDir, { recursive: true });
        await mkdir(this.ticketsDir, { recursive: true });
    }

    async readJson(file) {
        return (await readRecord(file)).record;
    }

    /** Current holder of a device, or null when it is free. Reclaims dead holders. */
    async holderOf(deviceId) {
        const file = this.holderPath(deviceId);
        const { status, record } = await readRecord(file);
        if (!record) {
            // An unreadable record is not an absent one. Reporting the device free
            // on a torn read would let a second session believe it can take a
            // device somebody already holds.
            return status === "unreadable" ? { deviceId, unreadable: true } : null;
        }
        if (!isLive(record)) {
            // Re-read before deleting: between the read and the unlink another
            // session may have taken the device, and removing their holder would
            // hand the same device to two sessions.
            const current = (await readRecord(file)).record;
            if (current && sameRecord(current, record) && !isLive(current)) {
                await unlink(file).catch(() => {});
            }
            return null;
        }
        return record;
    }

    /** Live tickets for a device, oldest first. Drops tickets from dead sessions. */
    async waitersFor(deviceId) {
        await this.ensureDirs();
        const prefix = `${safeName(deviceId)}__`;
        const names = (await readdir(this.ticketsDir).catch(() => [])).filter(
            (name) => name.startsWith(prefix) && name.endsWith(".json"),
        );

        const live = [];
        await Promise.all(
            names.map(async (name) => {
                const file = path.join(this.ticketsDir, name);
                const { status, record } = await readRecord(file);
                if (status === "unreadable") {
                    // Being rewritten by its owner's heartbeat, or truncated. Deleting
                    // it here would silently cost a live session its place in line.
                    return;
                }
                if (!isLive(record)) {
                    await unlink(file).catch(() => {});
                    return;
                }
                live.push(record);
            }),
        );
        live.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt) || a.ticketId.localeCompare(b.ticketId));
        return live;
    }

    async enqueue(deviceId, { reason = null, ticketId = randomUUID(), candidates = [deviceId] } = {}) {
        await this.ensureDirs();
        const record = {
            deviceId,
            ticketId,
            reason,
            // Every device this ticket would accept. A waiter for "any" device sits
            // at the head of several queues but will consume exactly one, so others
            // need to know it is not really blocked on this particular device.
            candidates,
            sessionId: this.owner.sessionId,
            sessionLabel: this.owner.sessionLabel,
            pid: this.owner.pid,
            enqueuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
        };
        this.tickets.set(`${deviceId}:${ticketId}`, record);
        await writeRecordAtomic(this.ticketPath(deviceId, ticketId), record);
        this.startHeartbeat();
        return record;
    }

    async dropTicket(deviceId, ticketId) {
        this.tickets.delete(`${deviceId}:${ticketId}`);
        await unlink(this.ticketPath(deviceId, ticketId)).catch(() => {});
    }

    /**
     * Whether an older waiter genuinely needs *this* device, or is a request for
     * "any" device that another free device can satisfy just as well.
     *
     * Without this, one pooled waiter sitting at the head of every queue reserves
     * the entire pool while it can only ever consume one device, and sessions
     * asking for a specific free device wait behind a ticket that will never take it.
     */
    async blocksThisDevice(ticket, deviceId) {
        const alternatives = (ticket.candidates ?? [ticket.deviceId]).filter((candidate) => candidate !== deviceId);
        if (alternatives.length === 0) {
            return true;
        }
        for (const candidate of alternatives) {
            if (!(await this.holderOf(candidate))) {
                // Another device this waiter accepts is free right now, so it is not
                // waiting on this one.
                return false;
            }
        }
        return true;
    }

    /**
     * Take a device if it is free *and* nobody older is waiting for it. The holder
     * file is created exclusively, so a race between two sessions has exactly one
     * winner rather than both believing they hold it.
     */
    async tryAcquire(deviceId, { reason = null, ticketId = null } = {}) {
        await this.ensureDirs();
        const holder = await this.holderOf(deviceId);
        if (holder) {
            return holder.sessionId === this.owner.sessionId ? { granted: true, holder } : { granted: false, holder };
        }

        const waiters = await this.waitersFor(deviceId);
        for (const waiter of waiters) {
            if (waiter.ticketId === ticketId) {
                break;
            }
            if (await this.blocksThisDevice(waiter, deviceId)) {
                // Someone asked first; taking it now would jump the queue.
                return { granted: false, holder: null, blockedBy: waiter };
            }
        }

        const record = {
            deviceId,
            reason,
            // Identifies this acquisition, not just this session. Renewal, release
            // and stale cleanup all check it, so an in-flight write from a hold we
            // have already given up cannot resurrect or clobber somebody else's.
            token: randomUUID(),
            sessionId: this.owner.sessionId,
            sessionLabel: this.owner.sessionLabel,
            pid: this.owner.pid,
            acquiredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + HOLDER_TTL_MS).toISOString(),
        };
        try {
            await writeFile(this.holderPath(deviceId), `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
        } catch {
            // Another session created it first.
            return { granted: false, holder: await this.holderOf(deviceId) };
        }

        this.held.set(deviceId, record);
        if (ticketId) {
            await this.dropTicket(deviceId, ticketId);
        }
        this.startHeartbeat();
        return { granted: true, holder: record };
    }

    /**
     * Wait for one of `deviceIds` in FIFO order. A ticket is placed on every
     * candidate so a session asking for "any device" is granted whichever frees
     * first, and the losing tickets are withdrawn.
     */
    async acquire(deviceIds, { reason = null, timeoutMs = 0, onWait = null } = {}) {
        const candidates = Array.isArray(deviceIds) ? deviceIds : [deviceIds];
        if (candidates.length === 0) {
            throw new Error("No candidate devices were supplied.");
        }

        // A free device is taken immediately, before any queueing.
        for (const deviceId of candidates) {
            const attempt = await this.tryAcquire(deviceId, { reason });
            if (attempt.granted) {
                return { deviceId, holder: attempt.holder, waited: false, waitedMs: 0 };
            }
        }
        if (timeoutMs <= 0) {
            return null;
        }

        const ticketId = randomUUID();
        await Promise.all(candidates.map((deviceId) => this.enqueue(deviceId, { reason, ticketId, candidates })));
        const startedAt = Date.now();

        try {
            while (Date.now() - startedAt < timeoutMs) {
                for (const deviceId of candidates) {
                    const attempt = await this.tryAcquire(deviceId, { reason, ticketId });
                    if (attempt.granted) {
                        await Promise.all(
                            candidates
                                .filter((other) => other !== deviceId)
                                .map((other) => this.dropTicket(other, ticketId)),
                        );
                        return { deviceId, holder: attempt.holder, waited: true, waitedMs: Date.now() - startedAt };
                    }
                }
                if (onWait) {
                    const positions = await Promise.all(
                        candidates.map(async (deviceId) => ({
                            deviceId,
                            position: (await this.waitersFor(deviceId)).findIndex((t) => t.ticketId === ticketId) + 1,
                        })),
                    );
                    onWait(positions);
                }
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            }
            return null;
        } finally {
            await Promise.all(candidates.map((deviceId) => this.dropTicket(deviceId, ticketId)));
        }
    }

    async release(deviceId) {
        const record = this.held.get(deviceId);
        this.held.delete(deviceId);
        const holder = await this.readJson(this.holderPath(deviceId));
        // Only the owning session may release, or a crashed session's leftovers.
        if (holder && holder.sessionId !== this.owner.sessionId && isLive(holder)) {
            return false;
        }
        // If the file on disk is a different acquisition than ours, it belongs to
        // whoever took the device after us. Deleting it would free a device that
        // is in use.
        if (holder && record && holder.token && record.token && holder.token !== record.token && isLive(holder)) {
            return false;
        }
        await unlink(this.holderPath(deviceId)).catch(() => {});
        if (this.held.size === 0 && this.tickets.size === 0) {
            this.stopHeartbeat();
        }
        return Boolean(record) || Boolean(holder);
    }

    async releaseAll() {
        await Promise.all(Array.from(this.held.keys()).map((deviceId) => this.release(deviceId)));
        await Promise.all(
            Array.from(this.tickets.values()).map((ticket) => this.dropTicket(ticket.deviceId, ticket.ticketId)),
        );
        this.stopHeartbeat();
    }

    /** Who holds each device and who is waiting, for display and diagnostics. */
    async status(deviceIds) {
        const rows = await Promise.all(
            deviceIds.map(async (deviceId) => {
                const [holder, waiters] = await Promise.all([this.holderOf(deviceId), this.waitersFor(deviceId)]);
                return {
                    deviceId,
                    holder: holder
                        ? {
                              // A torn read means somebody holds it but the record was
                              // mid-rewrite; say so rather than naming a phantom session.
                              sessionLabel: holder.unreadable ? "another session" : holder.sessionLabel,
                              reason: holder.reason ?? null,
                              acquiredAt: holder.acquiredAt ?? null,
                              isMine: holder.sessionId === this.owner.sessionId,
                          }
                        : null,
                    waiting: waiters.map((ticket, index) => ({
                        position: index + 1,
                        sessionLabel: ticket.sessionLabel,
                        reason: ticket.reason,
                        enqueuedAt: ticket.enqueuedAt,
                        isMine: ticket.sessionId === this.owner.sessionId,
                    })),
                };
            }),
        );
        return rows;
    }

    startHeartbeat() {
        if (this.heartbeat) {
            return;
        }
        this.heartbeat = setInterval(() => {
            void this.beat();
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeat.unref?.();
    }

    /**
     * Renews only records we still own. Writing unconditionally would let a beat
     * that was already in flight when we released recreate the holder file, or
     * overwrite the record of the session that took the device next.
     */
    async beat() {
        const now = Date.now();
        await Promise.all([
            ...Array.from(this.held.entries()).map(async ([deviceId, record]) => {
                const current = await this.readJson(this.holderPath(deviceId));
                if (!current || current.token !== record.token) {
                    // Somebody else owns it now, or it is already gone.
                    this.held.delete(deviceId);
                    return;
                }
                if (this.held.get(deviceId) !== record) {
                    return;
                }
                record.expiresAt = new Date(now + HOLDER_TTL_MS).toISOString();
                await writeRecordAtomic(this.holderPath(deviceId), record).catch(() => {});
            }),
            ...Array.from(this.tickets.values()).map(async (ticket) => {
                const key = `${ticket.deviceId}:${ticket.ticketId}`;
                if (!this.tickets.has(key)) {
                    return;
                }
                ticket.expiresAt = new Date(now + TICKET_TTL_MS).toISOString();
                // Withdrawn between the check and the write: do not recreate it.
                if (!this.tickets.has(key)) {
                    return;
                }
                await writeRecordAtomic(this.ticketPath(ticket.deviceId, ticket.ticketId), ticket).catch(() => {});
            }),
        ]);
    }

    stopHeartbeat() {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
    }
}

import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

/**
 * Shared primitives for the two on-disk coordination stores (claims and queue).
 *
 * Both publish small JSON records that other sessions read, both trust a record
 * only while its process is alive and its heartbeat is fresh, and both used to
 * carry their own copy of these rules. Keeping one copy means the liveness
 * definition cannot drift between "who has this device open" and "who gets it
 * next".
 */

export function safeName(value) {
    return String(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

export function processAlive(pid) {
    if (!Number.isInteger(pid)) {
        return false;
    }
    try {
        // Signal 0 tests for existence without touching the process.
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === "EPERM";
    }
}

/** A record is only trusted while its heartbeat is fresh *and* its writer still exists. */
export function isLive(record) {
    if (!record) {
        return false;
    }
    const expiresAt = record.expiresAt ? new Date(record.expiresAt).getTime() : 0;
    return expiresAt > Date.now() && processAlive(record.pid);
}

/**
 * Distinguishes "no such file" from "this file did not parse", which callers
 * must not treat alike: a torn read of a record being rewritten is not evidence
 * that the owning session is gone.
 */
export async function readRecord(file) {
    let raw;
    try {
        raw = await readFile(file, "utf8");
    } catch (error) {
        return error?.code === "ENOENT" ? { status: "missing", record: null } : { status: "unreadable", record: null };
    }
    try {
        return { status: "ok", record: JSON.parse(raw) };
    } catch {
        // Mid-write, or truncated by a crash. Either way it is not ours to judge.
        return { status: "unreadable", record: null };
    }
}

/**
 * Replaces a record in one step.
 *
 * Writing in place truncates the file first, so a concurrent reader can observe
 * an empty or half-written record. Readers that treat an unparseable record as a
 * dead one would then delete a live session's file. Renaming over the target is
 * atomic, so a reader sees either the old record or the new one.
 */
export async function writeRecordAtomic(file, payload) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(payload)}\n`, "utf8");
        await rename(temporary, file);
    } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
    }
}

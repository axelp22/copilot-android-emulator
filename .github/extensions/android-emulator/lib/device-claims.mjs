import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Control leases live in memory, so they only coordinate the canvases and agents
 * inside one Copilot session. Each session runs its own extension process, so
 * without a shared record two sessions can drive the same device at once and
 * neither can see the other.
 *
 * Claims are small files in a well-known directory on the host, since every
 * session that can reach a device over adb runs on the same machine. A claim is
 * only trusted while its owning process is alive and its heartbeat is fresh, so a
 * crashed session never leaves a device looking permanently taken.
 */

const HEARTBEAT_INTERVAL_MS = 15_000;
const CLAIM_TTL_MS = 45_000;

export function defaultClaimsRoot() {
    return path.join(os.homedir(), ".copilot", "android-emulator", "claims");
}

function safeName(value) {
    return String(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

function processAlive(pid) {
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

export class DeviceClaimStore {
    constructor({ root = defaultClaimsRoot(), owner = {} } = {}) {
        this.root = root;
        this.owner = {
            sessionId: owner.sessionId ?? `pid-${process.pid}`,
            workingDirectory: owner.workingDirectory ?? process.cwd(),
            pid: process.pid,
            ...owner,
        };
        this.claims = new Map();
        this.heartbeat = null;
    }

    setOwner(owner) {
        this.owner = { ...this.owner, ...owner };
    }

    label() {
        const directory = this.owner.workingDirectory;
        return directory ? path.basename(directory) : this.owner.sessionId;
    }

    filePath(deviceId) {
        return path.join(this.root, `${safeName(deviceId)}__${safeName(this.owner.sessionId)}.json`);
    }

    /** Record, or upgrade, this session's use of a device. */
    async claim(deviceId, { mode = "open", reason = null } = {}) {
        this.claims.set(deviceId, { mode, reason });
        await this.flush(deviceId).catch(() => {});
        this.ensureHeartbeat();
    }

    async release(deviceId) {
        this.claims.delete(deviceId);
        if (this.claims.size === 0) {
            this.stopHeartbeat();
        }
        await unlink(this.filePath(deviceId)).catch(() => {});
    }

    async releaseAll() {
        const deviceIds = Array.from(this.claims.keys());
        this.claims.clear();
        this.stopHeartbeat();
        await Promise.allSettled(deviceIds.map((deviceId) => unlink(this.filePath(deviceId)).catch(() => {})));
    }

    async flush(deviceId) {
        const entry = this.claims.get(deviceId);
        if (!entry) {
            return;
        }
        await mkdir(this.root, { recursive: true });
        const payload = {
            deviceId,
            mode: entry.mode,
            reason: entry.reason,
            sessionId: this.owner.sessionId,
            sessionLabel: this.label(),
            workingDirectory: this.owner.workingDirectory,
            pid: this.owner.pid,
            updatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
        };
        await writeFile(this.filePath(deviceId), `${JSON.stringify(payload)}\n`, "utf8");
    }

    ensureHeartbeat() {
        if (this.heartbeat || this.claims.size === 0) {
            return;
        }
        this.heartbeat = setInterval(() => {
            for (const deviceId of this.claims.keys()) {
                void this.flush(deviceId).catch(() => {});
            }
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeat.unref?.();
    }

    stopHeartbeat() {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
    }

    /** Live claims held by *other* sessions, keyed by device id. */
    async foreignClaims() {
        const byDevice = new Map();
        let entries = [];
        try {
            entries = await readdir(this.root);
        } catch {
            return byDevice;
        }

        const now = Date.now();
        await Promise.all(
            entries
                .filter((name) => name.endsWith(".json"))
                .map(async (name) => {
                    const file = path.join(this.root, name);
                    let claim;
                    try {
                        claim = JSON.parse(await readFile(file, "utf8"));
                    } catch {
                        return;
                    }
                    if (claim.sessionId === this.owner.sessionId) {
                        return;
                    }
                    const expired = !claim.expiresAt || new Date(claim.expiresAt).getTime() < now;
                    if (expired || !processAlive(claim.pid)) {
                        // The owning session is gone; do not let it hold the device forever.
                        await unlink(file).catch(() => {});
                        return;
                    }
                    const existing = byDevice.get(claim.deviceId);
                    // A control claim is more important than a mere open one.
                    if (!existing || (existing.mode !== "control" && claim.mode === "control")) {
                        byDevice.set(claim.deviceId, claim);
                    }
                }),
        );
        return byDevice;
    }
}

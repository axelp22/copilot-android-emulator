import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Windows refuses to replace a file another handle has open (an overlapping
 * rename, antivirus, the indexer); those clear within milliseconds.
 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];

function safeFileName(instanceId) {
    return `${String(instanceId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

let tempCounter = 0;

export class CanvasBindingStore {
    constructor(root, { renameFile = rename, sleep = delay, retryDelaysMs = RENAME_RETRY_DELAYS_MS } = {}) {
        this.root = root;
        this.renameFile = renameFile;
        this.sleep = sleep;
        this.retryDelaysMs = retryDelaysMs;
        /** Per-instance write chains, so writes land one at a time in call order. */
        this.writes = new Map();
    }

    #serialize(instanceId, fn) {
        const key = String(instanceId);
        const previous = this.writes.get(key) ?? Promise.resolve();
        const run = previous.then(fn, fn);
        const tail = run.catch(() => {});
        this.writes.set(key, tail);
        void tail.then(() => {
            if (this.writes.get(key) === tail) {
                this.writes.delete(key);
            }
        });
        return run;
    }

    async #rename(from, to) {
        for (let attempt = 0; ; attempt += 1) {
            try {
                await this.renameFile(from, to);
                return;
            } catch (error) {
                if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt >= this.retryDelaysMs.length) {
                    throw error;
                }
                await this.sleep(this.retryDelaysMs[attempt]);
            }
        }
    }

    filePath(instanceId) {
        return path.join(this.root, safeFileName(instanceId));
    }

    async get(instanceId) {
        let raw;
        try {
            raw = await readFile(this.filePath(instanceId), "utf8");
        } catch {
            return undefined;
        }
        let payload;
        try {
            payload = JSON.parse(raw);
        } catch {
            // A truncated or corrupt file (e.g. from a crash before writes were
            // atomic) would otherwise be re-read, and ignored, on every reopen.
            await this.delete(instanceId).catch(() => {});
            return undefined;
        }
        return typeof payload?.deviceId === "string" || payload?.deviceId === null ? payload.deviceId : undefined;
    }

    set(instanceId, deviceId) {
        return this.#serialize(instanceId, () => this.#write(instanceId, deviceId));
    }

    async #write(instanceId, deviceId) {
        await mkdir(this.root, { recursive: true });
        const target = this.filePath(instanceId);
        // Write then rename so a reopen racing this write, or a crash mid-write,
        // never observes a half-written binding.
        const temp = `${target}.${process.pid}.${++tempCounter}.tmp`;
        try {
            await writeFile(temp, `${JSON.stringify({ deviceId })}\n`, "utf8");
            await this.#rename(temp, target);
        } catch (error) {
            await unlink(temp).catch(() => {});
            throw error;
        }
    }

    delete(instanceId) {
        return this.#serialize(instanceId, () => this.#remove(instanceId));
    }

    async #remove(instanceId) {
        try {
            await unlink(this.filePath(instanceId));
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }
}

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

function safeFileName(instanceId) {
    return `${String(instanceId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

let tempCounter = 0;

export class CanvasBindingStore {
    constructor(root) {
        this.root = root;
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

    async set(instanceId, deviceId) {
        await mkdir(this.root, { recursive: true });
        const target = this.filePath(instanceId);
        // Write then rename so a reopen racing this write, or a crash mid-write,
        // never observes a half-written binding.
        const temp = `${target}.${process.pid}.${++tempCounter}.tmp`;
        try {
            await writeFile(temp, `${JSON.stringify({ deviceId })}\n`, "utf8");
            await rename(temp, target);
        } catch (error) {
            await unlink(temp).catch(() => {});
            throw error;
        }
    }

    async delete(instanceId) {
        try {
            await unlink(this.filePath(instanceId));
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }
}

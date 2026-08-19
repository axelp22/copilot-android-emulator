import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

function safeFileName(instanceId) {
    return `${String(instanceId).replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

export class CanvasBindingStore {
    constructor(root) {
        this.root = root;
    }

    filePath(instanceId) {
        return path.join(this.root, safeFileName(instanceId));
    }

    async get(instanceId) {
        try {
            const payload = JSON.parse(await readFile(this.filePath(instanceId), "utf8"));
            return typeof payload.deviceId === "string" || payload.deviceId === null ? payload.deviceId : undefined;
        } catch (error) {
            if (error?.code === "ENOENT") {
                return undefined;
            }
            return undefined;
        }
    }

    async set(instanceId, deviceId) {
        await mkdir(this.root, { recursive: true });
        await writeFile(this.filePath(instanceId), `${JSON.stringify({ deviceId })}\n`, "utf8");
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

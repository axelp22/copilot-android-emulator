import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, "..");
export const extensionRoot = path.join(repoRoot, ".github", "extensions", "android-emulator");

/** Imports an extension module. Dynamic import() needs a file: URL: a raw absolute Windows path reads as a URL scheme. */
export function extensionModule(...segments) {
    return import(pathToFileURL(path.join(extensionRoot, ...segments)).href);
}

/** A temporary directory removed when the test ends, pass or fail. */
export async function tempDir(t, prefix = "android-emulator-test-") {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    return dir;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `predicate` until it holds, failing with `message` after `timeoutMs`. */
export async function waitUntil(predicate, { timeoutMs = 5_000, intervalMs = 20, message = "condition" } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for ${message}`);
}

/** Whether a pid is still running. */
export function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
});

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** A valid solid-colour RGB PNG, so a real browser can decode what a fake stream sends. */
export function solidPng(width, height, [r, g, b]) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
        row[1 + x * 3] = r;
        row[2 + x * 3] = g;
        row[3 + x * 3] = b;
    }
    const raw = Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

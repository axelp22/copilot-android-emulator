import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const extensionRoot = path.resolve(here, "..", "..", ".github", "extensions", "android-emulator");

/** Every knob these suites need, overridable from the environment. */
export const config = {
    /** Stable device id: an AVD name for emulators, a serial for physical devices. */
    deviceId: process.env.VERIFY_DEVICE_ID ?? "Pixel_10_Pro_XL",
    /** adb serial of the same device, used for out-of-band checks. */
    serial: process.env.VERIFY_SERIAL ?? "emulator-5554",
    /** A shut-down AVD the lifecycle suite may boot and stop again. */
    bootAvd: process.env.VERIFY_BOOT_AVD ?? "lowend_api34",
    adb: process.env.VERIFY_ADB ?? "adb",
    chrome: process.env.VERIFY_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    artifactsRoot: process.env.VERIFY_ARTIFACTS ?? "/tmp/android-emulator-verify",
};

export function createReporter(suiteName) {
    const results = [];
    return {
        assert(condition, name, detail = "") {
            const line = `${condition ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`;
            results.push(line);
            console.log(line);
            return Boolean(condition);
        },
        skip(name, reason) {
            results.push(`SKIP ${name} — ${reason}`);
            console.log(`SKIP ${name} — ${reason}`);
        },
        note(message) {
            console.error(`[${suiteName}] ${message}`);
        },
        finish() {
            const failures = results.filter((line) => line.startsWith("FAIL"));
            const skipped = results.filter((line) => line.startsWith("SKIP"));
            const total = results.length - skipped.length;
            console.log(
                `\n${suiteName}: ${total - failures.length}/${total} checks passed` +
                    (skipped.length > 0 ? ` (${skipped.length} skipped)` : ""),
            );
            process.exit(failures.length === 0 ? 0 : 1);
        },
    };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function adb(args, { buffer = false, serial = config.serial } = {}) {
    const full = serial ? ["-s", serial, ...args] : args;
    return new Promise((resolve, reject) => {
        execFile(
            config.adb,
            full,
            { encoding: buffer ? "buffer" : "utf8", maxBuffer: 64 * 1024 * 1024 },
            (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout)),
        );
    });
}

/** Incrementally decodes the `[uint32 length][uint8 tag][payload]` canvas framing. */
export function createFrameReader() {
    let buffer = Buffer.alloc(0);
    return function push(chunk) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        const frames = [];
        let offset = 0;
        while (buffer.length - offset >= 5) {
            const length = buffer.readUInt32BE(offset);
            if (buffer.length - offset < 4 + length) {
                break;
            }
            frames.push({ tag: buffer[offset + 4], payload: Buffer.from(buffer.subarray(offset + 5, offset + 4 + length)) });
            offset += 4 + length;
        }
        buffer = buffer.subarray(offset);
        return frames;
    };
}

/** Rebuilds an Annex-B elementary stream from AVCC samples so ffprobe can read it. */
export function avccToAnnexB(sample) {
    const parts = [];
    let offset = 0;
    while (offset + 4 <= sample.length) {
        const length = sample.readUInt32BE(offset);
        offset += 4;
        if (length === 0 || offset + length > sample.length) {
            break;
        }
        parts.push(Buffer.from([0, 0, 0, 1]), Buffer.from(sample.subarray(offset, offset + length)));
        offset += length;
    }
    return Buffer.concat(parts);
}

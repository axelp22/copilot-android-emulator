import { execFile, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

let cachedToolchain = null;

async function isExecutable(candidate) {
    if (!candidate) {
        return false;
    }
    try {
        await access(candidate, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function sdkRoots() {
    const roots = [];
    if (process.env.ANDROID_HOME) {
        roots.push(process.env.ANDROID_HOME);
    }
    if (process.env.ANDROID_SDK_ROOT) {
        roots.push(process.env.ANDROID_SDK_ROOT);
    }
    const home = os.homedir();
    if (process.platform === "darwin") {
        roots.push(path.join(home, "Library", "Android", "sdk"));
    }
    roots.push(path.join(home, "Android", "Sdk"));
    roots.push(path.join(home, "AppData", "Local", "Android", "Sdk"));
    return roots.filter(Boolean);
}

function executableName(name) {
    return process.platform === "win32" ? `${name}.exe` : name;
}

async function resolveOnPath(name) {
    const finder = process.platform === "win32" ? "where" : "which";
    try {
        const { stdout } = await execFileAsync(finder, [name], { encoding: "utf8", timeout: 10_000 });
        const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        return (await isExecutable(first)) ? first : null;
    } catch {
        return null;
    }
}

async function resolveTool(name, relativeDirs) {
    for (const root of sdkRoots()) {
        for (const relativeDir of relativeDirs) {
            const candidate = path.join(root, relativeDir, executableName(name));
            if (await isExecutable(candidate)) {
                return candidate;
            }
        }
    }
    return await resolveOnPath(name);
}

/**
 * Resolve `adb` and `emulator`, preferring an explicit SDK root over `PATH`.
 * The result is cached because SDK layout does not change while the extension runs.
 */
export async function resolveToolchain({ refresh = false } = {}) {
    if (cachedToolchain && !refresh) {
        return cachedToolchain;
    }

    const [adbPath, emulatorPath] = await Promise.all([
        resolveTool("adb", ["platform-tools"]),
        resolveTool("emulator", ["emulator", path.join("tools")]),
    ]);

    cachedToolchain = {
        adbPath,
        emulatorPath,
        sdkRoots: sdkRoots(),
    };
    return cachedToolchain;
}

export async function requireAdb() {
    const { adbPath } = await resolveToolchain();
    if (!adbPath) {
        throw new AppError(
            "adb_not_found",
            "Could not find `adb`. Install the Android SDK platform-tools and set ANDROID_HOME, or put `adb` on PATH.",
            500,
        );
    }
    return adbPath;
}

export async function requireEmulatorBinary() {
    const { emulatorPath } = await resolveToolchain();
    if (!emulatorPath) {
        throw new AppError(
            "emulator_not_found",
            "Could not find the Android `emulator` binary. Install the SDK emulator package and set ANDROID_HOME, or put `emulator` on PATH.",
            500,
        );
    }
    return emulatorPath;
}

function describeExecError(error, fallback) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    const stdout = error?.stdout ? String(error.stdout).trim() : "";
    return stderr || stdout || error?.message || fallback;
}

/** Run `adb <args>` and return trimmed stdout as UTF-8 text. */
export async function adb(args, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    const adbPath = await requireAdb();
    try {
        const { stdout } = await execFileAsync(adbPath, args, {
            encoding: "utf8",
            maxBuffer: MAX_BUFFER,
            timeout,
        });
        return stdout;
    } catch (error) {
        throw new AppError("adb_error", describeExecError(error, `adb ${args.join(" ")} failed`), 502);
    }
}

/** Run `adb <args>` and return raw stdout bytes (for `exec-out` binary payloads). */
export async function adbBuffer(args, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    const adbPath = await requireAdb();
    try {
        const { stdout } = await execFileAsync(adbPath, args, {
            encoding: "buffer",
            maxBuffer: MAX_BUFFER,
            timeout,
        });
        return stdout;
    } catch (error) {
        throw new AppError("adb_error", describeExecError(error, `adb ${args.join(" ")} failed`), 502);
    }
}

/** Spawn `adb <args>` without buffering, for long-lived streams. */
export async function spawnAdb(args, options = {}) {
    const adbPath = await requireAdb();
    return spawn(adbPath, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
}

export async function adbShell(serial, command, options = {}) {
    return await adb(["-s", serial, "shell", ...command], options);
}

export async function adbExecOut(serial, command, options = {}) {
    return await adbBuffer(["-s", serial, "exec-out", ...command], options);
}

export async function adbVersion() {
    const stdout = await adb(["version"]);
    const line = stdout.split(/\r?\n/).find((entry) => entry.includes("version")) ?? stdout.trim();
    return line.trim();
}

export async function startAdbServer() {
    await adb(["start-server"], { timeout: 30_000 });
}

/** Parse `adb devices -l` into `{ serial, state, properties }` entries. */
export async function listAttached() {
    const stdout = await adb(["devices", "-l"]);
    const entries = [];
    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("List of devices")) {
            continue;
        }
        const [serial, state, ...rest] = trimmed.split(/\s+/);
        if (!serial || !state) {
            continue;
        }
        const properties = {};
        for (const token of rest) {
            const separator = token.indexOf(":");
            if (separator > 0) {
                properties[token.slice(0, separator)] = token.slice(separator + 1);
            }
        }
        entries.push({ serial, state, properties });
    }
    return entries;
}

/** `adb -s <serial> emu avd name` prints the AVD name, then `OK`. */
export async function emulatorAvdName(serial) {
    try {
        const stdout = await adb(["-s", serial, "emu", "avd", "name"], { timeout: 15_000 });
        const first = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0 && line !== "OK");
        return first ?? null;
    } catch {
        return null;
    }
}

export async function listAvds() {
    const emulatorPath = await requireEmulatorBinary();
    try {
        const { stdout } = await execFileAsync(emulatorPath, ["-list-avds"], {
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: MAX_BUFFER,
        });
        return stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.includes(" "));
    } catch (error) {
        throw new AppError("emulator_list_failed", describeExecError(error, "emulator -list-avds failed"), 502);
    }
}

export async function getProps(serial, names) {
    const results = {};
    await Promise.all(
        names.map(async (name) => {
            try {
                const value = await adbShell(serial, ["getprop", name], { timeout: 15_000 });
                results[name] = value.trim();
            } catch {
                results[name] = "";
            }
        }),
    );
    return results;
}

/** `wm size` reports `Physical size:` and optionally an `Override size:` that wins. */
export async function getWmSize(serial) {
    const stdout = await adbShell(serial, ["wm", "size"], { timeout: 15_000 });
    const override = stdout.match(/Override size:\s*(\d+)x(\d+)/i);
    const physical = stdout.match(/Physical size:\s*(\d+)x(\d+)/i);
    const chosen = override ?? physical;
    if (!chosen) {
        return null;
    }
    return { width: Number(chosen[1]), height: Number(chosen[2]) };
}

export async function getWmDensity(serial) {
    try {
        const stdout = await adbShell(serial, ["wm", "density"], { timeout: 15_000 });
        const override = stdout.match(/Override density:\s*(\d+)/i);
        const physical = stdout.match(/Physical density:\s*(\d+)/i);
        const chosen = override ?? physical;
        return chosen ? Number(chosen[1]) : null;
    } catch {
        return null;
    }
}

/** Effective display rotation (0-3), read from the window manager rather than the setting. */
export async function getDisplayRotation(serial) {
    try {
        const stdout = await adbShell(serial, ["dumpsys", "window", "displays"], { timeout: 20_000 });
        const match = stdout.match(/mDisplayRotation=ROTATION_(\d+)/) ?? stdout.match(/\bmRotation=ROTATION_(\d+)/);
        if (match) {
            return Math.round(Number(match[1]) / 90) % 4;
        }
    } catch {
        // fall through to the persisted user setting
    }
    try {
        const stdout = await adbShell(serial, ["settings", "get", "system", "user_rotation"], { timeout: 15_000 });
        const value = Number(stdout.trim());
        return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 0;
    } catch {
        return 0;
    }
}

export async function isBootCompleted(serial) {
    try {
        const stdout = await adbShell(serial, ["getprop", "sys.boot_completed"], { timeout: 10_000 });
        return stdout.trim() === "1";
    } catch {
        return false;
    }
}

export function parsePngDimensions(buffer) {
    if (!buffer || buffer.length < 24) {
        throw new AppError("png_parse_error", "Screenshot PNG is too small to parse dimensions.", 502);
    }
    if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new AppError("png_parse_error", "Screenshot payload is not a PNG image.", 502);
    }
    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
    };
}

export async function screencapPng(serial) {
    const image = await adbExecOut(serial, ["screencap", "-p"], { timeout: 30_000 });
    if (!image || image.length === 0) {
        throw new AppError("screenshot_failed", "screencap returned no image data.", 502);
    }
    return image;
}

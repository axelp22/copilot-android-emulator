/**
 * Locates running emulators through the discovery files the emulator writes on
 * startup.
 *
 * Every running emulator drops a `pid_<pid>.ini` describing how to reach it,
 * including the gRPC port and the directory where a client publishes its public
 * key. Reading these is what lets the extension attach to emulators it did not
 * launch itself — one started from Android Studio, for example.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Candidate discovery roots, most specific first. The emulator picks its
 * location from the platform's per-user temp directory.
 */
export function discoveryRoots() {
    const roots = [];
    const home = os.homedir();
    if (process.platform === "darwin") {
        roots.push(path.join(home, "Library", "Caches", "TemporaryItems", "avd", "running"));
    } else if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
        roots.push(path.join(localAppData, "Temp", "avd", "running"));
    } else {
        if (process.env.XDG_RUNTIME_DIR) {
            roots.push(path.join(process.env.XDG_RUNTIME_DIR, "avd", "running"));
        }
        if (typeof process.getuid === "function") {
            roots.push(path.join("/run", "user", String(process.getuid()), "avd", "running"));
        }
        roots.push(path.join(os.tmpdir(), "avd", "running"));
    }
    return roots;
}

/**
 * The files are `key=value` per line, but `cmdline` embeds quoted arguments
 * containing `=`, so only the first separator may be split on.
 */
export function parseDiscoveryIni(text) {
    const entries = {};
    for (const line of text.split(/\r?\n/)) {
        const separator = line.indexOf("=");
        if (separator <= 0) {
            continue;
        }
        entries[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    return entries;
}

function toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/** A discovery file outlives a crashed emulator, so confirm the process exists. */
function isProcessAlive(pid) {
    if (!pid) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the process exists but belongs to someone else.
        return error?.code === "EPERM";
    }
}

function toRecord(entries, pid) {
    const grpcPort = toNumber(entries["grpc.port"]);
    const consolePort = toNumber(entries["port.serial"]);
    return {
        pid,
        grpcPort,
        // `-grpc` (no JWT) leaves no jwks directory; that emulator needs no token.
        jwksDir: entries["grpc.jwks"] ?? null,
        token: entries["grpc.token"] ?? null,
        consolePort,
        adbPort: toNumber(entries["port.adb"]),
        // adb names emulators after the console port, which is how a discovery
        // record is matched to the serial the rest of the extension already uses.
        serial: consolePort ? `emulator-${consolePort}` : null,
        avdName: entries["avd.name"] ?? null,
        avdId: entries["avd.id"] ?? null,
        emulatorVersion: entries["emulator.version"] ?? null,
        // The launch command reveals which allowlist the emulator booted with,
        // which decides the token issuer this extension is allowed to claim.
        cmdline: entries.cmdline ?? "",
    };
}

/**
 * A discovery file tells us where to connect and which directory to write a
 * signing key into, so it is only trusted when the current user owns it.
 *
 * On Linux the fallback root is the shared system temp directory, where another
 * user's emulator — or a file planted to look like one — would otherwise be
 * treated as ours. `lstat` rather than `stat`: a symlink owned by us can point
 * at a file that is not.
 */
async function isOwnedByCurrentUser(target) {
    if (typeof process.getuid !== "function") {
        // Windows has no uid; the per-user LOCALAPPDATA root is the boundary there.
        return true;
    }
    try {
        const stats = await lstat(target);
        return stats.isSymbolicLink() ? false : stats.uid === process.getuid();
    } catch {
        return false;
    }
}

/** All live emulators that published a discovery file we trust. */
export async function listRunningEmulators() {
    const found = [];
    const seen = new Set();
    for (const root of discoveryRoots()) {
        let names;
        try {
            names = await readdir(root);
        } catch {
            continue;
        }
        for (const name of names) {
            const match = /^pid_(\d+)\.ini$/.exec(name);
            if (!match) {
                continue;
            }
            const pid = Number(match[1]);
            if (seen.has(pid) || !isProcessAlive(pid)) {
                continue;
            }
            const file = path.join(root, name);
            if (!(await isOwnedByCurrentUser(file))) {
                continue;
            }
            try {
                const record = toRecord(parseDiscoveryIni(await readFile(file, "utf8")), pid);
                if (!record.grpcPort) {
                    continue;
                }
                // The key directory is writable state named by a file we just
                // read, so it needs the same ownership check rather than
                // inheriting trust from the discovery file.
                if (record.jwksDir && !(await isOwnedByCurrentUser(record.jwksDir))) {
                    continue;
                }
                seen.add(pid);
                found.push(record);
            } catch {
                // A half-written file during emulator startup is expected; the next
                // refresh picks it up.
            }
        }
    }
    return found;
}

/** Resolve the discovery record for an adb serial such as `emulator-5554`. */
export async function findEmulatorBySerial(serial) {
    if (!serial) {
        return null;
    }
    const running = await listRunningEmulators();
    return running.find((entry) => entry.serial === serial) ?? null;
}

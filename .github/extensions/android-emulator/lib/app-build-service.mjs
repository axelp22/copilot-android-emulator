import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppError } from "./errors.mjs";

const CONFIG_FILENAMES = [".android-emulator.json", "android-emulator.json", ".github/android-emulator.json"];
const DEFAULT_TASK = "installDebug";
const MAX_LOG_LINES = 400;

/**
 * Gradle reads a leading `-` as an option, and options such as
 * `--init-script=<file>` run a chosen script before the build starts. Task names
 * never begin with one.
 *
 * This is not a sandbox, and must not be mistaken for one: running any
 * repository's `gradlew` already executes that repository's build logic. What it
 * removes is the ability to turn the *task argument itself* -- which arrives
 * from a tool call or from `.android-emulator.json` -- into a different command
 * than the build the user asked for.
 */
function assertSafeTask(task) {
    const value = String(task ?? "").trim();
    if (value.startsWith("-") || !/^:?[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)*$/.test(value)) {
        throw new AppError(
            "invalid_gradle_task",
            `Refusing to run "${value}": expected a Gradle task name such as ":app:installDebug".`,
            400,
        );
    }
    return value;
}

/**
 * The wrapper Gradle generates for each platform. Windows cannot execute the
 * POSIX `gradlew` script, and POSIX systems cannot run `gradlew.bat`.
 */
function wrapperNameFor(platform) {
    return platform === "win32" ? "gradlew.bat" : "gradlew";
}

/** Walks up from `from` looking for a Gradle wrapper, so nested module dirs work. */
export async function findGradleRoot(from, { platform = process.platform } = {}) {
    const wrapperName = wrapperNameFor(platform);
    // Windows has no execute bit: X_OK there only tests existence.
    const mode = platform === "win32" ? constants.F_OK : constants.X_OK;
    let dir = path.resolve(from);
    for (let depth = 0; depth < 8; depth += 1) {
        const wrapper = path.join(dir, wrapperName);
        if (await access(wrapper, mode).then(() => true).catch(() => false)) {
            return { root: dir, wrapper, wrapperName };
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return null;
}

/**
 * How to start the wrapper on `platform`.
 *
 * POSIX runs the executable script directly, with no shell in between. Windows
 * cannot: Node refuses to spawn a `.bat` without a shell (CVE-2024-27980), so the
 * batch file goes through `cmd.exe` explicitly, with the whole command line
 * built here rather than by Node's generic shell quoting.
 *
 * `cmd /s /c "<line>"` strips exactly the outer pair of quotes and runs `<line>`,
 * in which the wrapper path and the task are each double-quoted, so spaces and
 * `& | < > ( ) ^` in a project path are literal. Delayed expansion is forced off
 * (`/v:off`) so `!` is literal too. `%` cannot be escaped inside quotes on a cmd
 * command line, and `"` cannot appear in a Windows path, so paths containing
 * either are refused with an explanation instead of being run as something
 * else. The task itself has already been limited to Gradle task-name characters
 * by assertSafeTask.
 *
 * Every build runs with `--no-daemon` and the extension's own `--init-script`,
 * so its executor can be identified and stopped (see "the build executor"
 * below). Both come before the task and from the extension, never from input.
 */
export function gradleInvocation({ wrapper, task, initScript, platform = process.platform, comSpec = process.env.ComSpec }) {
    const options = ["--no-daemon", "--init-script", initScript];
    if (platform !== "win32") {
        return { command: wrapper, args: [...options, task], options: { detached: true }, display: `./gradlew --no-daemon ${task}` };
    }
    for (const file of [wrapper, initScript]) {
        if (/["%\x00-\x1f]/.test(file)) {
            throw new AppError(
                "unsupported_gradle_path",
                `Cannot run "${file}" safely through cmd.exe: the path contains a quote, "%", or a control character. ` +
                    "Move it to a path without them.",
                400,
            );
        }
    }
    const line = `"${wrapper}" --no-daemon --init-script "${initScript}" "${task}"`;
    return {
        command: comSpec || "cmd.exe",
        args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
        options: { windowsHide: true, windowsVerbatimArguments: true },
        display: `gradlew.bat --no-daemon ${task}`,
    };
}

async function readConfig(workingDirectory) {
    for (const name of CONFIG_FILENAMES) {
        const file = path.join(workingDirectory, name);
        const raw = await readFile(file, "utf8").catch(() => null);
        if (raw === null) {
            continue;
        }
        try {
            return { file, config: JSON.parse(raw) };
        } catch (error) {
            throw new AppError("invalid_build_config", `${name} is not valid JSON: ${error.message}`, 400);
        }
    }
    return { file: null, config: {} };
}

/**
 * Splits a Gradle task path into the project it names and the task itself.
 * `:app:installDebug` and `app:installDebug` both name the `app` project (Gradle
 * runs from the root, so a relative path resolves from there), `:installDebug`
 * names the root project, and a bare `installDebug` names no project at all:
 * Gradle runs it in every project that has it.
 */
export function parseTaskPath(task) {
    const parts = String(task).split(":");
    const name = parts.pop() ?? "";
    return { name, projectSegments: parts.filter(Boolean), qualified: parts.length > 0 };
}

/** `installFreeDebug` -> `freeDebug`; null when the task does not name a variant. */
export function variantFromTask(name) {
    const match = /^(?:install|assemble|package)([A-Z][A-Za-z0-9_]*)$/.exec(String(name));
    return match ? match[1][0].toLowerCase() + match[1].slice(1) : null;
}

/**
 * Every `output-metadata.json` under one module's `build/outputs/apk`. Flavored
 * variants nest as apk/<flavor>/<buildType>/, plain ones as apk/<buildType>/,
 * so the depth is not fixed.
 */
async function moduleMetadata(moduleDir) {
    const apkRoot = path.join(moduleDir, "build", "outputs", "apk");
    const found = [];
    async function collect(dir, depth) {
        if (depth > 3) {
            return;
        }
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isDirectory()) {
                await collect(path.join(dir, entry.name), depth + 1);
            } else if (entry.name === "output-metadata.json") {
                const file = path.join(dir, entry.name);
                const parsed = await readFile(file, "utf8")
                    .then((raw) => JSON.parse(raw))
                    .catch(() => null);
                if (parsed?.applicationId) {
                    const relativeDir = path.relative(apkRoot, dir).split(path.sep).filter(Boolean);
                    found.push({ file, moduleDir, relativeDir, applicationId: parsed.applicationId, variantName: parsed.variantName ?? null });
                }
            }
        }
    }
    await collect(apkRoot, 0);
    return found;
}

/** Module directories of a multi-project build, for a task that names no project. */
async function allModuleDirs(gradleRoot) {
    const dirs = [gradleRoot];
    async function walk(dir, depth) {
        if (depth > 4) {
            return;
        }
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === "build" || entry.name.startsWith(".") || entry.name === "node_modules") {
                continue;
            }
            const child = path.join(dir, entry.name);
            dirs.push(child);
            await walk(child, depth + 1);
        }
    }
    await walk(gradleRoot, 0);
    return dirs;
}

/**
 * AGP records the variant in output-metadata.json; older versions did not, and
 * then the directory (apk/free/debug for `freeDebug`) is the variant name.
 */
function matchesVariant(candidate, variant) {
    const wanted = variant.toLowerCase();
    if (candidate.variantName) {
        return candidate.variantName.toLowerCase() === wanted;
    }
    return candidate.relativeDir.join("").toLowerCase() === wanted;
}

/**
 * The application id is needed to launch what was just installed. AGP writes it
 * next to the APK, which beats parsing build output or diffing installed
 * packages.
 *
 * The answer is read from the exact module and variant the task names, never
 * from whichever metadata is newest: an UP-TO-DATE `installDebug` leaves the
 * debug metadata older than a release build made earlier, and launching the
 * release app after installing debug is worse than not launching at all. When
 * the task does not pin one app, this throws rather than guessing.
 */
export async function resolveApplicationId(gradleRoot, task) {
    const { name, projectSegments, qualified } = parseTaskPath(task);
    const variant = variantFromTask(name);
    const moduleDirs = qualified ? [path.join(gradleRoot, ...projectSegments)] : await allModuleDirs(gradleRoot);
    const where = qualified ? path.relative(gradleRoot, moduleDirs[0]) || "the root project" : "any module";

    const candidates = (await Promise.all(moduleDirs.map(moduleMetadata))).flat();
    const matching = variant ? candidates.filter((candidate) => matchesVariant(candidate, variant)) : candidates;
    const ids = Array.from(new Set(matching.map((candidate) => candidate.applicationId)));
    const advice =
        'Set "packageName" in .android-emulator.json, or use a module-qualified task such as ":app:installDebug".';

    if (ids.length === 1) {
        return { applicationId: ids[0], metadataFile: matching[0].file };
    }
    if (ids.length === 0) {
        throw new AppError(
            "app_not_resolved",
            `${task} finished, but no build output for ${variant ? `variant "${variant}"` : "it"} was found in ${where}, ` +
                `so the app to launch is unknown. ${advice}`,
            422,
        );
    }
    const listing = matching
        .map((candidate) => `${path.relative(gradleRoot, candidate.moduleDir) || "."}: ${candidate.applicationId}`)
        .join(", ");
    throw new AppError(
        "app_ambiguous",
        `${task} matches more than one app (${listing}), so which one to launch is ambiguous. ${advice}`,
        409,
    );
}

const TERMINATE_KILL_WAIT_MS = 3_000;
/**
 * How long a build that ended on its own may take for its executor to exit
 * before it is stopped. Only ever followed by a stop and a confirmation: the
 * wait passing is never treated as the executor being gone.
 */
const EXECUTOR_EXIT_WAIT_MS = 5_000;
/** Build output can arrive thousands of lines at a time; the canvas needs a few updates a second. */
const PUBLISH_INTERVAL_MS = 250;
const EXIT_POLL_MS = 1_000;
const STOP_POLL_MS = 50;
/**
 * How often a running build's process tree is observed, so an executor that
 * wrote no record is still known after its client exits (liveBuildProcesses).
 */
const LINEAGE_POLL_MS = 500;
const EXECUTOR_MARKER_FORMAT = 1;
/** ps reports start times to the second, Java to the millisecond. */
const START_MATCH_SLACK_MS = 2_000;
/**
 * Set, with a random value, in the environment of every build. Processes inherit
 * it however they are started -- reparented, in a new session, after the client
 * that started them has died -- so a live process carrying it is this build's,
 * even one no observation saw (see processSnapshot).
 */
export const BUILD_TAG_ENV = "COPILOT_ANDROID_BUILD_TAG";

function cancelledError(run) {
    return new AppError("build_cancelled", run.cancelReason ?? "The build was cancelled.", 409);
}

/** Settles with `promise`, or rejects as soon as the run is cancelled, whichever is first. */
function unlessCancelled(run, promise) {
    const { signal } = run.abort;
    if (signal.aborted) {
        return Promise.reject(cancelledError(run));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(cancelledError(run));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

function waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const tick = () => {
            if (predicate()) {
                resolve(true);
            } else if (Date.now() - startedAt >= timeoutMs) {
                resolve(false);
            } else {
                setTimeout(tick, 50);
            }
        };
        tick();
    });
}

/** Does not keep the process alive: for watches that may never end. */
function pause(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/** Keeps the process alive: for bounded waits whose outcome decides a release. */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === "EPERM";
    }
}

// --- the build executor ------------------------------------------------------------
//
// Gradle runs a build in a daemon, not in the client `gradlew` starts, and a
// daemon -- even the single-use one `--no-daemon` forks -- calls setsid(), so it
// is outside the wrapper's process group and survives the client. Stopping the
// client therefore does not stop the build: a task already running, an install
// included, carries on. Every build is consequently run so that its executor
// can be identified exactly and stopped:
//
//   * `--no-daemon`: never a persistent daemon, which is shared with other builds
//     and may already be running someone else's; at most a single-use one this
//     build forks, as a child of its client.
//   * `--init-script` with the trusted script below: the process that evaluates
//     init scripts is the one that runs the tasks, and it records its pid, start
//     time and ancestry before any task can run.
//
// See ownedProcesses() for how those identify what is stopped.

export function defaultExecutorDir() {
    return path.join(os.homedir(), ".copilot", "android-emulator", "gradle");
}

export function executorPaths(executorDir) {
    return { initScript: path.join(executorDir, "build-executor.init.gradle"), markerDir: path.join(executorDir, "executors") };
}

function groovyString(value) {
    return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The init script. Its content depends only on `markerDir`, so it is identical
 * from build to build and does not invalidate Gradle's configuration cache. It
 * reads no build input and never fails the build. When the configuration cache
 * is reused, Gradle skips init scripts and no record is written; the executor
 * is then identified by ancestry alone (see ownedProcesses).
 */
export function executorInitScript(markerDir) {
    return [
        "// Written by the Android Emulator Copilot extension. Records which process runs",
        "// this build, so cancelling it can stop exactly that process and confirm it gone.",
        "try {",
        "    def self = ProcessHandle.current()",
        "    def ancestors = []",
        "    def parent = self.parent()",
        "    while (parent.isPresent() && ancestors.size() < 8) {",
        "        ancestors << parent.get().pid()",
        "        parent = parent.get().parent()",
        "    }",
        `    def dir = new File(${groovyString(markerDir)})`,
        "    dir.mkdirs()",
        "    def record = groovy.json.JsonOutput.toJson([",
        `        format: ${EXECUTOR_MARKER_FORMAT},`,
        "        pid: self.pid(),",
        "        ancestors: ancestors,",
        "        startedAt: self.info().startInstant().map { it.toEpochMilli() }.orElse(null),",
        "    ])",
        '    def target = new File(dir, "${self.pid()}.json")',
        '    def temp = new File(dir, "${self.pid()}.json.tmp")',
        "    temp.text = record",
        "    if (!temp.renameTo(target)) {",
        "        target.delete()",
        "        temp.renameTo(target)",
        "    }",
        "} catch (Throwable ignored) {",
        "}",
        "",
    ].join("\n");
}

/** Writes the init script (only when it changed) and returns where markers go. */
export async function prepareExecutorTracking(executorDir) {
    const paths = executorPaths(executorDir);
    await mkdir(paths.markerDir, { recursive: true });
    const content = executorInitScript(paths.markerDir);
    if ((await readFile(paths.initScript, "utf8").catch(() => null)) !== content) {
        const temp = `${paths.initScript}.${process.pid}.tmp`;
        await writeFile(temp, content);
        await rename(temp, paths.initScript);
    }
    // Records of executors that have exited are only clutter.
    for (const name of await readdir(paths.markerDir).catch(() => [])) {
        const pid = Number(/^(\d+)\.json$/.exec(name)?.[1]);
        if (pid && !pidAlive(pid)) {
            await rm(path.join(paths.markerDir, name), { force: true });
        }
    }
    return paths;
}

/**
 * The executor records written for this build. A record counts only when this
 * build's wrapper is the process itself or one of its recorded ancestors, and
 * the process started after the wrapper was spawned: a record left by an
 * earlier build, or written by another build sharing the directory, names
 * neither, so it can never point at the wrong process.
 *
 * Records are renamed into place whole, so one that cannot be parsed or
 * attributed was not written by the init script. If it appeared after this
 * build started it could be this build's, so reading fails rather than taking
 * it as "no executor"; one older than the build cannot be.
 */
export async function readExecutorMarkers(markerDir, { wrapperPid, spawnedAt }) {
    const markers = [];
    // Only a missing directory or file means "no record"; any other read error
    // throws, so it can never be taken as the executor having no record.
    const names = await readdir(markerDir).catch((error) => {
        if (error?.code === "ENOENT") {
            return [];
        }
        throw error;
    });
    for (const name of names) {
        if (!/^\d+\.json$/.test(name)) {
            continue;
        }
        const file = path.join(markerDir, name);
        let raw;
        let info;
        try {
            info = await stat(file);
            raw = await readFile(file, "utf8");
        } catch (error) {
            if (error?.code === "ENOENT") {
                continue;
            }
            throw error;
        }
        let record = null;
        try {
            record = JSON.parse(raw);
        } catch {
            // Not valid JSON: handled below like any other record that cannot be attributed.
        }
        const valid =
            record?.format === EXECUTOR_MARKER_FORMAT &&
            Number.isInteger(record.pid) &&
            record.pid > 0 &&
            Number.isFinite(record.startedAt) &&
            Array.isArray(record.ancestors) &&
            record.ancestors.every((pid) => Number.isInteger(pid));
        if (!valid) {
            if (info.mtimeMs < spawnedAt - START_MATCH_SLACK_MS) {
                continue;
            }
            throw new Error(`executor record ${file} is malformed, so whether it is this build's cannot be told`);
        }
        if (record.startedAt < spawnedAt - START_MATCH_SLACK_MS) {
            continue;
        }
        const lineage = [record.pid, ...record.ancestors];
        if (lineage.includes(wrapperPid)) {
            markers.push({ pid: record.pid, startedAt: record.startedAt, file });
        }
    }
    return markers;
}

async function psPath() {
    for (const candidate of ["/bin/ps", "/usr/bin/ps"]) {
        if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
            return candidate;
        }
    }
    throw new Error("ps was not found in /bin or /usr/bin");
}

function assertTag(tag) {
    if (typeof tag !== "string" || !/^[A-Za-z0-9-]{16,}$/.test(tag)) {
        throw new Error("invalid build tag");
    }
}

/**
 * Linux: marks each process whose initial environment (/proc/<pid>/environ)
 * carries the build tag. A process that is gone, or not this user's, cannot be
 * read and is not marked; any other failure to read fails the whole snapshot.
 */
export async function markTaggedFromProc(processes, tag, { procRoot = "/proc" } = {}) {
    assertTag(tag);
    const needle = Buffer.from(`\0${BUILD_TAG_ENV}=${tag}\0`);
    await Promise.all(
        Array.from(processes.values()).map(async (proc) => {
            let environ;
            try {
                environ = await readFile(path.join(procRoot, String(proc.pid), "environ"));
            } catch (error) {
                if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error?.code)) {
                    proc.tagged = false;
                    return;
                }
                throw error;
            }
            proc.tagged = Buffer.concat([Buffer.from("\0"), environ, Buffer.from("\0")]).includes(needle);
        }),
    );
    return processes;
}

function runPs(ps, args) {
    return new Promise((resolve, reject) => {
        execFile(
            ps,
            args,
            { env: { ...process.env, LC_ALL: "C", LANG: "C" }, maxBuffer: 64 * 1024 * 1024, timeout: 5_000 },
            (error, out) => (error ? reject(error) : resolve(out)),
        );
    });
}

/**
 * macOS: `ps -E` silently omits the environment of some processes -- Apple
 * platform binaries such as /bin/sh and /bin/sleep -- and an omitted
 * environment reads exactly like one without the tag. Measured on macOS 26:
 * /bin/sh, /bin/sleep and launchd's services are hidden; JDK 17 java, Homebrew
 * node, /usr/bin/python3 and ad-hoc signed copies of /bin/sleep are visible.
 *
 * A hidden process (`envShown === false`) is decided, where it can be, by its
 * nearest ancestor whose environment was shown: a child inherits its parent's
 * environment, and on macOS an orphan is reparented to launchd, never to another
 * process, so a living shown ancestor is its real one. Otherwise it is left
 * undecided (`tagged` undefined, which fails the snapshot) when it could be one
 * of this build's: this user's, started since the build (`since`), and not a
 * process group leader launchd started -- launchd's own services, which start
 * all the time, are those. Everything else hidden is not the build's.
 *
 * Callers narrow `since` to the start of their last clean observation: every
 * process alive then was decided -- owned, and so remembered, or shown not to be
 * the build's, which cannot change -- so only processes started after it can be
 * unknown ones. That keeps unrelated orphans, such as another program's helpers
 * left behind when it was killed, from holding the device for long.
 *
 * Not covered: a hidden process that made itself a group leader (setsid) and
 * whose shown ancestors have all exited. The build's own processes -- the JVMs,
 * adb -- show their environment.
 */
export function classifyHiddenEnvironments(processes, { since = -Infinity, uid = process.getuid?.() } = {}) {
    for (const proc of processes.values()) {
        if (proc.envShown !== false || proc.tagged === true) {
            continue;
        }
        if (proc.uid !== uid || proc.startedAt < since - START_MATCH_SLACK_MS) {
            continue;
        }
        let top = proc;
        const seen = new Set();
        while (top && top.envShown === false && top.ppid > 1 && !seen.has(top.pid)) {
            seen.add(top.pid);
            top = processes.get(top.ppid);
        }
        if (top?.envShown === true) {
            proc.tagged = top.tagged;
        } else if (top && top.envShown === false && (top.ppid === 0 || (top.ppid === 1 && top.pgid === top.pid))) {
            continue;
        } else {
            proc.tagged = undefined;
            proc.envHidden = true;
        }
    }
    return processes;
}

/**
 * Every process on the machine: pid, parent, group, state and start time. The
 * start time is what tells a process from a later one that reused its pid.
 *
 * With `tag`, every process also says whether its environment carries this
 * build's tag (BUILD_TAG_ENV), which identifies a build process no earlier
 * observation saw. `since` is when the build started: nothing older carries
 * the tag. macOS appends the environment to `ps -E`'s command column (escaping
 * newlines, so one process stays one line), and a second listing without it
 * shows which environments were hidden (see classifyHiddenEnvironments); Linux
 * reads /proc. Elsewhere environments cannot be read and a tagged snapshot
 * fails, so nothing is ever confirmed gone without that evidence.
 */
export async function processSnapshot({ tag, since } = {}) {
    const withTag = tag !== undefined;
    if (withTag) {
        assertTag(tag);
        if (process.platform !== "darwin" && process.platform !== "linux") {
            throw new Error(`process environments cannot be read on ${process.platform}`);
        }
    }
    const fromPsEnv = withTag && process.platform === "darwin";
    const ps = await psPath();
    const stdout = await runPs(
        ps,
        fromPsEnv ? ["-A", "-ww", "-E", "-o", "pid=,ppid=,pgid=,uid=,stat=,lstart=,command="] : ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="],
    );
    // Listed after the environments, so a process in both is the same one when its start time matches.
    const plain = fromPsEnv ? await runPs(ps, ["-A", "-ww", "-o", "pid=,lstart=,command="]) : "";
    const tagToken = fromPsEnv ? new RegExp(`(?:^|\\s)${BUILD_TAG_ENV}=${tag}(?=\\s|$)`) : null;
    const processes = new Map();
    for (const line of stdout.split("\n")) {
        const match = fromPsEnv
            ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)(?:\s(.*))?$/.exec(line)
            : /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (!match) {
            if (fromPsEnv && line.trim()) {
                // A process that cannot be parsed could be one carrying the tag.
                throw new Error("ps printed a process line that could not be read");
            }
            continue;
        }
        const [stat, lstartText] = fromPsEnv ? [match[5], match[6]] : [match[4], match[5]];
        const lstart = lstartText.trim();
        const proc = {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            stat,
            lstart,
            startedAt: Date.parse(lstart),
        };
        if (fromPsEnv) {
            proc.uid = Number(match[4]);
            proc.command = match[7] ?? "";
            proc.tagged = tagToken.test(proc.command);
        }
        processes.set(proc.pid, proc);
    }
    if (processes.size === 0) {
        throw new Error("ps listed no processes");
    }
    if (fromPsEnv) {
        const listed = new Map();
        for (const line of plain.split("\n")) {
            const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)(?:\s(.*))?$/.exec(line);
            if (match) {
                listed.set(Number(match[1]), { lstart: match[2].trim(), command: match[3] ?? "" });
            }
        }
        for (const proc of processes.values()) {
            const bare = listed.get(proc.pid);
            // Shown only when the environment listing is the bare command plus more; a
            // process missing from the second listing, or changed, cannot be told apart.
            proc.envShown = Boolean(
                bare && bare.lstart === proc.lstart && proc.command.length > bare.command.length && proc.command.startsWith(`${bare.command} `),
            );
            delete proc.command;
        }
        classifyHiddenEnvironments(processes, { since });
    }
    if (withTag && !fromPsEnv) {
        await markTaggedFromProc(processes, tag);
    }
    return processes;
}

/**
 * Takes a snapshot; with a tag, only one in which every process says whether it
 * carries it -- a snapshot without that evidence cannot rule out an unseen
 * executor, so it is an error rather than an empty answer. A process whose
 * environment the system hid (`envHidden`, see classifyHiddenEnvironments) is
 * left undecided for undecidedProcesses().
 */
async function takeSnapshot(snapshot, tag, since) {
    const snap = await snapshot(tag === undefined ? undefined : { tag, since });
    if (tag !== undefined) {
        for (const proc of snap.values()) {
            if (typeof proc.tagged !== "boolean" && proc.envHidden !== true) {
                throw new Error(`the environment of pid ${proc.pid} was not read, so this build's processes cannot all be identified`);
            }
        }
    }
    return snap;
}

function isZombie(proc) {
    return proc.stat.startsWith("Z");
}

/**
 * Live processes that could be this build's -- their environment was hidden --
 * but that nothing else shows to be: while any remain, the build's processes
 * cannot be said to be gone.
 */
function undecidedProcesses(snapshot, owned) {
    return Array.from(snapshot.values())
        .filter((proc) => proc.envHidden === true && proc.tagged !== true && !owned.has(proc.pid) && !isZombie(proc))
        .map((proc) => proc.pid);
}

function undecidedDetail(pids) {
    return `the environment of pid(s) ${pids.join(", ")} is hidden by the system, so they cannot be told apart from this build's`;
}

/**
 * Which processes in `snapshot` belong to this build. Pure, so every rule is
 * tested on its own:
 *
 *   * processes already owned (`known`), while their pid still has the same start time;
 *   * the wrapper -- POSIX `gradlew` execs the client, so this is the client --
 *     while it has not exited, and its process group: a group id is never reused
 *     while the group has members, unless a new process holds the wrapper's pid;
 *   * the executors recorded for this build (readExecutorMarkers), when the pid's
 *     start time matches the record;
 *   * every process whose environment carries this build's tag (`tagged`, see
 *     processSnapshot) -- an executor no earlier observation saw, reparented
 *     after its client died, still carries it;
 *   * then, to a fixed point, the children of owned processes and members of
 *     groups owned processes lead. Gradle's single-use daemon is a child of its
 *     client: after setsid() it leaves the client's group, not its parentage.
 *
 * Unrelated processes, including other Gradle daemons, match none of these.
 * Ancestry holds only while parents live, which is why the caller freezes what
 * it finds (SIGSTOP) before looking again.
 */
export function ownedProcesses({ snapshot, wrapperPid, wrapperExited, markers = [], known = new Map() }) {
    const owned = new Map();
    for (const proc of snapshot.values()) {
        // Carries this build's tag (processSnapshot), which no unrelated process has.
        if (proc.tagged === true) {
            owned.set(proc.pid, proc);
        }
    }
    for (const [pid, lstart] of known) {
        const proc = snapshot.get(pid);
        if (proc?.lstart === lstart) {
            owned.set(pid, proc);
        }
    }
    const wrapper = snapshot.get(wrapperPid);
    if (wrapper && !wrapperExited) {
        owned.set(wrapperPid, wrapper);
    }
    const groupReused = Boolean(wrapper && wrapperExited);
    for (const proc of snapshot.values()) {
        if (proc.pgid === wrapperPid && !groupReused) {
            owned.set(proc.pid, proc);
        }
    }
    for (const marker of markers) {
        const proc = snapshot.get(marker.pid);
        if (proc && Number.isFinite(proc.startedAt) && Math.abs(marker.startedAt - proc.startedAt) <= START_MATCH_SLACK_MS) {
            owned.set(proc.pid, proc);
        }
    }
    for (let grew = true; grew; ) {
        grew = false;
        const leaders = new Set(Array.from(owned.values()).filter((proc) => proc.pgid === proc.pid).map((proc) => proc.pid));
        for (const proc of snapshot.values()) {
            if (!owned.has(proc.pid) && (owned.has(proc.ppid) || leaders.has(proc.pgid))) {
                owned.set(proc.pid, proc);
                grew = true;
            }
        }
    }
    return owned;
}

function sendSignal(kill, target, name) {
    try {
        kill(target, name);
        return true;
    } catch {
        return false;
    }
}

function runTaskkill(pid) {
    // Absolute path, so a `taskkill` earlier on PATH in the project cannot stand in for it.
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    return new Promise((resolve) => {
        execFile(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) => {
            resolve(error ? `${error.message} ${String(stderr ?? "").trim()}`.trim() : "ok");
        });
    });
}

const noMarkers = async () => [];

/**
 * POSIX: freezes, kills and confirms gone every process this build owns. Each
 * round freezes what it finds before looking again, so nothing can fork away
 * unseen, then everything is killed. It is only "confirmed" once a fresh
 * snapshot shows none of them left (an unreaped zombie can no longer act), the
 * wrapper reaped, and no executor record naming a live process.
 */
async function stopOwnedPosix(
    child,
    { killWaitMs, markers, snapshot, kill = process.kill.bind(process), pollMs = STOP_POLL_MS, known = new Map(), tag, since },
) {
    const wrapperPid = child.pid;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    // `known` may already hold processes seen owned while the build ran (see
    // liveBuildProcesses); `frozen` is what this stop has already SIGSTOPped.
    const frozen = new Set();
    const stopped = new Map();
    const executors = new Set();
    const deadline = Date.now() + killWaitMs;
    if (!exited()) {
        sendSignal(kill, -wrapperPid, "SIGSTOP");
    }
    let lastError = null;
    let settledPasses = 0;
    // Narrowed after each clean pass; see classifyHiddenEnvironments.
    let bound = since;
    for (;;) {
        let owned;
        let undecided = [];
        try {
            const records = await markers();
            for (const record of records) {
                executors.add(record.pid);
            }
            // Freeze to a fixed point: a frozen process cannot fork, or exit and
            // orphan its children, so the next snapshot sees all of them.
            for (let round = 0; round < 10; round += 1) {
                const passStart = Date.now();
                const snap = await takeSnapshot(snapshot, tag, bound);
                // exited() only after the snapshot: Node reaps the wrapper only once
                // its exit is recorded, so a wrapper not yet exited here still held
                // its pid when the snapshot was taken.
                owned = ownedProcesses({ snapshot: snap, wrapperPid, wrapperExited: exited(), markers: records, known });
                // Not signalled: they are not known to be this build's.
                undecided = undecidedProcesses(snap, owned);
                if (undecided.length === 0 && bound !== undefined) {
                    bound = Math.max(bound, passStart);
                }
                const fresh = Array.from(owned.values()).filter((proc) => !frozen.has(proc.pid) && !isZombie(proc));
                for (const proc of owned.values()) {
                    known.set(proc.pid, proc.lstart);
                }
                if (fresh.length === 0) {
                    break;
                }
                for (const proc of fresh) {
                    frozen.add(proc.pid);
                    sendSignal(kill, proc.pid, "SIGSTOP");
                    if (proc.pgid === proc.pid) {
                        sendSignal(kill, -proc.pid, "SIGSTOP");
                    }
                }
            }
        } catch (error) {
            lastError = error;
            owned = null;
            // A pass that could not look is not clean: confirmation needs two
            // clean passes in a row, and the deadline must still apply.
            settledPasses = 0;
        }
        if (owned) {
            const live = Array.from(owned.values()).filter((proc) => !isZombie(proc));
            // Two clean passes in a row, the second with freshly read records, so a
            // record written while the first was looking is still acted on.
            settledPasses = live.length === 0 && undecided.length === 0 && exited() ? settledPasses + 1 : 0;
            if (settledPasses >= 2) {
                return {
                    confirmed: true,
                    detail:
                        stopped.size === 0
                            ? "already exited"
                            : `stopped ${stopped.size} process(es) with SIGKILL and confirmed them gone`,
                    stopped: Array.from(stopped.values()),
                    executors: Array.from(executors),
                };
            }
            for (const proc of live) {
                stopped.set(proc.pid, { pid: proc.pid, ppid: proc.ppid, pgid: proc.pgid, lstart: proc.lstart });
                // Only after the snapshot just taken showed this pid with the start
                // time it was adopted with (ownedProcesses), so never a reused pid.
                if (proc.pgid === proc.pid) {
                    sendSignal(kill, -proc.pid, "SIGKILL");
                }
                sendSignal(kill, proc.pid, "SIGKILL");
                // A stopped process acts on SIGKILL, but resuming is harmless.
                sendSignal(kill, proc.pid, "SIGCONT");
            }
        }
        if (settledPasses === 1) {
            continue;
        }
        if (Date.now() >= deadline) {
            const remaining = owned
                ? Array.from(owned.values())
                      .filter((proc) => !isZombie(proc))
                      .map((proc) => proc.pid)
                : [];
            return {
                confirmed: false,
                detail: lastError && !owned
                    ? `its processes could not be listed (${lastError.message})`
                    : remaining.length === 0 && undecided.length > 0
                      ? undecidedDetail(undecided)
                      : `pid(s) ${remaining.join(", ") || wrapperPid} still running after SIGKILL`,
                stopped: Array.from(stopped.values()),
                executors: Array.from(executors),
            };
        }
        await delay(pollMs);
    }
}

/**
 * Windows has no process groups, no SIGSTOP and no start time from `tasklist`.
 * `taskkill /T` kills the tree under the wrapper by parent id, which reaches
 * the client and the single-use daemon it forked as long as the client is
 * alive. It is confirmed only when taskkill succeeded, the wrapper exited, and
 * no executor recorded for this build is still alive; a live pid there is not
 * killed (it cannot be told from a reused one) but leaves the stop unconfirmed.
 */
async function stopOwnedWindows(child, { killWaitMs, markers, taskkill }) {
    const pid = child.pid;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const result = await taskkill(pid);
    const parentGone = await waitFor(exited, killWaitMs);
    const records = await markers().catch(() => null);
    const liveExecutors = records ? records.filter((record) => pidAlive(record.pid)).map((record) => record.pid) : null;
    const executors = records ? records.map((record) => record.pid) : [];
    if (parentGone && result === "ok" && liveExecutors?.length === 0) {
        return { confirmed: true, detail: "stopped with taskkill /T /F", executors };
    }
    if (liveExecutors === null || liveExecutors.length > 0) {
        return {
            confirmed: false,
            detail: liveExecutors
                ? `Gradle's build process (pid ${liveExecutors.join(", ")}) is still running`
                : "Gradle's build-process records could not be read",
            executors,
        };
    }
    if (parentGone) {
        // The wrapper exiting says nothing about its children: once it is gone
        // taskkill can no longer find them by parent id.
        return {
            confirmed: false,
            treeUnreachable: true,
            detail: `pid ${pid} exited, but taskkill /T /F failed (${result}), so processes it started may still be running`,
            executors,
        };
    }
    return { confirmed: false, detail: `taskkill /T /F did not stop pid ${pid} (${result})`, executors };
}

/**
 * Stops a build's processes -- the wrapper, the Gradle client, the executor
 * (single-use daemon) and their descendants -- and reports whether they are
 * really gone, rather than assuming a sent signal worked. Nothing that is not
 * this build's is signalled (see ownedProcesses), and in particular no other
 * Gradle daemon.
 */
export async function terminateProcessTree(
    child,
    {
        platform = process.platform,
        killWaitMs = TERMINATE_KILL_WAIT_MS,
        taskkill = runTaskkill,
        markers = noMarkers,
        snapshot = processSnapshot,
        kill,
        pollMs,
        known,
        tag,
        since,
    } = {},
) {
    if (!child?.pid) {
        return { confirmed: true, detail: "the process never started" };
    }
    if (platform === "win32") {
        return stopOwnedWindows(child, { killWaitMs, markers, taskkill });
    }
    return stopOwnedPosix(child, { killWaitMs, markers, snapshot, kill, pollMs, known, tag, since });
}

/**
 * After an unconfirmed termination, keeps trying and resolves only once the
 * build's processes are verifiably gone. It may never resolve, and that is the
 * point: whatever waits on it keeps the device and project reserved.
 *
 * POSIX repeats the whole freeze-kill-confirm pass. Windows retries `taskkill
 * /T /F` while the wrapper is alive and waits for recorded executors to exit;
 * if the wrapper exits without taskkill ever succeeding, its children can no
 * longer be found, so the exit can never be confirmed and this never resolves --
 * the reservation then lasts until the Copilot session ends.
 */
export async function waitForProcessTreeExit(
    child,
    {
        platform = process.platform,
        pollMs = EXIT_POLL_MS,
        taskkill = runTaskkill,
        treeUnreachable = false,
        markers = noMarkers,
        snapshot = processSnapshot,
        killWaitMs = TERMINATE_KILL_WAIT_MS,
        kill,
        known,
        tag,
        since,
    } = {},
) {
    const pid = child.pid;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (platform === "win32") {
        let treeStopped = false;
        for (;;) {
            if (exited()) {
                if (!treeStopped || treeUnreachable) {
                    return new Promise(() => {});
                }
                const records = await markers().catch(() => null);
                if (records && records.every((record) => !pidAlive(record.pid))) {
                    return { confirmed: true, detail: "stopped with taskkill /T /F after a retry" };
                }
            } else {
                treeStopped = (await taskkill(pid)) === "ok";
            }
            await pause(pollMs);
        }
    }
    for (;;) {
        const outcome = await stopOwnedPosix(child, { killWaitMs, markers, snapshot, kill, known, tag, since });
        if (outcome.confirmed) {
            return { ...outcome, detail: `build processes exited after cancellation (${outcome.detail})` };
        }
        await pause(pollMs);
    }
}

/**
 * The build's processes still alive, without signalling any of them. POSIX
 * applies ownedProcesses() to a fresh snapshot; Windows can only check the
 * recorded executors.
 *
 * `known` (pid -> start time) is both read and extended: every process seen
 * owned is recorded, so one seen while its parent lived stays owned after it is
 * reparented. That is what identifies an executor that wrote no record -- the
 * configuration cache was reused, or it had not evaluated init scripts yet --
 * once its client has exited abruptly and left it outside the wrapper's group.
 */
export async function liveBuildProcesses(
    child,
    { platform = process.platform, markers = noMarkers, snapshot = processSnapshot, known = new Map(), tag, since } = {},
) {
    // Read only after every await: the wrapper can exit -- and its pid be reused --
    // while records or the snapshot are being read. Node reaps it only after its
    // exit is recorded, so "not exited" read here means the snapshot's process
    // with the wrapper's pid was still the wrapper.
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (platform === "win32") {
        const records = await markers();
        return [...(exited() ? [] : [child.pid]), ...records.filter((record) => pidAlive(record.pid)).map((record) => record.pid)];
    }
    const records = await markers();
    const snap = await takeSnapshot(snapshot, tag, since);
    const owned = ownedProcesses({ snapshot: snap, wrapperPid: child.pid, wrapperExited: exited(), markers: records, known });
    for (const proc of owned.values()) {
        known.set(proc.pid, proc.lstart);
    }
    const undecided = undecidedProcesses(snap, owned);
    if (undecided.length > 0) {
        throw new Error(undecidedDetail(undecided));
    }
    return Array.from(owned.values())
        .filter((proc) => !isZombie(proc))
        .map((proc) => proc.pid);
}

const defaultProcessTree = { terminate: terminateProcessTree, waitForExit: waitForProcessTreeExit, probe: liveBuildProcesses };

/**
 * Builds, installs and launches the app in the session's working directory.
 *
 * Gradle is given the device serial through ANDROID_SERIAL so `installDebug`
 * targets the selected device rather than "whatever adb picks", which is the
 * whole point when several devices are attached.
 *
 * Every run can be cancelled until the launch is dispatched -- while it is being
 * prepared, while it waits behind another build of the same project, and while
 * Gradle runs. Shutdown is irreversible: stopAll() refuses new runs, cancels the
 * rest, and only returns once every run has settled, so the caller can release
 * the device knowing nothing will install onto it afterwards.
 *
 * When Gradle's processes cannot be confirmed gone, the run is not reported
 * cancelled. It moves to "cancel_failed" at once, so callers get a bounded,
 * explicit error, but it keeps the project lock and -- through the error's
 * `retainHoldUntil` -- the device hold until the processes are seen to exit.
 * stopAll() then throws `build_stop_unconfirmed` naming those devices. The same
 * applies to a build that ends on its own while its executor lingers and then
 * cannot be confirmed stopped.
 */
export class AppBuildService {
    constructor({
        manager,
        onDiagnostic,
        platform = process.platform,
        terminateKillWaitMs = TERMINATE_KILL_WAIT_MS,
        executorExitWaitMs = EXECUTOR_EXIT_WAIT_MS,
        publishIntervalMs = PUBLISH_INTERVAL_MS,
        exitPollMs = EXIT_POLL_MS,
        lineagePollMs = LINEAGE_POLL_MS,
        executorDir = defaultExecutorDir(),
        processTree = defaultProcessTree,
    } = {}) {
        this.manager = manager;
        this.onDiagnostic = onDiagnostic ?? (() => {});
        this.platform = platform;
        this.terminateKillWaitMs = terminateKillWaitMs;
        this.executorExitWaitMs = executorExitWaitMs;
        this.publishIntervalMs = publishIntervalMs;
        this.exitPollMs = exitPollMs;
        this.lineagePollMs = lineagePollMs;
        this.executorDir = executorDir;
        this.processTree = { ...defaultProcessTree, ...processTree };
        this.workingDirectory = process.cwd();
        this.runs = new Map();
        // Two devices share one project tree, so Gradle runs are serialised by
        // project rather than by device: concurrent builds of the same tree fight
        // over the same outputs.
        this.projectLocks = new Map();
        /** Every run that has not settled yet, whatever its device. */
        this.inflight = new Map();
        this.stopping = false;
    }

    setWorkingDirectory(workingDirectory) {
        if (workingDirectory) {
            this.workingDirectory = workingDirectory;
        }
    }

    statusFor(deviceId) {
        const run = this.runs.get(deviceId);
        if (!run) {
            return null;
        }
        return {
            id: run.id,
            state: run.state,
            step: run.step,
            message: run.message,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt ?? null,
            packageName: run.packageName ?? null,
            command: run.command,
            cancellable: run.state === "running" && !run.launching && !run.abort?.signal.aborted,
            cancelRequested: Boolean(run.abort?.signal.aborted),
            quarantined: run.state === "cancel_failed",
            orphanPid: run.orphanPid ?? null,
            logTotal: run.logTotal ?? run.log.length,
            log: run.log.slice(-MAX_LOG_LINES),
        };
    }

    /** True while a build may still touch the device, including one whose cancellation is unconfirmed. */
    isRunning(deviceId) {
        const state = this.runs.get(deviceId)?.state;
        return state === "running" || state === "cancel_failed";
    }

    unconfirmedError(run) {
        return new AppError(
            "build_cancel_unconfirmed",
            run.message ?? "An earlier build could not be confirmed stopped.",
            409,
            { runId: run.id, pid: run.orphanPid ?? null },
        );
    }

    assertAccepting() {
        if (this.stopping) {
            throw new AppError("build_service_stopped", "The extension is shutting down; no new builds can start.", 503);
        }
    }

    /** Reports what pressing Install would do, without doing it. */
    async describe() {
        const gradle = await findGradleRoot(this.workingDirectory, { platform: this.platform });
        const { file, config } = await readConfig(this.workingDirectory);
        const task = config.gradleTask ?? DEFAULT_TASK;
        const wrapperName = wrapperNameFor(this.platform);
        return {
            workingDirectory: this.workingDirectory,
            gradleRoot: gradle?.root ?? null,
            available: Boolean(gradle),
            wrapper: this.platform === "win32" ? wrapperName : `./${wrapperName}`,
            task,
            configFile: file,
            packageName: config.packageName ?? null,
            activity: config.activity ?? null,
            reason: gradle ? null : `No Gradle wrapper (${wrapperName}) was found in this session's working directory.`,
        };
    }

    /**
     * Records a refusal that happened before a run started, so the canvas shows it.
     * Never replaces a run that is still going: a second click refused because a
     * build is running must not make that build look finished, or a third click
     * would start Gradle twice.
     */
    reportFailure(deviceId, message) {
        if (this.isRunning(deviceId)) {
            return;
        }
        const now = new Date().toISOString();
        this.runs.set(deviceId, {
            id: randomUUID(),
            state: "failed",
            step: "done",
            message,
            startedAt: now,
            finishedAt: now,
            command: null,
            log: [],
            logTotal: 0,
        });
        this.publish(deviceId);
    }

    async buildInstallLaunch({ deviceId, task: taskOverride, launch = true } = {}) {
        this.assertAccepting();
        const existing = this.runs.get(deviceId);
        if (existing?.state === "cancel_failed") {
            throw this.unconfirmedError(existing);
        }
        if (this.isRunning(deviceId)) {
            throw new AppError("build_in_progress", "A build is already running for this device.", 409);
        }

        // Claimed before the first await: two clicks in quick succession would
        // otherwise both get past the check above and run Gradle twice.
        const run = {
            id: randomUUID(),
            state: "running",
            step: "prepare",
            message: "Preparing the build",
            startedAt: new Date().toISOString(),
            command: null,
            log: [],
            logTotal: 0,
            child: null,
            abort: new AbortController(),
            cancelReason: null,
            launching: false,
            publishTimer: null,
        };
        this.runs.set(deviceId, run);
        this.publish(deviceId);

        const work = (async () => {
            try {
                return await this.runBuild({ deviceId, run, taskOverride, launch });
            } catch (error) {
                const unconfirmed = error?.code === "build_cancel_unconfirmed" || error?.code === "build_executor_unconfirmed";
                if (unconfirmed && run.exited) {
                    // Not stopped, and not over: Gradle may still be installing.
                    this.finish(deviceId, run, "cancel_failed", error.message);
                    run.exited = run.exited.then((outcome) => {
                        run.termination = outcome;
                        const cancelled = run.abort.signal.aborted;
                        this.finish(
                            deviceId,
                            run,
                            cancelled ? "cancelled" : "failed",
                            `${cancelled ? (run.cancelReason ?? "Cancelled.") : "The build's processes outlived it."} ` +
                                `Gradle (pid ${run.orphanPid}) has since exited (${outcome.detail}).`,
                        );
                        return outcome;
                    });
                    error.buildRecorded = true;
                    // Whoever holds the device for this run keeps it until then.
                    error.retainHoldUntil = run.exited;
                    throw error;
                }
                const cancelled = run.abort.signal.aborted;
                const recorded = cancelled
                    ? cancelledError(run)
                    : error instanceof AppError
                      ? error
                      : new AppError("build_failed", error.message, 502);
                this.finish(deviceId, run, cancelled ? "cancelled" : "failed", recorded.message);
                // The run already shows this failure; callers must not replace it.
                recorded.buildRecorded = true;
                throw recorded;
            }
        })();
        run.done = work.then(
            () => {},
            () => {},
        );
        this.inflight.set(run, run.done);
        void run.done.then(() => this.inflight.delete(run));
        return work;
    }

    finish(deviceId, run, state, message) {
        clearTimeout(run.publishTimer);
        run.publishTimer = null;
        run.state = state;
        run.step = "done";
        run.message = message;
        run.finishedAt = new Date().toISOString();
        run.child = null;
        this.publish(deviceId);
    }

    throwIfCancelled(run) {
        if (run.abort.signal.aborted) {
            throw cancelledError(run);
        }
    }

    /**
     * Serialises builds of one project. Waiting is cancellable, and a cancelled
     * waiter still hands its turn on, so it cannot wedge the builds behind it.
     */
    async acquireProjectLock(root, run, deviceId) {
        const waiting = this.projectLocks.has(root);
        const previous = this.projectLocks.get(root) ?? Promise.resolve();
        let releaseMine;
        const mine = new Promise((resolve) => {
            releaseMine = resolve;
        });
        const tail = previous.then(() => mine);
        this.projectLocks.set(root, tail);
        const release = () => {
            releaseMine();
            // Only once the tail has really settled: a cancelled waiter releases
            // while its predecessor is still building, and dropping the entry then
            // would let the next build of this project start alongside it.
            void tail.then(() => {
                if (this.projectLocks.get(root) === tail) {
                    this.projectLocks.delete(root);
                }
            });
        };
        if (waiting) {
            run.step = "queued";
            run.message = "Waiting for another build of this project to finish";
            this.publish(deviceId);
        }
        try {
            await unlessCancelled(run, previous);
        } catch (error) {
            release();
            throw error;
        }
        return release;
    }

    async runBuild({ deviceId, run, taskOverride, launch }) {
        const plan = await unlessCancelled(run, this.describe());
        if (!plan.available) {
            throw new AppError("gradle_not_found", plan.reason, 404);
        }

        const device = this.manager.snapshot(deviceId);
        const task = assertSafeTask(taskOverride ?? plan.task);
        const gradle = await unlessCancelled(run, findGradleRoot(this.workingDirectory, { platform: this.platform }));
        if (!gradle) {
            throw new AppError("gradle_not_found", plan.reason ?? "The Gradle wrapper disappeared.", 404);
        }
        const tracking = await unlessCancelled(run, prepareExecutorTracking(this.executorDir));
        const invocation = gradleInvocation({ wrapper: gradle.wrapper, task, initScript: tracking.initScript, platform: this.platform });
        run.command = invocation.display;

        const release = await this.acquireProjectLock(gradle.root, run, deviceId);

        const append = (line) => {
            const text = line.trimEnd();
            if (!text) {
                return;
            }
            run.log.push(text);
            run.logTotal += 1;
            if (run.log.length > MAX_LOG_LINES * 2) {
                run.log.splice(0, run.log.length - MAX_LOG_LINES);
            }
            // Gradle's own progress lines are the most useful status we have.
            if (!run.abort.signal.aborted && (/^> (Task|Configure|Transform)/.test(text) || /^BUILD /.test(text))) {
                run.message = text.slice(0, 160);
            }
            this.schedulePublish(deviceId, run);
        };

        try {
            this.throwIfCancelled(run);
            run.step = "build";
            run.message = `Running ${task}`;
            this.publish(deviceId);

            await this.runGradle({
                invocation,
                cwd: gradle.root,
                task,
                serial: device.serial,
                onLine: append,
                log: run.log,
                run,
                deviceId,
                markerDir: tracking.markerDir,
            });
            this.throwIfCancelled(run);

            run.step = "launch";
            run.message = "Resolving the installed app";
            this.publish(deviceId);

            let packageName = plan.packageName ?? null;
            if (!packageName && launch) {
                packageName = (await unlessCancelled(run, resolveApplicationId(gradle.root, task))).applicationId;
            } else if (!packageName) {
                // Only reported, never acted on, so an ambiguous answer is just unknown.
                packageName = await resolveApplicationId(gradle.root, task).then(
                    (resolved) => resolved.applicationId,
                    () => null,
                );
            }
            run.packageName = packageName ?? null;
            this.throwIfCancelled(run);

            if (launch) {
                // From here the device is being told to start the app, which cannot
                // be taken back, so cancellation stops being offered.
                run.launching = true;
                run.message = `Launching ${packageName}`;
                this.publish(deviceId);
                await this.manager.launchApp({ deviceId, packageName, activity: plan.activity ?? undefined });
                run.message = `Launched ${packageName}`;
            } else {
                run.message = "Installed";
            }

            this.finish(deviceId, run, "succeeded", run.message);
            return this.statusFor(deviceId);
        } finally {
            if (run.exited) {
                // Gradle may still be writing this project's outputs.
                void run.exited.then(release);
            } else {
                release();
            }
        }
    }

    /** Coalesces log-driven updates so a chatty build cannot flood every canvas. */
    schedulePublish(deviceId, run) {
        if (run.publishTimer || run.state !== "running") {
            return;
        }
        run.publishTimer = setTimeout(() => {
            run.publishTimer = null;
            if (this.runs.get(deviceId) === run && run.state === "running") {
                this.publish(deviceId);
            }
        }, this.publishIntervalMs);
    }

    /**
     * Asks the device's current build to stop and returns at once; the run moves
     * to "cancelled" once its process tree is confirmed gone. `runId` pins the
     * build the caller saw, so a stale click cannot cancel a newer one.
     */
    requestCancel(deviceId, { runId = null, reason = "Cancelled." } = {}) {
        const run = this.runs.get(deviceId);
        if (run?.state === "cancel_failed") {
            throw this.unconfirmedError(run);
        }
        if (!run || run.state !== "running") {
            throw new AppError("no_build_running", "No build is running on this device.", 409);
        }
        if (runId && run.id !== runId) {
            throw new AppError("build_run_mismatch", "That build has already finished; a different build is running now.", 409);
        }
        if (run.launching) {
            throw new AppError(
                "build_not_cancellable",
                "The app has already been installed and is being launched, so the build can no longer be cancelled.",
                409,
            );
        }
        if (!run.abort.signal.aborted) {
            run.cancelReason = reason;
            run.message = "Cancelling…";
            run.abort.abort();
            this.publish(deviceId);
        }
        return run;
    }

    /**
     * Cancels and waits for the run to settle, returning its final status.
     * Bounded by the termination timeouts: when Gradle cannot be confirmed
     * stopped, this throws `build_cancel_unconfirmed` instead of waiting for it.
     */
    async cancel(deviceId, options = {}) {
        const run = this.requestCancel(deviceId, options);
        await run.done;
        if (run.state === "cancel_failed") {
            throw this.unconfirmedError(run);
        }
        return this.runs.get(deviceId) === run ? this.statusFor(deviceId) : null;
    }

    /**
     * Stops any Gradle this session started, so a reload cannot install onto a
     * device it no longer holds. Irreversible: no build starts after this.
     *
     * Throws `build_stop_unconfirmed`, with the affected `deviceIds` in its
     * details, when any build's processes could not be confirmed gone; those
     * devices must not be released.
     */
    async stopAll() {
        this.stopping = true;
        for (const [deviceId, run] of this.runs) {
            if (run.state === "running" && !run.abort?.signal.aborted && !run.launching) {
                run.cancelReason = "Stopped because the extension is shutting down.";
                run.abort.abort();
                this.publish(deviceId);
            }
        }
        // Includes runs being launched, which finish rather than stop, and runs
        // still preparing or queued, which settle as cancelled.
        await Promise.allSettled(Array.from(this.inflight.values()));
        const unconfirmed = Array.from(this.runs).filter(([, run]) => run.state === "cancel_failed");
        if (unconfirmed.length > 0) {
            throw new AppError(
                "build_stop_unconfirmed",
                `Gradle could not be confirmed stopped for ${unconfirmed.map(([deviceId]) => deviceId).join(", ")}: ` +
                    unconfirmed.map(([, run]) => run.message).join(" "),
                500,
                { deviceIds: unconfirmed.map(([deviceId]) => deviceId) },
            );
        }
    }

    /** Stops a run's processes (see terminateProcessTree); settles with the outcome, never throws. */
    stopProcesses(child, markers, known, owner) {
        return Promise.resolve()
            .then(() =>
                this.processTree.terminate(child, { platform: this.platform, killWaitMs: this.terminateKillWaitMs, markers, known, ...owner }),
            )
            .catch((error) => ({ confirmed: false, detail: `termination failed: ${error?.message ?? error}` }));
    }

    /**
     * Keeps the run reserved until its processes are seen to exit: `run.exited`
     * holds the project lock and, through the caller, the device.
     */
    quarantine(run, child, outcome, markers, known, owner) {
        run.orphanPid = outcome.executors?.[0] ?? child.pid;
        this.onDiagnostic(`Gradle (pid ${run.orphanPid}) could not be confirmed stopped: ${outcome.detail}`);
        run.exited = Promise.resolve(
            this.processTree.waitForExit(child, {
                platform: this.platform,
                pollMs: this.exitPollMs,
                killWaitMs: this.terminateKillWaitMs,
                treeUnreachable: Boolean(outcome.treeUnreachable),
                markers,
                known,
                ...owner,
            }),
        ).catch(() => new Promise(() => {})); // A watcher that fails confirms nothing.
    }

    /**
     * After the client has exited by itself, waits for the rest of the build --
     * the single-use daemon, which stops once it has reported the result -- to be
     * seen gone. One that does not exit in time is stopped like a cancelled
     * build; the wait never counts as confirmation.
     */
    async confirmBuildProcessesGone(child, markers, known, owner) {
        const deadline = Date.now() + this.executorExitWaitMs;
        for (;;) {
            const live = await Promise.resolve()
                .then(() => this.observe(child, markers, known, owner))
                .catch(() => null);
            if (live?.length === 0) {
                return { confirmed: true, detail: "exited with the build" };
            }
            if (Date.now() >= deadline) {
                return this.stopProcesses(child, markers, known, owner);
            }
            await delay(STOP_POLL_MS * 2);
        }
    }

    /**
     * Lists the build's live processes; a successful look is a clean one, which
     * narrows how far back an undecided process can have started (see
     * classifyHiddenEnvironments).
     */
    async observe(child, markers, known, owner) {
        const startedAt = Date.now();
        const live = await this.processTree.probe(child, { platform: this.platform, markers, known, ...owner });
        if (owner.since) {
            owner.since = Math.max(owner.since, startedAt);
        }
        return live;
    }

    /**
     * While the wrapper lives, records every process it owns (see
     * liveBuildProcesses). Purely additive: a failed observation proves nothing
     * and is ignored, and nothing is ever confirmed from it.
     */
    async trackLineage(child, markers, known, owner, isDone) {
        const exited = () => child.exitCode !== null || child.signalCode !== null;
        while (!isDone() && !exited()) {
            await Promise.resolve()
                .then(() => this.observe(child, markers, known, owner))
                .catch(() => {});
            await pause(this.lineagePollMs);
        }
    }

    runGradle({ invocation, cwd, task, serial, onLine, log, run, deviceId, markerDir }) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let stopping = false;
            let child;
            let spawnedAt = 0;
            const signal = run?.abort.signal;
            const settle = (fn, value) => {
                if (settled) {
                    return;
                }
                settled = true;
                signal?.removeEventListener("abort", onAbort);
                fn(value);
            };
            const launcher = this.platform === "win32" ? `${invocation.display} (through cmd.exe)` : invocation.display;
            const markers = () =>
                markerDir ? readExecutorMarkers(markerDir, { wrapperPid: child.pid, spawnedAt }) : Promise.resolve([]);
            // Every process seen owned during this run (pid -> start time); see liveBuildProcesses.
            const known = new Map();
            // The tag is in the environment of every process the build starts (see
            // processSnapshot), so an executor no observation saw before its client died
            // is still found; `since` is set when it starts.
            const owner = { tag: randomUUID(), since: 0 };
            // Only once the processes they name are confirmed gone.
            const forgetMarkers = () =>
                markers()
                    .then((records) => Promise.all(records.map((record) => rm(record.file, { force: true }))))
                    .catch(() => {});

            const onAbort = () => {
                if (!child || stopping) {
                    return;
                }
                stopping = true;
                if (run.state === "running" && deviceId !== undefined) {
                    run.message = "Cancelling… stopping Gradle's build process";
                    this.publish(deviceId);
                }
                void this.stopProcesses(child, markers, known, owner).then(async (outcome) => {
                    run.termination = outcome;
                    if (outcome.confirmed) {
                        await forgetMarkers();
                        settle(reject, cancelledError(run));
                        return;
                    }
                    this.quarantine(run, child, outcome, markers, known, owner);
                    settle(
                        reject,
                        new AppError(
                            "build_cancel_unconfirmed",
                            `Cancellation could not be confirmed: Gradle (pid ${run.orphanPid}) may still be running (${outcome.detail}). ` +
                                "The device and project stay reserved until it exits. End that process and its children " +
                                "manually if it does not stop; if they cannot be seen to exit, the reservation lasts until " +
                                "the Copilot session ends.",
                            500,
                            { pid: run.orphanPid },
                        ),
                    );
                });
            };

            if (signal?.aborted) {
                settle(reject, cancelledError(run));
                return;
            }
            try {
                spawnedAt = Date.now();
                owner.since = spawnedAt;
                child = spawn(invocation.command, invocation.args, {
                    cwd,
                    env: { ...process.env, ANDROID_SERIAL: serial, TERM: "dumb", [BUILD_TAG_ENV]: owner.tag },
                    stdio: ["ignore", "pipe", "pipe"],
                    ...invocation.options,
                });
            } catch (error) {
                settle(reject, new AppError("gradle_failed", `Could not start ${launcher}: ${error.message}`, 500));
                return;
            }

            if (run) {
                run.child = child;
                run.tracking = { wrapperPid: child.pid, spawnedAt, markerDir };
            }
            if (child.pid && this.platform !== "win32") {
                void this.trackLineage(child, markers, known, owner, () => settled || stopping);
            }

            let pending = "";
            const consume = (chunk) => {
                pending += chunk.toString("utf8");
                // Bare carriage returns too: progress meters redraw one line with them.
                const lines = pending.split(/\r\n|\n|\r/);
                pending = lines.pop() ?? "";
                for (const line of lines) {
                    onLine(line);
                }
            };
            child.stdout.on("data", consume);
            child.stderr.on("data", consume);

            child.on("error", (error) =>
                settle(reject, new AppError("gradle_failed", `Could not run ${launcher}: ${error.message}`, 500)),
            );
            child.on("close", (code) => {
                if (pending.trim()) {
                    onLine(pending);
                    pending = "";
                }
                if (signal?.aborted) {
                    // onAbort settles once every build process is confirmed gone.
                    return;
                }
                void this.confirmBuildProcessesGone(child, markers, known, owner).then(async (outcome) => {
                    if (signal?.aborted || settled) {
                        return;
                    }
                    run.termination = outcome;
                    if (!outcome.confirmed) {
                        this.quarantine(run, child, outcome, markers, known, owner);
                        settle(
                            reject,
                            new AppError(
                                "build_executor_unconfirmed",
                                `${task} ended, but Gradle (pid ${run.orphanPid}) could not be confirmed stopped (${outcome.detail}). ` +
                                    "The device and project stay reserved until it exits.",
                                500,
                                { pid: run.orphanPid },
                            ),
                        );
                        return;
                    }
                    await forgetMarkers();
                    if (code === 0) {
                        settle(resolve);
                        return;
                    }
                    // Gradle's own explanation beats an exit code the user has to go hunting for.
                    const summary = failureSummary(log ?? []);
                    settle(
                        reject,
                        new AppError("build_failed", summary ? `${task} failed: ${summary}` : `${task} failed (exit code ${code}).`, 502),
                    );
                });
            });

            if (signal) {
                if (signal.aborted) {
                    onAbort();
                } else {
                    signal.addEventListener("abort", onAbort, { once: true });
                }
            }
        });
    }

    publish(deviceId) {
        this.manager.notifyDevice?.(deviceId);
    }
}

/** Pulls the "What went wrong" explanation out of Gradle's failure report. */
function failureSummary(log) {
    const index = log.findIndex((line) => line.startsWith("* What went wrong:"));
    if (index === -1) {
        return log.filter((line) => /^(e: |error: |FAILURE)/i.test(line)).slice(-3).join(" ") || null;
    }
    return log
        .slice(index + 1, index + 5)
        .filter((line) => line.trim() && !line.startsWith("*"))
        .join(" ")
        .slice(0, 400);
}

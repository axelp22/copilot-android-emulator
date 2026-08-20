import { spawn } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { AppError } from "./errors.mjs";

const CONFIG_FILENAMES = [".android-emulator.json", "android-emulator.json", ".github/android-emulator.json"];
const DEFAULT_TASK = "installDebug";
const MAX_LOG_LINES = 400;

/**
 * Gradle reads a leading `-` as an option, and options such as
 * `--init-script=<file>` run arbitrary code before the build starts. Task names
 * never begin with one, so refusing them keeps a hostile
 * `.android-emulator.json` -- or a tool call written by a prompt-injected agent
 * -- from turning "Install" into host code execution.
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

/** Walks up from `from` looking for a Gradle wrapper, so nested module dirs work. */
async function findGradleRoot(from) {
    let dir = path.resolve(from);
    for (let depth = 0; depth < 8; depth += 1) {
        const wrapper = path.join(dir, "gradlew");
        if (await access(wrapper, constants.X_OK).then(() => true).catch(() => false)) {
            return { root: dir, wrapper };
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return null;
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
 * The application id is needed to launch what we just installed. AGP writes it
 * next to the APK, which beats parsing build output or diffing installed
 * packages -- both of which break as soon as a project has more than one variant.
 */
async function findApplicationId(gradleRoot, { moduleHint } = {}) {
    const candidates = [];

    // Flavored projects nest as apk/<flavor>/<buildType>/, plain ones as
    // apk/<buildType>/, so the depth under outputs/apk is not fixed.
    async function collectMetadata(dir, depth) {
        if (depth > 3) {
            return;
        }
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isDirectory()) {
                await collectMetadata(path.join(dir, entry.name), depth + 1);
            } else if (entry.name === "output-metadata.json") {
                candidates.push(path.join(dir, entry.name));
            }
        }
    }

    async function walk(dir, depth) {
        if (depth > 4) {
            return;
        }
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (entry.name === "build") {
                await collectMetadata(path.join(dir, "build", "outputs", "apk"), 0);
                continue;
            }
            if (entry.name.startsWith(".") || entry.name === "node_modules") {
                continue;
            }
            await walk(path.join(dir, entry.name), depth + 1);
        }
    }

    await walk(gradleRoot, 0);
    if (candidates.length === 0) {
        return null;
    }

    // Prefer the module the task named, then whichever was written most recently:
    // that is the one this build just produced.
    const scored = await Promise.all(
        candidates.map(async (file) => ({
            file,
            mtime: await stat(file).then((info) => info.mtimeMs).catch(() => 0),
            matchesModule: moduleHint ? file.includes(`${path.sep}${moduleHint}${path.sep}`) : false,
        })),
    );
    scored.sort((a, b) => Number(b.matchesModule) - Number(a.matchesModule) || b.mtime - a.mtime);

    for (const candidate of scored) {
        const parsed = await readFile(candidate.file, "utf8")
            .then((raw) => JSON.parse(raw))
            .catch(() => null);
        if (parsed?.applicationId) {
            return parsed.applicationId;
        }
    }
    return null;
}

/** `:app:installDebug` -> `app`, so the metadata search can prefer that module. */
function moduleFromTask(task) {
    const parts = String(task).split(":").filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 2] : null;
}

/**
 * Builds, installs and launches the app in the session's working directory.
 *
 * Gradle is given the device serial through ANDROID_SERIAL so `installDebug`
 * targets the selected device rather than "whatever adb picks", which is the
 * whole point when several devices are attached.
 */
export class AppBuildService {
    constructor({ manager, onDiagnostic } = {}) {
        this.manager = manager;
        this.onDiagnostic = onDiagnostic ?? (() => {});
        this.workingDirectory = process.cwd();
        this.runs = new Map();
        // Two devices share one project tree, so Gradle runs are serialised by
        // project rather than by device: concurrent builds of the same tree fight
        // over the same outputs.
        this.projectLocks = new Map();
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
            state: run.state,
            step: run.step,
            message: run.message,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt ?? null,
            packageName: run.packageName ?? null,
            command: run.command,
            log: run.log.slice(-MAX_LOG_LINES),
        };
    }

    isRunning(deviceId) {
        return this.runs.get(deviceId)?.state === "running";
    }

    /** Reports what pressing Install would do, without doing it. */
    async describe() {
        const gradle = await findGradleRoot(this.workingDirectory);
        const { file, config } = await readConfig(this.workingDirectory);
        const task = config.gradleTask ?? DEFAULT_TASK;
        return {
            workingDirectory: this.workingDirectory,
            gradleRoot: gradle?.root ?? null,
            available: Boolean(gradle),
            task,
            configFile: file,
            packageName: config.packageName ?? null,
            activity: config.activity ?? null,
            reason: gradle ? null : "No Gradle wrapper (gradlew) was found in this session's working directory.",
        };
    }

    /** Records a refusal that happened before a run started, so the canvas shows it. */
    reportFailure(deviceId, message) {
        this.runs.set(deviceId, {
            state: "failed",
            step: "done",
            message,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            command: null,
            log: [],
        });
        this.publish(deviceId);
    }

    async buildInstallLaunch({ deviceId, task: taskOverride, launch = true } = {}) {
        if (this.isRunning(deviceId)) {
            throw new AppError("build_in_progress", "A build is already running for this device.", 409);
        }

        // Claimed before the first await: two clicks in quick succession would
        // otherwise both get past the check above and run Gradle twice.
        const run = {
            state: "running",
            step: "prepare",
            message: "Preparing the build",
            startedAt: new Date().toISOString(),
            command: null,
            log: [],
            child: null,
        };
        this.runs.set(deviceId, run);
        this.publish(deviceId);

        try {
            return await this.runBuild({ deviceId, run, taskOverride, launch });
        } catch (error) {
            run.state = "failed";
            run.step = "done";
            run.finishedAt = new Date().toISOString();
            run.message = error.message;
            this.publish(deviceId);
            throw error instanceof AppError ? error : new AppError("build_failed", error.message, 502);
        }
    }

    async runBuild({ deviceId, run, taskOverride, launch }) {
        const plan = await this.describe();
        if (!plan.available) {
            throw new AppError("gradle_not_found", plan.reason, 404);
        }

        const device = this.manager.snapshot(deviceId);
        const task = assertSafeTask(taskOverride ?? plan.task);
        const gradle = await findGradleRoot(this.workingDirectory);

        run.step = "build";
        run.message = `Running ${task}`;
        run.command = `./gradlew ${task}`;
        this.publish(deviceId);

        const previous = this.projectLocks.get(gradle.root) ?? Promise.resolve();
        let releaseProject;
        this.projectLocks.set(
            gradle.root,
            previous.then(() => new Promise((resolve) => {
                releaseProject = resolve;
            })),
        );
        await previous.catch(() => {});

        const append = (line) => {
            const text = line.trimEnd();
            if (!text) {
                return;
            }
            run.log.push(text);
            if (run.log.length > MAX_LOG_LINES * 2) {
                run.log.splice(0, run.log.length - MAX_LOG_LINES);
            }
            // Gradle's own progress lines are the most useful status we have.
            if (/^> (Task|Configure|Transform)/.test(text) || /^BUILD /.test(text)) {
                run.message = text.slice(0, 160);
                this.publish(deviceId);
            }
        };

        try {
            await this.runGradle({ gradle, task, serial: device.serial, onLine: append, log: run.log, run });

            run.step = "launch";
            run.message = "Resolving the installed app";
            this.publish(deviceId);

            const packageName = plan.packageName ?? (await findApplicationId(gradle.root, { moduleHint: moduleFromTask(task) }));
            run.packageName = packageName ?? null;

            if (launch && packageName) {
                run.message = `Launching ${packageName}`;
                this.publish(deviceId);
                await this.manager.launchApp({ deviceId, packageName, activity: plan.activity ?? undefined });
                run.message = `Launched ${packageName}`;
            } else if (launch) {
                run.message = "Installed, but the app's package name could not be determined, so it was not launched.";
            } else {
                run.message = "Installed";
            }

            run.state = "succeeded";
            run.step = "done";
            run.finishedAt = new Date().toISOString();
            this.publish(deviceId);
            return this.statusFor(deviceId);
        } finally {
            releaseProject?.();
        }
    }

    /** Stops any Gradle this session started, so a reload cannot install onto a device it no longer holds. */
    async stopAll() {
        const running = Array.from(this.runs.values()).filter((run) => run.state === "running" && run.child);
        await Promise.all(
            running.map(
                (run) =>
                    new Promise((resolve) => {
                        const child = run.child;
                        if (!child || child.exitCode !== null) {
                            resolve();
                            return;
                        }
                        const done = setTimeout(() => {
                            child.kill("SIGKILL");
                            resolve();
                        }, 5_000);
                        done.unref?.();
                        child.once("close", () => {
                            clearTimeout(done);
                            resolve();
                        });
                        child.kill("SIGTERM");
                    }),
            ),
        );
    }

    runGradle({ gradle, task, serial, onLine, log, run }) {
        return new Promise((resolve, reject) => {
            const child = spawn(gradle.wrapper, [task], {
                cwd: gradle.root,
                env: { ...process.env, ANDROID_SERIAL: serial, TERM: "dumb" },
                stdio: ["ignore", "pipe", "pipe"],
            });

            if (run) {
                run.child = child;
            }

            let pending = "";
            const consume = (chunk) => {
                pending += chunk.toString("utf8");
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() ?? "";
                for (const line of lines) {
                    onLine(line);
                }
            };
            child.stdout.on("data", consume);
            child.stderr.on("data", consume);

            child.on("error", (error) => reject(new AppError("gradle_failed", `Could not run gradlew: ${error.message}`, 500)));
            child.on("close", (code) => {
                if (pending.trim()) {
                    onLine(pending);
                }
                if (code === 0) {
                    resolve();
                    return;
                }
                // Gradle's own explanation beats an exit code the user has to go hunting for.
                const summary = failureSummary(log ?? []);
                reject(
                    new AppError("build_failed", summary ? `${task} failed: ${summary}` : `${task} failed (exit code ${code}).`, 502),
                );
            });
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

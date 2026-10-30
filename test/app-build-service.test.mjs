/**
 * The Install button's build service: launching Gradle on every platform,
 * resolving the app to launch, and stopping builds -- by the user, by the agent,
 * and at shutdown -- without leaving anything behind.
 *
 * POSIX tests run real (harmless) `gradlew` shell scripts; Windows tests run
 * real `gradlew.bat` files. Nothing here talks to adb or a device.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { extensionModule, extensionRoot, isAlive, sleep, tempDir, waitUntil } from "./helpers.mjs";

const {
    AppBuildService,
    executorInitScript,
    executorPaths,
    findGradleRoot,
    gradleInvocation,
    ownedProcesses,
    parseTaskPath,
    readExecutorMarkers,
    resolveApplicationId,
    terminateProcessTree,
    variantFromTask,
    waitForProcessTreeExit,
} = await extensionModule("lib", "app-build-service.mjs");

// The extension's own executor records, kept out of the real ~/.copilot.
const executorDir = await mkdtemp(path.join(os.tmpdir(), "android-emulator-executors-"));
after(() => rm(executorDir, { recursive: true, force: true }));

const isWindows = process.platform === "win32";
const posixOnly = { skip: isWindows ? "POSIX process groups and shell fixtures" : false };
const windowsOnly = { skip: isWindows ? false : "needs cmd.exe and taskkill" };

function fakeManager({ launchApp } = {}) {
    const calls = { launch: [], notify: 0 };
    return {
        calls,
        snapshot: (deviceId) => ({ id: deviceId, serial: `serial-${deviceId}` }),
        notifyDevice: () => {
            calls.notify += 1;
        },
        launchApp: async (input) => {
            calls.launch.push(input);
            return launchApp ? launchApp(input) : input;
        },
    };
}

function newService(manager, options = {}) {
    return new AppBuildService({
        manager,
        terminateKillWaitMs: 2_000,
        executorExitWaitMs: 1_000,
        publishIntervalMs: 20,
        executorDir,
        ...options,
    });
}

async function writeMetadata(root, relativeDir, { applicationId, variantName, mtime } = {}) {
    const dir = path.join(root, ...relativeDir.split("/"));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "output-metadata.json");
    const body = { version: 3, applicationId, elements: [{ outputFile: "app.apk" }] };
    if (variantName) {
        body.variantName = variantName;
    }
    await writeFile(file, JSON.stringify(body));
    if (mtime) {
        await utimes(file, mtime, mtime);
    }
    return file;
}

/** A POSIX project whose wrapper runs `body`. */
async function posixProject(t, body, { config } = {}) {
    const root = await tempDir(t, "gradle-fixture-");
    const wrapper = path.join(root, "gradlew");
    await writeFile(wrapper, `#!/bin/sh\n${body}\n`);
    await chmod(wrapper, 0o755);
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.app", variantName: "debug" });
    if (config) {
        await writeFile(path.join(root, ".android-emulator.json"), JSON.stringify(config));
    }
    return root;
}

function rejection(promise) {
    return promise.then(
        () => {
            throw new Error("expected a rejection");
        },
        (error) => error,
    );
}

// --- launching Gradle -------------------------------------------------------------

test("POSIX runs the wrapper directly, in its own process group, without a shared daemon and with the task as one argument", () => {
    const invocation = gradleInvocation({
        wrapper: "/work/my project/gradlew",
        task: ":app:installDebug",
        initScript: "/state/build-executor.init.gradle",
        platform: "linux",
    });
    assert.equal(invocation.command, "/work/my project/gradlew");
    assert.deepEqual(invocation.args, ["--no-daemon", "--init-script", "/state/build-executor.init.gradle", ":app:installDebug"]);
    assert.equal(invocation.options.detached, true);
    assert.equal(invocation.options.shell, undefined);
});

test("Windows runs gradlew.bat through cmd.exe with the path and task quoted", () => {
    const wrapper = "C:\\Users\\A B\\proj & (x) ^ !\\gradlew.bat";
    const initScript = "C:\\Users\\A B\\.copilot\\build-executor.init.gradle";
    const invocation = gradleInvocation({
        wrapper,
        task: ":app:installDebug",
        initScript,
        platform: "win32",
        comSpec: "C:\\Windows\\system32\\cmd.exe",
    });
    assert.equal(invocation.command, "C:\\Windows\\system32\\cmd.exe");
    assert.deepEqual(invocation.args, [
        "/d",
        "/v:off",
        "/s",
        "/c",
        `""${wrapper}" --no-daemon --init-script "${initScript}" ":app:installDebug""`,
    ]);
    assert.equal(invocation.options.windowsVerbatimArguments, true);
    assert.equal(invocation.options.windowsHide, true);
    assert.equal(invocation.options.detached, undefined, "a detached Windows child would get its own console");
});

test("Windows refuses paths cmd.exe cannot quote", () => {
    for (const wrapper of ["C:\\a%PATH%b\\gradlew.bat", 'C:\\a"b\\gradlew.bat', "C:\\a\nb\\gradlew.bat"]) {
        assert.throws(() => gradleInvocation({ wrapper, task: "installDebug", initScript: "C:\\s\\i.gradle", platform: "win32" }), {
            code: "unsupported_gradle_path",
        });
    }
    assert.throws(
        () => gradleInvocation({ wrapper: "C:\\p\\gradlew.bat", task: "installDebug", initScript: "C:\\a%b\\i.gradle", platform: "win32" }),
        { code: "unsupported_gradle_path" },
    );
});

test("each platform looks for its own wrapper", async (t) => {
    const root = await tempDir(t);
    const nested = path.join(root, "app", "src");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, "gradlew.bat"), "@echo off\r\n");

    const windows = await findGradleRoot(nested, { platform: "win32" });
    assert.equal(windows?.root, root);
    assert.equal(windows?.wrapperName, "gradlew.bat");
    assert.equal(await findGradleRoot(nested, { platform: "linux" }), null, "POSIX cannot run gradlew.bat");
});

test("a non-executable POSIX gradlew is not offered", posixOnly, async (t) => {
    const root = await tempDir(t);
    await writeFile(path.join(root, "gradlew"), "#!/bin/sh\n", { mode: 0o644 });
    assert.equal(await findGradleRoot(root, { platform: "linux" }), null);
    await chmod(path.join(root, "gradlew"), 0o755);
    assert.equal((await findGradleRoot(root, { platform: "linux" }))?.root, root);
});

test("a task that looks like a Gradle option is refused before Gradle starts", posixOnly, async (t) => {
    const root = await posixProject(t, 'touch "$(dirname "$0")/ran"');
    const service = newService(fakeManager());
    service.setWorkingDirectory(root);
    for (const task of ["--init-script=evil.gradle", "-q", "installDebug --offline", "a;b", ":app:install Debug"]) {
        const error = await rejection(service.buildInstallLaunch({ deviceId: "dev", task }));
        assert.equal(error.code, "invalid_gradle_task", task);
    }
    await assert.rejects(readFile(path.join(root, "ran")), { code: "ENOENT" });
});

test("Gradle gets the device serial and the task verbatim, and output is published as it arrives", posixOnly, async (t) => {
    const root = await posixProject(
        t,
        [
            'echo "serial=$ANDROID_SERIAL argc=$# args=$*"',
            "printf 'Downloading 10%%\\rDownloading 100%%\\n'",
            "i=0; while [ $i -lt 30 ]; do echo \"compile line $i\"; i=$((i+1)); done",
            'echo "> Task :app:installDebug"',
            "sleep 0.4",
            "echo done",
        ].join("\n"),
    );
    const manager = fakeManager();
    const service = newService(manager);
    service.setWorkingDirectory(root);
    const running = service.buildInstallLaunch({ deviceId: "dev", task: ":app:installDebug" });

    await waitUntil(() => service.statusFor("dev")?.log.includes("> Task :app:installDebug"), { message: "streamed output" });
    const midway = service.statusFor("dev");
    assert.equal(midway.state, "running", "output is visible before the build ends");
    assert.equal(midway.message, "> Task :app:installDebug");
    assert.ok(midway.log.includes("Downloading 10%"), "carriage-return progress lines are split out");
    assert.ok(midway.log.includes("compile line 29"), "non-Gradle lines are published too");

    const result = await running;
    assert.equal(result.state, "succeeded");
    const { initScript } = executorPaths(executorDir);
    assert.ok(
        result.log.includes(`serial=serial-dev argc=4 args=--no-daemon --init-script ${initScript} :app:installDebug`),
        result.log.join("\n"),
    );
    assert.equal(result.command, "./gradlew --no-daemon :app:installDebug");
    assert.deepEqual(manager.calls.launch, [{ deviceId: "dev", packageName: "com.example.app", activity: undefined }]);
    assert.ok(manager.calls.notify < 20, `publication is coalesced (${manager.calls.notify} updates for 33 lines)`);
});

// --- choosing the app to launch -------------------------------------------------

test("task paths name a project and a variant", () => {
    assert.deepEqual(parseTaskPath(":app:installDebug"), { name: "installDebug", projectSegments: ["app"], qualified: true });
    assert.deepEqual(parseTaskPath("app:installDebug"), { name: "installDebug", projectSegments: ["app"], qualified: true });
    assert.deepEqual(parseTaskPath(":installDebug"), { name: "installDebug", projectSegments: [], qualified: true });
    assert.deepEqual(parseTaskPath("installDebug"), { name: "installDebug", projectSegments: [], qualified: false });
    assert.equal(variantFromTask("installFreeStagingDebug"), "freeStagingDebug");
    assert.equal(variantFromTask("installDebug"), "debug");
    assert.equal(variantFromTask("deployToDevice"), null);
});

test("an up-to-date debug install launches debug, not a newer release", async (t) => {
    const root = await tempDir(t);
    const old = new Date(Date.now() - 3_600_000);
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.debug", variantName: "debug", mtime: old });
    await writeMetadata(root, "app/build/outputs/apk/release", { applicationId: "com.example", variantName: "release" });

    assert.equal((await resolveApplicationId(root, ":app:installDebug")).applicationId, "com.example.debug");
    assert.equal((await resolveApplicationId(root, "installDebug")).applicationId, "com.example.debug");
    assert.equal((await resolveApplicationId(root, ":app:installRelease")).applicationId, "com.example");
});

test("flavored variants in nested modules resolve exactly, with or without variantName", async (t) => {
    const root = await tempDir(t);
    await writeMetadata(root, "features/shop/build/outputs/apk/free/debug", { applicationId: "com.shop.free", variantName: "freeDebug" });
    await writeMetadata(root, "features/shop/build/outputs/apk/paid/debug", { applicationId: "com.shop.paid", variantName: "paidDebug" });
    // Older AGP: no variantName, so the directory is the variant.
    await writeMetadata(root, "features/shop/build/outputs/apk/paid/release", { applicationId: "com.shop.paid.rel" });

    assert.equal((await resolveApplicationId(root, ":features:shop:installPaidDebug")).applicationId, "com.shop.paid");
    assert.equal((await resolveApplicationId(root, ":features:shop:installFreeDebug")).applicationId, "com.shop.free");
    assert.equal((await resolveApplicationId(root, ":features:shop:installPaidRelease")).applicationId, "com.shop.paid.rel");
});

test("a module-qualified task reads only its own module", async (t) => {
    const root = await tempDir(t);
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.app", variantName: "debug" });
    await writeMetadata(root, "wear/build/outputs/apk/debug", { applicationId: "com.example.wear", variantName: "debug" });

    assert.equal((await resolveApplicationId(root, ":app:installDebug")).applicationId, "com.example.app");
    assert.equal((await resolveApplicationId(root, ":wear:installDebug")).applicationId, "com.example.wear");
    const ambiguous = await rejection(resolveApplicationId(root, "installDebug"));
    assert.equal(ambiguous.code, "app_ambiguous");
    assert.match(ambiguous.message, /com\.example\.app/);
    assert.match(ambiguous.message, /packageName/);
});

test("a variant with no build output is reported, not guessed", async (t) => {
    const root = await tempDir(t);
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.app", variantName: "debug" });
    const error = await rejection(resolveApplicationId(root, ":app:installStaging"));
    assert.equal(error.code, "app_not_resolved");
    assert.match(error.message, /staging/);
});

test("an ambiguous app fails the run without launching anything, and keeps the log", posixOnly, async (t) => {
    const root = await posixProject(t, 'echo "BUILD SUCCESSFUL"');
    await writeMetadata(root, "wear/build/outputs/apk/debug", { applicationId: "com.example.wear", variantName: "debug" });
    const manager = fakeManager();
    const service = newService(manager);
    service.setWorkingDirectory(root);

    const error = await rejection(service.buildInstallLaunch({ deviceId: "dev" }));
    assert.equal(error.code, "app_ambiguous");
    assert.equal(error.buildRecorded, true);
    assert.equal(manager.calls.launch.length, 0);
    const status = service.statusFor("dev");
    assert.equal(status.state, "failed");
    assert.ok(status.log.includes("BUILD SUCCESSFUL"));
});

test("a configured packageName overrides resolution, and launch:false never needs one", posixOnly, async (t) => {
    const root = await posixProject(t, "exit 0", { config: { packageName: "com.configured", activity: ".Main" } });
    await writeMetadata(root, "wear/build/outputs/apk/debug", { applicationId: "com.example.wear", variantName: "debug" });
    const manager = fakeManager();
    const service = newService(manager);
    service.setWorkingDirectory(root);

    const launched = await service.buildInstallLaunch({ deviceId: "dev" });
    assert.equal(launched.packageName, "com.configured");
    assert.deepEqual(manager.calls.launch, [{ deviceId: "dev", packageName: "com.configured", activity: ".Main" }]);

    const plainRoot = await posixProject(t, "exit 0");
    await writeMetadata(plainRoot, "wear/build/outputs/apk/debug", { applicationId: "com.example.wear", variantName: "debug" });
    service.setWorkingDirectory(plainRoot);
    const installed = await service.buildInstallLaunch({ deviceId: "dev", launch: false });
    assert.equal(installed.state, "succeeded");
    assert.equal(installed.message, "Installed");
    assert.equal(installed.packageName, null, "ambiguity is just unknown when nothing is launched");
    assert.equal(manager.calls.launch.length, 1);
});

// --- cancelling ---------------------------------------------------------------------

test("cancelling a running build stops its whole process tree and nothing else", posixOnly, async (t) => {
    const root = await posixProject(
        t,
        ['sleep 30 &', 'echo $! > "$(dirname "$0")/grandchild.pid"', 'echo started', "wait"].join("\n"),
    );
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    t.after(() => bystander.kill("SIGKILL"));

    const manager = fakeManager();
    const service = newService(manager);
    service.setWorkingDirectory(root);
    const running = rejection(service.buildInstallLaunch({ deviceId: "dev" }));
    await waitUntil(() => service.statusFor("dev")?.log.includes("started"), { message: "the build to start" });
    const grandchild = Number(await readFile(path.join(root, "grandchild.pid"), "utf8"));
    assert.ok(isAlive(grandchild));
    assert.equal(service.statusFor("dev").cancellable, true);

    const startedAt = Date.now();
    const final = await service.cancel("dev", { runId: service.statusFor("dev").id, reason: "Cancelled by test." });
    assert.equal(final.state, "cancelled");
    assert.equal(final.message, "Cancelled by test.");
    assert.ok(Date.now() - startedAt < 5_000, "cancellation is bounded");
    assert.equal(isAlive(grandchild), false, "Gradle's descendants are stopped");
    assert.equal(isAlive(bystander.pid), true, "unrelated processes are left alone");
    assert.equal(manager.calls.launch.length, 0);
    assert.equal((await running).code, "build_cancelled");
    assert.match(service.runs.get("dev").termination.detail, /SIGKILL and confirmed them gone/);
    const stopped = service.runs.get("dev").termination.stopped.map((proc) => proc.pid);
    assert.ok(stopped.includes(grandchild), "the grandchild was among the processes stopped");
    assert.ok(!stopped.includes(bystander.pid));
});

test("a build that ignores SIGTERM is killed, and only then reported cancelled", posixOnly, async (t) => {
    const root = await posixProject(t, ["trap '' TERM", "echo started", "while :; do sleep 0.1; done"].join("\n"));
    const service = newService(fakeManager());
    service.setWorkingDirectory(root);
    const running = rejection(service.buildInstallLaunch({ deviceId: "dev" }));
    await waitUntil(() => service.statusFor("dev")?.log.includes("started"), { message: "the build to start" });
    const pid = service.runs.get("dev").child.pid;

    const final = await service.cancel("dev");
    assert.equal(final.state, "cancelled");
    assert.match(service.runs.get("dev").termination.detail, /SIGKILL and confirmed them gone/);
    assert.equal(isAlive(pid), false);
    await running;
});

test("a queued build can be cancelled without starting Gradle or wedging the queue", posixOnly, async (t) => {
    const root = await posixProject(
        t,
        [
            'echo run >> "$(dirname "$0")/runs.log"',
            'while [ ! -f "$(dirname "$0")/go" ]; do sleep 0.05; done',
            "echo finished",
        ].join("\n"),
    );
    const service = newService(fakeManager());
    service.setWorkingDirectory(root);
    const runs = async () => (await readFile(path.join(root, "runs.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;

    const first = service.buildInstallLaunch({ deviceId: "one", launch: false });
    await waitUntil(async () => (await runs()) === 1, { message: "the first build" });
    const second = rejection(service.buildInstallLaunch({ deviceId: "two", launch: false }));
    await waitUntil(() => service.statusFor("two")?.step === "queued", { message: "the second build to queue" });
    assert.equal(service.statusFor("two").cancellable, true);

    const cancelled = await service.cancel("two");
    assert.equal(cancelled.state, "cancelled");
    assert.equal((await second).code, "build_cancelled");
    assert.equal(await runs(), 1, "the queued build never started Gradle");

    await writeFile(path.join(root, "go"), "");
    assert.equal((await first).state, "succeeded");
    const third = await service.buildInstallLaunch({ deviceId: "two", launch: false });
    assert.equal(third.state, "succeeded", "the cancelled waiter did not block later builds");
    assert.equal(await runs(), 2);
    assert.equal(service.projectLocks.size, 0, "no lock outlives the builds");
});

test("cancelling while the build is still being prepared never spawns Gradle", posixOnly, async (t) => {
    const root = await posixProject(t, 'touch "$(dirname "$0")/ran"');
    const service = newService(fakeManager());
    service.setWorkingDirectory(root);
    const describe = service.describe.bind(service);
    let releaseDescribe;
    service.describe = () => new Promise((resolve) => {
        releaseDescribe = () => resolve(describe());
    });

    const running = rejection(service.buildInstallLaunch({ deviceId: "dev" }));
    assert.equal(service.statusFor("dev").step, "prepare");
    service.requestCancel("dev");
    releaseDescribe();
    assert.equal((await running).code, "build_cancelled");
    assert.equal(service.statusFor("dev").state, "cancelled");
    await sleep(100);
    await assert.rejects(readFile(path.join(root, "ran")), { code: "ENOENT" });
});

test("cancelling after Gradle succeeds but before launch skips the launch", posixOnly, async (t) => {
    const root = await posixProject(t, "exit 0");
    const manager = fakeManager();
    const service = newService(manager);
    service.setWorkingDirectory(root);
    manager.notifyDevice = () => {
        const status = service.statusFor("dev");
        if (status?.step === "launch" && status.cancellable) {
            service.requestCancel("dev");
        }
    };
    assert.equal((await rejection(service.buildInstallLaunch({ deviceId: "dev" }))).code, "build_cancelled");
    assert.equal(manager.calls.launch.length, 0);
    assert.equal(service.statusFor("dev").state, "cancelled");
});

test("a launch already dispatched is not cancellable, and shutdown waits for it", posixOnly, async (t) => {
    const root = await posixProject(t, "exit 0");
    let finishLaunch;
    const manager = fakeManager({ launchApp: () => new Promise((resolve) => (finishLaunch = resolve)) });
    const service = newService(manager);
    service.setWorkingDirectory(root);
    const running = service.buildInstallLaunch({ deviceId: "dev" });
    await waitUntil(() => manager.calls.launch.length === 1, { message: "the launch" });

    assert.equal(service.statusFor("dev").cancellable, false);
    assert.throws(() => service.requestCancel("dev"), { code: "build_not_cancellable" });

    let stopped = false;
    const stopping = service.stopAll().then(() => {
        stopped = true;
    });
    await sleep(100);
    assert.equal(stopped, false, "shutdown waits for the launch to settle");
    finishLaunch();
    await stopping;
    assert.equal((await running).state, "succeeded");
});

test("a stale cancel cannot stop a newer build", posixOnly, async (t) => {
    const root = await posixProject(t, "echo started; sleep 30");
    const service = newService(fakeManager());
    service.setWorkingDirectory(root);
    const running = rejection(service.buildInstallLaunch({ deviceId: "dev", launch: false }));
    await waitUntil(() => service.statusFor("dev")?.log.includes("started"), { message: "the build to start" });
    assert.throws(() => service.requestCancel("dev", { runId: "an-old-run" }), { code: "build_run_mismatch" });
    assert.equal(service.statusFor("dev").state, "running");
    await service.cancel("dev");
    await running;
    assert.throws(() => service.requestCancel("dev"), { code: "no_build_running" });
});

test("a refused second click does not make the running build look finished", posixOnly, async (t) => {
    const root = await posixProject(t, "echo started; sleep 30");
    const service = newService(fakeManager());
    service.setWorkingDirectory(root);
    const running = rejection(service.buildInstallLaunch({ deviceId: "dev", launch: false }));
    await waitUntil(() => service.statusFor("dev")?.log.includes("started"), { message: "the build to start" });

    const refused = await rejection(service.buildInstallLaunch({ deviceId: "dev" }));
    assert.equal(refused.code, "build_in_progress");
    service.reportFailure("dev", refused.message);
    assert.equal(service.statusFor("dev").state, "running");
    await service.cancel("dev");
    await running;
});

test("a cancelled waiter does not let a later build overtake the one still running", async () => {
    const service = newService(fakeManager());
    const run = () => ({ abort: new AbortController(), cancelReason: null });
    const [a, b, c] = [run(), run(), run()];

    const releaseA = await service.acquireProjectLock("/project", a, "one");
    const waitingB = rejection(service.acquireProjectLock("/project", b, "two"));
    b.abort.abort();
    assert.equal((await waitingB).code, "build_cancelled");

    // C arrives while A is still building: it must queue behind A, not start.
    let grantedC = false;
    const waitingC = service.acquireProjectLock("/project", c, "three").then((release) => {
        grantedC = true;
        return release;
    });
    await sleep(50);
    assert.equal(grantedC, false, "C was granted the project while A still held it");
    assert.equal(service.projectLocks.size, 1);

    releaseA();
    const releaseC = await waitingC;
    assert.equal(grantedC, true);
    releaseC();
    await waitUntil(() => service.projectLocks.size === 0, { message: "the lock to be dropped" });
});

/** A process-tree seam whose termination is never confirmed until `exit()` is called. */
function stuckProcessTree() {
    let confirmExit;
    const exited = new Promise((resolve) => {
        confirmExit = resolve;
    });
    return {
        tree: {
            terminate: async () => ({ confirmed: false, detail: "the test refused to confirm it" }),
            waitForExit: () => exited,
        },
        exit: (detail = "the test confirmed it") => confirmExit({ confirmed: true, detail }),
    };
}

function killGroup(pid) {
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        // Already gone.
    }
}

test("an unconfirmed cancellation is reported as such and keeps the project until Gradle exits", posixOnly, async (t) => {
    const root = await posixProject(
        t,
        [
            'echo run >> "$(dirname "$0")/runs.log"',
            "echo started",
            'while [ ! -f "$(dirname "$0")/go" ]; do sleep 0.05; done',
        ].join("\n"),
    );
    const stuck = stuckProcessTree();
    const service = newService(fakeManager(), { processTree: stuck.tree });
    service.setWorkingDirectory(root);
    const runs = async () => (await readFile(path.join(root, "runs.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;

    const running = rejection(service.buildInstallLaunch({ deviceId: "one", launch: false }));
    await waitUntil(() => service.statusFor("one")?.log.includes("started"), { message: "the build to start" });
    const pid = service.runs.get("one").child.pid;
    t.after(() => killGroup(pid));
    const queued = service.buildInstallLaunch({ deviceId: "two", launch: false });
    await waitUntil(() => service.statusFor("two")?.step === "queued", { message: "the second build to queue" });

    const startedAt = Date.now();
    const refused = await rejection(service.cancel("one"));
    assert.ok(Date.now() - startedAt < 5_000, "cancellation returns without waiting for Gradle");
    assert.equal(refused.code, "build_cancel_unconfirmed");
    const status = service.statusFor("one");
    assert.equal(status.state, "cancel_failed", "not claimed as cancelled");
    assert.equal(status.quarantined, true);
    assert.equal(status.orphanPid, pid);
    assert.match(status.message, new RegExp(`pid ${pid}`));
    const failure = await running;
    assert.equal(failure.code, "build_cancel_unconfirmed");
    assert.ok(failure.retainHoldUntil instanceof Promise, "the device holder is told to keep the device");

    assert.equal(service.isRunning("one"), true);
    assert.equal((await rejection(service.buildInstallLaunch({ deviceId: "one" }))).code, "build_cancel_unconfirmed");
    assert.throws(() => service.requestCancel("one"), { code: "build_cancel_unconfirmed" });
    service.reportFailure("one", "a later refusal");
    assert.equal(service.statusFor("one").state, "cancel_failed", "a refusal does not hide the quarantine");
    await sleep(200);
    assert.equal(service.statusFor("two").step, "queued", "the project stays locked");
    assert.equal(await runs(), 1);

    killGroup(pid);
    await writeFile(path.join(root, "go"), "");
    stuck.exit();
    assert.equal((await queued).state, "succeeded", "the queued build runs once Gradle is gone");
    assert.equal(await runs(), 2);
    assert.equal(service.statusFor("one").state, "cancelled");
    assert.match(service.statusFor("one").message, /has since exited/);
    await waitUntil(() => service.projectLocks.size === 0, { message: "the lock to be dropped" });
});

test("shutdown fails explicitly, naming the device, when a build cannot be confirmed stopped", posixOnly, async (t) => {
    const root = await posixProject(t, "echo started; sleep 30");
    const stuck = stuckProcessTree();
    const service = newService(fakeManager(), { processTree: stuck.tree });
    service.setWorkingDirectory(root);
    const running = rejection(service.buildInstallLaunch({ deviceId: "one", launch: false }));
    await waitUntil(() => service.statusFor("one")?.log.includes("started"), { message: "the build to start" });
    const pid = service.runs.get("one").child.pid;
    t.after(() => killGroup(pid));

    const error = await rejection(service.stopAll());
    assert.equal(error.code, "build_stop_unconfirmed");
    assert.deepEqual(error.details.deviceIds, ["one"]);
    assert.equal((await running).code, "build_cancel_unconfirmed");
    killGroup(pid);
    stuck.exit();
    await waitUntil(() => service.statusFor("one").state === "cancelled", { message: "the late confirmation" });
    await service.stopAll();
});

test("Windows does not count the wrapper exiting as the tree stopping when taskkill failed", async () => {
    const exitedChild = { pid: 4242, exitCode: 1, signalCode: null };
    const outcome = await terminateProcessTree(exitedChild, {
        platform: "win32",
        killWaitMs: 100,
        taskkill: async () => "ERROR: Access is denied.",
    });
    assert.equal(outcome.confirmed, false);
    assert.equal(outcome.treeUnreachable, true);
    assert.match(outcome.detail, /taskkill \/T \/F failed/);

    const ok = await terminateProcessTree(exitedChild, { platform: "win32", killWaitMs: 100, taskkill: async () => "ok" });
    assert.equal(ok.confirmed, true);

    // Once the wrapper is gone its children cannot be found, so it is never confirmed.
    const unreachable = waitForProcessTreeExit(exitedChild, { platform: "win32", pollMs: 10, treeUnreachable: true, taskkill: async () => "ok" });
    assert.equal(await Promise.race([unreachable.then(() => "confirmed"), sleep(200).then(() => "pending")]), "pending");

    // While the wrapper lives, taskkill is retried, and a success then an exit confirms it.
    const living = { pid: 4343, exitCode: null, signalCode: null };
    let attempts = 0;
    const retried = await waitForProcessTreeExit(living, {
        platform: "win32",
        pollMs: 10,
        taskkill: async () => {
            attempts += 1;
            if (attempts < 3) {
                return "ERROR: in use";
            }
            living.exitCode = 1;
            return "ok";
        },
    });
    assert.equal(retried.confirmed, true);
    assert.equal(attempts, 3);
});

// --- shutdown -------------------------------------------------------------------------

test("shutdown cancels running and queued builds, waits for both, and refuses new ones", posixOnly, async (t) => {
    const root = await posixProject(
        t,
        ['echo run >> "$(dirname "$0")/runs.log"', "echo started", "sleep 30"].join("\n"),
    );
    const manager = fakeManager();
    const service = newService(manager);
    service.setWorkingDirectory(root);
    const runs = async () => (await readFile(path.join(root, "runs.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;

    // Observed at once: both are expected to reject while stopAll is awaited.
    const active = rejection(service.buildInstallLaunch({ deviceId: "one" }));
    await waitUntil(() => service.statusFor("one")?.log.includes("started"), { message: "the first build" });
    const queued = rejection(service.buildInstallLaunch({ deviceId: "two" }));
    await waitUntil(() => service.statusFor("two")?.step === "queued", { message: "the second build to queue" });
    const pid = service.runs.get("one").child.pid;

    await service.stopAll();
    // Everything has settled by the time stopAll returns.
    assert.equal(service.statusFor("one").state, "cancelled");
    assert.equal(service.statusFor("two").state, "cancelled");
    assert.match(service.statusFor("one").message, /shutting down/);
    assert.equal(isAlive(pid), false);
    assert.equal(service.inflight.size, 0);
    assert.equal((await active).code, "build_cancelled");
    assert.equal((await queued).code, "build_cancelled");

    await sleep(200);
    assert.equal(await runs(), 1, "the queued build never spawned after shutdown");
    assert.equal(manager.calls.launch.length, 0, "nothing was launched after shutdown");
    const late = await rejection(service.buildInstallLaunch({ deviceId: "three" }));
    assert.equal(late.code, "build_service_stopped");
});

// --- Windows ------------------------------------------------------------------------

async function windowsProject(t, lines) {
    // Spaces and cmd metacharacters in the path are the point of the test.
    const parent = await tempDir(t, "gradle-win-");
    const root = path.join(parent, "my proj & (x) ^ !");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "gradlew.bat"), ["@echo off", ...lines].join("\r\n") + "\r\n");
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.app", variantName: "debug" });
    return root;
}

test("Windows runs gradlew.bat from a path with spaces and metacharacters", windowsOnly, async (t) => {
    const root = await windowsProject(t, [
        "echo serial=%ANDROID_SERIAL%",
        "echo arg1=[%~1]",
        "echo arg3=[%~3]",
        "echo arg4=[%~4]",
        "echo arg5=[%~5]",
        "echo ^> Task :app:installDebug",
        "exit /b 0",
    ]);
    const manager = fakeManager();
    const service = newService(manager);
    service.setWorkingDirectory(root);
    const result = await service.buildInstallLaunch({ deviceId: "dev", task: ":app:installDebug" });
    assert.equal(result.state, "succeeded", result.message);
    assert.equal(result.command, "gradlew.bat --no-daemon :app:installDebug");
    assert.ok(result.log.includes("serial=serial-dev"), result.log.join("\n"));
    assert.ok(result.log.includes("arg1=[--no-daemon]"), result.log.join("\n"));
    assert.ok(result.log.includes(`arg3=[${executorPaths(executorDir).initScript}]`), result.log.join("\n"));
    assert.ok(result.log.includes("arg4=[:app:installDebug]"), result.log.join("\n"));
    assert.ok(result.log.includes("arg5=[]"), "the task stays a single argument");
    assert.equal(manager.calls.launch[0]?.packageName, "com.example.app");
});

test("Windows reports a failing gradlew.bat as a build failure", windowsOnly, async (t) => {
    const root = await windowsProject(t, ["echo * What went wrong:", "echo Broken on purpose", "exit /b 3"]);
    const service = newService(fakeManager());
    service.setWorkingDirectory(root);
    const error = await rejection(service.buildInstallLaunch({ deviceId: "dev" }));
    assert.equal(error.code, "build_failed");
    assert.match(error.message, /Broken on purpose/);
});

test("Windows cancellation stops the gradlew.bat process tree", windowsOnly, async (t) => {
    const root = await windowsProject(t, ["echo started", "ping -n 60 127.0.0.1 >nul", "exit /b 0"]);
    const service = newService(fakeManager());
    service.setWorkingDirectory(root);
    const running = rejection(service.buildInstallLaunch({ deviceId: "dev" }));
    await waitUntil(() => service.statusFor("dev")?.log.includes("started"), { message: "the build to start", timeoutMs: 15_000 });
    const final = await service.cancel("dev");
    assert.equal(final.state, "cancelled");
    assert.equal(service.runs.get("dev").termination.confirmed, true, service.runs.get("dev").termination.detail);
    await running;
});

// --- the build executor ---------------------------------------------------------------
//
// The shell `gradlew` stand-ins above are not Gradle: they never evaluate the init
// script, so they write no executor record -- like a real build whose
// configuration cache was reused -- and are identified by ancestry alone. The
// stand-ins below emulate Gradle's side of the handshake: a separate process in
// its own session (as Gradle's daemon calls setsid) that writes the same record
// the real init script writes, then does "install" work that ignores SIGTERM.
// Real Gradle and AGP are exercised against an emulator outside this suite.

function proc(pid, ppid, pgid, lstart = "Thu Oct 22 10:00:00 2026", stat = "S") {
    return [pid, { pid, ppid, pgid, stat, lstart, startedAt: Date.parse(lstart) }];
}

test("ownership: the wrapper's group, its descendants, and recorded executors -- nothing else", () => {
    const snapshot = new Map([
        proc(1, 0, 1),
        proc(100, 1, 100), // wrapper, which execs the Gradle client
        proc(101, 100, 100), // something the client started in its group
        proc(200, 100, 200), // single-use daemon: child of the client, own session
        proc(201, 200, 200), // a worker the daemon started
        proc(202, 1, 200), // orphaned into the daemon's group
        proc(300, 1, 300, "Thu Oct 22 10:00:05 2026"), // executor reparented away, known only by its record
        proc(900, 1, 900), // an unrelated Gradle daemon
        proc(901, 900, 900), // its worker
        proc(950, 1, 950, "Thu Oct 22 09:00:00 2026"), // recorded pid, since reused by another process
    ]);
    const owned = ownedProcesses({
        snapshot,
        wrapperPid: 100,
        wrapperExited: false,
        markers: [
            { pid: 300, startedAt: Date.parse("Thu Oct 22 10:00:05 2026") + 400 },
            { pid: 950, startedAt: Date.parse("Thu Oct 22 10:00:00 2026") },
        ],
    });
    assert.deepEqual(Array.from(owned.keys()).sort((a, b) => a - b), [100, 101, 200, 201, 202, 300]);
});

test("ownership: a wrapper pid reused after exit, and a known pid restarted, are not adopted", () => {
    const snapshot = new Map([
        proc(100, 1, 100, "Thu Oct 22 11:00:00 2026"), // a new process that got the old wrapper pid
        proc(101, 100, 100, "Thu Oct 22 11:00:00 2026"),
        proc(200, 1, 200, "Thu Oct 22 11:00:00 2026"), // pid 200 now belongs to someone else
    ]);
    const owned = ownedProcesses({
        snapshot,
        wrapperPid: 100,
        wrapperExited: true,
        known: new Map([[200, "Thu Oct 22 10:00:00 2026"]]),
    });
    assert.equal(owned.size, 0);
});

test("executor records count only when written by this build's wrapper lineage after it started", async (t) => {
    const dir = await tempDir(t, "executor-records-");
    const spawnedAt = Date.now();
    const write = (name, body) => writeFile(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
    await write("10.json", { format: 1, pid: 10, ancestors: [4242, 1], startedAt: spawnedAt + 500 }); // ours
    await write("11.json", { format: 1, pid: 11, ancestors: [4242, 1], startedAt: spawnedAt - 60_000 }); // stale
    await write("12.json", { format: 1, pid: 12, ancestors: [777, 1], startedAt: spawnedAt + 500 }); // another build's
    await write("13.json", "{ not json");
    await write("14.json", { format: 2, pid: 14, ancestors: [4242], startedAt: spawnedAt + 500 });
    await write("15.json.tmp", { format: 1, pid: 15, ancestors: [4242], startedAt: spawnedAt + 500 });
    await write("4242.json", { format: 1, pid: 4242, ancestors: [1], startedAt: spawnedAt + 100 }); // in-process build
    const records = await readExecutorMarkers(dir, { wrapperPid: 4242, spawnedAt });
    assert.deepEqual(records.map((record) => record.pid).sort((a, b) => a - b), [10, 4242]);
});

test("the init script records pid, ancestry and start time atomically, and quotes its directory", () => {
    const script = executorInitScript("/home/o'neil\\x/executors");
    assert.ok(script.includes("new File('/home/o\\'neil\\\\x/executors')"), script);
    for (const piece of ["format: 1,", "pid: self.pid(),", "ancestors: ancestors,", "startInstant()", ".json.tmp", "renameTo(target)"]) {
        assert.ok(script.includes(piece), piece);
    }
    assert.match(script, /catch \(Throwable ignored\)/, "it can never fail the build");
    assert.doesNotMatch(script, /getenv|getProperty|providers\./, "reads no build input, so the configuration cache keeps working");
    assert.deepEqual(executorPaths("/s"), { initScript: path.join("/s", "build-executor.init.gradle"), markerDir: path.join("/s", "executors") });
});

/** A fake process table and kill(), so the stop sequence can be checked call by call. */
function fakeProcesses(entries) {
    const table = new Map(entries);
    const signals = [];
    const gone = new Set();
    return {
        table,
        signals,
        snapshot: async () => new Map(Array.from(table).filter(([pid]) => !gone.has(pid))),
        kill: (target, name) => {
            signals.push([target, name]);
            if (name === "SIGKILL" && target > 0 && table.has(target) && !table.get(target).unkillable) {
                gone.add(target);
            }
        },
    };
}

test("stopping freezes the wrapper first, kills only owned processes, and confirms only from a fresh snapshot", async () => {
    const fake = fakeProcesses([proc(1, 0, 1), proc(100, 1, 100), proc(200, 100, 200), proc(900, 1, 900)]);
    const child = { pid: 100, exitCode: null, signalCode: null };
    const kill = fake.kill;
    fake.kill = (target, name) => {
        kill(target, name);
        if (target === 100 && name === "SIGKILL") {
            child.signalCode = "SIGKILL";
        }
    };
    const outcome = await terminateProcessTree(child, { platform: "linux", snapshot: fake.snapshot, kill: fake.kill, killWaitMs: 500, pollMs: 5 });
    assert.equal(outcome.confirmed, true, outcome.detail);
    assert.deepEqual(fake.signals[0], [-100, "SIGSTOP"], "the wrapper's group is frozen before anything is looked up");
    const killed = fake.signals.filter(([, name]) => name === "SIGKILL").map(([target]) => target);
    assert.ok(killed.includes(200) && killed.includes(100));
    assert.ok(fake.signals.every(([target]) => ![1, 900, -1, -900].includes(target)), JSON.stringify(fake.signals));
    const stopIndex = fake.signals.findIndex(([target, name]) => target === 200 && name === "SIGSTOP");
    const killIndex = fake.signals.findIndex(([target, name]) => target === 200 && name === "SIGKILL");
    assert.ok(stopIndex !== -1 && stopIndex < killIndex, "the daemon is frozen before it is killed");
    assert.deepEqual(outcome.stopped.map((entry) => entry.pid).sort(), [100, 200]);
});

test("a recorded executor that cannot be seen to exit leaves the stop unconfirmed", async () => {
    const fake = fakeProcesses([proc(100, 1, 100), proc(300, 1, 300, "Thu Oct 22 10:00:05 2026")]);
    fake.table.get(300).unkillable = true;
    const child = { pid: 100, exitCode: 0, signalCode: null };
    const markers = async () => [{ pid: 300, startedAt: Date.parse("Thu Oct 22 10:00:05 2026") }];
    const outcome = await terminateProcessTree(child, { platform: "linux", snapshot: fake.snapshot, kill: fake.kill, markers, killWaitMs: 150, pollMs: 5 });
    assert.equal(outcome.confirmed, false);
    assert.match(outcome.detail, /300/);
    assert.deepEqual(outcome.executors, [300]);
});

test("a record that appears during the stop is acted on before it is confirmed", async () => {
    const fake = fakeProcesses([proc(100, 1, 100), proc(300, 1, 300, "Thu Oct 22 10:00:05 2026")]);
    const child = { pid: 100, exitCode: 0, signalCode: null };
    let reads = 0;
    const markers = async () => (++reads >= 2 ? [{ pid: 300, startedAt: Date.parse("Thu Oct 22 10:00:05 2026") }] : []);
    // The first pass finds nothing; the record read by the confirming pass names a live executor.
    const outcome = await terminateProcessTree(child, { platform: "linux", snapshot: fake.snapshot, kill: fake.kill, markers, killWaitMs: 500, pollMs: 5 });
    assert.equal(outcome.confirmed, true);
    assert.deepEqual(outcome.executors, [300]);
    assert.ok(fake.signals.some(([target, name]) => target === 300 && name === "SIGKILL"));
});

test("a process list that cannot be read is never taken as everything having stopped", async () => {
    const child = { pid: 100, exitCode: 0, signalCode: null };
    const outcome = await terminateProcessTree(child, {
        platform: "linux",
        snapshot: async () => {
            throw new Error("ps is unavailable");
        },
        kill: () => {},
        killWaitMs: 50,
        pollMs: 5,
    });
    assert.equal(outcome.confirmed, false);
    assert.match(outcome.detail, /could not be listed/);
});

/**
 * A project whose `gradlew` behaves like Gradle's client with a single-use
 * daemon. The daemon writes the executor record, prints "started", and
 * "installs" (writes `installed`) after `installAfterMs`, ignoring SIGTERM.
 * `orphan` makes it reparent away from the client, so only its record names it.
 */
async function daemonProject(t, { installAfterMs = 1_500, orphan = false, clientExits = false, daemonLingersMs = 0 } = {}) {
    const root = await tempDir(t, "daemon-fixture-");
    await writeFile(
        path.join(root, "daemon.cjs"),
        `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [role, initScript, root] = process.argv.slice(2);
if (role === "launcher") {
    // Starts the daemon in a new session, as Gradle's does, then exits so it is orphaned.
    spawn(process.execPath, [__filename, "daemon", initScript, root], { detached: true, stdio: "inherit" }).unref();
    process.exit(0);
}
process.on("SIGTERM", () => {});
const markerDir = path.join(path.dirname(initScript), "executors");
const ancestors = [process.ppid];
const startedAt = Math.round(performance.timeOrigin);
fs.mkdirSync(markerDir, { recursive: true });
fs.writeFileSync(path.join(markerDir, process.pid + ".json.tmp"), JSON.stringify({ format: 1, pid: process.pid, ancestors: ${orphan ? "[Number(process.env.WRAPPER_PID), 1]" : "ancestors"}, startedAt }));
fs.renameSync(path.join(markerDir, process.pid + ".json.tmp"), path.join(markerDir, process.pid + ".json"));
fs.writeFileSync(path.join(root, "daemon.pid"), String(process.pid));
console.log("started");
setTimeout(() => {
    fs.writeFileSync(path.join(root, "installed"), String(Date.now()));
    console.log("installed");
    setTimeout(() => process.exit(0), ${daemonLingersMs});
}, ${installAfterMs});
`,
    );
    const role = orphan ? "launcher" : "daemon";
    // $3 is the --init-script argument the service passes.
    // Like Gradle's daemon, one that outlives its client does not keep the client's output open.
    const detachOutput = clientExits ? '> "$ROOT/daemon.log" 2>&1' : "";
    const tail = clientExits ? 'while [ ! -f "$ROOT/daemon.pid" ]; do sleep 0.02; done; exit 0' : "sleep 30";
    await writeFile(
        path.join(root, "gradlew"),
        `#!/bin/sh\nROOT="$(dirname "$0")"\nexport WRAPPER_PID=$$\n"${process.execPath}" "$ROOT/daemon.cjs" ${role} "$3" "$ROOT" ${detachOutput} ${orphan ? "" : "&"}\n${tail}\n`,
    );
    await chmod(path.join(root, "gradlew"), 0o755);
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.app", variantName: "debug" });
    return root;
}

async function daemonPid(root) {
    await waitUntil(async () => Boolean(await readFile(path.join(root, "daemon.pid"), "utf8").catch(() => null)), { message: "the daemon" });
    return Number(await readFile(path.join(root, "daemon.pid"), "utf8"));
}

for (const orphan of [false, true]) {
    test(
        `cancelling stops the build's executor ${orphan ? "after it was orphaned from the client" : "outside the client's process group"} before reporting cancelled`,
        posixOnly,
        async (t) => {
            const root = await daemonProject(t, { orphan });
            // Stand-ins for things that are not this build's: another Gradle daemon in
            // its own session, and an ordinary process.
            const foreignDaemon = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
            const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
            t.after(() => {
                foreignDaemon.kill("SIGKILL");
                bystander.kill("SIGKILL");
            });
            const service = newService(fakeManager());
            service.setWorkingDirectory(root);
            const running = rejection(service.buildInstallLaunch({ deviceId: "dev", launch: false }));
            await waitUntil(() => service.statusFor("dev")?.log.includes("started"), { message: "the daemon to start" });
            const daemon = await daemonPid(root);
            t.after(() => {
                try {
                    process.kill(daemon, "SIGKILL");
                } catch {
                    // Gone, as expected.
                }
            });
            const final = await service.cancel("dev");
            assert.equal(isAlive(daemon), false, "the executor was gone before cancellation was reported");
            assert.equal(final.state, "cancelled");
            assert.equal((await running).code, "build_cancelled");
            const termination = service.runs.get("dev").termination;
            assert.deepEqual(termination.executors, [daemon], "the executor was identified by its record");
            assert.ok(termination.stopped.some((entry) => entry.pid === daemon));
            assert.equal(isAlive(foreignDaemon.pid), true, "another daemon is never touched");
            assert.equal(isAlive(bystander.pid), true);
            assert.deepEqual(await readdir(executorPaths(executorDir).markerDir).then((names) => names.filter((n) => n === `${daemon}.json`)), []);
            await sleep(2_000);
            await assert.rejects(readFile(path.join(root, "installed")), { code: "ENOENT" }, "nothing was installed after cancellation");
        },
    );
}

test("a build is only over once its executor has exited, even after the client has", posixOnly, async (t) => {
    const root = await daemonProject(t, { installAfterMs: 300, clientExits: true, daemonLingersMs: 200 });
    const service = newService(fakeManager(), { executorExitWaitMs: 3_000 });
    service.setWorkingDirectory(root);
    const result = await service.buildInstallLaunch({ deviceId: "dev", launch: false });
    const daemon = Number(await readFile(path.join(root, "daemon.pid"), "utf8"));
    assert.equal(result.state, "succeeded");
    assert.equal(isAlive(daemon), false, "the daemon had exited by the time the build was reported done");
    assert.ok(await readFile(path.join(root, "installed"), "utf8"), "it finished its work");
});

test("an executor that outlives its client beyond the wait is stopped, not trusted", posixOnly, async (t) => {
    const root = await daemonProject(t, { installAfterMs: 5_000, clientExits: true });
    const service = newService(fakeManager(), { executorExitWaitMs: 300 });
    service.setWorkingDirectory(root);
    const result = await service.buildInstallLaunch({ deviceId: "dev", launch: false });
    const daemon = Number(await readFile(path.join(root, "daemon.pid"), "utf8"));
    assert.equal(result.state, "succeeded");
    assert.equal(isAlive(daemon), false);
    assert.match(service.runs.get("dev").termination?.detail ?? "", /SIGKILL/);
    await assert.rejects(readFile(path.join(root, "installed")), { code: "ENOENT" });
});

test("waiting for a lingering executor keeps the process alive until the build settles", posixOnly, async (t) => {
    // Regression: with nothing else keeping Node alive, an unreferenced timer let it
    // exit with the build still waiting on its executor (seen with real Gradle).
    const root = await daemonProject(t, { installAfterMs: 0, clientExits: true, daemonLingersMs: 600 });
    const script = path.join(root, "run.mjs");
    await writeFile(
        script,
        [
            `const { AppBuildService } = await import(${JSON.stringify(pathToFileURL(path.join(extensionRoot, "lib", "app-build-service.mjs")).href)});`,
            "const manager = { snapshot: (id) => ({ id, serial: 's' }), notifyDevice() {}, async launchApp() {} };",
            `const service = new AppBuildService({ manager, executorDir: ${JSON.stringify(executorDir)} });`,
            `service.setWorkingDirectory(${JSON.stringify(root)});`,
            "const result = await service.buildInstallLaunch({ deviceId: 'dev', launch: false });",
            "console.log('SETTLED ' + result.state);",
        ].join("\n"),
    );
    const output = await new Promise((resolve) => {
        const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
        let text = "";
        child.stdout.on("data", (chunk) => (text += chunk));
        child.stderr.on("data", (chunk) => (text += chunk));
        child.on("close", () => resolve(text));
    });
    assert.match(output, /SETTLED succeeded/);
});

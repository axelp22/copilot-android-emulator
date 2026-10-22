/**
 * The build service wired into the rest of the extension: the device manager's
 * queue holds and leases, and the canvas server's routes. Discovery is stubbed
 * and coordination lives in temporary directories, so no device is touched.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { extensionModule, extensionRoot, isAlive, tempDir, waitUntil } from "./helpers.mjs";

const { DeviceSessionManager } = await extensionModule("lib", "device-session-manager.mjs");
const { DeviceClaimStore } = await extensionModule("lib", "device-claims.mjs");
const { DeviceQueue } = await extensionModule("lib", "device-queue.mjs");
const { createCanvasServer } = await extensionModule("lib", "canvas-server.mjs");
const { AppError } = await extensionModule("lib", "errors.mjs");
const { liveBuildProcesses, terminateProcessTree, waitForProcessTreeExit } = await extensionModule("lib", "app-build-service.mjs");

const isWindows = process.platform === "win32";

function bootedDevice(id) {
    return {
        id,
        serial: `emulator-${id}`,
        avdName: id,
        kind: "emulator",
        name: id,
        state: "Booted",
        isAvailable: true,
        apiLevel: 34,
        androidVersion: "14",
        screen: { width: 1080, height: 2400, density: 420 },
    };
}

/** A project whose build prints "started" and then runs until it is stopped. */
async function longBuildProject(t) {
    const root = await tempDir(t, "manager-build-");
    if (isWindows) {
        await writeFile(path.join(root, "gradlew.bat"), "@echo off\r\necho started\r\nping -n 60 127.0.0.1 >nul\r\n");
    } else {
        await writeFile(path.join(root, "gradlew"), '#!/bin/sh\necho "$ANDROID_SERIAL" >> "$(dirname "$0")/runs.log"\necho started\nsleep 30\n');
        await chmod(path.join(root, "gradlew"), 0o755);
    }
    const outputs = path.join(root, "app", "build", "outputs", "apk", "debug");
    await mkdir(outputs, { recursive: true });
    await writeFile(path.join(outputs, "output-metadata.json"), JSON.stringify({ applicationId: "com.example.app", variantName: "debug" }));
    return root;
}

async function createManager(t, { sessionId, root, project }) {
    const manager = new DeviceSessionManager({ onDiagnostic: () => {} });
    manager.claims = new DeviceClaimStore({ root: path.join(root, "claims") });
    manager.queue = new DeviceQueue({ root: path.join(root, "queue") });
    manager.discoverDevices = async () => [bootedDevice("Pixel_A"), bootedDevice("Pixel_B")];
    // The extension's executor records, kept out of the real ~/.copilot.
    manager.build.executorDir = path.join(root, "gradle-executors");
    manager.setSessionIdentity({ sessionId, workingDirectory: project });
    await manager.refreshDevices({ force: true });
    t.after(() => manager.dispose());
    return manager;
}

async function holder(manager, deviceId) {
    const [status] = await manager.queue.status([deviceId]);
    return status.holder ? { label: status.holder.sessionLabel, mine: status.holder.isMine } : null;
}

test("disposal releases a device only after its builds -- running and queued -- have stopped", { timeout: 30_000 }, async (t) => {
    const root = await tempDir(t, "coordination-");
    const project = await longBuildProject(t);
    const manager = await createManager(t, { sessionId: "session-one", root, project });

    const running = manager.buildInstallLaunch({ deviceId: "Pixel_A" }).catch((error) => error);
    await waitUntil(() => manager.build.statusFor("Pixel_A")?.log.includes("started"), { message: "the first build" });
    const queued = manager.buildInstallLaunch({ deviceId: "Pixel_B" }).catch((error) => error);
    await waitUntil(() => manager.build.statusFor("Pixel_B")?.step === "queued", { message: "the second build to queue" });
    assert.equal((await holder(manager, "Pixel_A"))?.mine, true, "the build holds its device");
    assert.equal((await holder(manager, "Pixel_B"))?.mine, true, "a queued build already holds its device");

    const pid = manager.build.runs.get("Pixel_A").child.pid;
    const releases = [];
    for (const method of ["release", "releaseAll"]) {
        const original = manager.queue[method].bind(manager.queue);
        manager.queue[method] = async (...args) => {
            const deviceId = method === "release" ? args[0] : null;
            releases.push({
                method,
                deviceId,
                // A device's own build has settled; for releaseAll, every build has.
                buildRunning: deviceId
                    ? manager.build.isRunning(deviceId)
                    : ["Pixel_A", "Pixel_B"].some((id) => manager.build.isRunning(id)),
                gradleAlive: deviceId === "Pixel_B" ? false : isAlive(pid),
            });
            return original(...args);
        };
    }

    await manager.dispose();
    assert.ok(releases.some((release) => release.method === "releaseAll"));
    for (const release of releases) {
        const label = `${release.method}(${release.deviceId ?? ""})`;
        assert.equal(release.buildRunning, false, `${label} ran with its build still running`);
        assert.equal(release.gradleAlive, false, `${label} ran with Gradle still alive`);
    }
    assert.equal(manager.build.inflight.size, 0);
    assert.equal((await running).code, "build_cancelled");
    assert.equal((await queued).code, "build_cancelled");
    assert.equal(await holder(manager, "Pixel_A"), null);
    assert.equal(await holder(manager, "Pixel_B"), null);

    const late = await manager.buildInstallLaunch({ deviceId: "Pixel_A" }).catch((error) => error);
    assert.equal(late.code, "build_service_stopped");
    assert.equal(await holder(manager, "Pixel_A"), null, "a refused build takes no hold");

    const other = await createManager(t, { sessionId: "session-two", root, project });
    const lease = await other.acquireLease({ deviceId: "Pixel_A", ownerInstanceId: "x", reason: "next" });
    assert.equal(lease.lease?.active, true, "another session can take the device straight away");
});

test("cancelling a build leaves the agent's lease and its device hold alone", { timeout: 30_000 }, async (t) => {
    const root = await tempDir(t, "coordination-");
    const project = await longBuildProject(t);
    const manager = await createManager(t, { sessionId: "session-one", root, project });

    const lease = await manager.acquireLease({ deviceId: "Pixel_A", ownerInstanceId: "agent", reason: "test run" });
    const running = manager.buildInstallLaunch({ deviceId: "Pixel_A", launch: false }).catch((error) => error);
    await waitUntil(() => manager.build.statusFor("Pixel_A")?.log.includes("started"), { message: "the build" });

    const final = await manager.cancelBuild({ deviceId: "Pixel_A", runId: manager.build.statusFor("Pixel_A").id });
    assert.equal(final.state, "cancelled");
    assert.equal((await running).code, "build_cancelled");
    assert.equal(manager.snapshot("Pixel_A").lease?.active, true, "the lease is untouched");
    assert.equal(manager.snapshot("Pixel_A").lease?.leaseId, lease.lease.leaseId);
    assert.equal((await holder(manager, "Pixel_A"))?.mine, true, "the lease still holds the device");
});

/** Termination that is never confirmed until `exit()`; the Gradle fixture is killed by the test. */
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
        exit: () => confirmExit({ confirmed: true, detail: "the test confirmed it" }),
    };
}

function killGroup(pid) {
    try {
        process.kill(isWindows ? pid : -pid, "SIGKILL");
    } catch {
        // Already gone.
    }
}

test(
    "an unconfirmed cancellation keeps the device held, even past the lease, until Gradle is gone",
    { timeout: 30_000, skip: isWindows ? "POSIX process groups" : false },
    async (t) => {
        const root = await tempDir(t, "coordination-");
        const project = await longBuildProject(t);
        const manager = await createManager(t, { sessionId: "session-one", root, project });
        const stuck = stuckProcessTree();
        manager.build.processTree = stuck.tree;

        const lease = await manager.acquireLease({ deviceId: "Pixel_A", ownerInstanceId: "agent", reason: "test run" });
        const running = manager.buildInstallLaunch({ deviceId: "Pixel_A", launch: false }).catch((error) => error);
        await waitUntil(() => manager.build.statusFor("Pixel_A")?.log.includes("started"), { message: "the build" });
        const pid = manager.build.runs.get("Pixel_A").child.pid;
        t.after(() => killGroup(pid));

        const refused = await manager.cancelBuild({ deviceId: "Pixel_A" }).catch((error) => error);
        assert.equal(refused.code, "build_cancel_unconfirmed");
        assert.equal(manager.build.statusFor("Pixel_A").state, "cancel_failed");
        assert.equal((await running).code, "build_cancel_unconfirmed");

        // The lease going away must not take the build's hold with it.
        await manager.releaseLease({ deviceId: "Pixel_A", leaseId: lease.lease.leaseId });
        assert.equal((await holder(manager, "Pixel_A"))?.mine, true, "the device stays held for the stuck build");
        const other = await createManager(t, { sessionId: "session-two", root, project });
        const blocked = await other.acquireLease({ deviceId: "Pixel_A", ownerInstanceId: "x", reason: "next" }).catch((error) => error);
        assert.equal(blocked.code, "device_busy", "another session cannot take the device");
        assert.equal(
            (await manager.buildInstallLaunch({ deviceId: "Pixel_A" }).catch((error) => error)).code,
            "build_cancel_unconfirmed",
            "no new build on the device",
        );

        killGroup(pid);
        stuck.exit();
        await waitUntil(async () => (await holder(manager, "Pixel_A")) === null, { message: "the hold to be released" });
        assert.equal(manager.build.statusFor("Pixel_A").state, "cancelled");

        // Recovered: a new build may run and be cancelled normally.
        manager.build.processTree = { terminate: terminateProcessTree, waitForExit: waitForProcessTreeExit, probe: liveBuildProcesses };
        const again = manager.buildInstallLaunch({ deviceId: "Pixel_A", launch: false }).catch((error) => error);
        await waitUntil(() => manager.build.statusFor("Pixel_A")?.state === "running" && manager.build.statusFor("Pixel_A").log.includes("started"), {
            message: "the next build",
        });
        assert.equal((await manager.cancelBuild({ deviceId: "Pixel_A" })).state, "cancelled");
        assert.equal((await again).code, "build_cancelled");
        await waitUntil(async () => (await holder(manager, "Pixel_A")) === null, { message: "the second hold to be released" });
    },
);

test(
    "disposal fails, and keeps only the stuck build's device, when Gradle cannot be confirmed stopped",
    { timeout: 30_000, skip: isWindows ? "POSIX process groups" : false },
    async (t) => {
        const root = await tempDir(t, "coordination-");
        const project = await longBuildProject(t);
        const manager = await createManager(t, { sessionId: "session-one", root, project });
        const stuck = stuckProcessTree();
        manager.build.processTree = stuck.tree;

        await manager.acquireLease({ deviceId: "Pixel_B", ownerInstanceId: "agent", reason: "idle" });
        const running = manager.buildInstallLaunch({ deviceId: "Pixel_A", launch: false }).catch((error) => error);
        await waitUntil(() => manager.build.statusFor("Pixel_A")?.log.includes("started"), { message: "the build" });
        const pid = manager.build.runs.get("Pixel_A").child.pid;
        t.after(() => killGroup(pid));

        const error = await manager.dispose().then(
            () => null,
            (failure) => failure,
        );
        assert.equal(error?.code, "build_stop_unconfirmed");
        assert.equal((await running).code, "build_cancel_unconfirmed");
        assert.equal((await holder(manager, "Pixel_A"))?.mine, true, "the stuck build's device is not handed on");
        assert.equal(await holder(manager, "Pixel_B"), null, "devices no build touches are released");

        killGroup(pid);
        stuck.exit();
        await waitUntil(async () => (await holder(manager, "Pixel_A")) === null, { message: "the late release" });
    },
);

test("a failure the run already recorded is not overwritten by the canvas", async (t) => {
    const root = await tempDir(t, "coordination-");
    const project = await longBuildProject(t);
    const manager = await createManager(t, { sessionId: "session-one", root, project });
    manager.build.runs.set("Pixel_A", { id: "r1", state: "failed", message: "compile error", log: ["e: oops"], logTotal: 1 });

    const recorded = new AppError("build_failed", "compile error", 502);
    recorded.buildRecorded = true;
    manager.reportInstallFailure("Pixel_A", recorded);
    assert.deepEqual(manager.build.statusFor("Pixel_A").log, ["e: oops"]);

    manager.reportInstallFailure("Pixel_A", new AppError("device_busy", "Someone else has it", 409));
    assert.equal(manager.build.statusFor("Pixel_A").message, "Someone else has it");
});

// --- canvas server routes -----------------------------------------------------------

function fakeCanvasManager({ lease = false } = {}) {
    const calls = { cancel: [], install: [], reported: [] };
    const state = {
        deviceId: "Pixel_A",
        state: "Booted",
        name: "Pixel A",
        screen: { width: 1080, height: 2400 },
        lease: lease ? { active: true, expiresAt: new Date(Date.now() + 60_000).toISOString() } : { active: false },
        sharing: { heldByOtherSession: false },
        install: null,
    };
    return {
        calls,
        subscribe: () => () => {},
        registerManualInputStop: () => () => {},
        refreshSharing: async () => null,
        snapshot: () => state,
        getCachedDeviceState: () => state,
        getDeviceState: async () => state,
        buildInstallLaunch: async (input) => {
            calls.install.push(input);
            const error = new AppError("build_failed", "recorded", 502);
            error.buildRecorded = true;
            throw error;
        },
        reportInstallFailure: (deviceId, error) => calls.reported.push({ deviceId, error }),
        cancelBuild: async (input) => {
            calls.cancel.push(input);
            return { id: input.runId, state: "running", cancelRequested: true };
        },
    };
}

function post(url, route, body) {
    const target = new URL(route, url);
    return new Promise((resolve, reject) => {
        const req = request(
            target,
            { method: "POST", headers: { "Content-Type": "application/json" } },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
            },
        );
        req.on("error", reject);
        req.end(JSON.stringify(body));
    });
}

async function startServer(t, manager) {
    const server = await createCanvasServer({
        manager,
        instanceId: "test",
        deviceId: "Pixel_A",
        webRoot: path.join(extensionRoot, "web"),
    });
    t.after(() => server.close());
    return server;
}

test("the canvas cancels the build it shows, without waiting for Gradle", async (t) => {
    const manager = fakeCanvasManager();
    const server = await startServer(t, manager);
    const response = await post(server.url, "api/install/cancel", { runId: "run-7" });
    assert.equal(response.status, 202);
    assert.deepEqual(manager.calls.cancel, [
        { deviceId: "Pixel_A", runId: "run-7", wait: false, reason: "Cancelled from the canvas." },
    ]);
});

test("the canvas cannot cancel while an agent holds the device", async (t) => {
    const manager = fakeCanvasManager({ lease: true });
    const server = await startServer(t, manager);
    const response = await post(server.url, "api/install/cancel", { runId: "run-7" });
    assert.equal(response.status, 423);
    assert.equal(response.body.error.code, "lease_active");
    assert.equal(manager.calls.cancel.length, 0);
});

test("an install failure is handed over with its error, so a recorded run keeps its log", async (t) => {
    const manager = fakeCanvasManager();
    const server = await startServer(t, manager);
    const response = await post(server.url, "api/install", {});
    assert.equal(response.status, 202);
    await waitUntil(() => manager.calls.reported.length === 1, { message: "the failure report" });
    assert.equal(manager.calls.reported[0].error.buildRecorded, true);
});

test("the new tray script is served to the canvas", async (t) => {
    const server = await startServer(t, fakeCanvasManager());
    const response = await fetch(new URL("status-tray.js", server.url));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.match(await response.text(), /export function createBuildPanel/);
});

test("closing the canvas server does not wait on a request that never finishes", { timeout: 10_000 }, async (t) => {
    const manager = { ...fakeCanvasManager(), getFramePng: () => new Promise(() => {}) };
    const server = await createCanvasServer({
        manager,
        instanceId: "test",
        deviceId: "Pixel_A",
        webRoot: path.join(extensionRoot, "web"),
    });
    // Aborted afterwards regardless, so a regression fails this test instead of
    // leaving the run waiting on the socket.
    const client = new AbortController();
    t.after(() => client.abort());
    const hanging = fetch(new URL("api/frame.png", server.url), { signal: client.signal }).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const outcome = await Promise.race([
        server.close().then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 3_000)),
    ]);
    assert.equal(outcome, "closed", "shutdown must not hang on an open connection, or the device is never released");
    assert.ok((await hanging) instanceof Error);
});

test(
    "launching by package skips monkey's system keys, which AVDs without hardware keys refuse",
    { skip: isWindows ? "POSIX shell stand-in for adb" : false },
    async (t) => {
        const { resolveToolchain } = await extensionModule("lib", "adb.mjs");
        const sdk = await tempDir(t, "fake-sdk-");
        await mkdir(path.join(sdk, "platform-tools"));
        // Mirrors real monkey on such an AVD: exit 251 unless system keys are turned off.
        await writeFile(
            path.join(sdk, "platform-tools", "adb"),
            '#!/bin/sh\necho "$*" >> "$(dirname "$0")/calls.log"\n' +
                'case "$*" in *"--pct-syskeys 0"*) echo "Events injected: 1"; exit 0;; esac\n' +
                'echo "** SYS_KEYS has no physical keys but with factor 2.0%." >&2\nexit 251\n',
        );
        await chmod(path.join(sdk, "platform-tools", "adb"), 0o755);
        const previous = process.env.ANDROID_HOME;
        process.env.ANDROID_HOME = sdk;
        await resolveToolchain({ refresh: true });
        t.after(async () => {
            if (previous === undefined) {
                delete process.env.ANDROID_HOME;
            } else {
                process.env.ANDROID_HOME = previous;
            }
            await resolveToolchain({ refresh: true });
        });

        const root = await tempDir(t, "coordination-");
        const manager = await createManager(t, { sessionId: "session-one", root, project: root });
        const launched = await manager.launchApp({ deviceId: "Pixel_A", packageName: "com.example.app" });
        assert.equal(launched.packageName, "com.example.app");
        const calls = await readFile(path.join(sdk, "platform-tools", "calls.log"), "utf8");
        assert.match(calls, /-s emulator-Pixel_A shell monkey -p com\.example\.app -c android\.intent\.category\.LAUNCHER --pct-syskeys 0 1/);
    },
);

test(
    "a cancelled build keeps its device and project until Gradle's executor is gone, then releases them",
    { timeout: 30_000, skip: isWindows ? "POSIX shell stand-in for gradlew" : false },
    async (t) => {
        const project = await tempDir(t, "manager-build-");
        // Not Gradle: stands in for its single-use daemon. It runs in its own session,
        // so stopping the client's group does not stop it; it writes the executor
        // record Gradle's init script writes, then "installs" after a while,
        // ignoring SIGTERM, unless it is killed first.
        await writeFile(
            path.join(project, "daemon.cjs"),
            [
                'const fs = require("node:fs");',
                'const path = require("node:path");',
                "const [initScript, root] = process.argv.slice(2);",
                'process.on("SIGTERM", () => {});',
                'const dir = path.join(path.dirname(initScript), "executors");',
                "fs.mkdirSync(dir, { recursive: true });",
                "const ancestors = [process.ppid, Number(process.env.WRAPPER_PID)];",
                "const record = { format: 1, pid: process.pid, ancestors, startedAt: Math.round(performance.timeOrigin) };",
                'fs.writeFileSync(path.join(dir, process.pid + ".json"), JSON.stringify(record));',
                'fs.writeFileSync(path.join(root, "daemon.pid"), String(process.pid));',
                'console.log("started");',
                'setTimeout(() => fs.writeFileSync(path.join(root, "installed"), String(Date.now())), 1_500);',
                "setInterval(() => {}, 1_000);",
            ].join("\n"),
        );
        await writeFile(
            path.join(project, "gradlew"),
            `#!/bin/sh\nROOT="$(dirname "$0")"\nexport WRAPPER_PID=$$\n"${process.execPath}" -e 'require("node:child_process").spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "inherit" })' "$ROOT/daemon.cjs" "$3" "$ROOT"\nsleep 30\n`,
        );
        await chmod(path.join(project, "gradlew"), 0o755);
        const outputs = path.join(project, "app", "build", "outputs", "apk", "debug");
        await mkdir(outputs, { recursive: true });
        await writeFile(path.join(outputs, "output-metadata.json"), JSON.stringify({ applicationId: "com.example.app", variantName: "debug" }));
        const root = await tempDir(t, "coordination-");
        const manager = await createManager(t, { sessionId: "session-one", root, project });

        const running = manager.buildInstallLaunch({ deviceId: "Pixel_A", launch: false }).catch((error) => error);
        await waitUntil(() => manager.build.statusFor("Pixel_A")?.log.includes("started"), { message: "the build" });
        const daemon = Number(await readFile(path.join(project, "daemon.pid"), "utf8"));
        t.after(() => {
            try {
                process.kill(daemon, "SIGKILL");
            } catch {
                // Gone, as expected.
            }
        });

        // While it is being stopped, the device and the project are still reserved.
        const during = [];
        const terminate = manager.build.processTree.terminate;
        manager.build.processTree.terminate = async (child, options) => {
            during.push({ held: (await holder(manager, "Pixel_A"))?.mine, locked: manager.build.projectLocks.size, daemonAlive: isAlive(daemon) });
            return terminate(child, options);
        };
        const releases = [];
        const original = manager.queue.release.bind(manager.queue);
        manager.queue.release = async (...args) => {
            releases.push({ daemonAlive: isAlive(daemon), locked: manager.build.projectLocks.size });
            return original(...args);
        };

        assert.equal((await manager.cancelBuild({ deviceId: "Pixel_A" })).state, "cancelled");
        assert.equal((await running).code, "build_cancelled");
        assert.deepEqual(during, [{ held: true, locked: 1, daemonAlive: true }]);
        assert.equal(releases.length, 1);
        assert.equal(releases[0].daemonAlive, false, "the executor was gone before the device was released");
        assert.equal(manager.build.runs.get("Pixel_A").termination.executors[0], daemon);
        await waitUntil(() => manager.build.projectLocks.size === 0, { message: "the project lock" });
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await assert.rejects(readFile(path.join(project, "installed")), { code: "ENOENT" }, "nothing installed after release");
    },
);

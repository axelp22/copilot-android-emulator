/**
 * Device-free checks for the opt-in AGP fixture suite (scripts/verify/agp-fixture.mjs):
 * the disposable-target guard, the suite's refusal paths with a fake adb that
 * records every call, and the shape of the checked-in fixture. Nothing here
 * builds the fixture or talks to a real device.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { checkDisposableTarget } from "../scripts/verify/_disposable-target.mjs";
import { checkPackageAbsent, cleanupFixture, finishFixtureRun, hasPackage, holdFixtureDevice } from "../scripts/verify/_fixture-package.mjs";
import { extensionModule, repoRoot, tempDir } from "./helpers.mjs";

const fixtureRoot = path.join(repoRoot, "test", "fixtures", "agp-app");

/** A fake `adb -s <serial> ...` keyed by the args after the serial. */
function fakeAdb(responses) {
    const calls = [];
    const runAdb = async (args) => {
        calls.push(args.join(" "));
        const value = responses[args.join(" ")];
        if (value instanceof Error) {
            throw value;
        }
        return value ?? "";
    };
    return { calls, runAdb };
}

const healthyEmulator = {
    "get-state": "device\n",
    "shell getprop ro.kernel.qemu": "1\n",
    "shell getprop ro.boot.qemu": "\n",
    "shell getprop sys.boot_completed": "1\n",
    "emu avd name": "Throwaway_API_34\r\nOK\r\n",
};

test("the guard requires an explicit serial and makes no adb call without one", async () => {
    for (const serial of [undefined, "", "   "]) {
        const { calls, runAdb } = fakeAdb(healthyEmulator);
        const result = await checkDisposableTarget({ serial, runAdb });
        assert.equal(result.ok, false);
        assert.equal(result.code, "serial_required");
        assert.match(result.reason, /VERIFY_AGP_SERIAL/);
        assert.deepEqual(calls, []);
    }
});

test("the guard refuses serials that are not emulator-<port>", async () => {
    for (const serial of ["R5CT1234ABC", "192.168.1.20:5555", "emulator-", "emulator-x", "adb-XYZ._adb-tls-connect._tcp"]) {
        const { calls, runAdb } = fakeAdb(healthyEmulator);
        const result = await checkDisposableTarget({ serial, runAdb });
        assert.equal(result.ok, false, serial);
        assert.equal(result.code, "not_emulator_serial", serial);
        assert.deepEqual(calls, [], serial);
    }
});

test("the guard checks connection, adb state, emulator kind and boot", async () => {
    const cases = [
        [{ ...healthyEmulator, "get-state": new Error("device 'emulator-5580' not found") }, "not_connected"],
        [{ ...healthyEmulator, "get-state": "offline\n" }, "not_ready"],
        [{ ...healthyEmulator, "shell getprop ro.kernel.qemu": "0\n" }, "not_emulator"],
        [{ ...healthyEmulator, "shell getprop sys.boot_completed": "\n" }, "not_booted"],
    ];
    for (const [responses, code] of cases) {
        const { runAdb } = fakeAdb(responses);
        const result = await checkDisposableTarget({ serial: "emulator-5580", runAdb });
        assert.equal(result.ok, false, code);
        assert.equal(result.code, code);
    }
});

test("the guard accepts a booted emulator and reports its AVD", async () => {
    const { runAdb } = fakeAdb(healthyEmulator);
    assert.deepEqual(await checkDisposableTarget({ serial: " emulator-5580 ", runAdb }), {
        ok: true,
        serial: "emulator-5580",
        avdName: "Throwaway_API_34",
    });

    const { runAdb: bootQemuOnly } = fakeAdb({
        ...healthyEmulator,
        "shell getprop ro.kernel.qemu": "\n",
        "shell getprop ro.boot.qemu": "1\n",
    });
    assert.equal((await checkDisposableTarget({ serial: "emulator-5582", runAdb: bootQemuOnly })).ok, true);
});

/** Runs the suite with a recording fake adb (answering `responses`, keyed by the args after the serial) and a gradle that must never be invoked. */
async function runSuite(t, env, responses = { "get-state": "offline\n" }) {
    const dir = await tempDir(t, "agp-fixture-suite-");
    const log = path.join(dir, "calls.log");
    // Node scripts rather than executables, so the stand-ins run on Windows as well: the suite runs `.cjs` tools under node.
    const fake = async (name, body) => {
        const file = path.join(dir, `${name}.cjs`);
        await writeFile(
            file,
            `require("node:fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + "\\n");\n` +
                body,
        );
        return file;
    };
    // An `{ error }` response fails the command, like adb does.
    const adb = await fake(
        "adb",
        `const value = ${JSON.stringify(responses)}[process.argv.slice(4).join(" ")];\n` +
            `if (value && typeof value === "object") { process.stderr.write(value.error); process.exit(1); }\n` +
            `if (typeof value === "string") { process.stdout.write(value); }\n`,
    );
    const gradle = await fake("gradle", "process.exit(1);\n");

    const childEnv = { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir, VERIFY_ADB: adb, VERIFY_GRADLE: gradle, ...env };
    for (const [key, value] of Object.entries(childEnv)) {
        if (value === undefined) {
            delete childEnv[key];
        }
    }
    const { code, output } = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "verify", "agp-fixture.mjs")], {
            cwd: repoRoot,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (chunk) => (text += chunk));
        child.stderr.on("data", (chunk) => (text += chunk));
        child.on("error", reject);
        child.on("close", (exit) => resolve({ code: exit, output: text }));
    });
    const calls = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
    return { code, output, calls };
}

test("the suite refuses to run without VERIFY_AGP_SERIAL and never calls adb", { timeout: 30_000 }, async (t) => {
    const { code, output, calls } = await runSuite(t, { VERIFY_AGP_SERIAL: undefined, VERIFY_SERIAL: "emulator-5554" });
    assert.equal(code, 2, output);
    assert.match(output, /refusing to run/);
    assert.match(output, /VERIFY_AGP_SERIAL/);
    assert.deepEqual(calls, []);
});

test("the suite refuses a non-emulator serial without calling adb", { timeout: 30_000 }, async (t) => {
    const { code, output, calls } = await runSuite(t, { VERIFY_AGP_SERIAL: "R5CT1234ABC" });
    assert.equal(code, 2, output);
    assert.match(output, /not_emulator_serial/);
    assert.deepEqual(calls, []);
});

test("the suite refuses an emulator that is not ready, addressing only that serial", { timeout: 30_000 }, async (t) => {
    const { code, output, calls } = await runSuite(t, { VERIFY_AGP_SERIAL: "emulator-5580" });
    assert.equal(code, 2, output);
    assert.match(output, /not_ready/);
    assert.deepEqual(calls, ["adb -s emulator-5580 get-state"]);
});

const PKG = "dev.copilot.androidemulator.fixture";
const LIST = `shell pm list packages ${PKG}`;
const neverInstalls = (calls) =>
    assert.deepEqual(
        calls.filter((call) => /^gradle |\binstall\b|\buninstall\b|force-stop/.test(call)),
        [],
        "no build, install or removal",
    );

test("the suite refuses an emulator that already has the fixture package", { timeout: 30_000 }, async (t) => {
    const { code, output, calls } = await runSuite(t, { VERIFY_AGP_SERIAL: "emulator-5580" }, {
        ...healthyEmulator,
        [LIST]: `package:${PKG}.extra\npackage:${PKG}\n`,
    });
    assert.equal(code, 2, output);
    assert.match(output, /package_present/);
    neverInstalls(calls);
    assert.ok(calls.every((call) => call.startsWith("adb -s emulator-5580 ")));
});

test("the suite refuses when it cannot check for the fixture package", { timeout: 30_000 }, async (t) => {
    const { code, output, calls } = await runSuite(t, { VERIFY_AGP_SERIAL: "emulator-5580" }, {
        ...healthyEmulator,
        [LIST]: { error: "error: closed" },
    });
    assert.equal(code, 2, output);
    assert.match(output, /package_check_failed/);
    neverInstalls(calls);
});

test("the suite refuses a VERIFY_ADB that is not the adb the extension and Gradle use", { timeout: 30_000 }, async (t) => {
    // Only a similarly named package is installed, so the preflight passes; the fake adb is never the SDK's.
    const { code, output, calls } = await runSuite(t, { VERIFY_AGP_SERIAL: "emulator-5580" }, {
        ...healthyEmulator,
        [LIST]: `package:${PKG}.extra\n`,
    });
    assert.equal(code, 2, output);
    assert.match(output, /adb_mismatch/);
    neverInstalls(calls);
    assert.ok(calls.includes(`adb -s emulator-5580 ${LIST}`));
});

test("the package preflight matches the exact package and fails closed", async () => {
    assert.equal(hasPackage(`package:${PKG}.extra\r\n`, PKG), false);
    assert.equal(hasPackage(`package:${PKG}\r\n`, PKG), true);
    assert.deepEqual(await checkPackageAbsent({ packageName: PKG, runAdb: fakeAdb({ [LIST]: "" }).runAdb }), { ok: true });
    assert.equal((await checkPackageAbsent({ packageName: PKG, runAdb: fakeAdb({ [LIST]: `package:${PKG}\n` }).runAdb })).code, "package_present");
    assert.equal((await checkPackageAbsent({ packageName: PKG, runAdb: fakeAdb({ [LIST]: new Error("offline") }).runAdb })).code, "package_check_failed");
});

/** Cleanup with a recording fake adb; `log` records order across adb, builds and scratch removal. */
async function cleanup(responses, overrides = {}) {
    const log = [];
    const { runAdb } = fakeAdb(responses);
    const result = await cleanupFixture({
        packageName: PKG,
        serial: "emulator-5580",
        runAdb: async (args) => {
            log.push(`adb ${args.join(" ")}`);
            return runAdb(args);
        },
        stopBuilds: async () => log.push("stopBuilds"),
        installAttempted: true,
        scratch: "/tmp/agp-fixture-x",
        removeScratch: async () => log.push("removeScratch"),
        ...overrides,
    });
    return { ...result, log };
}

test("cleanup stops builds first, then uninstalls, verifies and removes scratch", async () => {
    const { checks, log } = await cleanup({ [LIST]: "" });
    assert.deepEqual(log, [
        "stopBuilds",
        `adb shell am force-stop ${PKG}`,
        `adb uninstall ${PKG}`,
        `adb ${LIST}`,
        "removeScratch",
    ]);
    assert.deepEqual(checks, [{ ok: true, label: "the fixture is uninstalled afterwards", detail: "" }]);
});

test("cleanup never reports a removal it could not verify", async () => {
    const unverified = await cleanup({ [LIST]: new Error("device offline") });
    assert.equal(unverified.checks.length, 1);
    assert.equal(unverified.checks[0].ok, false);
    assert.match(unverified.checks[0].detail, /could not be verified/);

    const stillThere = await cleanup({ [`uninstall ${PKG}`]: new Error("DELETE_FAILED_INTERNAL_ERROR"), [LIST]: `package:${PKG}\n` });
    assert.equal(stillThere.checks[0].ok, false);
    assert.match(stillThere.checks[0].detail, /still installed: DELETE_FAILED/);
});

test("cleanup keeps the package and scratch when builds are not confirmed stopped", async () => {
    const error = Object.assign(new Error("Gradle could not be confirmed stopped for emulator-5580"), { code: "build_stop_unconfirmed" });
    const { checks, notes, log } = await cleanup({ [LIST]: "" }, { stopBuilds: async () => Promise.reject(error) });
    assert.deepEqual(log, [], "no uninstall or scratch removal after an unconfirmed stop");
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, false);
    assert.match(checks[0].detail, /build_stop_unconfirmed/);
    assert.match(checks[0].detail, /adb -s emulator-5580 uninstall/);
    assert.deepEqual(notes, ["kept /tmp/agp-fixture-x"]);
});

test("cleanup surfaces a scratch removal failure and skips the uninstall when nothing was installed", async () => {
    const { checks, log } = await cleanup({}, {
        installAttempted: false,
        removeScratch: async () => {
            throw new Error("EBUSY");
        },
    });
    assert.deepEqual(log, ["stopBuilds"], "builds stopped, but no adb calls");
    assert.deepEqual(checks.map((check) => [check.ok, check.label]), [[false, "the scratch directory is removed"]]);
    assert.match(checks[0].detail, /EBUSY/);
});

async function listFiles(dir, base = dir) {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listFiles(full, base)));
        } else {
            files.push(path.relative(base, full).split(path.sep).join("/"));
        }
    }
    return files;
}

test("the AGP fixture is minimal and self-contained", async () => {
    // Local build output and a generated wrapper/local.properties are git-ignored; only source counts.
    const ignored = /^(\.gradle\/|build\/|app\/build\/|gradle\/|gradlew(\.bat)?$|local\.properties$)/;
    const files = (await listFiles(fixtureRoot)).filter((file) => !ignored.test(file)).sort();
    assert.deepEqual(files, [
        ".gitignore",
        "app/build.gradle.kts",
        "app/src/main/AndroidManifest.xml",
        "app/src/main/java/dev/copilot/androidemulator/fixture/MainActivity.java",
        "build.gradle.kts",
        "gradle.properties",
        "settings.gradle.kts",
    ]);
    const gitignore = await readFile(path.join(fixtureRoot, ".gitignore"), "utf8");
    for (const entry of ["gradlew", "gradlew.bat", "gradle/wrapper/", "local.properties", "build/"]) {
        assert.ok(gitignore.split(/\r?\n/).includes(entry), `.gitignore keeps ${entry} out of the repo`);
    }

    const appBuild = await readFile(path.join(fixtureRoot, "app", "build.gradle.kts"), "utf8");
    assert.match(appBuild, /applicationId = "dev\.copilot\.androidemulator\.fixture"/);
    assert.doesNotMatch(appBuild, /dependencies\s*\{[^}]*\S[^}]*\}/, "the fixture has no library dependencies");
    assert.doesNotMatch(appBuild, /androidx/i);

    const properties = await readFile(path.join(fixtureRoot, "gradle.properties"), "utf8");
    assert.match(properties, /^fixtureAgpVersion=\d+\.\d+\.\d+$/m);

    const manifest = await readFile(path.join(fixtureRoot, "app", "src", "main", "AndroidManifest.xml"), "utf8");
    assert.match(manifest, /android\.intent\.category\.LAUNCHER/);
    assert.ok((await stat(path.join(fixtureRoot, "settings.gradle.kts"))).isFile());
});

/** A real extension manager whose shared queue lives in `queueRoot` instead of the user's home. */
async function sharedQueueManager(queueRoot, claimsRoot) {
    const { DeviceSessionManager } = await extensionModule("lib", "device-session-manager.mjs");
    const { DeviceQueue } = await extensionModule("lib", "device-queue.mjs");
    const { DeviceClaimStore } = await extensionModule("lib", "device-claims.mjs");
    const manager = new DeviceSessionManager({ onDiagnostic: () => {} });
    manager.queue = new DeviceQueue({ root: queueRoot });
    manager.claims = new DeviceClaimStore({ root: claimsRoot });
    return manager;
}

test("two fixture runs contend for the same device through the shared queue and never install together", async (t) => {
    const dir = await tempDir(t, "agp-fixture-queue-");
    const queueRoot = path.join(dir, "queue");
    const claimsRoot = path.join(dir, "claims");
    const first = await sharedQueueManager(queueRoot, claimsRoot);
    const second = await sharedQueueManager(queueRoot, claimsRoot);
    t.after(async () => {
        await first.dispose().catch(() => {});
        await second.dispose().catch(() => {});
    });
    const deviceId = "emulator-5580";

    const held = await holdFixtureDevice({ manager: first, deviceId, serial: "emulator-5580", runId: "11111111-run-one" });
    assert.equal(held.ok, true);
    const refused = await holdFixtureDevice({ manager: second, deviceId, serial: "emulator-5580", runId: "22222222-run-two" });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "device_busy");
    assert.match(refused.reason, /agp-fixture suite 11111111/);

    // The install path (withDeviceHold) runs for the holder and is refused for the other run.
    const installs = [];
    await first.withDeviceHold(deviceId, "install", async () => {
        installs.push("first");
        await assert.rejects(
            second.withDeviceHold(deviceId, "install", async () => installs.push("second")),
            (error) => error.code === "device_busy",
        );
    });
    assert.deepEqual(installs, ["first"]);
    const [stillHeld] = await first.queue.status([deviceId]);
    assert.equal(stillHeld.holder?.isMine, true, "an install inside the run keeps the run's hold");

    await held.release();
    const after = await holdFixtureDevice({ manager: second, deviceId, serial: "emulator-5580", runId: "33333333-run-three" });
    assert.equal(after.ok, true, "the device is free once the first run releases it");
    await after.release();
});

test("a real Copilot session's hold makes the fixture refuse", async (t) => {
    const dir = await tempDir(t, "agp-fixture-session-");
    const { DeviceQueue } = await extensionModule("lib", "device-queue.mjs");
    const session = new DeviceQueue({ root: path.join(dir, "queue"), owner: { sessionId: "copilot-session", sessionLabel: "my-app" } });
    assert.ok(await session.acquire(["emulator-5580"], { reason: "debugging" }));
    t.after(() => session.releaseAll().catch(() => {}));
    const fixture = await sharedQueueManager(path.join(dir, "queue"), path.join(dir, "claims"));
    t.after(() => fixture.dispose().catch(() => {}));

    const result = await holdFixtureDevice({ manager: fixture, deviceId: "emulator-5580", serial: "emulator-5580" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "device_busy");
    assert.match(result.reason, /my-app \(debugging\) holds it/);
});

test("the suite uses the extension's shared queue rather than a private one", async () => {
    const source = await readFile(path.join(repoRoot, "scripts", "verify", "agp-fixture.mjs"), "utf8");
    assert.doesNotMatch(source, /new DeviceQueue|\.queue\s*=/);
    assert.match(source, /holdFixtureDevice\(/);
});

/** A reporter that records instead of exiting, in the order calls happen. */
function recordingReport(log) {
    const report = { checks: [], notes: [], finished: false };
    report.assert = (ok, label, detail = "") => report.checks.push({ ok, label, detail });
    report.note = (note) => report.notes.push(note);
    report.skip = () => {};
    report.finish = () => {
        report.finished = true;
        log.push("finish");
    };
    return report;
}

/**
 * The suite's end-of-run path with the real extension manager and shared queue; only
 * the build service is faked so Gradle can stay unconfirmed until `gradle.exited`.
 */
async function supervisedRun(t, { pollMs = 20 } = {}) {
    const dir = await tempDir(t, "agp-fixture-supervise-");
    const queueRoot = path.join(dir, "queue");
    const claimsRoot = path.join(dir, "claims");
    const manager = await sharedQueueManager(queueRoot, claimsRoot);
    const rival = await sharedQueueManager(queueRoot, claimsRoot);
    t.after(async () => {
        await manager.dispose().catch(() => {});
        await rival.dispose().catch(() => {});
    });
    const deviceId = "emulator-5580";
    const hold = await holdFixtureDevice({ manager, deviceId, serial: deviceId, runId: "44444444-run-sup" });
    assert.equal(hold.ok, true);

    const log = [];
    const gradle = { exited: false, stopAttempts: 0 };
    const unconfirmed = () =>
        Object.assign(new Error(`Gradle could not be confirmed stopped for ${deviceId}`), {
            code: "build_stop_unconfirmed",
            details: { deviceIds: [deviceId] },
        });
    manager.build = {
        runs: new Map([[deviceId, { orphanPid: 4242 }]]),
        stopAll: async () => {
            gradle.stopAttempts += 1;
            if (!gradle.exited) {
                throw unconfirmed();
            }
        },
    };
    let beats = 0;
    const { runAdb } = fakeAdb({ [LIST]: "" });
    const signals = new EventEmitter();
    const exits = [];
    const report = recordingReport(log);
    const done = finishFixtureRun({
        packageName: PKG,
        serial: deviceId,
        runAdb: async (args) => {
            log.push(`adb ${args.join(" ")}`);
            return runAdb(args);
        },
        stopBuilds: () => manager.build.stopAll(),
        installAttempted: true,
        scratch: "/tmp/agp-fixture-sup",
        removeScratch: async () => log.push("removeScratch"),
        releaseHold: async () => {
            log.push("releaseHold");
            await hold.release();
        },
        dispose: async () => {
            log.push("dispose");
            await manager.dispose();
        },
        heartbeat: async () => {
            beats += 1;
            await manager.queue.beat();
        },
        orphanPids: () => [...manager.build.runs.values()].map((run) => run.orphanPid),
        report,
        pollMs,
        signals,
        exit: (code) => exits.push(code),
    });
    const until = async (predicate) => {
        while (!predicate()) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    };
    return { manager, rival, deviceId, log, gradle, report, signals, exits, done, until, beats: () => beats };
}

test("an unconfirmed Gradle stop keeps the run alive and the shared hold live until it exits", { timeout: 20_000 }, async (t) => {
    const run = await supervisedRun(t);
    await run.until(() => run.gradle.stopAttempts >= 3 && run.beats() >= 2);

    // Still supervising: nothing uninstalled, released, disposed or exited.
    assert.equal(run.report.finished, false, "report.finish (process.exit) is not reached while Gradle is unconfirmed");
    assert.deepEqual(run.log, [], "no uninstall, scratch removal, release or dispose before confirmation");
    assert.deepEqual(run.exits, []);
    assert.ok(run.report.notes.some((note) => /^FAIL: Gradle could not be confirmed stopped/.test(note)));
    assert.ok(run.report.notes.some((note) => /pid 4242/.test(note) && /adb -s emulator-5580 uninstall/.test(note)));

    // Other sessions stay excluded through the same shared store, and the hold is renewed.
    const [status] = await run.manager.queue.status([run.deviceId]);
    assert.equal(status.holder?.isMine, true);
    const blocked = await holdFixtureDevice({ manager: run.rival, deviceId: run.deviceId, serial: run.deviceId, runId: "55555555-rival" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "device_busy");

    run.gradle.exited = true;
    await run.done;
    assert.deepEqual(run.log, [
        `adb shell am force-stop ${PKG}`,
        `adb uninstall ${PKG}`,
        `adb ${LIST}`,
        "removeScratch",
        "releaseHold",
        "dispose",
        "finish",
    ]);
    assert.ok(run.report.notes.includes("Gradle has since exited; finishing cleanup."));
    assert.ok(run.report.checks.some((check) => !check.ok && check.label === "builds are confirmed stopped before cleanup"), "the run still fails");
    assert.ok(run.report.checks.some((check) => check.ok && check.label === "the fixture is uninstalled afterwards"));
    assert.deepEqual(run.exits, []);

    const after = await holdFixtureDevice({ manager: run.rival, deviceId: run.deviceId, serial: run.deviceId, runId: "66666666-rival" });
    assert.equal(after.ok, true, "the device is free only after confirmed cleanup");
    await after.release();
});

test("one signal while supervising only warns; a second abandons with recovery steps and exit 1", { timeout: 20_000 }, async (t) => {
    const run = await supervisedRun(t, { pollMs: 60_000 });
    await run.until(() => run.report.notes.length > 0);

    run.signals.emit("SIGINT", "SIGINT");
    assert.ok(run.report.notes.some((note) => /SIGINT received, but Gradle is still unconfirmed/.test(note)));
    assert.deepEqual(run.exits, []);

    run.signals.emit("SIGTERM", "SIGTERM");
    await run.done;
    assert.deepEqual(run.exits, [1]);
    const abandoned = run.report.checks.find((check) => check.label === "the device stays held until Gradle is confirmed stopped");
    assert.equal(abandoned?.ok, false);
    assert.match(abandoned.detail, /abandoned on SIGTERM/);
    assert.match(abandoned.detail, /adb -s emulator-5580 uninstall/);
    assert.equal(run.report.finished, false);
    assert.deepEqual(run.log, [], "abandoning does not uninstall, release or dispose");
    assert.equal(run.signals.listenerCount("SIGINT") + run.signals.listenerCount("SIGTERM"), 0, "signal handlers are removed");
});

test("the suite ends through finishFixtureRun and never exits on its own after cleanup", async () => {
    const source = await readFile(path.join(repoRoot, "scripts", "verify", "agp-fixture.mjs"), "utf8");
    const tail = source.slice(source.lastIndexOf("} finally {"));
    assert.match(tail, /await finishFixtureRun\(\{/);
    assert.match(tail, /stopBuilds: \(\) => manager\.build\.stopAll\(\)/);
    assert.match(tail, /heartbeat: \(\) => manager\.queue\.beat\(\)/);
    assert.doesNotMatch(tail, /report\.finish\(|process\.exit\(|cleanupFixture\(/);
    assert.doesNotMatch(source, /cleanupFixture/);
});

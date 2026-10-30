/**
 * Device-free checks for the opt-in AGP fixture suite (scripts/verify/agp-fixture.mjs):
 * the disposable-target guard, the suite's refusal paths with a fake adb that
 * records every call, and the shape of the checked-in fixture. Nothing here
 * builds the fixture or talks to a real device.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { checkDisposableTarget } from "../scripts/verify/_disposable-target.mjs";
import { repoRoot, tempDir } from "./helpers.mjs";

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

/** Runs the suite with a recording fake adb and a gradle that must never be invoked. */
async function runSuite(t, env) {
    const dir = await tempDir(t, "agp-fixture-suite-");
    const log = path.join(dir, "calls.log");
    const fake = (name, body) => {
        const file = path.join(dir, name);
        return writeFile(
            file,
            `#!${process.execPath}\n` +
                `require("node:fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + "\\n");\n` +
                body,
        ).then(() => chmod(file, 0o755).then(() => file));
    };
    const adb = await fake("adb", `if (process.argv[4] === "get-state") { process.stdout.write("offline\\n"); }\n`);
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

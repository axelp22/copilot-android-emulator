/**
 * Install against a real Android Gradle Plugin build. `app-install.mjs` uses a
 * stand-in gradlew; this suite copies the checked-in fixture under
 * test/fixtures/agp-app to a temporary directory, runs a real AGP build through
 * the extension's Install flow, and checks the result on a disposable emulator.
 *
 * Opt-in only. It needs an explicitly named, already-booted emulator that you
 * are happy to install and uninstall an app on. There is no default serial and
 * no fallback to whichever device adb would pick:
 *
 *   VERIFY_AGP_SERIAL=emulator-5580 node scripts/verify/agp-fixture.mjs
 *
 * See scripts/verify/README.md for the requirements and an isolated setup.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDisposableTarget } from "./_disposable-target.mjs";
import { checkPackageAbsent, finishFixtureRun, hasPackage, holdFixtureDevice, sameExecutable } from "./_fixture-package.mjs";
import { createReporter, extensionImport, sleep } from "./_shared.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "..", "..", "test", "fixtures", "agp-app");
const FIXTURE_PACKAGE = "dev.copilot.androidemulator.fixture";

const settings = {
    serial: (process.env.VERIFY_AGP_SERIAL ?? "").trim(),
    adbOverride: (process.env.VERIFY_ADB ?? "").trim(),
    adb: null,
    gradle: process.env.VERIFY_GRADLE || "gradle",
    gradleVersion: process.env.VERIFY_AGP_GRADLE_VERSION || "8.13",
    agpVersion: (process.env.VERIFY_AGP_VERSION ?? "").trim(),
    keepProject: process.env.VERIFY_AGP_KEEP === "1",
};

const report = createReporter("AGP FIXTURE");

/** Runs a tool without a shell. A `.js`/`.cjs`/`.mjs` path (a test stand-in) runs under this node, so it works on Windows too. */
function run(command, args, options = {}) {
    if (/\.[cm]?js$/i.test(command)) {
        [command, args] = [process.execPath, [command, ...args]];
    }
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

/** Every device command goes through `adb -s <serial>`: nothing here can reach another device. */
const runAdb = (args) => run(settings.adb, ["-s", settings.serial, ...args]);

// --- refuse anything that is not an explicit, booted emulator -----------------
// Checked before anything else (including loading the extension) so a missing
// or wrong serial never results in a device command.
if (!settings.serial) {
    console.error(
        "AGP FIXTURE: refusing to run. Set VERIFY_AGP_SERIAL to the serial of a disposable, " +
            "already-booted emulator (for example VERIFY_AGP_SERIAL=emulator-5580). There is no default.",
    );
    process.exit(2);
}

function refuse(code, reason) {
    console.error(`AGP FIXTURE: refusing to run (${code}). ${reason}`);
    process.exit(2);
}

// The extension and Gradle find adb through ANDROID_HOME / the SDK, not VERIFY_ADB,
// so the suite uses that same adb unless told otherwise (resolving it runs no device command).
const { resolveToolchain } = await extensionImport("lib", "adb.mjs");
const extensionAdb = (await resolveToolchain()).adbPath;
settings.adb = settings.adbOverride || extensionAdb;
if (!settings.adb) {
    refuse("adb_not_found", "No adb found. Set ANDROID_HOME to an SDK with platform-tools.");
}

const target = await checkDisposableTarget({ serial: settings.serial, runAdb });
if (!target.ok) {
    refuse(target.code, target.reason);
}
report.note(`target ${target.serial}${target.avdName ? ` (AVD ${target.avdName})` : ""}`);

// Only an app the suite installed itself may be removed: refuse if it is already there.
// Checked again below once the device is held, which is the check that counts.
const absent = await checkPackageAbsent({ packageName: FIXTURE_PACKAGE, runAdb });
if (!absent.ok) {
    refuse(absent.code, absent.reason);
}

// The guard above used VERIFY_ADB; the build and install use the extension's adb.
// A different binary could talk to a different server, so the two must agree.
if (settings.adbOverride && !(await sameExecutable(settings.adbOverride, extensionAdb))) {
    refuse(
        "adb_mismatch",
        `VERIFY_ADB (${settings.adbOverride}) is not the adb the extension and Gradle use (${extensionAdb ?? "none found"}). ` +
            "Unset VERIFY_ADB, or point ANDROID_HOME at the SDK that contains it.",
    );
}

const { DeviceSessionManager } = await extensionImport("lib", "device-session-manager.mjs");

// --- hold the device in the shared queue every Copilot session uses -----------
// The manager keeps its default queue and claim stores, so a session driving this
// serial, or another fixture run, makes the suite refuse instead of installing
// alongside it. The hold lasts until cleanup has finished.
const manager = new DeviceSessionManager({ onDiagnostic: () => {} });
/** Gives up the shared hold (and anything else the manager holds) before a refusal. */
async function refuseHeld(code, reason) {
    await manager.dispose().catch(() => {});
    refuse(code, reason);
}
let deviceId;
try {
    // Always resolve by the explicit serial; never let the manager choose.
    deviceId = await manager.resolveDeviceId(settings.serial);
    const device = manager.state.getDeviceOrThrow(deviceId);
    if (device.serial !== settings.serial || device.kind !== "emulator") {
        throw new Error(`resolved ${deviceId} (${device.serial}, ${device.kind}) instead of emulator ${settings.serial}`);
    }
} catch (error) {
    await refuseHeld("target_not_resolved", String(error?.message ?? error));
}
const hold = await holdFixtureDevice({ manager, deviceId, serial: settings.serial });
if (!hold.ok) {
    await refuseHeld(hold.code, hold.reason);
}
const absentWhileHeld = await checkPackageAbsent({ packageName: FIXTURE_PACKAGE, runAdb });
if (!absentWhileHeld.ok) {
    await refuseHeld(absentWhileHeld.code, absentWhileHeld.reason);
}
report.assert(true, "the device is held in the shared device queue", `${deviceId} as ${hold.owner.sessionLabel}`);

const scratch = await mkdtemp(path.join(os.tmpdir(), "agp-fixture-"));
const project = path.join(scratch, "project");
const wrapperDir = path.join(scratch, "wrapper");
let installAttempted = false;

try {
    // --- a private copy of the fixture with a generated wrapper ---------------
    await cp(fixtureRoot, project, {
        recursive: true,
        filter: (source) => !/[\\/](\.gradle|build|local\.properties)$/.test(source),
    });
    if (settings.agpVersion) {
        const propertiesFile = path.join(project, "gradle.properties");
        const properties = await readFile(propertiesFile, "utf8");
        await writeFile(
            propertiesFile,
            properties.replace(/^fixtureAgpVersion=.*$/m, `fixtureAgpVersion=${settings.agpVersion}`),
        );
    }

    // The wrapper is generated in an empty directory: `gradle wrapper` inside the
    // fixture would configure the project, and so need AGP, before it exists.
    await mkdir(wrapperDir, { recursive: true });
    await writeFile(path.join(wrapperDir, "settings.gradle"), "");
    await run(settings.gradle, ["wrapper", "--gradle-version", settings.gradleVersion, "-q"], { cwd: wrapperDir });
    for (const entry of ["gradlew", "gradlew.bat", "gradle"]) {
        await cp(path.join(wrapperDir, entry), path.join(project, entry), { recursive: true });
    }
    report.assert(true, "the fixture is copied with a generated wrapper", `Gradle ${settings.gradleVersion}`);

    // --- the extension, pointed at the copy and the named emulator only --------
    // Artifacts and the project stay in the scratch directory; only the queue is shared.
    manager.setArtifactsRoot(path.join(scratch, "artifacts"));
    manager.build.setWorkingDirectory(project);
    report.assert(true, "the extension resolves the named emulator", `${deviceId} -> ${settings.serial}`);

    const plan = await manager.refreshBuildPlan();
    report.assert(plan.available === true, "the fixture is detected as a Gradle project", String(plan.gradleRoot));
    report.assert(plan.task === "installDebug", "the default task is installDebug", String(plan.task));

    // --- real build, install and launch ----------------------------------------
    report.note(`building with AGP ${settings.agpVersion || "from gradle.properties"}; the first run downloads dependencies`);
    let result = null;
    let failure = null;
    // The package was confirmed absent above, so whatever is installed from here on is ours.
    installAttempted = true;
    try {
        result = await manager.buildInstallLaunch({ deviceId });
    } catch (error) {
        failure = error;
    }
    report.assert(result?.state === "succeeded", "the AGP build installs and launches", result ? `${result.state}: ${result.message}` : `${failure?.code}: ${String(failure?.message).slice(0, 200)}`);
    report.assert(result?.packageName === FIXTURE_PACKAGE, "the application id comes from the real build output", String(result?.packageName));

    const packages = await runAdb(["shell", "pm", "list", "packages", FIXTURE_PACKAGE]).catch(() => "");
    report.assert(hasPackage(packages, FIXTURE_PACKAGE), "the fixture is installed on the target emulator");

    let focused = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
        focused = await runAdb(["shell", "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"]).catch(() => "");
        if (focused.includes(FIXTURE_PACKAGE)) {
            break;
        }
        await sleep(500);
    }
    report.assert(
        focused.includes(FIXTURE_PACKAGE),
        "the fixture activity is in the foreground",
        focused.trim().split("\n")[0]?.slice(0, 90) ?? "no focus reported",
    );

    const [queueAfter] = await manager.queue.status([deviceId]);
    report.assert(queueAfter.holder?.isMine === true, "the device stays held by this run after the build", queueAfter.holder?.sessionLabel ?? "no holder");
} catch (error) {
    report.assert(false, "the suite ran to completion", String(error?.message ?? error).slice(0, 300));
} finally {
    // Cleanup with builds confirmed stopped first. If they cannot be confirmed, this
    // never returns: the process stays alive holding the device until they are.
    await finishFixtureRun({
        packageName: FIXTURE_PACKAGE,
        serial: settings.serial,
        runAdb,
        // stopAll throws unless every build is confirmed stopped.
        stopBuilds: () => manager.build.stopAll(),
        installAttempted,
        scratch,
        keepScratch: settings.keepProject,
        removeScratch: () => rm(scratch, { recursive: true, force: true }),
        releaseHold: () => hold.release(),
        dispose: () => manager.dispose(),
        heartbeat: () => manager.queue.beat(),
        orphanPids: () => [...manager.build.runs.values()].map((run) => run.orphanPid),
        report,
    });
}

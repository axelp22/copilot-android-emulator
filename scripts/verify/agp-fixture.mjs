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
import { createReporter, extensionRoot, sleep } from "./_shared.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, "..", "..", "test", "fixtures", "agp-app");
const FIXTURE_PACKAGE = "dev.copilot.androidemulator.fixture";

const settings = {
    serial: (process.env.VERIFY_AGP_SERIAL ?? "").trim(),
    adb: process.env.VERIFY_ADB || "adb",
    gradle: process.env.VERIFY_GRADLE || "gradle",
    gradleVersion: process.env.VERIFY_AGP_GRADLE_VERSION || "8.13",
    agpVersion: (process.env.VERIFY_AGP_VERSION ?? "").trim(),
    keepProject: process.env.VERIFY_AGP_KEEP === "1",
};

const report = createReporter("AGP FIXTURE");

function run(command, args, options = {}) {
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

const target = await checkDisposableTarget({ serial: settings.serial, runAdb });
if (!target.ok) {
    console.error(`AGP FIXTURE: refusing to run (${target.code}). ${target.reason}`);
    process.exit(2);
}
report.note(`target ${target.serial}${target.avdName ? ` (AVD ${target.avdName})` : ""}`);

const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));
const { DeviceQueue } = await import(path.join(extensionRoot, "lib", "device-queue.mjs"));

const scratch = await mkdtemp(path.join(os.tmpdir(), "agp-fixture-"));
const project = path.join(scratch, "project");
const wrapperDir = path.join(scratch, "wrapper");
let manager = null;
let installedByUs = false;

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
    manager = new DeviceSessionManager({ onDiagnostic: () => {} });
    manager.setArtifactsRoot(path.join(scratch, "artifacts"));
    manager.queue = new DeviceQueue({
        root: path.join(scratch, "queue"),
        owner: { sessionId: "verify-agp-fixture", sessionLabel: "agp-fixture-suite" },
    });
    manager.build.setWorkingDirectory(project);

    // Always resolve by the explicit serial; never let the manager choose.
    const deviceId = await manager.resolveDeviceId(settings.serial);
    const device = manager.state.getDeviceOrThrow(deviceId);
    if (device.serial !== settings.serial || device.kind !== "emulator") {
        throw new Error(`resolved ${deviceId} (${device.serial}, ${device.kind}) instead of emulator ${settings.serial}`);
    }
    report.assert(true, "the extension resolves the named emulator", `${deviceId} -> ${device.serial}`);

    const plan = await manager.refreshBuildPlan();
    report.assert(plan.available === true, "the fixture is detected as a Gradle project", String(plan.gradleRoot));
    report.assert(plan.task === "installDebug", "the default task is installDebug", String(plan.task));

    // --- real build, install and launch ----------------------------------------
    report.note(`building with AGP ${settings.agpVersion || "from gradle.properties"}; the first run downloads dependencies`);
    let result = null;
    let failure = null;
    installedByUs = true;
    try {
        result = await manager.buildInstallLaunch({ deviceId });
    } catch (error) {
        failure = error;
    }
    report.assert(result?.state === "succeeded", "the AGP build installs and launches", result ? `${result.state}: ${result.message}` : `${failure?.code}: ${String(failure?.message).slice(0, 200)}`);
    report.assert(result?.packageName === FIXTURE_PACKAGE, "the application id comes from the real build output", String(result?.packageName));

    const packages = await runAdb(["shell", "pm", "list", "packages", FIXTURE_PACKAGE]).catch(() => "");
    report.assert(packages.includes(`package:${FIXTURE_PACKAGE}`), "the fixture is installed on the target emulator");

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
    report.assert(!queueAfter.holder, "the device is released after the build");
} catch (error) {
    report.assert(false, "the suite ran to completion", String(error?.message ?? error).slice(0, 300));
} finally {
    // --- cleanup: only the fixture package, only on the named serial ------------
    if (installedByUs) {
        await runAdb(["shell", "am", "force-stop", FIXTURE_PACKAGE]).catch(() => {});
        await runAdb(["uninstall", FIXTURE_PACKAGE]).catch(() => {});
        const left = await runAdb(["shell", "pm", "list", "packages", FIXTURE_PACKAGE]).catch(() => "");
        report.assert(!left.includes(`package:${FIXTURE_PACKAGE}`), "the fixture is uninstalled afterwards");
    }
    await manager?.dispose().catch(() => {});
    if (settings.keepProject) {
        report.note(`kept ${scratch}`);
    } else {
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
}

report.finish();

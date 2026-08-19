/**
 * The Install button: build with Gradle, install, launch. A real AGP build takes
 * minutes and needs an Android app project, so these checks drive a stand-in
 * gradlew that behaves like Gradle -- same output shape, same metadata file, same
 * exit codes. Everything around the build is real: device selection, the
 * application id lookup, launching on emulator-5554, and the refusal when another
 * session holds the device.
 *
 *   node scripts/verify/app-install.mjs
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config, createReporter, extensionRoot, sleep } from "./_shared.mjs";

const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));
const { DeviceQueue } = await import(path.join(extensionRoot, "lib", "device-queue.mjs"));

const report = createReporter("APP INSTALL");
const queueRoot = await mkdtemp(path.join(os.tmpdir(), "install-queue-"));

// Settings is present on every emulator image and is launchable, so it stands in
// for "the app we just installed" without needing to build one.
const STAND_IN_APP = "com.android.settings";

/** A project that looks like a Gradle build to everything downstream of it. */
async function makeProject({ exitCode = 0, applicationId = STAND_IN_APP, failure = null } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "gradle-project-"));
    const script = exitCode === 0
        ? `#!/bin/sh
echo "> Task :app:preBuild UP-TO-DATE"
echo "> Task :app:assembleDebug"
echo "> Task :app:installDebug"
echo "Installed on 1 device."
echo "BUILD SUCCESSFUL in 3s"
exit 0
`
        : `#!/bin/sh
echo "> Task :app:compileDebugKotlin FAILED"
echo "FAILURE: Build failed with an exception."
echo ""
echo "* What went wrong:"
echo "${failure ?? "Execution failed for task ':app:compileDebugKotlin'."}"
exit ${exitCode}
`;
    await writeFile(path.join(root, "gradlew"), script, { mode: 0o755 });

    const outputs = path.join(root, "app", "build", "outputs", "apk", "debug");
    await mkdir(outputs, { recursive: true });
    await writeFile(
        path.join(outputs, "output-metadata.json"),
        JSON.stringify({ version: 3, applicationId, elements: [{ outputFile: "app-debug.apk" }] }, null, 2),
    );
    return root;
}

function newManager(workingDirectory, { sessionId = "session-install", label = "install-suite" } = {}) {
    const manager = new DeviceSessionManager({ onDiagnostic: () => {} });
    manager.setArtifactsRoot(config.artifactsRoot);
    manager.queue = new DeviceQueue({ root: queueRoot, owner: { sessionId, sessionLabel: label } });
    manager.build.setWorkingDirectory(workingDirectory);
    return manager;
}

// --- a project Gradle can build ----------------------------------------------
const project = await makeProject();
const manager = newManager(project);
const deviceId = await manager.resolveDeviceId(config.deviceId);

const plan = await manager.refreshBuildPlan();
report.assert(plan.available === true, "a Gradle project is detected", String(plan.gradleRoot));
report.assert(plan.task === "installDebug", "the default task is installDebug", String(plan.task));

// The button reads this: no plan, no build.
const beforeSnapshot = manager.snapshot(deviceId);
report.assert(beforeSnapshot.build?.available === true, "the canvas is told a build is possible");
report.assert(beforeSnapshot.install === null, "no install is reported before one runs");

// --- building, installing and launching ---------------------------------------
const result = await manager.buildInstallLaunch({ deviceId });
report.assert(result.state === "succeeded", "the build succeeds", `${result.state}: ${result.message}`);
report.assert(result.packageName === STAND_IN_APP, "the application id is read from the build output", String(result.packageName));
report.assert(String(result.message).includes("Launched"), "the app is launched after installing", String(result.message));
report.assert(
    result.log.some((line) => line.includes("installDebug")),
    "Gradle's output is captured for the canvas",
    `${result.log.length} lines`,
);

// It really launched: the app should now be in the foreground on the device.
const { adb } = await import("./_shared.mjs");
// Launching returns as soon as the activity is started, so wait for the window
// to actually come up rather than sampling once and racing it.
let focused = "";
for (let attempt = 0; attempt < 12; attempt += 1) {
    // One shell string: the pipe has to run on the device, not be passed as argv.
    focused = await adb(["shell", "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"]).catch(() => "");
    if (focused.includes(STAND_IN_APP)) {
        break;
    }
    await sleep(500);
}
report.assert(
    focused.includes(STAND_IN_APP),
    "the launched app is in the foreground on the device",
    focused.trim().split("\n")[0]?.slice(0, 90) ?? "no focus reported",
);

// The finished run stays visible so the canvas can report the outcome.
const afterSnapshot = manager.snapshot(deviceId);
report.assert(afterSnapshot.install?.state === "succeeded", "the finished run is visible in the canvas state");

// --- the device is left free ---------------------------------------------------
const [queueAfter] = await manager.queue.status([deviceId]);
report.assert(!queueAfter.holder, "the device is released once the build finishes", JSON.stringify(queueAfter.holder ?? null));

// --- another session is using the device ---------------------------------------
const otherQueue = new DeviceQueue({ root: queueRoot, owner: { sessionId: "other", sessionLabel: "other-repo" } });
await otherQueue.acquire(deviceId, { reason: "running its own tests", timeoutMs: 0 });

await manager.refreshSharing(deviceId);
const shared = manager.snapshot(deviceId);
report.assert(shared.sharing?.heldByOtherSession === true, "the canvas is told the device is taken");
report.assert(shared.sharing?.holderLabel === "other-repo", "the holder is named for the button's tooltip", String(shared.sharing?.holderLabel));

let refused = null;
await manager.buildInstallLaunch({ deviceId }).catch((error) => {
    refused = error;
});
report.assert(refused?.code === "device_busy", "installing is refused while another session holds the device", refused?.code ?? "not refused");
report.assert(String(refused?.message).includes("other-repo"), "the refusal names the other session", String(refused?.message).slice(0, 70));

await otherQueue.releaseAll();
await manager.refreshSharing(deviceId);
report.assert(manager.snapshot(deviceId).sharing?.heldByOtherSession === false, "the button is freed once the device is released");

// --- a build that fails ---------------------------------------------------------
const brokenManager = newManager(await makeProject({ exitCode: 1, failure: "Unresolved reference: nope" }));
await brokenManager.resolveDeviceId(config.deviceId);
await brokenManager.refreshBuildPlan();

let failure = null;
await brokenManager.buildInstallLaunch({ deviceId }).catch((error) => {
    failure = error;
});
report.assert(failure?.code === "build_failed", "a failing build is reported as a failure", failure?.code ?? "no error");
report.assert(
    String(failure?.message).includes("Unresolved reference"),
    "the failure quotes Gradle's own explanation",
    String(failure?.message).slice(0, 90),
);
const failedSnapshot = brokenManager.snapshot(deviceId);
report.assert(failedSnapshot.install?.state === "failed", "the canvas sees the failed run");

// A failed build must not leave the device held.
const [afterFailure] = await brokenManager.queue.status([deviceId]);
report.assert(!afterFailure.holder, "a failed build still releases the device", JSON.stringify(afterFailure.holder ?? null));

// --- a directory with no Gradle project ------------------------------------------
const emptyManager = newManager(await mkdtemp(path.join(os.tmpdir(), "not-a-project-")));
await emptyManager.resolveDeviceId(config.deviceId);
const emptyPlan = await emptyManager.refreshBuildPlan();
report.assert(emptyPlan.available === false, "a directory without gradlew offers no build");
report.assert(Boolean(emptyPlan.reason), "the canvas is given a reason to show", String(emptyPlan.reason).slice(0, 60));

let missing = null;
await emptyManager.buildInstallLaunch({ deviceId }).catch((error) => {
    missing = error;
});
report.assert(missing?.code === "gradle_not_found", "installing without a Gradle project is refused", missing?.code ?? "not refused");

// --- configuration override --------------------------------------------------------
const configured = await makeProject();
await writeFile(
    path.join(configured, ".android-emulator.json"),
    JSON.stringify({ gradleTask: ":app:installRelease", packageName: STAND_IN_APP }),
);
const configuredManager = newManager(configured);
const configuredPlan = await configuredManager.refreshBuildPlan();
report.assert(configuredPlan.task === ":app:installRelease", "a configured task overrides the default", String(configuredPlan.task));
report.assert(configuredPlan.packageName === STAND_IN_APP, "a configured package name is picked up", String(configuredPlan.packageName));

await sleep(200);
for (const instance of [manager, brokenManager, emptyManager, configuredManager]) {
    await instance.dispose().catch(() => {});
}
report.finish();

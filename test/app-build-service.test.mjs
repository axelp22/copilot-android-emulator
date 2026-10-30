/**
 * The Install button's build service: launching Gradle on every platform,
 * resolving the app to launch, and stopping builds -- by the user, by the agent,
 * and at shutdown -- without leaving anything behind.
 *
 * POSIX tests run real (harmless) `gradlew` shell scripts; Windows tests run
 * real `gradlew.bat` files. Nothing here talks to adb or a device.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { extensionModule, extensionRoot, isAlive, sleep, tempDir, waitUntil } from "./helpers.mjs";

const {
    AppBuildService,
    BUILD_TAG_ENV,
    buildExecutableRoots,
    classifyHiddenEnvironments,
    executorInitScript,
    executorPaths,
    findGradleRoot,
    gradleInvocation,
    liveBuildProcesses,
    markTaggedFromProc,
    ownedProcesses,
    processSnapshot,
    parseTaskPath,
    prepareProjectLayout,
    projectLayoutInitScript,
    layoutRecordName,
    projectLayoutPaths,
    readExecutorMarkers,
    readInstallEvidence,
    INSTALL_EVIDENCE_ENV,
    readProjectLayout,
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

function shellQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Shell lines that write the install evidence the layout init script's action
 * would write when `installs` ran (`dir`/`buildDir` relative to the root).
 */
function evidenceLines(root, installs) {
    return installs.map((install, index) => {
        const record = {
            format: 2,
            kind: install.kind ?? "install",
            rootDir: root,
            project: install.project,
            task: install.task,
            projectDir: path.join(root, ...install.dir.split("/").filter(Boolean)),
            buildDir: path.join(root, ...(install.buildDir ?? `${install.dir}/build`).split("/").filter(Boolean)),
        };
        return (
            `[ -n "$ANDROID_EMULATOR_INSTALL_EVIDENCE" ] && mkdir -p "$ANDROID_EMULATOR_INSTALL_EVIDENCE" && ` +
            `printf '%s' ${shellQuote(JSON.stringify(record))} > "$ANDROID_EMULATOR_INSTALL_EVIDENCE/fake-${index}.json"`
        );
    });
}

const DEFAULT_INSTALLS = [{ project: ":app", task: "installDebug", dir: "app" }];

/**
 * A POSIX project whose wrapper runs `body`. Like a real build of `:app:installDebug`,
 * the wrapper first records that the app's install task ran (`installs: null`
 * records nothing, as a run of a task that installs nothing).
 */
async function posixProject(t, body, { config, installs = DEFAULT_INSTALLS } = {}) {
    const root = await realpath(await tempDir(t, "gradle-fixture-"));
    const wrapper = path.join(root, "gradlew");
    await writeFile(wrapper, ["#!/bin/sh", ...evidenceLines(root, installs ?? []), body, ""].join("\n"));
    await chmod(wrapper, 0o755);
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.app", variantName: "debug" });
    if (config) {
        await writeFile(path.join(root, ".android-emulator.json"), JSON.stringify(config));
    }
    return root;
}

/**
 * What the layout init script records for the build rooted at `root`. `projects`
 * use paths relative to `root`; `buildDir` defaults to `<projectDir>/build`.
 */
async function writeLayout(layoutDir, root, projects, { writtenAt = Date.now(), rootDir, status = "ok", errors = [], name } = {}) {
    const canonical = rootDir ?? (await realpath(root));
    await mkdir(layoutDir, { recursive: true });
    const record = {
        format: 3,
        rootDir: canonical,
        gradleVersion: "8.10",
        writtenAt,
        status,
        errors,
        projects: projects.map((project) => ({
            path: project.path,
            projectDir: path.join(canonical, ...project.dir.split("/").filter(Boolean)),
            buildDir: project.buildDir ? path.join(canonical, ...project.buildDir.split("/")) : null,
            tasks: project.tasks ?? null,
            android: project.android ?? (project.variants ? "application" : null),
            variants: project.variants ?? [],
        })),
    };
    const file = name ?? `${createHash("sha256").update(`${canonical}:${writtenAt}`).digest("hex").slice(0, 24)}.json`;
    await writeFile(path.join(layoutDir, file), JSON.stringify(record));
    return record;
}

async function layoutFor(t, root, projects) {
    const layoutDir = await tempDir(t, "layout-");
    await writeLayout(layoutDir, root, projects);
    return readProjectLayout(layoutDir, root);
}

/** One evidence record as readInstallEvidence returns it (paths relative to `root`). */
function assemble(root, project, task, dir, buildDir = `${dir}/build`) {
    return install(root, project, task, dir, buildDir, "assemble");
}

function install(root, project, task, dir, buildDir = `${dir}/build`, kind = "install") {
    return {
        kind,
        rootDir: root,
        project,
        task,
        projectDir: path.join(root, ...dir.split("/").filter(Boolean)),
        buildDir: path.join(root, ...buildDir.split("/").filter(Boolean)),
    };
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

test("the layout init script is passed after the executor one, quoted the same way", () => {
    const posix = gradleInvocation({
        wrapper: "/work/gradlew",
        task: "installDebug",
        initScript: "/state/build-executor.init.gradle",
        layoutInitScript: "/state/project-layout.init.gradle",
        platform: "darwin",
    });
    assert.deepEqual(posix.args, [
        "--no-daemon",
        "--init-script",
        "/state/build-executor.init.gradle",
        "--init-script",
        "/state/project-layout.init.gradle",
        "installDebug",
    ]);
    const windows = gradleInvocation({
        wrapper: "C:\\p\\gradlew.bat",
        task: "installDebug",
        initScript: "C:\\s\\a.gradle",
        layoutInitScript: "C:\\s\\b.gradle",
        platform: "win32",
        comSpec: "cmd.exe",
    });
    assert.equal(windows.args[4], `""C:\\p\\gradlew.bat" --no-daemon --init-script "C:\\s\\a.gradle" --init-script "C:\\s\\b.gradle" "installDebug""`);
    assert.throws(
        () => gradleInvocation({ wrapper: "C:\\p\\gradlew.bat", task: "x", initScript: "C:\\a", layoutInitScript: 'C:\\"b', platform: "win32" }),
        /./,
        "the second script gets the same path check",
    );
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
    const layoutScript = projectLayoutPaths(executorDir).initScript;
    assert.ok(
        result.log.includes(
            `serial=serial-dev argc=6 args=--no-daemon --init-script ${initScript} --init-script ${layoutScript} :app:installDebug`,
        ),
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
    const root = await posixProject(t, 'echo "BUILD SUCCESSFUL"', {
        installs: [
            { project: ":app", task: "installDebug", dir: "app" },
            { project: ":wear", task: "installDebug", dir: "wear" },
        ],
    });
    await writeMetadata(root, "wear/build/outputs/apk/debug", { applicationId: "com.example.wear", variantName: "debug" });
    const manager = fakeManager();
    const service = newService(manager);
    service.setWorkingDirectory(root);

    const error = await rejection(service.buildInstallLaunch({ deviceId: "dev", task: "installDebug" }));
    assert.equal(error.code, "app_ambiguous");
    assert.match(error.message, /installed more than one app/);
    assert.match(error.message, /":app:installDebug", ":wear:installDebug"/);
    assert.equal(error.buildRecorded, true);
    assert.equal(manager.calls.launch.length, 0);
    const status = service.statusFor("dev");
    assert.equal(status.state, "failed");
    assert.ok(status.log.includes("BUILD SUCCESSFUL"));
});

test("a configured packageName overrides resolution, and launch:false never needs one", posixOnly, async (t) => {
    const both = [
        { project: ":app", task: "installDebug", dir: "app" },
        { project: ":wear", task: "installDebug", dir: "wear" },
    ];
    const root = await posixProject(t, "exit 0", { config: { packageName: "com.configured", activity: ".Main" }, installs: both });
    await writeMetadata(root, "wear/build/outputs/apk/debug", { applicationId: "com.example.wear", variantName: "debug" });
    const manager = fakeManager();
    const service = newService(manager);
    service.setWorkingDirectory(root);

    const launched = await service.buildInstallLaunch({ deviceId: "dev" });
    assert.equal(launched.packageName, "com.configured");
    assert.deepEqual(manager.calls.launch, [{ deviceId: "dev", packageName: "com.configured", activity: ".Main" }]);

    const plainRoot = await posixProject(t, "exit 0", { installs: both });
    await writeMetadata(plainRoot, "wear/build/outputs/apk/debug", { applicationId: "com.example.wear", variantName: "debug" });
    service.setWorkingDirectory(plainRoot);
    const installed = await service.buildInstallLaunch({ deviceId: "dev", launch: false });
    assert.equal(installed.state, "succeeded");
    assert.equal(installed.message, "Installed");
    assert.equal(installed.packageName, null, "ambiguity is just unknown when nothing is launched");
    assert.equal(manager.calls.launch.length, 1);
});

// --- resolving against the layout Gradle recorded ---------------------------------

test("a remapped projectDir and custom buildDir are read where Gradle says they are", async (t) => {
    const root = await tempDir(t);
    // settings.gradle: project(":app").projectDir = file("android/application"), buildDir = out/app
    await writeMetadata(root, "out/app/outputs/apk/debug", { applicationId: "com.remapped", variantName: "debug" });
    // A decoy where the task path would conventionally point.
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.decoy", variantName: "debug" });
    const layout = await layoutFor(t, root, [
        { path: ":", dir: "" },
        { path: ":app", dir: "android/application", buildDir: "out/app", android: "application" },
    ]);

    const resolved = await resolveApplicationId(root, ":app:installDebug", { layout });
    assert.equal(resolved.applicationId, "com.remapped");
    assert.equal(resolved.projectPath, ":app");
    assert.equal(resolved.metadataFile, path.join(await realpath(root), "out/app/outputs/apk/debug/output-metadata.json"));
    assert.equal((await resolveApplicationId(root, ":app:installDebug")).applicationId, "com.decoy", "without a layout: convention");
});

test("nested project paths map to Gradle's directories, not to their segments", async (t) => {
    const root = await tempDir(t);
    await writeMetadata(root, "modules/shop-app/build/outputs/apk/debug", { applicationId: "com.shop", variantName: "debug" });
    const layout = await layoutFor(t, root, [
        { path: ":", dir: "" },
        { path: ":feature", dir: "feature" },
        { path: ":feature:shop", dir: "modules/shop-app", android: "application" },
    ]);
    assert.equal((await resolveApplicationId(root, ":feature:shop:installDebug", { layout })).applicationId, "com.shop");
    const missing = await rejection(resolveApplicationId(root, ":features:shop:installDebug", { layout }));
    assert.equal(missing.code, "app_not_resolved");
    assert.match(missing.message, /no project ":features:shop"/);
    assert.match(missing.message, /application projects: ":feature:shop"/);
});

test("flavored application ids come from each variant's output under the real buildDir", async (t) => {
    const root = await tempDir(t);
    await writeMetadata(root, "out/app/outputs/apk/free/debug", { applicationId: "com.example.free.debug", variantName: "freeDebug" });
    await writeMetadata(root, "out/app/outputs/apk/paid/debug", { applicationId: "com.example.paid.debug", variantName: "paidDebug" });
    await writeMetadata(root, "out/app/outputs/apk/paid/release", { applicationId: "com.example.paid", variantName: "paidRelease" });
    const layout = await layoutFor(t, root, [
        { path: ":", dir: "" },
        { path: ":app", dir: "app", buildDir: "out/app", variants: [{ name: "freeDebug" }, { name: "paidDebug" }, { name: "paidRelease" }] },
    ]);
    assert.equal((await resolveApplicationId(root, ":app:assemblePaidDebug", { layout })).applicationId, "com.example.paid.debug");
    assert.equal((await resolveApplicationId(root, "app:assembleFreeDebug", { layout })).applicationId, "com.example.free.debug");
    assert.equal((await resolveApplicationId(root, "assemblePaidRelease", { layout })).applicationId, "com.example.paid");

    const unknown = await rejection(resolveApplicationId(root, ":app:assembleDebug", { layout }));
    assert.equal(unknown.code, "app_not_resolved");
    assert.match(unknown.message, /no variant "debug"/);
    assert.match(unknown.message, /":app:installFreeDebug", ":app:installPaidDebug", ":app:installPaidRelease"/);
});

test("a variant Gradle names is resolved only from its own output under the real buildDir", async (t) => {
    const root = await tempDir(t);
    // No variantName: matched by its directory.
    await writeMetadata(root, "out/app/outputs/apk/free/debug", { applicationId: "com.from.output" });
    const layout = await layoutFor(t, root, [
        { path: ":app", dir: "app", buildDir: "out/app", variants: [{ name: "freeDebug" }, { name: "paidDebug" }] },
    ]);
    assert.equal((await resolveApplicationId(root, ":app:assembleFreeDebug", { layout })).applicationId, "com.from.output");
    const error = await rejection(resolveApplicationId(root, ":app:assemblePaidDebug", { layout }));
    assert.equal(error.code, "app_not_resolved");
    assert.match(error.message, /reports variant "paidDebug" in project ":app" \(app\), but no build output naming its application id was found/);
});

test("an unqualified task that several apps have is ambiguous, and the error lists the exact tasks to pick", async (t) => {
    const root = await tempDir(t);
    await writeMetadata(root, "phone/build/outputs/apk/debug", { applicationId: "com.example", variantName: "debug" });
    await writeMetadata(root, "watch/build/outputs/apk/debug", { applicationId: "com.example.wear", variantName: "debug" });
    await writeMetadata(root, "tv/build/outputs/apk/debug", { applicationId: "com.example.tv", variantName: "debug" });
    const projects = [
        { path: ":", dir: "", tasks: [] },
        { path: ":app", dir: "phone", tasks: ["assembleDebug"], variants: [{ name: "debug" }] },
        { path: ":wear", dir: "watch", tasks: ["assembleDebug"], variants: [{ name: "debug" }] },
        // Has the variant but not the task: an unqualified task does not run here.
        { path: ":tv", dir: "tv", tasks: ["assembleRelease"], variants: [{ name: "debug" }] },
    ];
    const layout = await layoutFor(t, root, projects);
    const error = await rejection(resolveApplicationId(root, "assembleDebug", { layout }));
    assert.equal(error.code, "app_ambiguous");
    assert.equal(error.status, 409);
    assert.match(error.message, /:app debug: com\.example; :wear debug: com\.example\.wear/);
    assert.match(error.message, /Set "gradleTask" to one of ":app:assembleDebug", ":wear:assembleDebug"/);
    assert.doesNotMatch(error.message, /com\.example\.tv/);
    assert.deepEqual(error.details.candidates, [
        { project: ":app", variant: "debug", applicationId: "com.example" },
        { project: ":wear", variant: "debug", applicationId: "com.example.wear" },
    ]);

    const single = await layoutFor(t, root, [projects[1], { ...projects[2], tasks: [] }]);
    assert.equal((await resolveApplicationId(root, "assembleDebug", { layout: single })).applicationId, "com.example");
});

test("a matching app whose id is unreadable keeps an unqualified task ambiguous", async (t) => {
    const root = await tempDir(t);
    await writeMetadata(root, "phone/build/outputs/apk/debug", { applicationId: "com.example.phone", variantName: "debug" });
    // The wear app was built too, but its metadata is missing: it may be what was meant.
    const layout = await layoutFor(t, root, [
        { path: ":app", dir: "phone", tasks: ["assembleDebug"], variants: [{ name: "debug" }] },
        { path: ":wear", dir: "watch", tasks: ["assembleDebug"], variants: [{ name: "debug" }] },
    ]);
    const error = await rejection(resolveApplicationId(root, "assembleDebug", { layout }));
    assert.equal(error.code, "app_ambiguous");
    assert.match(error.message, /:wear debug: application id unknown/);
    assert.deepEqual(error.details.candidates.map((candidate) => candidate.applicationId), ["com.example.phone", null]);
});

test("the same application id in several matches is not ambiguous", async (t) => {
    const root = await tempDir(t);
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example", variantName: "debug" });
    await writeMetadata(root, "app2/build/outputs/apk/debug", { applicationId: "com.example", variantName: "debug" });
    const layout = await layoutFor(t, root, [
        { path: ":app", dir: "app", tasks: ["assembleDebug"], variants: [{ name: "debug" }] },
        { path: ":app2", dir: "app2", tasks: ["assembleDebug"], variants: [{ name: "debug" }] },
    ]);
    assert.equal((await resolveApplicationId(root, "assembleDebug", { layout })).applicationId, "com.example");
});

test("a custom task is never resolved from the project it is in, only from what it installed", async (t) => {
    const root = await realpath(await tempDir(t));
    await writeMetadata(root, "phone/build/outputs/apk/debug", { applicationId: "com.example.phone", variantName: "debug" });
    await writeMetadata(root, "watch/out/outputs/apk/debug", { applicationId: "com.example.wear", variantName: "debug" });
    // :app:deployWear depends only on :wear:installDebug; :app has exactly one variant.
    const layout = await layoutFor(t, root, [
        { path: ":", dir: "" },
        { path: ":app", dir: "phone", variants: [{ name: "debug" }] },
        { path: ":wear", dir: "watch", buildDir: "watch/out", variants: [{ name: "debug" }] },
    ]);
    const unrecorded = await rejection(resolveApplicationId(root, ":app:deployWear", { layout }));
    assert.equal(unrecorded.code, "app_not_resolved");
    assert.match(unrecorded.message, /"deployWear" does not name an Android variant/);
    assert.match(unrecorded.message, /":app:installDebug", ":wear:installDebug"/);
    assert.match(unrecorded.message, /packageName/);

    const wear = { installs: [install(root, ":wear", "installDebug", "watch", "watch/out")], problems: [] };
    const resolved = await resolveApplicationId(root, ":app:deployWear", { layout, installs: wear });
    assert.equal(resolved.applicationId, "com.example.wear", "not the phone app of the project the task is in");
    assert.equal(resolved.projectPath, ":wear");

    // A bare root task works the same way.
    const phone = { installs: [install(root, ":app", "installDebug", "phone")], problems: [] };
    assert.equal((await resolveApplicationId(root, "deployToDevice", { layout, installs: phone })).applicationId, "com.example.phone");
    const nothing = await rejection(resolveApplicationId(root, "deployToDevice", { layout, installs: { installs: [], problems: [] } }));
    assert.equal(nothing.code, "app_not_resolved");
    assert.match(nothing.message, /ran no Android install task/);
});

test("an id recorded at configuration time never overrides the installed artifact", async (t) => {
    // Configuration cache A -> B -> A: the record may describe B while A's outputs were installed.
    const root = await realpath(await tempDir(t));
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.installed", variantName: "debug" });
    const layoutDir = await tempDir(t, "layout-");
    const record = await writeLayout(layoutDir, root, [{ path: ":app", dir: "app", variants: [{ name: "debug" }] }], { name: layoutRecordName(root) });
    record.projects[0].variants = [{ name: "debug", applicationId: "com.example.cachedB" }];
    await writeFile(path.join(layoutDir, layoutRecordName(root)), JSON.stringify(record));
    const layout = await readProjectLayout(layoutDir, root);
    const installs = { installs: [install(root, ":app", "installDebug", "app")], problems: [] };
    assert.equal((await resolveApplicationId(root, ":app:installDebug", { layout, installs })).applicationId, "com.example.installed");
    assert.equal((await resolveApplicationId(root, ":app:assembleDebug", { layout })).applicationId, "com.example.installed");
});

test("a stale layout record never resolves a non-install task without this run's evidence", async (t) => {
    // assembleDebug (A) -> installDebug -Pflip (B: build-b, id B) -> assembleDebug (A) on a cache hit:
    // the root-keyed record still describes B, and B's real metadata remains in build-b.
    const root = await realpath(await tempDir(t));
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.a", variantName: "debug" });
    await writeMetadata(root, "app/build-b/outputs/apk/debug", { applicationId: "com.example.b", variantName: "debug" });
    const layoutDir = await tempDir(t, "layout-");
    await writeLayout(layoutDir, root, [{ path: ":", dir: "" }, { path: ":app", dir: "app", buildDir: "app/build-b", variants: [{ name: "debug" }] }], {
        name: layoutRecordName(root),
    });
    const layout = await readProjectLayout(layoutDir, root);
    const ranA = { installs: [assemble(root, ":app", "assembleDebug", "app")], problems: [] };
    const nothingRan = { installs: [], problems: [] };
    for (const task of [":app:assembleDebug", "assembleDebug"]) {
        assert.equal((await resolveApplicationId(root, task, { layout, installs: ranA })).applicationId, "com.example.a", task);
        const stale = await rejection(resolveApplicationId(root, task, { layout, installs: nothingRan }));
        assert.equal(stale.code, "app_not_resolved", task);
    }
    // Without a layout at all, this run's assemble evidence alone still resolves A.
    assert.equal((await resolveApplicationId(root, "assembleDebug", { installs: ranA })).applicationId, "com.example.a");
});

test("assemble evidence fails closed for custom, packaging and ambiguous tasks", async (t) => {
    const root = await realpath(await tempDir(t));
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.app", variantName: "debug" });
    await writeMetadata(root, "wear/build/outputs/apk/debug", { applicationId: "com.example.wear", variantName: "debug" });
    const layout = await layoutFor(t, root, [
        { path: ":app", dir: "app", variants: [{ name: "debug" }] },
        { path: ":wear", dir: "wear", variants: [{ name: "debug" }] },
    ]);
    const one = { installs: [assemble(root, ":app", "assembleDebug", "app")], problems: [] };
    const both = { installs: [assemble(root, ":app", "assembleDebug", "app"), assemble(root, ":wear", "assembleDebug", "wear")], problems: [] };

    const ambiguous = await rejection(resolveApplicationId(root, "assembleDebug", { layout, installs: both }));
    assert.equal(ambiguous.code, "app_ambiguous");
    assert.equal((await resolveApplicationId(root, ":wear:assembleDebug", { layout, installs: both })).applicationId, "com.example.wear");
    for (const task of ["deployToDevice", ":app:installDebug"]) {
        const error = await rejection(resolveApplicationId(root, task, { layout, installs: one }));
        assert.equal(error.code, "app_not_resolved", task);
    }
    // A packaging-only run records no assemble task, so the layout alone resolves nothing.
    const packaged = await rejection(resolveApplicationId(root, ":app:packageDebug", { layout, installs: { installs: [], problems: [] } }));
    assert.equal(packaged.code, "app_not_resolved");
    assert.match(packaged.message, /recorded no assemble task/);
});

test("the init script records assemble evidence only for applications and never reads applicationId", () => {
    const script = projectLayoutInitScript("/state/layout");
    assert.match(script, /kind = 'assemble'/);
    assert.doesNotMatch(script, /applicationId/);
    const appBlock = script.indexOf("withId('com.android.application')");
    assert.ok(appBlock >= 0 && script.indexOf("kind = 'assemble'") > appBlock, "assemble evidence is registered under the application plugin");
});

test("install evidence is read strictly, and any gap fails closed", async (t) => {
    const root = await realpath(await tempDir(t));
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.app", variantName: "debug" });
    const dir = await tempDir(t, "installs-");
    const good = { format: 2, kind: "install", rootDir: root, project: ":app", task: "installDebug", projectDir: path.join(root, "app"), buildDir: path.join(root, "app/build") };
    await writeFile(path.join(dir, "a.json"), JSON.stringify(good));
    await writeFile(path.join(dir, "notes.txt"), "ignored");
    let evidence = await readInstallEvidence(dir);
    assert.deepEqual(evidence, { installs: [{ kind: "install", rootDir: root, project: ":app", task: "installDebug", projectDir: good.projectDir, buildDir: good.buildDir }], problems: [] });
    assert.deepEqual(await readInstallEvidence(path.join(dir, "missing")), { installs: [], problems: [] });

    await writeFile(path.join(dir, "b.json"), JSON.stringify({ ...good, projectDir: "relative" }));
    await writeFile(path.join(dir, "c.json"), "{ truncated");
    await writeFile(path.join(dir, "d.error"), "java.io.IOException: disk full\n");
    evidence = await readInstallEvidence(dir);
    assert.equal(evidence.installs.length, 1);
    assert.equal(evidence.problems.length, 3);
    const error = await rejection(resolveApplicationId(root, ":app:installDebug", { installs: evidence }));
    assert.equal(error.code, "app_layout_failed");
    assert.match(error.message, /could not be fully recorded/);
    assert.match(error.message, /disk full/);

    // A project whose install tasks could not be watched makes the list incomplete too.
    const layout = await layoutFor(t, root, [{ path: ":app", dir: "app", variants: [{ name: "debug" }] }]);
    layout.errors = [{ project: ":wear", step: "installs", message: "boom" }];
    layout.status = "partial";
    const unwatched = await rejection(resolveApplicationId(root, "installDebug", { layout, installs: { installs: [install(root, ":app", "installDebug", "app")], problems: [] } }));
    assert.equal(unwatched.code, "app_layout_failed");
    assert.match(unwatched.message, /could not watch every install task/);
});

test("an included build's task resolves only from what it installed", async (t) => {
    const root = await realpath(await tempDir(t));
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.decoy", variantName: "debug" });
    await writeMetadata(root, "my-app/app/build/outputs/apk/debug", { applicationId: "com.example.included", variantName: "debug" });
    const layoutDir = await tempDir(t, "layout-");
    const record = await writeLayout(layoutDir, root, [{ path: ":", dir: "" }, { path: ":app", dir: "app", variants: [{ name: "debug" }] }], {
        name: layoutRecordName(root),
    });
    record.includedBuilds = [{ name: "my-app", projectDir: path.join(root, "my-app") }];
    await writeFile(path.join(layoutDir, layoutRecordName(root)), JSON.stringify(record));
    const layout = await readProjectLayout(layoutDir, root);

    const unrecorded = await rejection(resolveApplicationId(root, ":my-app:app:installDebug", { layout }));
    assert.equal(unrecorded.code, "app_not_resolved");
    assert.match(unrecorded.message, /runs in the included build "my-app"/);

    const installs = { installs: [install(path.join(root, "my-app"), ":app", "installDebug", "app")], problems: [] };
    const resolved = await resolveApplicationId(root, ":my-app:app:installDebug", { layout, installs });
    assert.equal(resolved.applicationId, "com.example.included", "not :app of the top-level build");
});

test("concurrent builds prepare the layout script without racing", async (t) => {
    const home = await tempDir(t, "executors-");
    const results = await Promise.all(Array.from({ length: 16 }, () => prepareProjectLayout(home)));
    assert.equal(new Set(results.map((paths) => paths.initScript)).size, 1);
    const files = await readdir(path.dirname(results[0].initScript));
    assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), []);
    assert.equal(await readFile(results[0].initScript, "utf8"), projectLayoutInitScript(results[0].layoutDir));
});

test("without a recorded layout, the convention's failures say so", async (t) => {
    const root = await tempDir(t);
    const error = await rejection(resolveApplicationId(root, ":app:installDebug"));
    assert.equal(error.code, "app_not_resolved");
    assert.match(error.message, /Gradle did not record this build's project layout/);
});

test("the recorded layout is the newest one for this exact root", async (t) => {
    const root = await tempDir(t);
    const other = await tempDir(t);
    const layoutDir = await tempDir(t, "layout-");
    assert.equal(await readProjectLayout(layoutDir, root), null);
    assert.equal(await readProjectLayout(path.join(layoutDir, "missing"), root), null);

    await writeLayout(layoutDir, root, [{ path: ":old", dir: "old" }], { writtenAt: 1 });
    await writeLayout(layoutDir, root, [{ path: ":app", dir: "android/app" }], { writtenAt: 2 });
    await writeLayout(layoutDir, other, [{ path: ":other", dir: "x" }], { writtenAt: 3 });
    await writeFile(path.join(layoutDir, "abc.json"), "{ not json");
    await writeFile(path.join(layoutDir, "def.json"), JSON.stringify({ format: 99, rootDir: await realpath(root), projects: [] }));
    await writeFile(path.join(layoutDir, "notes.txt"), "ignored");

    const layout = await readProjectLayout(layoutDir, root);
    const canonical = await realpath(root);
    assert.equal(layout.rootDir, canonical);
    assert.deepEqual(layout.projects, [
        {
            path: ":app",
            projectDir: path.join(canonical, "android", "app"),
            buildDir: path.join(canonical, "android", "app", "build"),
            tasks: null,
            android: null,
            variants: [],
        },
    ]);

    // Entries that are not usable are dropped rather than trusted.
    await writeFile(
        path.join(layoutDir, "ffff.json"),
        JSON.stringify({
            format: 3,
            rootDir: canonical,
            writtenAt: 10,
            status: "ok",
            projects: [
                { path: "app", projectDir: canonical },
                { path: ":rel", projectDir: "relative/dir" },
                { path: ":ok", projectDir: canonical, variants: [{ name: "debug", applicationId: "not an id" }, { applicationId: "com.x" }] },
            ],
        }),
    );
    const filtered = await readProjectLayout(layoutDir, root);
    assert.deepEqual(filtered.projects.map((project) => project.path), [":ok"]);
    assert.deepEqual(filtered.projects[0].variants, [{ name: "debug" }], "an id in the record is never carried over");
    assert.equal(filtered.status, "partial", "dropped entries are reported, not hidden");
    assert.match(filtered.errors[0].message, /2 project entries have no usable path/);
});

test("records written by an older format are ignored rather than misread", async (t) => {
    const root = await tempDir(t);
    const layoutDir = await tempDir(t, "layout-");
    const canonical = await realpath(root);
    await writeFile(
        path.join(layoutDir, layoutRecordName(canonical)),
        JSON.stringify({ format: 1, rootDir: canonical, writtenAt: 1, projects: [{ path: ":app", projectDir: canonical }] }),
    );
    assert.equal(await readProjectLayout(layoutDir, root), null);
    // Format 2 carried application ids read at configuration time; they are not trusted either.
    await writeFile(
        path.join(layoutDir, layoutRecordName(canonical)),
        JSON.stringify({ format: 2, rootDir: canonical, writtenAt: 2, status: "ok", errors: [], projects: [{ path: ":app", projectDir: canonical, variants: [{ name: "debug", applicationId: "com.stale" }] }] }),
    );
    assert.equal(await readProjectLayout(layoutDir, root), null);
});

test("this build's own record being unreadable is an error, not a missing layout", async (t) => {
    const root = await tempDir(t);
    const layoutDir = await tempDir(t, "layout-");
    const own = path.join(layoutDir, layoutRecordName(await realpath(root)));
    await writeFile(own, "{ truncated");
    let error = await rejection(readProjectLayout(layoutDir, root));
    assert.equal(error.code, "app_layout_failed");
    assert.match(error.message, /could not be read/);

    await writeFile(own, JSON.stringify({ format: 3, rootDir: await realpath(root), projects: [] }));
    error = await rejection(readProjectLayout(layoutDir, root));
    assert.match(error.message, /missing its projects or status/);

    // Another build's unreadable record says nothing about this one.
    await rm(own);
    await writeFile(path.join(layoutDir, "0123abcd.json"), "{ truncated");
    assert.equal(await readProjectLayout(layoutDir, root), null);
});

test("a failed collection is reported with Gradle's errors instead of falling back to the path convention", async (t) => {
    const root = await tempDir(t);
    // The convention would find this, which is exactly what must not happen.
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.wrong", variantName: "debug" });
    const layoutDir = await tempDir(t, "layout-");
    await writeLayout(layoutDir, root, [], {
        status: "failed",
        errors: [{ project: ":", step: "projects", message: "java.lang.IllegalStateException: boom" }],
    });
    const layout = await readProjectLayout(layoutDir, root);
    assert.equal(layout.status, "failed");
    const error = await rejection(resolveApplicationId(root, ":app:installDebug", { layout }));
    assert.equal(error.code, "app_layout_failed");
    assert.equal(error.status, 422);
    assert.match(error.message, /boom/);
    assert.deepEqual(error.details.errors, layout.errors);
});

test("a partial collection fails only when the error touches a project the task could mean", async (t) => {
    const root = await tempDir(t);
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.app", variantName: "debug" });
    const layoutDir = await tempDir(t, "layout-");
    await writeLayout(
        layoutDir,
        root,
        [
            { path: ":", dir: "" },
            { path: ":app", dir: "app", variants: [{ name: "debug" }] },
            // Its variants could not be read.
            { path: ":broken", dir: "broken", android: "application" },
        ],
        { status: "partial", errors: [{ project: ":broken", step: "variants", message: "onVariants threw" }] },
    );
    const layout = await readProjectLayout(layoutDir, root);
    assert.equal(layout.status, "partial");

    assert.equal((await resolveApplicationId(root, ":app:assembleDebug", { layout })).applicationId, "com.example.app");

    const scoped = await rejection(resolveApplicationId(root, ":broken:assembleDebug", { layout }));
    assert.equal(scoped.code, "app_layout_failed");
    assert.match(scoped.message, /:broken.*variants.*onVariants threw/s);

    // An unqualified task could mean :broken too.
    const unqualified = await rejection(resolveApplicationId(root, "assembleDebug", { layout }));
    assert.equal(unqualified.code, "app_layout_failed");

    const elsewhere = await rejection(resolveApplicationId(root, ":app:assembleRelease", { layout }));
    assert.equal(elsewhere.code, "app_not_resolved");
    assert.match(elsewhere.message, /":app:installDebug"/);
    assert.doesNotMatch(elsewhere.message, /:broken:install/);

    // What a run installed is not affected by another project's layout errors.
    const canonical = await realpath(root);
    const installs = { installs: [install(canonical, ":app", "installDebug", "app")], problems: [] };
    assert.equal((await resolveApplicationId(root, "installDebug", { layout, installs })).applicationId, "com.example.app");
});

test("a layout without status or errors fields is treated as not failed", async (t) => {
    // Older in-memory callers may pass a layout built by hand.
    const root = await realpath(await tempDir(t));
    await writeMetadata(root, "x/app/build/outputs/apk/debug", { applicationId: "com.example.x", variantName: "debug" });
    const layout = {
        rootDir: root,
        projects: [{ path: ":app", projectDir: path.join(root, "x/app"), buildDir: path.join(root, "x/app/build"), tasks: null, android: "application", variants: [{ name: "debug" }] }],
    };
    assert.equal((await resolveApplicationId(root, ":app:assembleDebug", { layout })).applicationId, "com.example.x");
});

test("the layout init script is stable, quotes its directory, and guards every step", async (t) => {
    const dir = "/tmp/it's a \\dir";
    const script = projectLayoutInitScript(dir);
    assert.equal(script, projectLayoutInitScript(dir), "stable content keeps the configuration cache valid");
    assert.ok(script.includes(String.raw`new File('/tmp/it\'s a \\dir')`), script);
    assert.ok(!/LAYOUT_DIR/.test(script));
    assert.equal((script.match(/try \{/g) ?? []).length, (script.match(/catch \(Throwable/g) ?? []).length);
    assert.doesNotMatch(script, /catch \(Throwable ignored/, "every caught failure is recorded, not swallowed");
    for (const piece of ["copilotErrors", "status:", "errors:", "'failed'", "'partial'", "t.cause"]) {
        assert.ok(script.includes(piece), `records ${piece}`);
    }
    assert.match(script, /gradle\.projectsEvaluated/);
    assert.doesNotMatch(script, /ANDROID_SERIAL|adb|exec\(|tasks\.register|dependsOn/, "records only; runs nothing");

    const home = await tempDir(t, "layout-home-");
    const paths = await prepareProjectLayout(home);
    assert.equal(await readFile(paths.initScript, "utf8"), projectLayoutInitScript(paths.layoutDir));
    const before = (await stat(paths.initScript)).mtimeMs;
    await sleep(20);
    await prepareProjectLayout(home);
    assert.equal((await stat(paths.initScript)).mtimeMs, before, "unchanged content is not rewritten");
    assert.ok((await stat(paths.layoutDir)).isDirectory());
});

test("a build launches the app its install task recorded, from Gradle's real directories", posixOnly, async (t) => {
    // The fake wrapper stands in for the init script's install action.
    const root = await posixProject(t, "exit 0", { installs: [{ project: ":app", task: "installDebug", dir: "android/phone", buildDir: "out/phone" }] });
    await writeMetadata(root, "out/phone/outputs/apk/debug", { applicationId: "com.example.phone", variantName: "debug" });
    const manager = fakeManager();
    const service = newService(manager);
    service.setWorkingDirectory(root);

    const result = await service.buildInstallLaunch({ deviceId: "dev", task: ":app:installDebug" });
    assert.equal(result.state, "succeeded");
    assert.equal(result.packageName, "com.example.phone", "not com.example.app from the conventional app/build");
    assert.deepEqual(manager.calls.launch, [{ deviceId: "dev", packageName: "com.example.phone", activity: undefined }]);
    const { installsDir } = projectLayoutPaths(executorDir);
    await waitUntil(async () => (await readdir(installsDir)).length === 0, { message: "the run's evidence to be removed" });
});

test("a build whose install was not recorded fails closed instead of guessing", posixOnly, async (t) => {
    // Neither a layout nor install evidence: the conventional app/build must not be launched.
    const root = await posixProject(t, "exit 0", { installs: null });
    const manager = fakeManager();
    const service = newService(manager);
    service.setWorkingDirectory(root);
    const error = await rejection(service.buildInstallLaunch({ deviceId: "dev", task: ":app:installDebug" }));
    assert.equal(error.code, "app_layout_failed");
    assert.match(error.message, /recorded neither/);
    assert.equal(manager.calls.launch.length, 0);

    // A layout that shows the install task did not run is reported as such.
    const { layoutDir } = projectLayoutPaths(executorDir);
    await writeLayout(layoutDir, root, [{ path: ":app", dir: "app", variants: [{ name: "debug" }] }], { name: layoutRecordName(root) });
    const notRun = await rejection(service.buildInstallLaunch({ deviceId: "dev", task: ":app:installDebug" }));
    assert.equal(notRun.code, "app_not_resolved");
    assert.match(notRun.message, /no Android install task ran/);
    assert.equal(manager.calls.launch.length, 0);
});

test("an unwritable layout init script is reported at launch, not replaced by the path convention", posixOnly, async (t) => {
    const home = await tempDir(t, "executors-");
    // "projects" being a file makes preparing the layout script fail.
    await writeFile(path.join(home, "projects"), "not a directory");
    const root = await posixProject(t, "exit 0");
    const manager = fakeManager();
    const service = newService(manager, { executorDir: home });
    service.setWorkingDirectory(root);
    const error = await rejection(service.buildInstallLaunch({ deviceId: "dev", task: ":app:installDebug" }));
    assert.equal(error.code, "app_layout_failed");
    assert.match(error.message, /layout init script could not be written/);
    assert.equal(manager.calls.launch.length, 0);
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
    const retried = await whileHostAlive(waitForProcessTreeExit(living, {
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
    }));
    assert.equal(retried.confirmed, true);
    assert.equal(attempts, 3);
});

/**
 * Exit watches deliberately do not keep the process alive (a watch may never
 * end), and a fake wrapper holds no handle the way a real child does. A test
 * awaiting one stands in for the extension host, which outlives it; without
 * this, Node 22's runner sees the loop drain and abandons the file.
 */
async function whileHostAlive(promise) {
    const host = setInterval(() => {}, 60_000);
    try {
        return await promise;
    } finally {
        clearInterval(host);
    }
}

test("an exit watch never keeps the host process alive, yet confirms while the host lives", async () => {
    const moduleUrl = pathToFileURL(path.join(extensionRoot, "lib", "app-build-service.mjs")).href;
    const script = (held) => `
        const { waitForProcessTreeExit } = await import(${JSON.stringify(moduleUrl)});
        const living = { pid: 4343, exitCode: null, signalCode: null };
        let attempts = 0;
        const host = ${held} ? setInterval(() => {}, 60_000) : null;
        const outcome = await waitForProcessTreeExit(living, {
            platform: "win32",
            pollMs: 10,
            taskkill: async () => {
                attempts += 1;
                if (${held} && attempts >= 3) {
                    living.exitCode = 1;
                    return "ok";
                }
                return "ERROR: in use";
            },
        });
        clearInterval(host);
        console.log(JSON.stringify({ confirmed: outcome.confirmed, attempts }));
    `;
    const run = (held) =>
        spawnSync(process.execPath, ["--input-type=module", "-e", script(held)], { encoding: "utf8", timeout: 20_000 });

    // Nothing else alive: the never-confirmed watch lets the process end (13 = unsettled top-level await).
    const unheld = run(false);
    assert.equal(unheld.error, undefined, "the watch did not hold the process open");
    assert.equal(unheld.status, 13, unheld.stderr);
    assert.equal(unheld.stdout, "");

    // With the host alive, the same watch keeps retrying until it can confirm.
    const held = run(true);
    assert.equal(held.status, 0, held.stderr);
    assert.deepEqual(JSON.parse(held.stdout), { confirmed: true, attempts: 3 });
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
    const dir = path.join(parent, "my proj & (x) ^ !");
    await mkdir(dir, { recursive: true });
    const root = await realpath(dir);
    // What the install-evidence action records for :app:installDebug, copied into place like the real one.
    await writeFile(
        path.join(root, "install-evidence.json"),
        JSON.stringify({ format: 2, kind: "install", rootDir: root, project: ":app", task: "installDebug", projectDir: path.join(root, "app"), buildDir: path.join(root, "app", "build") }),
    );
    const evidence = [
        'if defined ANDROID_EMULATOR_INSTALL_EVIDENCE (',
        '  mkdir "%ANDROID_EMULATOR_INSTALL_EVIDENCE%" 2>nul',
        '  copy /y "%~dp0install-evidence.json" "%ANDROID_EMULATOR_INSTALL_EVIDENCE%\\fake.json" >nul',
        ')',
    ];
    await writeFile(path.join(root, "gradlew.bat"), ["@echo off", ...evidence, ...lines].join("\r\n") + "\r\n");
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
        "echo arg6=[%~6]",
        "echo arg7=[%~7]",
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
    assert.ok(result.log.includes("arg4=[--init-script]"), result.log.join("\n"));
    assert.ok(result.log.includes(`arg5=[${projectLayoutPaths(executorDir).initScript}]`), result.log.join("\n"));
    assert.ok(result.log.includes("arg6=[:app:installDebug]"), result.log.join("\n"));
    assert.ok(result.log.includes("arg7=[]"), "the task stays a single argument");
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
    // Malformed, but written long before this build started: an earlier build's leftovers.
    await write("13.json", "{ not json");
    await write("14.json", { format: 2, pid: 14, ancestors: [4242], startedAt: spawnedAt + 500 });
    const old = new Date(spawnedAt - 60_000);
    await utimes(path.join(dir, "13.json"), old, old);
    await utimes(path.join(dir, "14.json"), old, old);
    await write("15.json.tmp", { format: 1, pid: 15, ancestors: [4242], startedAt: spawnedAt + 500 });
    await write("4242.json", { format: 1, pid: 4242, ancestors: [1], startedAt: spawnedAt + 100 }); // in-process build
    const records = await readExecutorMarkers(dir, { wrapperPid: 4242, spawnedAt });
    assert.deepEqual(records.map((record) => record.pid).sort((a, b) => a - b), [10, 4242]);
});

test("a malformed executor record written during this build fails closed instead of being skipped", async (t) => {
    const spawnedAt = Date.now();
    for (const [name, body] of [
        ["13.json", "{ not json"],
        ["14.json", JSON.stringify({ format: 2, pid: 14, ancestors: [4242], startedAt: spawnedAt + 500 })],
        ["16.json", JSON.stringify({ format: 1, pid: "16", ancestors: [4242], startedAt: spawnedAt + 500 })],
        ["17.json", JSON.stringify({ format: 1, pid: 17, ancestors: "4242", startedAt: spawnedAt + 500 })],
    ]) {
        const dir = await tempDir(t, "executor-records-");
        await writeFile(path.join(dir, "10.json"), JSON.stringify({ format: 1, pid: 10, ancestors: [4242], startedAt: spawnedAt + 500 }));
        await writeFile(path.join(dir, name), body);
        // It could name this build's executor, so it cannot count as "no executor".
        await assert.rejects(readExecutorMarkers(dir, { wrapperPid: 4242, spawnedAt }), /malformed/, name);

        const fake = fakeProcesses([proc(1, 0, 1)]);
        const outcome = await terminateProcessTree(
            { pid: 4242, exitCode: 0, signalCode: null },
            {
                platform: "linux",
                snapshot: fake.snapshot,
                kill: fake.kill,
                markers: () => readExecutorMarkers(dir, { wrapperPid: 4242, spawnedAt }),
                killWaitMs: 60,
                pollMs: 5,
            },
        );
        assert.equal(outcome.confirmed, false, `${name}: ${outcome.detail}`);
        assert.equal(fake.signals.length, 0, "nothing is signalled on its account");
    }
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

// --- executors that wrote no record (configuration cache reused) ------------------

test("an executor seen while its client lived stays owned after an abrupt client exit, by pid and start time", async () => {
    // Cache reuse: no record. The single-use daemon is a child of the client in its own session.
    const running = new Map([proc(1, 0, 1), proc(100, 1, 100), proc(200, 100, 200), proc(900, 1, 900)]);
    const child = { pid: 100, exitCode: null, signalCode: null };
    const known = new Map();
    assert.deepEqual((await liveBuildProcesses(child, { platform: "linux", snapshot: async () => running, known })).sort(), [100, 200]);
    assert.equal(known.get(200), running.get(200).lstart, "observing records what it saw");

    // The client is killed: the daemon is reparented to init, outside the wrapper's group.
    child.signalCode = "SIGKILL";
    const reparented = new Map([proc(1, 0, 1), proc(200, 1, 200), proc(900, 1, 900)]);
    assert.deepEqual(
        await liveBuildProcesses(child, { platform: "linux", snapshot: async () => reparented }),
        [],
        "lineage alone loses it -- the gap this guards",
    );
    assert.deepEqual(await liveBuildProcesses(child, { platform: "linux", snapshot: async () => reparented, known }), [200]);

    // Its pid reused by an unrelated process: a different start time is not ours.
    const reused = new Map([proc(1, 0, 1), proc(200, 1, 200, "Thu Oct 22 11:00:00 2026")]);
    assert.deepEqual(await liveBuildProcesses(child, { platform: "linux", snapshot: async () => reused, known }), []);
});

test("stopping uses what was seen during the build to stop a reparented executor that wrote no record", async () => {
    const fake = fakeProcesses([proc(1, 0, 1), proc(200, 1, 200), proc(900, 1, 900)]);
    const child = { pid: 100, exitCode: null, signalCode: "SIGKILL" };
    const known = new Map([
        [100, "Thu Oct 22 10:00:00 2026"],
        [200, "Thu Oct 22 10:00:00 2026"],
    ]);
    const outcome = await terminateProcessTree(child, { platform: "linux", snapshot: fake.snapshot, kill: fake.kill, known, killWaitMs: 500, pollMs: 5 });
    assert.equal(outcome.confirmed, true, outcome.detail);
    const stopIndex = fake.signals.findIndex(([target, name]) => target === 200 && name === "SIGSTOP");
    const killIndex = fake.signals.findIndex(([target, name]) => target === 200 && name === "SIGKILL");
    assert.ok(stopIndex !== -1 && stopIndex < killIndex, "a seeded process is still frozen before it is killed");
    assert.ok(fake.signals.every(([target]) => ![1, 900, -1, -900].includes(target)), JSON.stringify(fake.signals));

    // The same pid, now another process: left alone, and nothing to wait for.
    const other = fakeProcesses([proc(1, 0, 1), proc(200, 1, 200, "Thu Oct 22 11:00:00 2026")]);
    const reused = await terminateProcessTree(child, {
        platform: "linux",
        snapshot: other.snapshot,
        kill: other.kill,
        known: new Map([[200, "Thu Oct 22 10:00:00 2026"]]),
        killWaitMs: 500,
        pollMs: 5,
    });
    assert.equal(reused.confirmed, true, reused.detail);
    assert.ok(other.signals.every(([target]) => Math.abs(target) !== 200), JSON.stringify(other.signals));
});

test("an unkillable executor known only from the build stays unconfirmed", async () => {
    const fake = fakeProcesses([proc(200, 1, 200)]);
    fake.table.get(200).unkillable = true;
    const child = { pid: 100, exitCode: 0, signalCode: null };
    const outcome = await terminateProcessTree(child, {
        platform: "linux",
        snapshot: fake.snapshot,
        kill: fake.kill,
        known: new Map([[200, "Thu Oct 22 10:00:00 2026"]]),
        killWaitMs: 150,
        pollMs: 5,
    });
    assert.equal(outcome.confirmed, false);
    assert.match(outcome.detail, /200/);
});

test("a wrapper that exits while ownership is being read is not confused with a process that reused its pid", async () => {
    // The wrapper is alive when the probe starts, exits during markers(), and the
    // snapshot that follows shows its pid reused by an unrelated process.
    const child = { pid: 100, exitCode: null, signalCode: null };
    const reusedAt = "Thu Oct 22 11:00:00 2026";
    const table = [proc(1, 0, 1), proc(100, 1, 100, reusedAt), proc(101, 100, 100, reusedAt), proc(900, 1, 900)];
    const known = new Map();
    const markers = async () => {
        child.exitCode = 0;
        return [];
    };
    const live = await liveBuildProcesses(child, { platform: "linux", markers, snapshot: async () => new Map(table), known });
    assert.deepEqual(live, [], "the replacement is not this build's");
    assert.equal(known.size, 0, "nor is it remembered as owned");

    const fake = fakeProcesses(table);
    const outcome = await terminateProcessTree(child, { platform: "linux", snapshot: fake.snapshot, kill: fake.kill, known, killWaitMs: 200, pollMs: 5 });
    assert.equal(outcome.confirmed, true, outcome.detail);
    assert.ok(
        fake.signals.every(([target]) => ![100, -100, 101, -101].includes(target)),
        `an unrelated process was signalled: ${JSON.stringify(fake.signals)}`,
    );
});

test("a wrapper that exits while the snapshot is taken is judged by its state after it", async () => {
    const child = { pid: 100, exitCode: null, signalCode: null };
    const reusedAt = "Thu Oct 22 11:00:00 2026";
    const known = new Map();
    const snapshot = async () => {
        child.signalCode = "SIGKILL";
        return new Map([proc(1, 0, 1), proc(100, 1, 100, reusedAt)]);
    };
    assert.deepEqual(await liveBuildProcesses(child, { platform: "linux", snapshot, known }), []);
    assert.equal(known.size, 0);
});

test("ownership: a process carrying this build's tag is owned without any other evidence", () => {
    const snapshot = new Map([
        proc(1, 0, 1),
        [200, { ...proc(200, 1, 200)[1], tagged: true }], // reparented executor, no record, never seen
        [201, { ...proc(201, 200, 200)[1], tagged: true }],
        [900, { ...proc(900, 1, 900)[1], tagged: false }], // another daemon
    ]);
    const owned = ownedProcesses({ snapshot, wrapperPid: 100, wrapperExited: true, known: new Map([[100, "Thu Oct 22 10:00:00 2026"]]) });
    assert.deepEqual(Array.from(owned.keys()).sort((a, b) => a - b), [200, 201]);
});

const TAG = "0123456789abcdef-tag";

test("an executor no observation saw is found by its tag after its client died, and stopped", async () => {
    // The reviewer's case: the wrapper (100) has exited, the executor (200) is alive,
    // reparented, with no record; the only observation saw the wrapper alone.
    const child = { pid: 100, exitCode: null, signalCode: "SIGKILL" };
    const table = [[1, { ...proc(1, 0, 1)[1], tagged: false }], [200, { ...proc(200, 1, 200)[1], tagged: true }], [900, { ...proc(900, 1, 900)[1], tagged: false }]];
    const known = new Map([[100, "Thu Oct 22 10:00:00 2026"]]);
    const fake = fakeProcesses(table);
    const tagged = async (options) => {
        assert.equal(options?.tag, TAG, "the snapshot is asked for the build's tag");
        return fake.snapshot();
    };
    assert.deepEqual(await liveBuildProcesses(child, { platform: "linux", snapshot: tagged, known, tag: TAG }), [200], "not gone");
    const outcome = await terminateProcessTree(child, { platform: "linux", snapshot: tagged, kill: fake.kill, known, tag: TAG, killWaitMs: 500, pollMs: 5 });
    assert.equal(outcome.confirmed, true, outcome.detail);
    assert.ok(fake.signals.some(([target, name]) => target === 200 && name === "SIGKILL"));
    assert.ok(fake.signals.every(([target]) => Math.abs(target) !== 900), JSON.stringify(fake.signals));
});

test("without the tag in a snapshot, an unseen executor is never reported gone", async () => {
    // Same case, but the snapshot cannot say which processes carry the tag.
    const child = { pid: 100, exitCode: null, signalCode: "SIGKILL" };
    const fake = fakeProcesses([proc(1, 0, 1), proc(200, 1, 200), proc(900, 1, 900)]);
    const known = new Map([[100, "Thu Oct 22 10:00:00 2026"]]);
    await assert.rejects(liveBuildProcesses(child, { platform: "linux", snapshot: fake.snapshot, known, tag: TAG }), /was not read/);
    const outcome = await terminateProcessTree(child, { platform: "linux", snapshot: fake.snapshot, kill: fake.kill, known, tag: TAG, killWaitMs: 60, pollMs: 5 });
    assert.equal(outcome.confirmed, false, outcome.detail);
    assert.equal(fake.signals.length, 0, "nothing is signalled without identifying it");
});

test("a process whose environment the system hid keeps the stop unconfirmed and is never signalled", async () => {
    // macOS case: the wrapper (100) has exited; 200 is a recent same-user orphan whose
    // environment ps did not show, so it could be this build's executor, or not.
    const child = { pid: 100, exitCode: null, signalCode: "SIGKILL" };
    const hidden = { ...proc(200, 1, 200)[1], tagged: undefined, envHidden: true };
    const fake = fakeProcesses([[1, { ...proc(1, 0, 1)[1], tagged: false }], [200, hidden], [900, { ...proc(900, 1, 900)[1], tagged: false }]]);
    const known = new Map([[100, "Thu Oct 22 10:00:00 2026"]]);
    await assert.rejects(liveBuildProcesses(child, { platform: "darwin", snapshot: fake.snapshot, known, tag: TAG }), /pid\(s\) 200 \(executable unknown\) is hidden by the system/);
    const outcome = await terminateProcessTree(child, { platform: "darwin", snapshot: fake.snapshot, kill: fake.kill, known, tag: TAG, killWaitMs: 60, pollMs: 5 });
    assert.equal(outcome.confirmed, false, outcome.detail);
    assert.match(outcome.detail, /pid\(s\) 200 \(executable unknown\) is hidden by the system/);
    assert.equal(fake.signals.length, 0, JSON.stringify(fake.signals));

    // The same hidden process in the wrapper's group is owned and stopped as usual.
    const grouped = fakeProcesses([[1, { ...proc(1, 0, 1)[1], tagged: false }], [200, { ...hidden, pgid: 100 }]]);
    const stopped = await terminateProcessTree(child, { platform: "darwin", snapshot: grouped.snapshot, kill: grouped.kill, known, tag: TAG, killWaitMs: 500, pollMs: 5 });
    assert.equal(stopped.confirmed, true, stopped.detail);
    assert.ok(grouped.signals.some(([target, name]) => target === 200 && name === "SIGKILL"));
});

test("a stop narrows the hidden-environment window to after its last clean look, never past an unseen start", async () => {
    // A macOS-style snapshot classified by the real rule. 300 is another program's hidden
    // helper whose shown, untagged parent (250) exits after the first look, leaving it an
    // orphan; it was decided then and cannot become the build's later. 400 is a hidden
    // orphan that first appears after that look, so it could be one the build started.
    const uid = 501;
    const spawnedAt = Date.now() - 60_000;
    const entry = (pid, ppid, pgid, startedAt, envShown) => [pid, { pid, ppid, pgid, uid, stat: "S", lstart: String(startedAt), startedAt, envShown }];
    const run = async (withLate) => {
        const child = { pid: 100, exitCode: null, signalCode: "SIGKILL" };
        let calls = 0;
        const sinces = [];
        const snapshot = async (options) => {
            calls += 1;
            sinces.push(options.since);
            const now = Date.now();
            const table = new Map([entry(1, 0, 1, 0, true), entry(300, calls === 1 ? 250 : 1, 250, spawnedAt + 1_000, false)]);
            if (calls === 1) {
                table.set(...entry(250, 1, 250, spawnedAt + 500, true));
            } else if (withLate) {
                table.set(...entry(400, 1, 399, now, false));
            }
            // As processSnapshot: none carries the tag; a hidden one reads as untagged until classified.
            for (const proc of table.values()) {
                proc.tagged = false;
            }
            classifyHiddenEnvironments(table, { since: options.since, uid });
            return table;
        };
        const fake = fakeProcesses([]);
        const outcome = await terminateProcessTree(child, { platform: "darwin", snapshot, kill: fake.kill, tag: TAG, since: spawnedAt, killWaitMs: 150, pollMs: 5 });
        return { outcome, sinces, signals: fake.signals };
    };

    const quiet = await run(false);
    assert.equal(quiet.outcome.confirmed, true, quiet.outcome.detail);
    assert.equal(quiet.sinces[0], spawnedAt);
    assert.ok(quiet.sinces[1] > spawnedAt, "narrowed after the clean first look");
    assert.equal(quiet.signals.length, 0, "the unrelated helper is never signalled");

    const late = await run(true);
    assert.equal(late.outcome.confirmed, false, late.outcome.detail);
    assert.match(late.outcome.detail, /pid\(s\) 400 \(executable unknown\) is hidden by the system/);
    assert.equal(late.signals.length, 0, JSON.stringify(late.signals));
});

test("the snapshot reads the build tag from real process environments", { skip: ["darwin", "linux"].includes(process.platform) ? false : "environments are read on macOS and Linux only" }, async (t) => {
    const tag = `${Date.now()}-0123456789abcdef`;
    const since = Date.now();
    const tagged = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env: { ...process.env, [BUILD_TAG_ENV]: tag },
        detached: true,
        stdio: "ignore",
    });
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env: { ...process.env, [BUILD_TAG_ENV]: `${tag}x` }, // a prefix match is not a match
        stdio: "ignore",
    });
    t.after(() => {
        tagged.kill("SIGKILL");
        other.kill("SIGKILL");
    });
    await waitUntil(async () => (await processSnapshot({ tag, since })).get(tagged.pid)?.tagged === true, { message: "the tag to be visible" });
    const snap = await processSnapshot({ tag, since });
    assert.equal(snap.get(other.pid)?.tagged, false);
    assert.equal(snap.get(process.pid)?.tagged, false);
    // Undecided only where macOS hid the environment (other tests' orphaned shells, say).
    assert.ok(Array.from(snap.values()).every((entry) => typeof entry.tagged === "boolean" || entry.envHidden === true));
    assert.ok(Number.isFinite(snap.get(tagged.pid).startedAt));
    await assert.rejects(processSnapshot({ tag: "short" }), /invalid build tag/);
});

test("a hidden macOS environment is decided by its shown ancestor, or left undecided when it could be the build's", () => {
    const since = Date.parse("Thu Oct 22 10:00:00 2026");
    const uid = 501;
    const at = (pid, ppid, pgid, { lstart = "Thu Oct 22 10:00:05 2026", shown = false, tagged = false, owner = uid } = {}) => {
        const [, entry] = proc(pid, ppid, pgid, lstart);
        return [pid, { ...entry, uid: owner, envShown: shown, tagged }];
    };
    const processes = new Map([
        at(1, 0, 1, { owner: 0 }),
        at(10, 1, 10, { shown: true, tagged: true }), // the build's JVM
        at(11, 10, 10), // hidden child of the tagged JVM: ours through it
        at(12, 11, 10), // hidden grandchild: ours through the JVM
        at(20, 1, 20, { shown: true }), // another tool, shown, untagged
        at(21, 20, 20), // hidden child of that tool: not ours
        at(30, 1, 30), // launchd-started group leader (an XPC service): not ours
        at(31, 30, 30), // its hidden child: not ours
        at(40, 1, 39), // hidden orphan, not a leader: could be a reparented build process
        at(41, 40, 39), // its hidden child: likewise
        at(50, 1, 39, { lstart: "Thu Oct 22 09:59:00 2026" }), // started before the build: not ours
        at(60, 1, 39, { owner: 0 }), // another user's: not ours
        at(70, 999, 70), // hidden, parent no longer listed: undecided
    ]);
    classifyHiddenEnvironments(processes, { since, uid });
    const result = Object.fromEntries(Array.from(processes.values()).map((entry) => [entry.pid, entry.tagged]));
    assert.deepEqual(result, {
        1: false, 10: true, 11: true, 12: true, 20: false, 21: false, 30: false, 31: false,
        40: undefined, 41: undefined, 50: false, 60: false, 70: undefined,
    });
    assert.equal(processes.get(40).envHidden, true);
});

test("a hidden orphan is undecided only when its executable is one a build could run", () => {
    const since = Date.parse("Thu Oct 22 10:00:00 2026");
    const uid = 501;
    const roots = ["/Library/Java/JavaVirtualMachines/jdk-17/Contents/Home", "/Users/u/.gradle", "/Users/u/proj"];
    // Each a hidden, same-uid, launchd-parented process outside its group's lead, started
    // after the bound: shape alone cannot tell it from a reparented build process.
    const orphan = (pid, file) => {
        const [, entry] = proc(pid, 1, pid - 1, "Thu Oct 22 10:00:05 2026");
        return [pid, { ...entry, uid, envShown: false, tagged: false, ...(file === undefined ? {} : { path: file }) }];
    };
    const crashpad = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/chrome_crashpad_handler";
    const processes = new Map([
        orphan(10, crashpad), // another app's helper: not the build's
        orphan(20, "/Applications/Microsoft Teams.app/Contents/Helpers/msedgewebview2_crashpad_handler"),
        orphan(30, "/bin/sleep"), // a platform binary: could be
        orphan(40, "/usr/libexec/xpcproxy"),
        orphan(50, `${roots[0]}/bin/java`), // the build's JDK
        orphan(60, "/Users/u/.gradle/wrapper/dists/gradle-8/bin/gradle"),
        orphan(70, "/Users/u/proj/build/tool"),
        orphan(80, "/Users/u/project-other/tool"), // a sibling, not under the project dir
        orphan(90, undefined), // path unreadable
        orphan(100, "sleep"), // not a full path
        orphan(110, "/binary/elsewhere"), // /bin is not a prefix of /binary
    ]);
    classifyHiddenEnvironments(processes, { since, uid, roots });
    const result = Object.fromEntries(Array.from(processes.values()).map((entry) => [entry.pid, entry.tagged]));
    assert.deepEqual(result, {
        10: false, 20: false, 30: undefined, 40: undefined, 50: undefined, 60: undefined, 70: undefined,
        80: false, 90: undefined, 100: undefined, 110: false,
    });
    assert.equal(processes.get(10).envHidden, undefined, "an .app helper is decided, not hidden-undecided");
});

test("the build's executable roots are its JDK, SDK, NDK, Gradle home and project, given and resolved", async (t) => {
    const home = await tempDir(t, "home-");
    const real = await tempDir(t, "jdk-");
    const link = path.join(home, "jdk-link");
    await symlink(real, link);
    const roots = buildExecutableRoots({
        env: { JAVA_HOME: link, ANDROID_HOME: "/opt/sdk", ANDROID_NDK_HOME: "/opt/ndk", GRADLE_USER_HOME: "relative/ignored" },
        cwd: "/work/proj",
        home,
    });
    for (const expected of [link, "/opt/sdk", "/opt/ndk", "/work/proj", path.join(home, "Library", "Android", "sdk")]) {
        assert.ok(roots.includes(path.resolve(expected)), `${expected} in ${roots}`);
    }
    assert.ok(roots.includes(realpathSync.native(real)), "the JDK's resolved path");
    assert.ok(!roots.some((root) => root.includes("relative")), "a relative Gradle home is not a root");
    assert.ok(buildExecutableRoots({ env: {}, home }).includes(path.join(home, ".gradle")), "Gradle's default user home");
});

test("a quarantine retry keeps the bound a clean pass advanced, so a later foreign orphan cannot hold it", { timeout: 10_000 }, async () => {
    // The wrapper is gone; its executor (200) outlives the first attempts. A hidden helper
    // (300, a platform binary) started after the spawn under a shown, untagged parent
    // (250): not the build's while that parent lives. Once the bound has passed its start,
    // the parent exits and it is reparented to launchd -- its shape is now a reparented
    // build process. A retry that went back to the spawn-time bound would hold the run
    // until it exits; one keeping the advanced bound releases it.
    const uid = 501;
    const begun = Date.now();
    const spawnedAt = begun - 60_000;
    const helperStartedAt = begun - 10_000;
    const child = { pid: 100, exitCode: null, signalCode: "SIGKILL" };
    let calls = 0;
    const sinces = [];
    const snapshot = async (options) => {
        calls += 1;
        sinces.push(options.since);
        const table = new Map();
        const add = (pid, ppid, pgid, startedAt, extra = {}) =>
            table.set(pid, { pid, ppid, pgid, uid, stat: "S", lstart: String(startedAt), startedAt, envShown: true, tagged: false, ...extra });
        add(1, 0, 1, 0);
        if (Date.now() - begun < 200) {
            add(200, 1, 200, spawnedAt + 100, { tagged: true });
        }
        const orphaned = calls > 3;
        if (!orphaned) {
            add(250, 1, 250, helperStartedAt - 5);
        }
        add(300, orphaned ? 1 : 250, 250, helperStartedAt, { envShown: false, path: "/bin/sleep" });
        classifyHiddenEnvironments(table, { since: options.since, uid, roots: [] });
        return table;
    };
    const outcome = await whileHostAlive(waitForProcessTreeExit(child, { platform: "darwin", snapshot, kill: () => {}, tag: TAG, since: spawnedAt, killWaitMs: 30, pollMs: 5 }));
    assert.equal(outcome.confirmed, true, outcome.detail);
    assert.ok(sinces.at(-1) > helperStartedAt + 2_000, `the final bound ${sinces.at(-1)} is past the helper's start`);
    // And the helper's shape alone, at the spawn-time bound, is undecided: the bound is what releases it.
    const alone = new Map([[1, { pid: 1, ppid: 0, pgid: 1, uid, startedAt: 0, envShown: true, tagged: false }], [300, { pid: 300, ppid: 1, pgid: 250, uid, startedAt: helperStartedAt, envShown: false, tagged: false, path: "/bin/sleep" }]]);
    classifyHiddenEnvironments(alone, { since: spawnedAt, uid, roots: [] });
    assert.equal(alone.get(300).tagged, undefined);
});

test("an app's crashpad helper started during the build neither blocks a running build nor holds a quarantined one", { timeout: 10_000 }, async () => {
    // Chrome, Edge and Teams double-fork their crashpad handler under launchd, outside
    // its group's lead, with its environment hidden. Launched mid-build it has the shape
    // of a reparented build process; only its executable says it is not the build's.
    const uid = 501;
    const begun = Date.now();
    const spawnedAt = begun - 60_000;
    const crashpad = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/chrome_crashpad_handler";
    const table = ({ wrapper, executor, helperPath }) => async (options) => {
        const processes = new Map();
        const add = (pid, ppid, pgid, startedAt, extra = {}) =>
            processes.set(pid, { pid, ppid, pgid, uid, stat: "S", lstart: String(startedAt), startedAt, envShown: true, tagged: false, ...extra });
        add(1, 0, 1, 0);
        if (wrapper()) {
            add(100, 1, 100, spawnedAt, { tagged: true });
        }
        if (executor()) {
            add(200, 1, 200, spawnedAt + 100, { tagged: true });
        }
        add(500, 1, 499, begun - 1_000, { envShown: false, path: helperPath });
        classifyHiddenEnvironments(processes, { since: options.since, uid, roots: ["/Users/u/.gradle", "/Users/u/proj"] });
        return processes;
    };

    // A successful build: the running wrapper and executor are its only live processes.
    const running = { pid: 100, exitCode: null, signalCode: null };
    const live = table({ wrapper: () => true, executor: () => true, helperPath: crashpad });
    assert.deepEqual((await liveBuildProcesses(running, { platform: "darwin", snapshot: live, tag: TAG, since: spawnedAt })).sort(), [100, 200]);
    // The same shape from a platform binary could be the build's, and is never counted gone.
    const sleeper = table({ wrapper: () => true, executor: () => true, helperPath: "/bin/sleep" });
    await assert.rejects(liveBuildProcesses(running, { platform: "darwin", snapshot: sleeper, tag: TAG, since: spawnedAt }), /pid\(s\) 500 \(\/bin\/sleep\) is hidden by the system/);

    // A quarantined run whose executor outlives the first attempts is released once it
    // exits, although the helper keeps running and is never signalled.
    const stopped = { pid: 100, exitCode: null, signalCode: "SIGKILL" };
    const signals = [];
    const quarantined = table({ wrapper: () => false, executor: () => Date.now() - begun < 200, helperPath: crashpad });
    const outcome = await whileHostAlive(
        waitForProcessTreeExit(stopped, { platform: "darwin", snapshot: quarantined, kill: (...call) => signals.push(call), tag: TAG, since: spawnedAt, killWaitMs: 30, pollMs: 5 }),
    );
    assert.equal(outcome.confirmed, true, outcome.detail);
    assert.ok(!signals.some(([target]) => Math.abs(target) === 500 || Math.abs(target) === 499), JSON.stringify(signals));
});

test("a platform binary carrying the tag is never read as untagged on macOS", { skip: process.platform === "darwin" ? false : "macOS hides some environments from ps" }, async (t) => {
    // The reviewer's case: `ps -E` prints no environment for /bin/sleep and does not say
    // so. A tagged parent (standing in for the build's JVM) starts it, then dies, leaving it
    // reparented to launchd with no shown ancestor.
    const tag = `${Date.now()}-0123456789abcdef`;
    const since = Date.now();
    const parent = spawn(
        process.execPath,
        ["-e", "const c = require('node:child_process').spawn('/bin/sleep', ['30'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);"],
        { env: { ...process.env, [BUILD_TAG_ENV]: tag }, detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let sleeperPid;
    t.after(() => {
        parent.kill("SIGKILL");
        if (sleeperPid) {
            try {
                process.kill(sleeperPid, "SIGKILL");
            } catch {}
        }
    });
    sleeperPid = Number(await new Promise((resolve) => parent.stdout.once("data", (data) => resolve(String(data).trim()))));
    assert.ok(sleeperPid > 0);
    const raw = spawnSync("ps", ["-ww", "-E", "-o", "command=", "-p", String(sleeperPid)], { encoding: "utf8" }).stdout;
    t.diagnostic(`ps -E shows /bin/sleep's environment: ${raw.includes(`${BUILD_TAG_ENV}=`)}`);

    await waitUntil(async () => (await processSnapshot({ tag, since })).get(sleeperPid)?.tagged === true, {
        message: "sleep to be read as the tagged parent's",
    });
    parent.kill("SIGKILL");
    await waitUntil(async () => (await processSnapshot({ tag, since })).get(sleeperPid)?.ppid === 1, { message: "sleep to be reparented" });
    const entry = (await processSnapshot({ tag, since })).get(sleeperPid);
    assert.notEqual(entry.tagged, false, "a hidden environment is not read as untagged");
    if (!entry.envShown) {
        assert.equal(entry.tagged, undefined, "undecided");
        // Owned through the dead parent's process group, it is simply not gone...
        const child = { pid: parent.pid, exitCode: null, signalCode: "SIGKILL" };
        assert.ok((await liveBuildProcesses(child, { platform: "darwin", tag, since })).includes(sleeperPid));
        // ...and with no such link it cannot be counted gone either.
        const unrelated = { pid: 99_999_999, exitCode: 0, signalCode: null };
        await assert.rejects(liveBuildProcesses(unrelated, { platform: "darwin", tag, since }), /hidden by the system/);
    }
    // Don't leave a hidden orphan behind for concurrently running test files to trip over.
    process.kill(sleeperPid, "SIGKILL");
    sleeperPid = undefined;
});

test("reading tags from /proc: unreadable others are not ours, any other failure fails the snapshot", async (t) => {
    const root = await tempDir(t, "proc-");
    const environ = (pid, body) => mkdir(path.join(root, String(pid)), { recursive: true }).then(() => writeFile(path.join(root, String(pid), "environ"), body));
    await environ(10, `PATH=/bin\0${BUILD_TAG_ENV}=${TAG}\0HOME=/h\0`);
    await environ(11, `${BUILD_TAG_ENV}=${TAG}x\0`);
    await environ(12, `${BUILD_TAG_ENV}=${TAG}`); // first and last, without a trailing NUL
    const processes = new Map([proc(10, 1, 10), proc(11, 1, 11), proc(12, 1, 12), proc(13, 1, 13)]); // 13: exited meanwhile
    await markTaggedFromProc(processes, TAG, { procRoot: root });
    assert.deepEqual(
        Array.from(processes.values()).map((entry) => [entry.pid, entry.tagged]),
        [[10, true], [11, false], [12, true], [13, false]],
    );
    await mkdir(path.join(root, "14", "environ"), { recursive: true }); // EISDIR
    await assert.rejects(markTaggedFromProc(new Map([proc(14, 1, 14)]), TAG, { procRoot: root }), { code: "EISDIR" });
});

test("a process list that fails after one clean pass does not confirm, and the deadline still applies", { timeout: 5_000 }, async () => {
    const child = { pid: 100, exitCode: 0, signalCode: null };
    let calls = 0;
    const startedAt = Date.now();
    const outcome = await terminateProcessTree(child, {
        platform: "linux",
        snapshot: async () => {
            calls += 1;
            if (calls === 1) {
                return new Map([proc(1, 0, 1)]);
            }
            throw new Error("ps is unavailable");
        },
        kill: () => {},
        killWaitMs: 100,
        pollMs: 5,
    });
    assert.equal(outcome.confirmed, false, outcome.detail);
    assert.match(outcome.detail, /could not be listed/);
    assert.ok(Date.now() - startedAt < 2_000, "it gave up at the deadline instead of spinning");
});

test("a records directory that cannot be read fails loudly instead of reading as no executor", posixOnly, async (t) => {
    const dir = await tempDir(t, "executor-records-");
    assert.deepEqual(await readExecutorMarkers(path.join(dir, "missing"), { wrapperPid: 1, spawnedAt: 0 }), [], "absent is empty");

    const notADir = path.join(dir, "file");
    await writeFile(notADir, "");
    await assert.rejects(readExecutorMarkers(notADir, { wrapperPid: 1, spawnedAt: 0 }), { code: "ENOTDIR" });

    const records = path.join(dir, "records");
    await mkdir(records);
    await writeFile(path.join(records, "10.json"), JSON.stringify({ format: 1, pid: 10, ancestors: [1], startedAt: 1 }));
    await chmod(path.join(records, "10.json"), 0o000);
    t.after(() => chmod(path.join(records, "10.json"), 0o600).catch(() => {}));
    if (process.getuid?.() !== 0) {
        await assert.rejects(readExecutorMarkers(records, { wrapperPid: 1, spawnedAt: 0 }), { code: "EACCES" });
    }

    const fake = fakeProcesses([proc(1, 0, 1)]);
    const outcome = await terminateProcessTree(
        { pid: 100, exitCode: 0, signalCode: null },
        {
            platform: "linux",
            snapshot: fake.snapshot,
            kill: fake.kill,
            markers: () => readExecutorMarkers(notADir, { wrapperPid: 100, spawnedAt: 0 }),
            killWaitMs: 100,
            pollMs: 5,
        },
    );
    assert.equal(outcome.confirmed, false, "an unreadable record is not proof there is no executor");
});

test("one record of observations is shared by tracking, the post-exit check, and the stop it falls back to", posixOnly, async (t) => {
    const root = await posixProject(t, "echo started; sleep 0.3");
    const seen = { probe: new Set(), terminate: new Set(), waitForExit: new Set() };
    let probes = 0;
    const service = newService(fakeManager(), {
        executorExitWaitMs: 200,
        lineagePollMs: 10,
        processTree: {
            probe: async (_child, options) => {
                seen.probe.add(options.known);
                probes += 1;
                throw new Error("ps is unavailable"); // Neither tracking nor the check may treat this as gone.
            },
            terminate: async (_child, options) => {
                seen.terminate.add(options.known);
                return { confirmed: false, detail: "the test refused to confirm it" };
            },
            waitForExit: (_child, options) => {
                seen.waitForExit.add(options.known);
                return new Promise(() => {});
            },
        },
    });
    service.setWorkingDirectory(root);
    const failure = await rejection(service.buildInstallLaunch({ deviceId: "one", launch: false }));
    assert.equal(failure.code, "build_executor_unconfirmed");
    assert.ok(failure.retainHoldUntil instanceof Promise, "the device stays reserved");
    assert.equal(service.statusFor("one").quarantined, true);
    assert.equal(service.projectLocks.size, 1, "the project stays reserved");
    assert.ok(probes > 1, "it was observed while it ran, despite the failures");
    const maps = new Set([...seen.probe, ...seen.terminate, ...seen.waitForExit]);
    assert.equal(maps.size, 1, "every stage saw the same map");
    assert.ok([...maps][0] instanceof Map);
});

/**
 * A project whose `gradlew` execs a client that starts a single-use daemon in
 * its own session and writes no executor record -- as when the configuration
 * cache is reused -- then is SIGKILLed once the daemon is up, leaving the daemon
 * reparented outside the wrapper's group with nothing on disk naming it.
 */
async function recordlessProject(t, { clientDiesAfterMs = 600 } = {}) {
    const root = await tempDir(t, "recordless-fixture-");
    await writeFile(
        path.join(root, "client.cjs"),
        `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const out = fs.openSync(path.join(root, "daemon.log"), "a");
const daemon = spawn(process.execPath, ["-e", \`
    process.on("SIGTERM", () => {});
    require("node:fs").writeFileSync(\${JSON.stringify(path.join(root, "daemon.pid"))}, String(process.pid));
    setTimeout(() => require("node:fs").writeFileSync(\${JSON.stringify(path.join(root, "installed"))}, "x"), 5000);
    setInterval(() => {}, 1000);
\`], { detached: true, stdio: ["ignore", out, out] });
const wait = setInterval(() => {
    if (fs.existsSync(path.join(root, "daemon.pid"))) {
        clearInterval(wait);
        console.log("started");
        setTimeout(() => process.kill(process.pid, "SIGKILL"), ${clientDiesAfterMs});
    }
}, 10);
`,
    );
    await writeFile(path.join(root, "gradlew"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/client.cjs" "$(dirname "$0")"\n`);
    await chmod(path.join(root, "gradlew"), 0o755);
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.app", variantName: "debug" });
    return root;
}

test("a recordless executor left behind by a killed client is stopped before the build is reported over", posixOnly, async (t) => {
    const root = await recordlessProject(t);
    const service = newService(fakeManager(), { executorExitWaitMs: 300, lineagePollMs: 20 });
    service.setWorkingDirectory(root);
    const failure = await rejection(service.buildInstallLaunch({ deviceId: "dev", launch: false }));
    const daemon = await daemonPid(root);
    t.after(() => {
        try {
            process.kill(daemon, "SIGKILL");
        } catch {
            // Gone, as expected.
        }
    });
    assert.equal(failure.code, "build_failed", failure.message);
    assert.equal(isAlive(daemon), false, "the daemon was gone before the build was reported over");
    const termination = service.runs.get("dev").termination;
    assert.equal(termination.confirmed, true, termination.detail);
    assert.ok(termination.stopped?.some((entry) => entry.pid === daemon), JSON.stringify(termination));
});

test("an executor started and orphaned between observations is still found and stopped", posixOnly, async (t) => {
    // Every observation while the client lives fails, and the client dies as soon
    // as the daemon is up: nothing ever saw the daemon, which wrote no record.
    const root = await recordlessProject(t, { clientDiesAfterMs: 0 });
    let tracked = 0;
    const service = newService(fakeManager(), {
        executorExitWaitMs: 300,
        lineagePollMs: 5,
        processTree: {
            probe: async (child, options) => {
                if (child.exitCode === null && child.signalCode === null) {
                    tracked += 1;
                    throw new Error("ps is unavailable");
                }
                return liveBuildProcesses(child, options);
            },
        },
    });
    service.setWorkingDirectory(root);
    const failure = await rejection(service.buildInstallLaunch({ deviceId: "dev", launch: false }));
    const daemon = await daemonPid(root);
    t.after(() => {
        try {
            process.kill(daemon, "SIGKILL");
        } catch {
            // Gone, as expected.
        }
    });
    assert.ok(tracked > 0, "observations failed while the client ran");
    const termination = service.runs.get("dev").termination;
    if (["darwin", "linux"].includes(process.platform)) {
        assert.equal(failure.code, "build_failed", failure.message);
        assert.equal(isAlive(daemon), false, "the daemon was gone before the build was reported over");
        assert.equal(termination.confirmed, true, termination.detail);
        assert.ok(termination.stopped?.some((entry) => entry.pid === daemon), JSON.stringify(termination));
    } else {
        // No way to read the tag: the build stays reserved rather than guessing.
        assert.equal(failure.code, "build_executor_unconfirmed", failure.message);
        assert.equal(termination.confirmed, false);
    }
});

test("cancelling during wrapper startup confirms the stop before anything it would start can run", posixOnly, async (t) => {
    // The wrapper is still "downloading the distribution" when cancelled.
    const root = await posixProject(t, ['sleep 0.4', 'echo late > "$(dirname "$0")/daemon-started"'].join("\n"));
    const service = newService(fakeManager());
    service.setWorkingDirectory(root);
    const running = rejection(service.buildInstallLaunch({ deviceId: "dev", launch: false }));
    await waitUntil(() => service.runs.get("dev")?.child?.pid, { message: "the wrapper to be spawned" });
    const pid = service.runs.get("dev").child.pid;
    t.after(() => killGroup(pid));
    const final = await service.cancel("dev");
    assert.equal(final.state, "cancelled");
    assert.equal((await running).code, "build_cancelled");
    assert.equal(service.runs.get("dev").termination.confirmed, true);
    assert.equal(isAlive(pid), false);
    await sleep(700);
    await assert.rejects(readFile(path.join(root, "daemon-started")), { code: "ENOENT" }, "nothing ran after the cancellation");
    await waitUntil(() => service.projectLocks.size === 0, { message: "the lock to be dropped" });
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

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
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { extensionModule, extensionRoot, isAlive, sleep, tempDir, waitUntil } from "./helpers.mjs";

const {
    AppBuildService,
    executorInitScript,
    executorPaths,
    findGradleRoot,
    gradleInvocation,
    ownedProcesses,
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
            format: 1,
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
function install(root, project, task, dir, buildDir = `${dir}/build`) {
    return {
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

test("install evidence is read strictly, and any gap fails closed", async (t) => {
    const root = await realpath(await tempDir(t));
    await writeMetadata(root, "app/build/outputs/apk/debug", { applicationId: "com.example.app", variantName: "debug" });
    const dir = await tempDir(t, "installs-");
    const good = { format: 1, rootDir: root, project: ":app", task: "installDebug", projectDir: path.join(root, "app"), buildDir: path.join(root, "app/build") };
    await writeFile(path.join(dir, "a.json"), JSON.stringify(good));
    await writeFile(path.join(dir, "notes.txt"), "ignored");
    let evidence = await readInstallEvidence(dir);
    assert.deepEqual(evidence, { installs: [{ rootDir: root, project: ":app", task: "installDebug", projectDir: good.projectDir, buildDir: good.buildDir }], problems: [] });
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
    const dir = path.join(parent, "my proj & (x) ^ !");
    await mkdir(dir, { recursive: true });
    const root = await realpath(dir);
    // What the install-evidence action records for :app:installDebug, copied into place like the real one.
    await writeFile(
        path.join(root, "install-evidence.json"),
        JSON.stringify({ format: 1, rootDir: root, project: ":app", task: "installDebug", projectDir: path.join(root, "app"), buildDir: path.join(root, "app", "build") }),
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
            `const { AppBuildService } = await import(${JSON.stringify(path.join(extensionRoot, "lib", "app-build-service.mjs"))});`,
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

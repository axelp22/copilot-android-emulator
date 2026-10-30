/**
 * The real canvas page in headless Chrome, served by the real canvas server in
 * front of a scripted device. Covers what only a browser can show: the build
 * panel and notices updating live, control and build errors leaving a healthy
 * picture alone, and the stream working -- or falling back once, cleanly --
 * in a runtime without WebCodecs.
 *
 * Skips, saying so, when no Chrome is available or Node has no WebSocket.
 * Point CHROME_PATH at a Chrome or Chromium binary to choose one.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { extensionModule, extensionRoot, sleep, solidPng, waitUntil } from "./helpers.mjs";

const { createCanvasServer } = await extensionModule("lib", "canvas-server.mjs");
const { FRAME_TAGS, frame } = await extensionModule("lib", "h264-stream.mjs");
const { AppError } = await extensionModule("lib", "errors.mjs");

function findChrome() {
    const fromEnv = process.env.CHROME_PATH ?? process.env.VERIFY_CHROME;
    if (fromEnv && existsSync(fromEnv)) {
        return fromEnv;
    }
    const candidates =
        process.platform === "darwin"
            ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
            : process.platform === "win32"
              ? [
                    path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
                    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
                ]
              : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].flatMap((name) =>
                    (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, name)),
                );
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const chromePath = findChrome();
const skip = !chromePath
    ? "Chrome was not found; set CHROME_PATH to run the browser tests"
    : typeof WebSocket === "undefined"
      ? "this Node has no global WebSocket (needs Node 22+)"
      : false;

/** Starts headless Chrome with a private profile, removed with the browser afterwards. */
async function launchChrome(t) {
    const profile = await mkdtemp(path.join(os.tmpdir(), "canvas-chrome-"));
    const args = [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=900,1200",
        "about:blank",
    ];
    // Ubuntu runners restrict the unprivileged namespaces Chrome's sandbox needs.
    if (process.platform === "linux") {
        args.unshift("--no-sandbox");
    }
    // Its own process group on POSIX, so the helper processes go with it: a
    // surviving network service keeps writing into the profile being removed.
    const posix = process.platform !== "win32";
    const chrome = spawn(chromePath, args, { stdio: "ignore", detached: posix });
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    const signal = (name) => {
        try {
            if (posix) {
                process.kill(-chrome.pid, name);
            } else {
                chrome.kill(name);
            }
        } catch {
            // Already gone.
        }
    };
    t.after(async () => {
        signal("SIGTERM");
        await Promise.race([exited, sleep(5_000)]);
        signal("SIGKILL");
        await sleep(300);
        // Windows can hold profile files briefly after the browser exits; a stray
        // temp directory is not worth failing the run over.
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) =>
            t.diagnostic(`could not remove the Chrome profile ${profile}: ${error.message}`),
        );
    });

    let port = null;
    await waitUntil(
        async () => {
            const contents = await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
            port = Number(contents.split("\n")[0]) || null;
            return port !== null;
        },
        { timeoutMs: 20_000, message: "Chrome's debugging port" },
    );
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    return connect(target.webSocketDebuggerUrl);
}

async function connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    const listeners = new Set();
    socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.method) {
            for (const listener of listeners) {
                listener(message);
            }
            return;
        }
        const entry = pending.get(message.id);
        if (entry) {
            pending.delete(message.id);
            if (message.error) {
                entry.reject(new Error(message.error.message));
            } else {
                entry.resolve(message.result);
            }
        }
    });
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
        });
    const evaluate = async (expression) => {
        const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        }
        return result.result.value;
    };
    const until = (expression, message, timeoutMs = 15_000) =>
        waitUntil(() => evaluate(expression), { timeoutMs, intervalMs: 100, message });
    // Subscribe before triggering the event: CDP does not replay ones already sent.
    const nextEvent = (method, timeoutMs = 15_000) => {
        let listener;
        let timer;
        return new Promise((resolve, reject) => {
            listener = (message) => message.method === method && resolve(message.params);
            listeners.add(listener);
            timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
        }).finally(() => {
            listeners.delete(listener);
            clearTimeout(timer);
        });
    };
    return { send, evaluate, until, nextEvent, close: () => socket.close() };
}

const seedPng = solidPng(40, 80, [61, 220, 132]);
const avcC = Buffer.from([0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80]);

/**
 * A device whose stream sends `frames` and then stays open, like an idle screen.
 * `others` adds more devices by id, each `{ transport, frames, reportedTransport, holdFrames }`,
 * for tests that switch the canvas to another device. `holdFrames` is a promise
 * the stream waits on before sending anything, for a device slow to show a frame.
 */
function scriptedDevice({ transport, frames, others = {} }) {
    const handlers = new Set();
    const calls = { streams: 0, screenshots: 0, cancel: [], children: [], streamsByDevice: {} };
    const extra = new Map(
        Object.entries(others).map(([deviceId, spec]) => [
            deviceId,
            {
                spec,
                state: {
                    deviceId,
                    serial: `emulator-${deviceId}`,
                    kind: "emulator",
                    name: deviceId.replace("_", " "),
                    state: "Booted",
                    isAvailable: true,
                    canManageLifecycle: true,
                    deviceFamily: "phone",
                    screen: { width: 1080, height: 2400, density: 420 },
                    orientation: "portrait",
                    stream: { codec: "h264", fps: 60, resolution: 100, transport: spec.reportedTransport ?? null },
                    controlPending: false,
                    lease: { active: false },
                    sharing: { heldByOtherSession: false, waiting: 0 },
                    build: { available: true, task: "installDebug" },
                    install: null,
                },
            },
        ]),
    );
    const stateOf = (deviceId) => extra.get(deviceId)?.state ?? state;
    let state = {
        deviceId: "Pixel_A",
        serial: "emulator-5554",
        kind: "emulator",
        name: "Pixel A",
        state: "Booted",
        isAvailable: true,
        canManageLifecycle: true,
        deviceFamily: "phone",
        screen: { width: 1080, height: 2400, density: 420 },
        orientation: "portrait",
        stream: { codec: "h264", fps: 60, resolution: 100, transport },
        controlPending: false,
        lease: { active: false },
        sharing: { heldByOtherSession: false, waiting: 0 },
        build: { available: true, task: "installDebug" },
        install: null,
    };
    const notify = () => {
        for (const handler of handlers) {
            handler();
        }
    };
    return {
        calls,
        update(patch) {
            state = { ...state, ...patch };
            notify();
        },
        subscribe(deviceId, handler) {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
        registerManualInputStop: () => () => {},
        refreshSharing: async () => null,
        snapshot: (deviceId) => stateOf(deviceId),
        getCachedDeviceState: (deviceId) => stateOf(deviceId),
        getDeviceState: async (deviceId) => stateOf(deviceId),
        listDevicePicker: async () => ({ groups: {} }),
        getFramePng: async () => {
            calls.screenshots += 1;
            return seedPng;
        },
        setStreamPreferences: async (deviceId, preferences) => {
            state = { ...state, stream: { ...state.stream, ...preferences } };
            return state;
        },
        pressButton: async () => {
            throw new AppError("device_busy", "Pixel A is busy in another session.", 409);
        },
        cancelBuild: async (input) => {
            calls.cancel.push(input);
            state = { ...state, install: { ...state.install, cancellable: false, cancelRequested: true, message: "Cancelling…" } };
            notify();
            return state.install;
        },
        createVideoStream: async ({ deviceId } = {}) => {
            calls.streams += 1;
            calls.streamsByDevice[deviceId] = (calls.streamsByDevice[deviceId] ?? 0) + 1;
            const spec = extra.get(deviceId)?.spec ?? { transport, frames };
            const stdout = new PassThrough();
            const exits = new Set();
            const child = {
                stdout,
                deviceId,
                transport: spec.transport,
                killed: false,
                stderrText: () => "",
                whenReaped: async () => {},
                on(event, handler) {
                    if (event === "exit") {
                        exits.add(handler);
                    }
                    return child;
                },
                off(event, handler) {
                    exits.delete(handler);
                    return child;
                },
                // The device side dropping the stream part way through, as an
                // emulator restart or a broken gRPC connection does.
                fail() {
                    child.killed = true;
                    for (const handler of exits) {
                        handler(1, null);
                    }
                    stdout.end();
                },
                kill() {
                    if (child.killed) {
                        return;
                    }
                    child.killed = true;
                    stdout.end();
                    for (const handler of exits) {
                        handler(0, "SIGTERM");
                    }
                },
            };
            calls.children.push(child);
            const send = () => {
                for (const chunk of spec.frames) {
                    if (!child.killed) {
                        stdout.write(chunk);
                    }
                }
            };
            if (spec.holdFrames) {
                void spec.holdFrames.then(send);
            } else {
                setImmediate(send);
            }
            return child;
        },
    };
}

async function openCanvas(t, device, { withoutVideoDecoder = false, latencyMs = 0 } = {}) {
    // The browser is registered for cleanup first so it is gone before the
    // server closes: a live page would otherwise keep reconnecting to it.
    const page = await launchChrome(t);
    const server = await createCanvasServer({ manager: device, instanceId: "browser", deviceId: "Pixel_A", webRoot: path.join(extensionRoot, "web") });
    t.after(() => page.close());
    t.after(() => server.close());
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    if (withoutVideoDecoder) {
        await page.send("Page.addScriptToEvaluateOnNewDocument", {
            source: "delete window.VideoDecoder; delete window.EncodedVideoChunk;",
        });
    }
    if (latencyMs > 0) {
        await page.send("Network.enable");
        await page.send("Network.emulateNetworkConditions", { offline: false, latency: latencyMs, downloadThroughput: -1, uploadThroughput: -1 });
    }
    // Page.navigate answers once the navigation starts, while the old about:blank
    // document (or a half-parsed canvas) may still be what Runtime.evaluate sees.
    // Polls that read canvas elements must not run until the canvas has loaded.
    const loaded = page.nextEvent("Page.loadEventFired");
    const navigation = await page.send("Page.navigate", { url: server.url });
    if (navigation.errorText) {
        throw new Error(`Could not open the canvas: ${navigation.errorText}`);
    }
    await loaded;
    const origin = await page.evaluate("location.origin");
    if (origin !== new URL(server.url).origin || !(await page.evaluate(`Boolean(document.getElementById("notice-text"))`))) {
        throw new Error(`The canvas page did not load (at ${origin})`);
    }
    page.server = server;
    return page;
}

const painted = `(() => {
    const win = document.querySelector(".screen-window");
    return win.classList.contains("has-frame") && win.classList.contains("h264-active");
})()`;
const screenErrorShown = `document.getElementById("screen-message").classList.contains("error")`;

test("openCanvas hands over the loaded canvas, even when it is slow to arrive", { skip, timeout: 60_000 }, async (t) => {
    const device = scriptedDevice({ transport: "grpc", frames: [frame(FRAME_TAGS.seed, seedPng)] });
    // Slow enough that a check right after Page.navigate still sees about:blank.
    const page = await openCanvas(t, device, { latencyMs: 400 });
    // Read once, without polling: every later page.until relies on this state.
    const ready = await page.evaluate(`({
        origin: location.origin,
        readyState: document.readyState,
        notice: typeof document.getElementById("notice-text")?.textContent,
        screen: Boolean(document.querySelector(".screen-window")),
    })`);
    assert.deepEqual(ready, { origin: new URL(page.server.url).origin, readyState: "complete", notice: "string", screen: true });
});

test("build progress, cancel and errors show in the tray without disturbing the picture", { skip, timeout: 60_000 }, async (t) => {
    const device = scriptedDevice({ transport: "grpc", frames: [frame(FRAME_TAGS.seed, seedPng)] });
    const page = await openCanvas(t, device);
    await page.until(painted, "the first frame");
    // Startup may open the stream more than once; what matters is that nothing
    // below opens another or closes the one that is showing.
    await sleep(500);
    const streamsAfterStartup = device.calls.streams;
    const liveStream = device.calls.children.at(-1);

    device.update({
        install: {
            id: "run-1",
            state: "running",
            step: "build",
            message: "> Task :app:compileDebugKotlin",
            cancellable: true,
            cancelRequested: false,
            logTotal: 2,
            log: ["Downloading 10%", "<b>not markup</b>"],
        },
    });
    await page.until(`!document.getElementById("build-panel").hidden`, "the build panel");
    assert.equal(await page.evaluate(`document.getElementById("build-title").textContent`), "Building");
    assert.equal(await page.evaluate(`document.getElementById("build-log").textContent`), "Downloading 10%\n<b>not markup</b>");
    assert.equal(await page.evaluate(`document.getElementById("build-log").children.length`), 0, "log text is not parsed as HTML");
    assert.equal(await page.evaluate(`document.getElementById("install-button").disabled`), true);

    await page.evaluate(`document.getElementById("build-cancel").click()`);
    await waitUntil(() => device.calls.cancel.length === 1, { message: "the cancel request" });
    assert.deepEqual(device.calls.cancel[0], { deviceId: "Pixel_A", runId: "run-1", wait: false, reason: "Cancelled from the canvas." });
    await page.until(`document.getElementById("build-cancel").textContent === "Cancelling…"`, "the cancelling state");

    device.update({
        install: {
            id: "run-1",
            state: "failed",
            step: "done",
            message: "installDebug failed: Execution failed for task ':app:compileDebugKotlin'.",
            cancellable: false,
            logTotal: 3,
            log: ["Downloading 10%", "e: Unresolved reference", "BUILD FAILED"],
        },
    });
    await page.until(`document.getElementById("build-title").textContent === "Build failed"`, "the failed build");
    assert.equal(await page.evaluate(`document.getElementById("build-panel").dataset.tone`), "error");
    assert.equal(await page.evaluate(`document.getElementById("build-cancel").hidden`), true);
    assert.equal(await page.evaluate(screenErrorShown), false, "a failed build is not a display error");

    await page.evaluate(`document.querySelector('[data-action="back"]').click()`);
    await page.until(`document.getElementById("notice-text").textContent.includes("busy in another session")`, "the control error");
    assert.equal(await page.evaluate(`document.getElementById("notice").getAttribute("role")`), "alert");
    assert.equal(await page.evaluate(screenErrorShown), false, "a refused control is not a display error");
    assert.equal(await page.evaluate(painted), true, "the picture is still showing");
    assert.equal(liveStream.killed, false, "the healthy stream was not torn down");
    assert.equal(device.calls.streams, streamsAfterStartup);

    await page.evaluate(`document.getElementById("build-dismiss").click()`);
    await page.until(`document.getElementById("build-panel").hidden`, "the dismissed panel");
});

test("without WebCodecs, a gRPC stream of stills still paints", { skip, timeout: 60_000 }, async (t) => {
    const device = scriptedDevice({ transport: "grpc", frames: [frame(FRAME_TAGS.seed, seedPng)] });
    const page = await openCanvas(t, device, { withoutVideoDecoder: true });
    await page.until(painted, "the first still");
    assert.equal(await page.evaluate(`"VideoDecoder" in window`), false);
    await sleep(500);
    const streamsAfterStartup = device.calls.streams;
    await sleep(1_500);
    assert.equal(device.calls.streams, streamsAfterStartup, "no reconnect loop");
    assert.equal(device.calls.children.at(-1).killed, false);
    assert.equal(device.calls.screenshots, 0, "no screenshot polling while the stream works");
    assert.equal(await page.evaluate(screenErrorShown), false);
});

test("without WebCodecs, mirrored video falls back to screenshots once and stays there", { skip, timeout: 60_000 }, async (t) => {
    const device = scriptedDevice({
        transport: "mirror",
        frames: [frame(FRAME_TAGS.seed, seedPng), frame(FRAME_TAGS.config, avcC)],
    });
    const page = await openCanvas(t, device, { withoutVideoDecoder: true });
    await page.until(`document.getElementById("notice-text").textContent.includes("cannot decode video")`, "the fallback notice");
    await waitUntil(() => device.calls.screenshots > 0, { message: "screenshot polling", timeoutMs: 10_000 });
    await page.until(`document.getElementById("screen").classList.contains("has-frame")`, "a screenshot");
    await waitUntil(() => device.calls.children.every((child) => child.killed), { message: "the undecodable stream to be closed" });
    const streamsAfterFallback = device.calls.streams;

    // A reconnect (here, a quality change) must not go round the same loop.
    await page.evaluate(`(() => {
        const select = document.getElementById("stream-fps");
        select.value = "30";
        select.dispatchEvent(new Event("change"));
    })()`);
    const screenshotsBefore = device.calls.screenshots;
    await sleep(2_000);
    assert.equal(device.calls.streams, streamsAfterFallback, "no new stream for video this runtime cannot decode");
    assert.ok(device.calls.screenshots > screenshotsBefore, "screenshots keep coming");
    assert.equal(await page.evaluate(screenErrorShown), false);
});

test("a decoder failure on one device does not keep a newly picked emulator off its stream", { skip, timeout: 60_000 }, async (t) => {
    const device = scriptedDevice({
        transport: "mirror",
        frames: [frame(FRAME_TAGS.seed, seedPng), frame(FRAME_TAGS.config, avcC)],
        // Nothing recorded yet about how this emulator streams; its gRPC stills need no WebCodecs.
        others: { Pixel_B: { reportedTransport: null, transport: "grpc", frames: [frame(FRAME_TAGS.seed, seedPng)] } },
    });
    const page = await openCanvas(t, device, { withoutVideoDecoder: true });
    await page.until(`document.getElementById("notice-text").textContent.includes("cannot decode video")`, "the fallback notice");
    await waitUntil(() => device.calls.screenshots > 0, { message: "screenshot polling", timeoutMs: 10_000 });
    const mirroredStreams = device.calls.streamsByDevice.Pixel_A;

    await page.server.rebindDevice("Pixel_B");
    await waitUntil(() => (device.calls.streamsByDevice.Pixel_B ?? 0) > 0, { message: "a stream for the new emulator", timeoutMs: 10_000 });
    await page.until(painted, "the new emulator's stills on the stream canvas");
    await sleep(1_000);
    assert.equal(device.calls.children.filter((child) => child.deviceId === "Pixel_B").at(-1).killed, false);
    assert.equal(await page.evaluate(screenErrorShown), false);

    // Back on the mirrored device, the failure it proved still holds.
    await page.server.rebindDevice("Pixel_A");
    const screenshotsBefore = device.calls.screenshots;
    await waitUntil(() => device.calls.screenshots > screenshotsBefore, { message: "screenshots for the mirrored device", timeoutMs: 10_000 });
    await sleep(1_000);
    assert.equal(device.calls.streamsByDevice.Pixel_A, mirroredStreams, "no new stream for video this runtime cannot decode");
});

test("a stream that fails part way through reconnects by itself, keeping screenshots meanwhile", { skip, timeout: 60_000 }, async (t) => {
    const device = scriptedDevice({ transport: "grpc", frames: [frame(FRAME_TAGS.seed, seedPng)] });
    const page = await openCanvas(t, device);
    await page.until(painted, "the first frame");
    await sleep(500);
    const streamsBefore = device.calls.streams;
    device.calls.children.at(-1).fail();

    await waitUntil(() => device.calls.screenshots > 0, { message: "screenshots while the stream is down", timeoutMs: 10_000 });
    await waitUntil(() => device.calls.streams > streamsBefore, { message: "an automatic new stream", timeoutMs: 10_000 });
    await page.until(painted, "video again after the reconnect");
    const live = device.calls.children.at(-1);
    assert.equal(live.killed, false);
    assert.equal(await page.evaluate(screenErrorShown), false, "a dropped stream is not a display error");

    // Once video is back the retry is spent: no further streams open on their own.
    const streamsAfterRecovery = device.calls.streams;
    await sleep(1_500);
    assert.equal(device.calls.streams, streamsAfterRecovery, "no reconnect loop once recovered");
    assert.equal(live.killed, false);
});

test("a stream that keeps failing settles on screenshots after a bounded number of retries", { skip, timeout: 90_000 }, async (t) => {
    const device = scriptedDevice({ transport: "grpc", frames: [] });
    const failing = device.createVideoStream;
    device.createVideoStream = async (input) => {
        const child = await failing(input);
        // A real mid-stream failure has already sent a response; a byte short
        // of a frame flushes it without painting, so the browser cannot replay
        // the request on its own and only the canvas's retries are counted.
        child.stdout.write(Buffer.from([0]));
        setTimeout(() => child.fail(), 20);
        return child;
    };
    const page = await openCanvas(t, device);
    await waitUntil(() => device.calls.screenshots > 0, { message: "screenshots", timeoutMs: 10_000 });
    // Retries are counted from the first fallback; startup may open more than once.
    const beforeRetries = device.calls.streams;
    // 0.5 + 1 + 2 + 4 + 8 + 8 s of backoff.
    await waitUntil(() => device.calls.streams - beforeRetries >= 6, { message: "the bounded retries", timeoutMs: 40_000 });
    await sleep(10_000);
    const retries = device.calls.streams - beforeRetries;
    assert.equal(retries, 6, `retries stop (saw ${retries})`);
    const screenshots = device.calls.screenshots;
    await sleep(500);
    assert.ok(device.calls.screenshots > screenshots, "screenshots keep coming");
    assert.equal(await page.evaluate(screenErrorShown), false);
});

test("the diagnostics panel names the transport and why, and copies an allowlisted report", { skip, timeout: 60_000 }, async (t) => {
    const device = scriptedDevice({ transport: "grpc", frames: [frame(FRAME_TAGS.seed, seedPng)] });
    const page = await openCanvas(t, device);
    await page.until(painted, "the first frame");
    await page.evaluate(`(() => {
        window.__copied = [];
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: async (text) => { window.__copied.push(text); } },
        });
    })()`);
    device.update({
        stream: {
            codec: "h264",
            fps: 60,
            resolution: 100,
            transport: "mirror",
            transportReason:
                "emulator-5554 Pixel_8_API_34 R58N47XC8HP refused: http://admin:hunter2@localhost:8554 token=sk-SECRET123 at /Users/someone/.android/avd/Pixel_A.avd",
        },
    });

    const toggle = `document.getElementById("diagnostics-toggle")`;
    assert.equal(await page.evaluate(`${toggle}.getAttribute("aria-expanded")`), "false");
    assert.equal(await page.evaluate(`document.getElementById("diagnostics-panel").hidden`), true);
    await page.evaluate(`${toggle}.click()`);
    await page.until(`!document.getElementById("diagnostics-panel").hidden`, "the diagnostics panel");
    assert.equal(await page.evaluate(`${toggle}.getAttribute("aria-expanded")`), "true");
    await page.until(`document.getElementById("diagnostics-transport").textContent === "Screen mirror video"`, "the mirror transport");
    assert.equal(await page.evaluate(`document.getElementById("diagnostics-reason").textContent`), "gRPC unavailable: the connection failed");

    await page.evaluate(`document.getElementById("diagnostics-copy").click()`);
    await page.until(`document.getElementById("diagnostics-copy-status").textContent === "Diagnostic report copied."`, "the copy status");
    const copied = await page.evaluate(`window.__copied.at(-1)`);
    assert.match(copied, /Screen mirror video/);
    for (const leak of ["sk-SECRET123", "/Users/someone", "Pixel_A", "Pixel_8", "R58N47XC8HP", "hunter2", "admin", "5554", "Pixel A", "127.0.0.1", "localhost"]) {
        assert.ok(!copied.includes(leak), `copied report leaks ${leak}`);
    }
    assert.equal(await page.evaluate(`document.getElementById("diagnostics-copy-status").getAttribute("role")`), "status");
    assert.equal(await page.evaluate(screenErrorShown), false, "opening diagnostics is not a display error");
});

test("when the clipboard is blocked, the report is shown selected and stays selected across refreshes", { skip, timeout: 60_000 }, async (t) => {
    const device = scriptedDevice({ transport: "grpc", frames: [frame(FRAME_TAGS.seed, seedPng)] });
    const page = await openCanvas(t, device);
    await page.until(painted, "the first frame");
    await page.evaluate(`Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => { throw new DOMException("Write permission denied.", "NotAllowedError"); } },
    })`);
    await page.evaluate(`document.getElementById("diagnostics-toggle").click()`);
    await page.until(`!document.getElementById("diagnostics-panel").hidden`, "the diagnostics panel");
    const details = `document.querySelector(".diagnostics-report-details")`;
    assert.equal(await page.evaluate(`${details}.open`), false, "the preview starts collapsed");

    await page.evaluate(`document.getElementById("diagnostics-copy").click()`);
    await page.until(
        `document.getElementById("diagnostics-copy-status").textContent === "Copy was blocked. The report is selected; copy it manually."`,
        "the blocked-copy status",
    );
    const selectionState = `(() => {
        const report = document.getElementById("diagnostics-report");
        const box = report.getBoundingClientRect();
        return {
            open: ${details}.open,
            visible: box.width > 0 && box.height > 0,
            focused: document.activeElement === report,
            report: report.textContent,
            selected: getSelection().toString(),
        };
    })()`;
    // Keyboard users land on the selected report (focus may take one frame to apply).
    await page.until(`document.activeElement === document.getElementById("diagnostics-report")`, "focus on the report");
    const before = await page.evaluate(selectionState);
    assert.equal(before.open, true, "the preview opens so the selection can be seen");
    assert.equal(before.visible, true);
    assert.equal(before.focused, true);
    assert.match(before.report, /^Android Emulator canvas diagnostics/);
    assert.equal(before.selected, before.report);

    // Outlast more than one of the panel's one-second refreshes.
    await sleep(2_500);
    const after = await page.evaluate(selectionState);
    assert.equal(after.report, before.report, "the refresh leaves the selected report alone");
    assert.equal(after.selected, before.report, "the selection is still whole");
    assert.equal(await page.evaluate(`document.getElementById("diagnostics-copy-status").textContent`), "Copy was blocked. The report is selected; copy it manually.");

    // Closing releases the pinned report, so the next look is current again.
    await page.evaluate(`document.getElementById("diagnostics-close").click()`);
    await page.evaluate(`document.getElementById("diagnostics-toggle").click()`);
    await page.until(`!document.getElementById("diagnostics-panel").hidden`, "the reopened panel");
    assert.notEqual(await page.evaluate(`document.getElementById("diagnostics-report").textContent`), before.report);
});

test("after switching devices, diagnostics wait for the new device's own first frame", { skip, timeout: 60_000 }, async (t) => {
    let releaseFrames;
    const holdFrames = new Promise((resolve) => {
        releaseFrames = resolve;
    });
    const device = scriptedDevice({
        transport: "mirror",
        frames: [frame(FRAME_TAGS.seed, seedPng), frame(FRAME_TAGS.config, avcC)],
        others: { Pixel_B: { reportedTransport: "grpc", transport: "grpc", frames: [frame(FRAME_TAGS.seed, seedPng)], holdFrames } },
    });
    t.after(() => releaseFrames());
    // Pixel_A ends up on screenshots, which is the frame clock a switch used to inherit.
    const page = await openCanvas(t, device, { withoutVideoDecoder: true });
    await page.evaluate(`document.getElementById("diagnostics-toggle").click()`);
    const connection = `document.getElementById("diagnostics-connection").textContent`;
    const transport = `document.getElementById("diagnostics-transport").textContent`;
    await page.until(`${transport} === "Screenshots" && ${connection} === "Live"`, "Pixel_A live on screenshots");

    await page.server.rebindDevice("Pixel_B");
    await waitUntil(() => (device.calls.streamsByDevice.Pixel_B ?? 0) > 0, { message: "a stream for Pixel_B", timeoutMs: 10_000 });
    await page.until(`${transport} === "Emulator gRPC video"`, "the new device's transport");
    // Hold across the panel's refreshes: nothing from Pixel_B has arrived yet.
    for (let i = 0; i < 3; i += 1) {
        assert.equal(await page.evaluate(connection), "Connecting", "no frame from the new device yet");
        assert.match(await page.evaluate(`document.getElementById("diagnostics-report").textContent`), /^Last frame: none yet$/m);
        await sleep(600);
    }

    releaseFrames();
    await page.until(`${connection} === "Live"`, "Live once the new device's first frame arrives");
    await page.until(painted, "Pixel_B's first frame");
});

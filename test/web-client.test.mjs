/**
 * Browser modules that can be exercised without a browser: the status tray and
 * the stream controller's capability handling. Node has no `window` and no
 * `VideoDecoder`, which is exactly the runtime the WebCodecs fallback is for.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { extensionModule, sleep, waitUntil } from "./helpers.mjs";

const { createBuildPanel, createNotice, describeBuild } = await extensionModule("web", "status-tray.js");
const { DECODER_UNAVAILABLE, chooseScreenSource, createH264StreamController, supportsVideoDecoder } =
    await extensionModule("web", "h264-stream.js");

function fakeElement() {
    const listeners = {};
    return {
        hidden: true,
        textContent: "",
        disabled: false,
        dataset: {},
        attributes: {},
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        addEventListener(type, handler) {
            (listeners[type] ??= []).push(handler);
        },
        click() {
            for (const handler of listeners.click ?? []) {
                handler({ preventDefault() {} });
            }
        },
    };
}

function panelElements() {
    return {
        root: fakeElement(),
        title: fakeElement(),
        detail: fakeElement(),
        cancel: fakeElement(),
        dismiss: fakeElement(),
        logDetails: fakeElement(),
        log: fakeElement(),
        logNote: fakeElement(),
    };
}

const running = {
    id: "run-1",
    state: "running",
    step: "build",
    message: "> Task :app:compileDebugKotlin",
    startedAt: "2026-01-01T00:00:00Z",
    cancellable: true,
    cancelRequested: false,
    logTotal: 2,
    log: ["Downloading 10%", "> Task :app:compileDebugKotlin"],
};

// --- build panel ---------------------------------------------------------------------

test("a running build shows progress, its log so far, and an enabled Cancel", () => {
    const elements = panelElements();
    const cancelled = [];
    const panel = createBuildPanel({ elements, onCancel: (runId) => cancelled.push(runId) });
    panel.bind();
    panel.render(running);

    assert.equal(elements.root.hidden, false);
    assert.equal(elements.root.dataset.tone, "running");
    assert.equal(elements.root.attributes["aria-busy"], "true");
    assert.equal(elements.title.textContent, "Building");
    assert.equal(elements.detail.textContent, "> Task :app:compileDebugKotlin");
    assert.equal(elements.log.textContent, "Downloading 10%\n> Task :app:compileDebugKotlin");
    assert.equal(elements.cancel.hidden, false);
    assert.equal(elements.cancel.disabled, false);
    assert.equal(elements.dismiss.hidden, true, "a running build cannot be dismissed");

    elements.cancel.click();
    assert.deepEqual(cancelled, ["run-1"], "cancel names the run it was shown for");
});

test("log text is rendered as text, never markup", () => {
    const elements = panelElements();
    const panel = createBuildPanel({ elements, onCancel() {} });
    panel.render({ ...running, message: "<img src=x onerror=alert(1)>", log: ["<script>alert(1)</script>"] });
    assert.equal(elements.detail.textContent, "<img src=x onerror=alert(1)>");
    assert.equal(elements.log.textContent, "<script>alert(1)</script>");
    assert.equal(elements.log.innerHTML, undefined, "the panel never touches innerHTML");
});

test("Cancel is withheld while cancelling, while launching, and under an agent lease", () => {
    const elements = panelElements();
    const panel = createBuildPanel({ elements, onCancel: () => assert.fail("must not cancel") });
    panel.bind();

    panel.render({ ...running, cancellable: false, cancelRequested: true });
    assert.equal(elements.title.textContent, "Cancelling build");
    assert.equal(elements.cancel.textContent, "Cancelling…");
    assert.equal(elements.cancel.disabled, true);
    elements.cancel.click();

    panel.render({ ...running, step: "launch", cancellable: false });
    assert.equal(elements.cancel.disabled, true);

    panel.render(running, { controlBlocked: true });
    assert.equal(elements.cancel.disabled, true);
    elements.cancel.click();
});

test("terminal states are distinct, dismissible, and a new run reappears after dismissal", () => {
    const elements = panelElements();
    const panel = createBuildPanel({ elements, onCancel() {} });
    panel.bind();

    for (const [state, tone, title] of [
        ["succeeded", "success", "Build finished"],
        ["failed", "error", "Build failed"],
        ["cancel_failed", "error", "Cancellation not confirmed"],
        ["cancelled", "cancelled", "Build cancelled"],
    ]) {
        panel.render({ ...running, state, cancellable: false, message: `${state} message` });
        assert.equal(elements.root.dataset.tone, tone);
        assert.equal(elements.title.textContent, title);
        assert.equal(elements.detail.textContent, `${state} message`);
        assert.equal(elements.cancel.hidden, true);
        assert.equal(elements.dismiss.hidden, false);
        assert.equal(elements.root.attributes["aria-busy"], "false");
    }

    elements.dismiss.click();
    assert.equal(elements.root.hidden, true);
    panel.render({ ...running, state: "cancelled", cancellable: false });
    assert.equal(elements.root.hidden, true, "the dismissed result stays dismissed across state pushes");
    panel.render({ ...running, id: "run-2" });
    assert.equal(elements.root.hidden, false, "the next build is shown");
});

test("a trimmed log says how much is shown, and no status hides the panel", () => {
    const view = describeBuild({ ...running, logTotal: 900, log: Array.from({ length: 400 }, (_, i) => `line ${i}`) });
    assert.equal(view.logNote, "Showing the last 400 of 900 lines");
    assert.equal(describeBuild(null).visible, false);
    const elements = panelElements();
    createBuildPanel({ elements, onCancel() {} }).render(null);
    assert.equal(elements.root.hidden, true);
});

// --- notices ---------------------------------------------------------------------------

test("information fades, errors stay and are announced assertively", () => {
    const elements = { root: fakeElement(), text: fakeElement(), dismiss: fakeElement() };
    const timers = [];
    const notice = createNotice({
        elements,
        setTimer: (fn) => {
            timers.push(fn);
            return timers.length;
        },
        clearTimer: () => {},
    });
    notice.bind();

    notice.show("Control returned to you.");
    assert.equal(elements.root.hidden, false);
    assert.equal(elements.root.attributes.role, "status");
    assert.equal(elements.root.attributes["aria-live"], "polite");
    assert.equal(timers.length, 1);
    timers[0]();
    assert.equal(elements.root.hidden, true);

    notice.show("Device busy", { error: true });
    assert.equal(elements.root.dataset.tone, "error");
    assert.equal(elements.root.attributes.role, "alert");
    assert.equal(elements.root.attributes["aria-live"], "assertive");
    assert.equal(timers.length, 1, "errors do not time out");
    elements.dismiss.click();
    assert.equal(elements.root.hidden, true);

    notice.show("   ");
    assert.equal(elements.root.hidden, true, "empty messages are ignored");
});

// --- stream capability ----------------------------------------------------------------

test("a runtime without VideoDecoder still tries the stream until video has proved undecodable", () => {
    assert.equal(supportsVideoDecoder(), false);
    assert.equal(chooseScreenSource({ hasVideoDecoder: false, decoderFailed: false, lastTransport: null }), "stream");
    assert.equal(chooseScreenSource({ hasVideoDecoder: false, decoderFailed: true, lastTransport: "mirror" }), "screenshots");
    assert.equal(chooseScreenSource({ hasVideoDecoder: false, decoderFailed: true, lastTransport: "grpc" }), "stream");
    assert.equal(chooseScreenSource({ hasVideoDecoder: true, decoderFailed: true, lastTransport: "mirror" }), "stream");
});

function framed(tag, payload) {
    const bytes = new Uint8Array(5 + payload.length);
    new DataView(bytes.buffer).setUint32(0, payload.length + 1);
    bytes[4] = tag;
    bytes.set(payload, 5);
    return bytes;
}

const originalFetch = globalThis.fetch;
const originalCreateImageBitmap = globalThis.createImageBitmap;
let fetchCalls;

/** Serves one canned stream: `frames` then either an end or a hang until aborted. */
function serveStream({ transport, frames, end = false, status = 200, body = null }) {
    globalThis.fetch = async (url, { signal } = {}) => {
        fetchCalls += 1;
        if (status !== 200) {
            return new Response(JSON.stringify(body ?? {}), { status, headers: { "Content-Type": "application/json" } });
        }
        const stream = new ReadableStream({
            start(controller) {
                for (const chunk of frames) {
                    controller.enqueue(chunk);
                }
                if (end) {
                    controller.close();
                    return;
                }
                signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
            },
        });
        return new Response(stream, { headers: transport ? { "X-Stream-Transport": transport } : {} });
    };
}

beforeEach(() => {
    fetchCalls = 0;
    globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.createImageBitmap = originalCreateImageBitmap;
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const avcC = new Uint8Array([0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00]);

test("gRPC stills paint without WebCodecs, and stopping is not an error", async () => {
    serveStream({ transport: "grpc", frames: [framed(0x04, png), framed(0x04, png)] });
    const painted = [];
    const errors = [];
    const controller = createH264StreamController({ onFrame: (bitmap) => painted.push(bitmap), onError: (error) => errors.push(error) });
    const started = controller.start({ url: "http://x/api/stream.h264", fps: 60 });
    await waitUntil(() => painted.length === 2, { message: "two stills" });
    assert.equal(controller.isStillStream(), true);
    controller.stop();
    await started;
    await sleep(20);
    assert.deepEqual(errors, []);
    assert.equal(fetchCalls, 1);
});

test("mirrored video without WebCodecs fails once, with a code the canvas can act on", async () => {
    serveStream({ transport: "mirror", frames: [framed(0x04, png), framed(0x01, avcC), framed(0x02, new Uint8Array([0, 0, 0, 1, 0x65]))] });
    const painted = [];
    const errors = [];
    const controller = createH264StreamController({ onFrame: (bitmap) => painted.push(bitmap), onError: (error) => errors.push(error) });
    await controller.start({ url: "http://x/api/stream.h264", fps: 60 });
    assert.equal(painted.length, 1, "the still before the video still paints");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, DECODER_UNAVAILABLE);
    assert.equal(controller.isStillStream(), false, "the failed stream is torn down");
});

test("a stream the host ends is reported, and an HTTP error carries the host's message", async () => {
    serveStream({ transport: "grpc", frames: [framed(0x04, png)], end: true });
    const errors = [];
    const controller = createH264StreamController({ onFrame() {}, onError: (error) => errors.push(error) });
    await controller.start({ url: "http://x/api/stream.h264", fps: 60 });
    assert.match(errors[0]?.message ?? "", /ended unexpectedly/);

    serveStream({ status: 502, body: { error: { code: "stream_failed", message: "adb went away" } } });
    const httpErrors = [];
    const second = createH264StreamController({ onFrame() {}, onError: (error) => httpErrors.push(error) });
    await second.start({ url: "http://x/api/stream.h264", fps: 60 });
    assert.equal(httpErrors[0]?.message, "adb went away");
});

/** A `createImageBitmap` whose first decode waits until released, reporting each still by its first byte. */
function gatedDecoder() {
    const decoded = [];
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    globalThis.createImageBitmap = async (blob) => {
        const label = new Uint8Array(await blob.arrayBuffer())[0];
        decoded.push(label);
        if (decoded.length === 1) {
            await gate;
        }
        return { label, width: 2, height: 2, close() {} };
    };
    return { decoded, release };
}

test("stills that arrive during a slow decode collapse to the newest", async () => {
    const { decoded, release } = gatedDecoder();
    serveStream({ transport: "grpc", frames: [1, 2, 3, 4].map((label) => framed(0x04, new Uint8Array([label]))) });
    const painted = [];
    const controller = createH264StreamController({ onFrame: (bitmap) => painted.push(bitmap.label), onError() {} });
    const started = controller.start({ url: "http://x/api/stream.h264", fps: 60 });

    await waitUntil(() => decoded.length === 1, { message: "the first decode" });
    await sleep(20);
    release();
    await waitUntil(() => painted.length === 2, { message: "the newest still" });
    await sleep(20);
    assert.deepEqual(painted, [1, 4], "stills 2 and 3 were superseded, not decoded");
    assert.deepEqual(decoded, [1, 4]);
    controller.stop();
    await started;
});

test("a still decoded after the stream stopped is not painted", async () => {
    const { decoded, release } = gatedDecoder();
    serveStream({ transport: "grpc", frames: [framed(0x04, new Uint8Array([7]))] });
    const painted = [];
    const errors = [];
    const controller = createH264StreamController({ onFrame: (bitmap) => painted.push(bitmap.label), onError: (error) => errors.push(error) });
    const started = controller.start({ url: "http://x/api/stream.h264", fps: 60 });

    await waitUntil(() => decoded.length === 1, { message: "the decode" });
    controller.stop();
    await started;
    release();
    await sleep(20);
    assert.deepEqual(painted, []);
    assert.deepEqual(errors, []);
});

test("keystrokes post in order, and keys typed during a request share the next one", async () => {
    const { createInputController } = await extensionModule("web", "input-controller.js");
    const originalDocument = globalThis.document;
    const originalElement = globalThis.Element;
    let keydown = null;
    globalThis.document = {
        addEventListener(type, handler) {
            if (type === "keydown") {
                keydown = handler;
            }
        },
    };
    globalThis.Element = class {};
    try {
        const posts = [];
        const pending = [];
        const notices = [];
        const fetchJson = (path, body) => {
            posts.push([path, body]);
            return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        };
        createInputController({
            elements: { screenWindow: fakeElement(), takeBack: fakeElement() },
            apiUrl: (path) => path,
            fetchJson,
            getState: () => ({ state: "Booted" }),
            isControlUnavailable: () => false,
            setNotice: (message, isError) => notices.push([message, isError]),
            setState() {},
            withPending: (task) => task(),
        }).bind();
        const press = (key, code = key) => {
            const event = { key, code, target: null, ctrlKey: false, metaKey: false, altKey: false, prevented: false };
            event.preventDefault = () => {
                event.prevented = true;
            };
            keydown(event);
            return event;
        };

        for (const key of "hello") {
            assert.equal(press(key, `Key${key.toUpperCase()}`).prevented, true);
        }
        press("Enter");
        press("!", "Digit1");
        assert.deepEqual(posts, [["api/input/text", { text: "h" }]], "one request at a time");

        pending[0].resolve({});
        await waitUntil(() => posts.length === 2, { message: "the joined text" });
        assert.deepEqual(posts[1], ["api/input/text", { text: "ello" }]);
        pending[1].reject(new Error("device busy"));
        await waitUntil(() => posts.length === 3, { message: "the key after a failure" });
        assert.deepEqual(posts[2], ["api/input/key", { code: "Enter" }], "a failure does not stall the queue");
        pending[2].resolve({});
        await waitUntil(() => posts.length === 4, { message: "the text after the key" });
        assert.deepEqual(posts[3], ["api/input/text", { text: "!" }]);
        pending[3].resolve({});
        await sleep(10);
        assert.deepEqual(notices, [["device busy", true]]);
    } finally {
        globalThis.document = originalDocument;
        globalThis.Element = originalElement;
    }
});

// --- connection diagnostics ----------------------------------------------------------

const { buildDiagnosticReport, classifyGrpcFailure, createConnectionDiagnostics, describeConnection } =
    await extensionModule("web", "connection-diagnostics.js");

const liveGrpc = {
    screenSource: "video",
    transport: "grpc",
    transportReason: null,
    hasVideoDecoder: true,
    deviceKind: "emulator",
    deviceState: "Booted",
    events: "open",
    eventErrors: 0,
    streamReconnects: 0,
    measuredFps: 29.94,
    lastFrameAt: Date.parse("2026-01-01T00:00:09Z"),
    requestedFps: 30,
    resolution: 100,
    androidVersion: "15",
    apiLevel: 35,
};

// Realistic identifiers: an adb serial, an AVD name, a physical serial, URL
// credentials on localhost, a token, a home path and an email address.
const sensitiveReason =
    "emulator-5554 Pixel_8_API_34 R58N47XC8HP: gRPC connect to http://admin:hunter2@localhost:8554/v1 failed " +
    "token=abc123secret /Users/alice/.android/avd/Pixel_8_API_34.avd C:\\Users\\alice\\AppData alice@example.com";

const LEAKS = [
    "emulator-5554",
    "5554",
    "Pixel_8",
    "API_34",
    "R58N47XC8HP",
    "admin",
    "hunter2",
    "localhost",
    "8554",
    "abc123secret",
    "alice",
    "AppData",
    "example.com",
];

function assertNoLeaks(text) {
    for (const leak of LEAKS) {
        assert.ok(!text.includes(leak), `leaked ${leak} in:\n${text}`);
    }
}

test("host gRPC failures are classified into fixed labels; anything else is omitted", () => {
    const cases = [
        ["This emulator has no gRPC control connection.", "this emulator has no gRPC endpoint"],
        ["EmulatorController/streamScreenshot was cancelled.", "the stream was cancelled"],
        ["EmulatorController/getStatus failed with HTTP 401.", "authentication was rejected"],
        ["EmulatorController/getStatus failed with HTTP 503.", "the emulator returned an HTTP error"],
        ["EmulatorController/getStatus failed: connect ECONNREFUSED 127.0.0.1:8554", "the connection failed"],
        ["The emulator stopped responding: no frame for 5000 ms", "the emulator stopped responding"],
        ["EmulatorController/getStatus returned no message.", "the emulator returned no data"],
        [sensitiveReason, "the connection failed"],
        ["emulator-5554 Pixel_8_API_34 R58N47XC8HP", "unrecognised error (details omitted)"],
        ["http://admin:hunter2@localhost:8554", "unrecognised error (details omitted)"],
        ["something entirely new", "unrecognised error (details omitted)"],
    ];
    for (const [reason, label] of cases) {
        assert.equal(classifyGrpcFailure(reason), label, reason);
        assertNoLeaks(classifyGrpcFailure(reason));
    }
    assert.equal(classifyGrpcFailure(null), "");
    assert.equal(classifyGrpcFailure("   "), "");
});

test("describeConnection names the transport, the connection state and why video fell back", () => {
    const grpc = describeConnection(liveGrpc);
    assert.equal(grpc.transportLabel, "Emulator gRPC video");
    assert.equal(grpc.connectionLabel, "Live");
    assert.equal(grpc.fallbackReason, "");
    assert.equal(grpc.degraded, false);
    assert.equal(grpc.fps, 29.9);
    assert.equal(grpc.summary, "Emulator gRPC video · Live");

    const mirror = describeConnection({ ...liveGrpc, transport: "mirror", transportReason: sensitiveReason });
    assert.equal(mirror.transportLabel, "Screen mirror video");
    assert.equal(mirror.degraded, true);
    assert.equal(mirror.fallbackReason, "gRPC unavailable: the connection failed");

    const unknown = describeConnection({ ...liveGrpc, transport: "mirror", transportReason: "emulator-5554 Pixel_8_API_34" });
    assert.equal(unknown.fallbackReason, "gRPC unavailable: unrecognised error (details omitted)");

    // A physical device always mirrors; that is not a fallback.
    const phone = describeConnection({ ...liveGrpc, transport: "mirror", deviceKind: "physical" });
    assert.equal(phone.fallbackReason, "");
    assert.equal(phone.degraded, false);

    const stills = describeConnection({ ...liveGrpc, screenSource: "screenshots", hasVideoDecoder: false });
    assert.equal(stills.transportLabel, "Screenshots");
    assert.equal(stills.fallbackReason, "This canvas cannot decode video");
    assert.equal(stills.fps, null);

    const stalled = describeConnection({ ...liveGrpc, screenSource: "screenshots", clientFallbackReason: "stalled" });
    assert.equal(stalled.fallbackReason, "Video stalled");
    // A raw message (an old client, or a code this module does not know) is never shown.
    const raw = describeConnection({
        ...liveGrpc,
        screenSource: "screenshots",
        clientFallbackReason: "Device stream failed (emulator-5554 R58N47XC8HP)",
    });
    assert.equal(raw.fallbackReason, "Video unavailable");

    assert.equal(describeConnection({ ...liveGrpc, events: "reconnecting" }).connectionLabel, "Reconnecting");
    const offline = describeConnection({ ...liveGrpc, events: "closed" });
    assert.equal(offline.connectionLabel, "Offline");
    assert.equal(offline.degraded, true);
    assert.equal(describeConnection({ ...liveGrpc, screenError: "boom" }).connection, "error");
    assert.equal(describeConnection({ ...liveGrpc, deviceState: "Shutdown" }).connectionLabel, "Device not running");
    const fresh = describeConnection({});
    assert.equal(fresh.transportLabel, "Not connected yet");
    assert.equal(fresh.connectionLabel, "Connecting");
});

test("the copyable report is an allowlist: useful facts, no serials, names, paths or tokens", () => {
    const report = buildDiagnosticReport(
        {
            ...liveGrpc,
            transport: "mirror",
            transportReason: sensitiveReason,
            serial: "emulator-5554",
            name: "Pixel_8",
            avdPath: "/Users/alice/.android/avd/Pixel_8.avd",
            token: "abc123secret",
            screenError: `Failed reading ${sensitiveReason}`,
            deviceState: "Booted",
            deviceKind: "emulator",
            androidVersion: "15 (emulator-5554)",
            futureField: sensitiveReason,
            eventErrors: 2,
            streamReconnects: 3,
        },
        { now: new Date("2026-01-01T00:00:10Z") },
    );
    const lines = report.split("\n");
    assert.equal(lines[0], "Android Emulator canvas diagnostics");
    assert.ok(lines.includes("Transport: Screen mirror video"));
    assert.ok(lines.includes("Connection: Error"));
    assert.ok(lines.includes("Requested: 30 fps at 100% resolution"));
    assert.ok(lines.includes("Measured: 29.9 fps"));
    assert.ok(lines.includes("Last frame: 1 s ago"));
    assert.ok(lines.includes("Event stream: open (2 errors)"));
    assert.ok(lines.includes("Stream reconnects: 3"));
    assert.ok(lines.includes("Android: unknown (API 35)"), "a malformed version is dropped, not copied");
    assert.ok(lines.includes("Fallback reason: gRPC unavailable: the connection failed"));
    assert.ok(lines.includes("Screen error: shown (details omitted)"));
    assert.ok(lines.includes("Host transport: mirror"));
    assertNoLeaks(report);

    const odd = buildDiagnosticReport({ ...liveGrpc, deviceState: "Pixel_8_API_34", deviceKind: "R58N47XC8HP", events: "emulator-5554", transport: "x" });
    assert.ok(odd.includes("Device state: other"));
    assert.ok(odd.includes("Device kind: other"));
    assert.ok(odd.includes("Event stream: other"));
    assert.ok(odd.includes("Host transport: other"));
    assert.ok(buildDiagnosticReport({ ...liveGrpc, androidVersion: "15" }).includes("Android: 15 (API 35)"));
    assertNoLeaks(odd);
});

function diagnosticsElements() {
    const elements = Object.fromEntries(
        ["toggle", "toggleLabel", "panel", "close", "copy", "copyStatus", "report", "reportDetails", "transport", "connection", "reason", "reconnects", "fps"].map(
            (key) => [key, fakeElement()],
        ),
    );
    elements.panel.id = "diagnostics-panel";
    let focused = 0;
    elements.toggle.focus = () => {
        focused += 1;
    };
    elements.focusCount = () => focused;
    return elements;
}

test("the diagnostics toggle is an accessible disclosure that summarises the connection", () => {
    const elements = diagnosticsElements();
    let snapshot = { ...liveGrpc, transport: "mirror", transportReason: "connection refused" };
    const diagnostics = createConnectionDiagnostics({ elements, getSnapshot: () => snapshot, clipboard: null });
    diagnostics.bind();

    assert.equal(elements.toggle.attributes["aria-controls"], "diagnostics-panel");
    assert.equal(elements.toggle.attributes["aria-expanded"], "false");
    assert.equal(elements.toggle.attributes["aria-label"], "Connection diagnostics: Screen mirror video · Live");
    assert.equal(elements.toggleLabel.textContent, "Screen mirror video");
    assert.equal(elements.toggle.dataset.degraded, "true");
    assert.match(elements.toggle.title, /gRPC unavailable: the connection failed/);
    assert.equal(elements.transport.textContent, "", "a closed panel is not rendered");

    elements.toggle.click();
    assert.equal(elements.panel.hidden, false);
    assert.equal(elements.toggle.attributes["aria-expanded"], "true");
    assert.equal(elements.transport.textContent, "Screen mirror video");
    assert.equal(elements.connection.textContent, "Live");
    assert.equal(elements.reason.textContent, "gRPC unavailable: the connection failed");
    assert.equal(elements.fps.textContent, "29.9 fps");
    assert.equal(elements.reconnects.textContent, "0");
    assert.match(elements.report.textContent, /^Android Emulator canvas diagnostics/);

    snapshot = { ...liveGrpc, events: "reconnecting", streamReconnects: 1 };
    diagnostics.render();
    assert.equal(elements.reason.textContent, "None");
    assert.equal(elements.connection.textContent, "Reconnecting");
    assert.equal(elements.reconnects.textContent, "1");
    assert.equal(elements.toggle.dataset.connection, "reconnecting");

    elements.close.click();
    assert.equal(elements.panel.hidden, true);
    assert.equal(elements.toggle.attributes["aria-expanded"], "false");
    assert.equal(elements.focusCount(), 1, "closing returns focus to the toggle");
});

test("copying writes the allowlisted report, and a blocked or missing clipboard selects it instead", async () => {
    const snapshot = { ...liveGrpc, transport: "mirror", transportReason: sensitiveReason };
    const now = () => new Date("2026-01-01T00:00:10Z");

    const written = [];
    const okElements = diagnosticsElements();
    const ok = createConnectionDiagnostics({
        elements: okElements,
        getSnapshot: () => snapshot,
        clipboard: { writeText: async (text) => void written.push(text) },
        selectText: () => assert.fail("a successful copy needs no manual selection"),
        now,
    });
    assert.equal(await ok.copyReport(), true);
    assert.equal(written.length, 1);
    assert.equal(written[0], buildDiagnosticReport(snapshot, { now: now() }));
    assertNoLeaks(written[0]);
    assert.equal(okElements.copyStatus.textContent, "Diagnostic report copied.");
    assert.equal(okElements.copyStatus.dataset.tone, "info");

    const selected = [];
    const blockedElements = diagnosticsElements();
    const blocked = createConnectionDiagnostics({
        elements: blockedElements,
        getSnapshot: () => snapshot,
        clipboard: { writeText: async () => Promise.reject(new Error("NotAllowedError")) },
        selectText: (element) => selected.push(element),
        now,
    });
    assert.equal(await blocked.copyReport(), false);
    assert.deepEqual(selected, [blockedElements.report]);
    assert.equal(blockedElements.reportDetails.open, true, "the preview opens so the selection is visible");
    assert.equal(blockedElements.copyStatus.textContent, "Copy was blocked. The report is selected; copy it manually.");
    assert.equal(blockedElements.copyStatus.dataset.tone, "error");
    assertNoLeaks(blockedElements.report.textContent);

    const noneElements = diagnosticsElements();
    const none = createConnectionDiagnostics({
        elements: noneElements,
        getSnapshot: () => snapshot,
        clipboard: null,
        selectText: (element) => selected.push(element),
        now,
    });
    assert.equal(await none.copyReport(), false);
    assert.equal(selected.at(-1), noneElements.report);
    assert.equal(noneElements.copyStatus.textContent, "Clipboard unavailable. The report is selected; copy it manually.");
});

test("a report waiting to be copied by hand survives the panel refresh until the next copy or close", async () => {
    let clock = Date.parse("2026-01-01T00:00:10Z");
    const now = () => new Date(clock);
    const elements = diagnosticsElements();
    let selections = 0;
    let clipboard = { writeText: async () => Promise.reject(new Error("NotAllowedError")) };
    const diagnostics = createConnectionDiagnostics({
        elements,
        getSnapshot: () => liveGrpc,
        clipboard: { writeText: (text) => clipboard.writeText(text) },
        selectText: () => {
            selections += 1;
        },
        now,
    });
    diagnostics.bind();
    diagnostics.setOpen(true);
    assert.equal(await diagnostics.copyReport(), false);
    const pinned = elements.report.textContent;
    assert.equal(diagnostics.reportPinned, true);

    clock += 5_000;
    diagnostics.render();
    assert.equal(elements.report.textContent, pinned, "a refresh must not replace the selected text");

    clipboard = { writeText: async () => {} };
    assert.equal(await diagnostics.copyReport(), true);
    assert.equal(diagnostics.reportPinned, false);
    assert.notEqual(elements.report.textContent, pinned);

    clipboard = { writeText: async () => Promise.reject(new Error("NotAllowedError")) };
    await diagnostics.copyReport();
    diagnostics.setOpen(false);
    assert.equal(diagnostics.reportPinned, false, "closing the panel releases the pin");
    clock += 5_000;
    diagnostics.setOpen(true);
    assert.match(elements.report.textContent, /Generated: 2026-01-01T00:00:20/);
    assert.equal(selections, 2);
});

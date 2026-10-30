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

// --- connection diagnostics ----------------------------------------------------------

const { buildDiagnosticReport, createConnectionDiagnostics, describeConnection, redactDiagnosticText } =
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

const sensitiveReason =
    "gRPC connect failed: /Users/alice/.android/avd/Pixel_8.avd/grpc.token token=abc123secret " +
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln https://host.local:8554/v1?key=zzz " +
    "C:\\Users\\alice\\AppData\\emu.log alice@example.com serial 0123456789abcdef0123";

const LEAKS = [
    "/Users/alice",
    "alice",
    "abc123secret",
    "eyJhbGciOiJIUzI1NiJ9",
    "key=zzz",
    "/v1",
    "AppData",
    "example.com",
    "0123456789abcdef0123",
    "Pixel_8",
    "emulator-5554",
];

function assertNoLeaks(text) {
    for (const leak of LEAKS) {
        assert.ok(!text.includes(leak), `leaked ${leak} in:\n${text}`);
    }
}

test("redaction strips tokens, credentials, paths, query strings, emails and long ids", () => {
    const text = redactDiagnosticText(sensitiveReason, { maxLength: 1_000 });
    assertNoLeaks(text);
    assert.match(text, /\[path\]/);
    assert.match(text, /token=\[redacted\]/);
    assert.match(text, /\[token\]/);
    assert.match(text, /https:\/\/host\.local:8554/);
    assert.match(text, /\[email\]/);
    assert.match(text, /\[id\]/);
    assert.match(redactDiagnosticText("open file:///home/bob/x.png and ~/secret/notes"), /^open \[path\] and \[path\]$/);
    assert.equal(redactDiagnosticText(null), "");
    assert.equal(redactDiagnosticText("line one\nline two\u0000"), "line one line two");
    const long = redactDiagnosticText("x ".repeat(200));
    assert.ok(long.length <= 160 && long.endsWith("…"));
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
    assert.match(mirror.fallbackReason, /^gRPC unavailable: gRPC connect failed:/);
    assertNoLeaks(mirror.fallbackReason);

    // A physical device always mirrors; that is not a fallback.
    const phone = describeConnection({ ...liveGrpc, transport: "mirror", deviceKind: "physical" });
    assert.equal(phone.fallbackReason, "");
    assert.equal(phone.degraded, false);

    const stills = describeConnection({ ...liveGrpc, screenSource: "screenshots", hasVideoDecoder: false });
    assert.equal(stills.transportLabel, "Screenshots");
    assert.equal(stills.fallbackReason, "This canvas cannot decode video");
    assert.equal(stills.fps, null);

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
    assert.ok(lines.includes("Android: 15 (API 35)"));
    assert.match(report, /^Fallback reason: gRPC unavailable: /m);
    assertNoLeaks(report);
});

function diagnosticsElements() {
    const elements = Object.fromEntries(
        ["toggle", "toggleLabel", "panel", "close", "copy", "copyStatus", "report", "transport", "connection", "reason", "reconnects", "fps"].map(
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
    assert.match(elements.toggle.title, /gRPC unavailable: connection refused/);
    assert.equal(elements.transport.textContent, "", "a closed panel is not rendered");

    elements.toggle.click();
    assert.equal(elements.panel.hidden, false);
    assert.equal(elements.toggle.attributes["aria-expanded"], "true");
    assert.equal(elements.transport.textContent, "Screen mirror video");
    assert.equal(elements.connection.textContent, "Live");
    assert.equal(elements.reason.textContent, "gRPC unavailable: connection refused");
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

test("copying writes the redacted report, and a blocked or missing clipboard selects it instead", async () => {
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

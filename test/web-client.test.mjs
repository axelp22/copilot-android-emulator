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

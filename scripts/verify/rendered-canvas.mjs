/**
 * Loads the canvas in a real Chrome instance so the web client, WebCodecs decoding
 * and pointer input are exercised for real. Pass the URL returned by `open_canvas`:
 *
 *   node scripts/verify/rendered-canvas.mjs "http://127.0.0.1:PORT/TOKEN/"
 *
 * If the agent currently holds a control lease, the lease overlay and the
 * "Take back control" affordance are verified too; otherwise those checks skip.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import { adb, config, createReporter, sleep } from "./_shared.mjs";

const canvasUrl = process.argv[2];
if (!canvasUrl) {
    console.error("usage: node scripts/verify/rendered-canvas.mjs <canvas url>");
    process.exit(2);
}

const report = createReporter("RENDERED CANVAS");
const port = 9400 + Math.floor(Math.random() * 300);

async function screenHash() {
    const png = await adb(["exec-out", "screencap", "-p"], { buffer: true });
    return crypto.createHash("sha256").update(png ?? Buffer.alloc(0)).digest("hex").slice(0, 16);
}

/**
 * Polls until the device screen differs from `baseline`. A fixed sleep is
 * unreliable: under load the emulator can take seconds to render a gesture.
 */
async function waitForScreenChange(baseline, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    let latest = baseline;
    while (Date.now() < deadline) {
        await sleep(600);
        latest = await screenHash();
        if (latest !== baseline) {
            return latest;
        }
    }
    return latest;
}

const chrome = spawn(
    config.chrome,
    [
        "--headless=new",
        `--remote-debugging-port=${port}`,
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=/tmp/android-emulator-verify-chrome-${port}`,
        "--window-size=900,1200",
        "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
);
chrome.stderr.on("data", () => {});

let version = null;
for (let attempt = 0; attempt < 40 && !version; attempt += 1) {
    try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
        await sleep(250);
    }
}
if (!version) {
    report.skip("rendered canvas", "Chrome could not be started");
    chrome.kill("SIGTERM");
    report.finish();
}
process.on("exit", () => chrome.kill("SIGKILL"));
report.note(version["Browser"]);

const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(canvasUrl)}`, { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
});
function send(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function shutdownBrowser() {
    // Browser.close exits every renderer; killing the launcher alone orphans them.
    try {
        await send("Browser.close");
    } catch {
        // The browser may already be gone.
    }
    socket.close();
    chrome.kill("SIGTERM");
    await sleep(300);
}

async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
    }
    return result.result.value;
}
async function drag(x, fromY, toY, steps = 10) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y: fromY, button: "left", clickCount: 1, buttons: 1 });
    for (let step = 1; step <= steps; step += 1) {
        await send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x,
            y: Math.round(fromY + ((toY - fromY) * step) / steps),
            button: "left",
            buttons: 1,
        });
        await sleep(45);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: toY, button: "left", clickCount: 1, buttons: 0 });
}
async function clickElement(selector) {
    const box = await evaluate(`(() => {
        const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
    })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.cx, y: box.cy, button: "left", clickCount: 1, buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.cx, y: box.cy, button: "left", clickCount: 1, buttons: 0 });
}

await send("Page.enable");
await send("Runtime.enable");

// The tab is created asynchronously, so wait for the shell before touching the DOM.
let domReady = false;
for (let attempt = 0; attempt < 60 && !domReady; attempt += 1) {
    domReady = await evaluate(`Boolean(document.querySelector(".screen-window"))`).catch(() => false);
    if (!domReady) {
        await sleep(250);
    }
}
if (!domReady) {
    report.skip("rendered canvas", "the canvas page never rendered; is the URL still live?");
    await shutdownBrowser();
    report.finish();
}

await evaluate(`(() => {
    window.__pointerLog = [];
    const surface = document.querySelector(".screen-window");
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
        surface.addEventListener(type, () => window.__pointerLog.push(type), true);
    }
    return true;
})()`);

// Make sure the device is awake and unlocked, or every visual check is meaningless.
await adb(["shell", "input", "keyevent", "224"]).catch(() => {});
await adb(["shell", "wm", "dismiss-keyguard"]).catch(() => {});
await adb(["shell", "input", "keyevent", "3"]).catch(() => {});

// Let the page connect SSE, open the stream and decode real frames.
await sleep(9000);

const view = await evaluate(`(() => {
    const canvas = document.getElementById("h264-screen");
    const surface = document.querySelector(".screen-window");
    const seen = new Set();
    let nonBlack = 0;
    if (canvas.width > 0 && canvas.height > 0) {
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < data.length; i += 4 * 997) {
            const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            seen.add(key);
            if (key !== 0) nonBlack += 1;
        }
    }
    return {
        hasVideoDecoder: "VideoDecoder" in window,
        deviceName: document.getElementById("device-name").textContent,
        status: document.getElementById("screen-status").textContent,
        hasFrame: surface.classList.contains("has-frame"),
        h264Active: surface.classList.contains("h264-active"),
        canvasSize: canvas.width + "x" + canvas.height,
        distinctColours: seen.size,
        nonBlackSamples: nonBlack,
        errorShown: document.getElementById("screen-message").classList.contains("error"),
        errorText: document.getElementById("error-details").textContent,
        toolbar: [...document.querySelectorAll(".floating-toolbar .icon-button")].map((b) => b.dataset.action).join(","),
        leaseActive: !document.getElementById("overlay").classList.contains("hidden"),
    };
})()`);
report.note(JSON.stringify(view));

report.assert(view.hasVideoDecoder, "browser exposes WebCodecs VideoDecoder");
report.assert(!view.errorShown, "no error surface shown", view.errorText || "(none)");
report.assert(view.h264Active, "canvas switched to the H.264 layer");
report.assert(view.canvasSize !== "0x0" && view.canvasSize !== "300x150", "video canvas sized from decoded frames", view.canvasSize);
report.assert(view.hasFrame, "a decoded frame was drawn");
report.assert(view.distinctColours > 20, "decoded frame has real image content", `${view.distinctColours} colours sampled`);
report.assert(view.nonBlackSamples > 50, "frame is not a black screen", `${view.nonBlackSamples} non-black samples`);
report.assert(view.status === "Device display ready", "status reports display ready", view.status);
report.assert(
    view.toolbar === "back,home,recents,rotate-right,volume-up,volume-down,power,shutdown",
    "Android toolbar rendered",
    view.toolbar,
);

const signature = () =>
    evaluate(`(() => {
        const c = document.getElementById("h264-screen");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4 * 331) sum += d[i] + d[i + 1] + d[i + 2];
        return sum;
    })()`);

// Sample repeatedly while forcing a deterministic visual change: alternating
// between the launcher and the app drawer guarantees a large difference, whereas
// a single swipe can settle back to an identical-looking screen.
const signatures = new Set([await signature()]);
const livenessDeadline = Date.now() + 20_000;
let toggle = 0;
while (Date.now() < livenessDeadline && signatures.size < 2) {
    await adb(["shell", "input", "keyevent", toggle % 2 === 0 ? "3" : "187"]).catch(() => {});
    toggle += 1;
    for (let poll = 0; poll < 6 && signatures.size < 2; poll += 1) {
        await sleep(500);
        signatures.add(await signature());
    }
}
report.assert(signatures.size > 1, "video is live rather than a frozen seed frame", `${signatures.size} distinct frames sampled`);

const geometry = await evaluate(`(() => {
    const r = document.querySelector(".screen-window").getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2), top: r.top, h: r.height };
})()`);
const dragX = geometry.cx;
const dragFrom = Math.round(geometry.top + geometry.h * 0.9);
const dragTo = Math.round(geometry.top + geometry.h * 0.2);

if (view.leaseActive) {
    // The agent holds control: manual input must be refused and the overlay shown.
    const overlay = await evaluate(`(() => ({
        reason: document.getElementById("overlay-reason").textContent,
        expiry: document.getElementById("overlay-expiry").textContent,
        busy: document.getElementById("viewport").getAttribute("aria-busy"),
        disabled: [...document.querySelectorAll(".floating-toolbar .icon-button")].filter((b) => b.disabled).length,
        pickerDisabled: document.getElementById("device-picker-button").disabled,
    }))()`);
    report.assert(/\d+s remaining/.test(overlay.expiry), "overlay shows the lease countdown", overlay.expiry);
    report.assert(overlay.busy === "true", "viewport marked aria-busy under lease");
    report.assert(overlay.disabled === 8, "toolbar disabled under lease", `${overlay.disabled}/8`);
    report.assert(overlay.pickerDisabled === true, "device picker disabled under lease");

    const before = await screenHash();
    await drag(dragX, dragFrom, dragTo, 6);
    await sleep(4000);
    report.assert(before === (await screenHash()), "manual input ignored while the agent holds the lease");

    await clickElement("#take-back");
    await sleep(2500);
    const released = await evaluate(`(() => ({
        hidden: document.getElementById("overlay").classList.contains("hidden"),
        disabled: [...document.querySelectorAll(".floating-toolbar .icon-button")].filter((b) => b.disabled).length,
    }))()`);
    report.assert(released.hidden === true, "overlay hidden after taking back control");
    report.assert(released.disabled === 0, "toolbar re-enabled after taking back control");
} else {
    report.skip("lease overlay checks", "no agent lease is currently held");
}

// Manual pointer input through the rendered UI. Start from the launcher so the
// gesture has a visible effect.
await adb(["shell", "input", "keyevent", "3"]);
await sleep(2500);
const atHome = await screenHash();
await evaluate("window.__pointerLog = []");
await drag(dragX, dragFrom, dragTo);
const afterDrag = await waitForScreenChange(atHome);
const pointerLog = await evaluate("window.__pointerLog.join(',')");
report.assert(pointerLog.includes("pointerdown") && pointerLog.includes("pointerup"), "canvas received real pointer events");
report.assert(atHome !== afterDrag, "manual drag changed the device screen", `${atHome} -> ${afterDrag}`);

await clickElement('[data-action="home"]');
const afterHome = await waitForScreenChange(afterDrag);
report.assert(afterDrag !== afterHome, "toolbar Home button changed the device screen", `${afterDrag} -> ${afterHome}`);

const shot = await send("Page.captureScreenshot", { format: "png" });
const shotPath = "/tmp/android-emulator-verify-canvas.png";
await writeFile(shotPath, Buffer.from(shot.data, "base64"));
report.note(`screenshot written to ${shotPath}`);

await shutdownBrowser();
report.finish();

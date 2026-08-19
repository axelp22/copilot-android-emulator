import { renderIcon } from "./icons.js";
import { applyDeviceMetrics, fitDeviceFrame } from "./device-frame.js";
import { createApiClient } from "./api-client.js";
import { createDevicePicker } from "./device-picker.js";
import { createH264StreamController, supportsVideoDecoder } from "./h264-stream.js";
import { createInputController } from "./input-controller.js";

const elements = {
    deviceName: document.getElementById("device-name"),
    devicePicker: document.getElementById("device-picker"),
    devicePickerButton: document.getElementById("device-picker-button"),
    devicePickerMenu: document.getElementById("device-picker-menu"),
    devicePickerContent: document.getElementById("device-picker-content"),
    viewport: document.getElementById("viewport"),
    phoneFrame: document.getElementById("phone-frame"),
    screen: document.getElementById("screen"),
    screenWindow: document.getElementById("screen").closest(".screen-window"),
    h264Screen: document.getElementById("h264-screen"),
    screenMessage: document.getElementById("screen-message"),
    screenStatus: document.getElementById("screen-status"),
    poweredOffTitle: document.getElementById("powered-off-title"),
    poweredOffHint: document.getElementById("powered-off-hint"),
    bootDevice: document.getElementById("boot-device"),
    retryError: document.getElementById("retry-error"),
    errorDetails: document.getElementById("error-details"),
    streamFps: document.getElementById("stream-fps"),
    streamResolution: document.getElementById("stream-resolution"),
    overlay: document.getElementById("overlay"),
    overlayReason: document.getElementById("overlay-reason"),
    overlayOperation: document.getElementById("overlay-operation"),
    overlayExpiry: document.getElementById("overlay-expiry"),
    takeBack: document.getElementById("take-back"),
};

const toolbarButtons = {
    back: document.querySelector('[data-action="back"]'),
    home: document.querySelector('[data-action="home"]'),
    recents: document.querySelector('[data-action="recents"]'),
    rotateRight: document.querySelector('[data-action="rotate-right"]'),
    volumeUp: document.querySelector('[data-action="volume-up"]'),
    volumeDown: document.querySelector('[data-action="volume-down"]'),
    power: document.querySelector('[data-action="power"]'),
    shutdown: document.querySelector('[data-action="shutdown"]'),
};

const buttonActions = {
    back: "back",
    home: "home",
    recents: "recents",
    "volume-up": "volume_up",
    "volume-down": "volume_down",
    power: "power",
};

const { fetchJson, url: apiUrl } = createApiClient(window.location.href);
const bootstrapParams = new URLSearchParams(window.location.search);
const bootstrapMetrics = {
    family: bootstrapParams.get("family") ?? "phone",
    screen: {
        width: Number(bootstrapParams.get("width")) || undefined,
        height: Number(bootstrapParams.get("height")) || undefined,
    },
};
const noImageDataUrl = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const frameElements = { viewport: elements.viewport, phoneFrame: elements.phoneFrame };
const useVideoDecoder = supportsVideoDecoder();
const PNG_FALLBACK_INTERVAL_MS = 600;
/** If nothing has painted by now, stop waiting on WebCodecs and poll screenshots. */
const H264_WATCHDOG_MS = 10_000;

let state = null;
let pending = false;
let streamRevision = 0;
let activeStreamKey = "";
let eventSource = null;
let screenError = null;
let pngFallbackTimer = null;
let h264Watchdog = null;

function agentControlUnavailable(currentState = state) {
    return currentState?.lease?.active === true || currentState?.controlPending === true;
}

function hydrateIcons() {
    for (const button of document.querySelectorAll("[data-icon]")) {
        button.innerHTML = renderIcon(button.dataset.icon);
    }
}

function setNotice(message, isError = false) {
    if (isError) {
        showScreenError(message);
    }
}

function setScreenMode(mode) {
    elements.screenWindow.classList.toggle("h264-active", mode === "h264");
    if (mode !== "h264") {
        const context = elements.h264Screen.getContext("2d");
        context?.clearRect(0, 0, elements.h264Screen.width, elements.h264Screen.height);
    }
}

function setScreenStatus(message, { error = false, poweredOff = false, stateName = "" } = {}) {
    elements.screenStatus.textContent = message;
    elements.screenMessage.classList.toggle("error", error);
    elements.screenMessage.classList.toggle("powered-off", poweredOff);
    elements.screenMessage.dataset.state = stateName;
}

function showScreenError(details) {
    screenError = String(details || "Unknown device error.");
    h264Stream.stop();
    stopPngFallback();
    stopH264Watchdog();
    elements.screen.src = noImageDataUrl;
    elements.screen.classList.remove("has-frame");
    elements.screenWindow.classList.remove("has-frame");
    elements.errorDetails.textContent = screenError;
    elements.errorDetails.closest("details").open = false;
    setScreenStatus("Device error. Retry or show details.", { error: true, stateName: "error" });
}

function clearScreenError() {
    screenError = null;
    elements.errorDetails.textContent = "";
    elements.errorDetails.closest("details").open = false;
    elements.screenMessage.classList.remove("error");
}

async function retryScreenError() {
    if (pending) {
        return;
    }
    pending = true;
    elements.retryError.disabled = true;
    try {
        await loadState();
        await devicePicker.refresh();
        clearScreenError();
        setScreenStatus("Retrying");
        reconnectStream();
    } finally {
        pending = false;
        elements.retryError.disabled = false;
        render();
    }
}

function inactiveScreenStatus() {
    if (state?.state === "Booting") {
        return "Emulator is starting";
    }
    if (state?.state === "Unassigned") {
        return "No device selected";
    }
    if (state?.state === "Unauthorized") {
        return "Device is unauthorized";
    }
    if (state?.state === "Offline") {
        return "Device is offline";
    }
    return "Emulator is not running";
}

function poweredOffCopy() {
    if (state?.state === "ShuttingDown") {
        return { title: "Stopping…", hint: "" };
    }
    if (state?.state === "Unassigned") {
        return { title: "Pick a device", hint: "" };
    }
    if (state?.state === "Unauthorized") {
        return { title: "Device unauthorized", hint: "Accept the USB debugging prompt on the device." };
    }
    if (state?.kind === "device") {
        return { title: "Device disconnected", hint: "Reconnect the device over USB or Wi-Fi debugging." };
    }
    return { title: "Emulator not running", hint: "" };
}

function leaseRemainingLabel(lease) {
    if (!lease?.active) {
        return "";
    }
    const remainingMs = Math.max(0, new Date(lease.expiresAt).getTime() - Date.now());
    return `${Math.ceil(remainingMs / 1000)}s remaining`;
}

function render() {
    if (!state) {
        return;
    }

    const leaseActive = state.lease?.active === true;
    const controlUnavailable = leaseActive || state.controlPending === true;
    const booted = state.state === "Booted";
    const booting = state.state === "Booting";
    const unassigned = state.state === "Unassigned";
    const manageable = state.canManageLifecycle === true;

    elements.deviceName.textContent = unassigned ? "Pick device" : (state.name ?? state.deviceId ?? "Unknown device");
    document.title = unassigned ? "Android Emulator" : (state.name ?? "Android Emulator");
    elements.devicePickerButton.dataset.deviceState = String(state.state ?? "unknown").toLowerCase();
    applyDeviceMetrics(frameElements, state.screen, state.deviceFamily);
    requestAnimationFrame(() => fitDeviceFrame(frameElements));

    const disabled = pending || controlUnavailable;
    for (const [name, button] of Object.entries(toolbarButtons)) {
        if (button) {
            button.disabled = disabled || !booted;
        }
        if (name === "shutdown" && button) {
            button.disabled = disabled || !booted || !manageable;
            button.title = manageable ? "Stop emulator" : "Physical devices are never shut down by this extension";
        }
    }

    const copy = poweredOffCopy();
    elements.poweredOffTitle.textContent = copy.title;
    elements.poweredOffHint.textContent = copy.hint;
    elements.bootDevice.disabled = disabled || booted || booting || unassigned || !manageable;
    elements.bootDevice.hidden = unassigned || state.state === "ShuttingDown" || !manageable;
    elements.streamFps.disabled = disabled || !booted;
    elements.streamResolution.disabled = disabled || !booted;
    elements.streamFps.value = String(state.stream?.fps ?? 60);
    elements.streamResolution.value = String(state.stream?.resolution ?? 100);
    if (disabled) {
        devicePicker.close();
    }
    devicePicker.render();

    elements.viewport.setAttribute("aria-busy", String(leaseActive));
    elements.overlay.classList.toggle("hidden", !leaseActive);
    if (leaseActive) {
        elements.overlayReason.textContent = state.lease.reason
            ? `Reason: ${state.lease.reason}`
            : "Reason: Agent control sequence";
        elements.overlayOperation.textContent = state.lease.currentOperation ?? "Waiting";
        elements.overlayExpiry.textContent = leaseRemainingLabel(state.lease);
    }

    ensureStream();
}

async function loadState() {
    state = await fetchJson("api/state");
    render();
}

async function withPending(action) {
    if (pending) {
        return;
    }
    pending = true;
    render();
    try {
        await action();
    } finally {
        pending = false;
        render();
    }
}

async function toolbarAction(path, body = {}) {
    await withPending(async () => {
        const payload = await fetchJson(path, body);
        if (payload?.deviceId && payload?.state) {
            state = payload;
        }
        render();
        await devicePicker.refresh();
    });
}

async function lightweightToolbarAction(path, body = {}) {
    const payload = await fetchJson(path, body);
    if (payload?.deviceId && payload?.state) {
        state = payload;
        render();
    }
}

function connectEvents() {
    eventSource?.close();
    eventSource = new EventSource(apiUrl("api/events"));
    eventSource.onmessage = (event) => {
        try {
            state = JSON.parse(event.data);
            render();
        } catch {
            setNotice("Received a malformed state update.", true);
        }
    };
}

function streamUrl() {
    const fps = state?.stream?.fps ?? 60;
    const resolution = state?.stream?.resolution ?? 100;
    return apiUrl(`api/stream.h264?fps=${fps}&resolution=${resolution}&r=${streamRevision}`);
}

function stopPngFallback() {
    clearInterval(pngFallbackTimer);
    pngFallbackTimer = null;
}

function stopH264Watchdog() {
    clearTimeout(h264Watchdog);
    h264Watchdog = null;
}

/** Used when the canvas runtime has no WebCodecs decoder: poll `screencap` instead. */
function startPngFallback() {
    stopPngFallback();
    setScreenMode("png");
    const refreshFrame = () => {
        if (state?.state !== "Booted") {
            return;
        }
        elements.screen.src = apiUrl(`api/frame.png?r=${Date.now()}`).toString();
    };
    refreshFrame();
    pngFallbackTimer = setInterval(refreshFrame, PNG_FALLBACK_INTERVAL_MS);
}

function ensureStream() {
    if (screenError) {
        return;
    }
    if (!state || state.state !== "Booted") {
        activeStreamKey = "";
        h264Stream.stop();
        stopPngFallback();
        stopH264Watchdog();
        setScreenMode("png");
        elements.screen.src = noImageDataUrl;
        elements.screen.classList.remove("has-frame");
        elements.screenWindow.classList.remove("has-frame");
        setScreenStatus(inactiveScreenStatus(), {
            poweredOff: state?.state !== "Booting",
            stateName: String(state?.state ?? "").toLowerCase(),
        });
        return;
    }

    const fps = state.stream?.fps ?? 60;
    const resolution = state.stream?.resolution ?? 100;
    const nextKey = `${fps}:${resolution}:${streamRevision}`;
    if (nextKey === activeStreamKey) {
        return;
    }
    activeStreamKey = nextKey;

    if (!useVideoDecoder) {
        setScreenStatus("Streaming screenshots (WebCodecs unavailable)");
        startPngFallback();
        return;
    }
    startH264Stream(fps);
}

function h264CanvasContext() {
    const context = elements.h264Screen.getContext("2d");
    if (!context) {
        throw new Error("The device canvas is unavailable.");
    }
    return context;
}

function drawVideoFrame(frame) {
    if (state?.state !== "Booted") {
        return;
    }
    clearTimeout(h264Watchdog);
    h264Watchdog = null;
    const width = frame.displayWidth || frame.codedWidth || frame.width;
    const height = frame.displayHeight || frame.codedHeight || frame.height;
    if (width && height && (elements.h264Screen.width !== width || elements.h264Screen.height !== height)) {
        elements.h264Screen.width = width;
        elements.h264Screen.height = height;
    }
    h264CanvasContext().drawImage(frame, 0, 0, elements.h264Screen.width, elements.h264Screen.height);
    clearScreenError();
    elements.screenWindow.classList.add("has-frame");
    setScreenStatus("Device display ready");
}

function handleH264StreamError(error) {
    setScreenStatus("H.264 stream failed.", { error: true });
    setNotice(error.message ?? String(error), true);
}

function startH264Stream(fps) {
    h264Stream.stop();
    stopPngFallback();
    setScreenMode("h264");
    elements.screen.src = noImageDataUrl;
    elements.screen.classList.remove("has-frame");
    elements.screenWindow.classList.remove("has-frame");
    setScreenStatus(`Connecting H.264 stream at ${fps} fps`);
    clearTimeout(h264Watchdog);
    h264Watchdog = setTimeout(() => {
        h264Watchdog = null;
        if (state?.state !== "Booted" || screenError) {
            return;
        }
        // Never leave the canvas blank because video decoding failed.
        h264Stream.stop();
        setScreenStatus("Video unavailable; streaming screenshots instead");
        startPngFallback();
    }, H264_WATCHDOG_MS);
    void h264Stream.start({ url: streamUrl(), fps });
}

function reconnectStream() {
    streamRevision += 1;
    activeStreamKey = "";
    ensureStream();
}

function bindToolbar() {
    for (const [action, button] of Object.entries(buttonActions)) {
        const element = document.querySelector(`[data-action="${action}"]`);
        element?.addEventListener("click", (event) => {
            event.preventDefault();
            void lightweightToolbarAction("api/toolbar/button", { button }).catch((error) =>
                setNotice(error.message, true),
            );
        });
    }

    toolbarButtons.shutdown.addEventListener("click", (event) => {
        event.preventDefault();
        if (!state || pending) {
            return;
        }
        void withPending(async () => {
            state = { ...state, state: "ShuttingDown" };
            render();
            const payload = await fetchJson("api/toolbar/shutdown", {});
            if (payload?.deviceId && payload?.state) {
                state = payload;
                render();
                await devicePicker.refresh();
            }
        }).catch((error) => {
            setNotice(error.message, true);
            void loadState().catch(() => {});
        });
    });
    elements.bootDevice.addEventListener("click", (event) => {
        event.preventDefault();
        void toolbarAction("api/toolbar/boot").catch((error) => {
            setNotice(error.message, true);
            void loadState().catch(() => {});
        });
    });
    elements.retryError.addEventListener("click", (event) => {
        event.preventDefault();
        void retryScreenError().catch((error) => setNotice(error.message ?? String(error), true));
    });
    toolbarButtons.rotateRight.addEventListener("click", (event) => {
        event.preventDefault();
        void fetchJson("api/toolbar/rotate", { direction: "right" })
            .then((result) => {
                if (result?.applied === false) {
                    setScreenStatus("The current app kept its orientation.");
                }
                reconnectStream();
            })
            .catch((error) => setNotice(error.message, true));
    });

    const applyStreamPreferences = () => {
        void toolbarAction("api/stream/preferences", {
            fps: Number(elements.streamFps.value),
            resolution: Number(elements.streamResolution.value),
        })
            .then(reconnectStream)
            .catch((error) => setNotice(error.message, true));
    };
    elements.streamFps.addEventListener("change", applyStreamPreferences);
    elements.streamResolution.addEventListener("change", applyStreamPreferences);
}

function bindSelectionGuards() {
    for (const eventName of ["selectstart", "dragstart"]) {
        document.addEventListener(eventName, (event) => event.preventDefault());
    }
    elements.viewport.addEventListener("contextmenu", (event) => event.preventDefault());
}

function bindScreenStatus() {
    elements.screen.addEventListener("load", () => {
        if (elements.screen.naturalWidth <= 1 || elements.screen.naturalHeight <= 1) {
            return;
        }
        if (state?.state === "Booted") {
            elements.screen.classList.add("has-frame");
            elements.screenWindow.classList.add("has-frame");
            clearScreenError();
            setScreenStatus("Device display ready");
        }
    });
}

function startLeaseTicker() {
    setInterval(() => {
        if (state?.lease?.active) {
            render();
        }
    }, 1000);
}

function bindResize() {
    if ("ResizeObserver" in window) {
        new ResizeObserver(() => fitDeviceFrame(frameElements)).observe(elements.viewport);
        return;
    }
    window.addEventListener("resize", () => fitDeviceFrame(frameElements));
}

const h264Stream = createH264StreamController({ onFrame: drawVideoFrame, onError: handleH264StreamError });

const devicePicker = createDevicePicker({
    elements: {
        root: elements.devicePicker,
        button: elements.devicePickerButton,
        menu: elements.devicePickerMenu,
        content: elements.devicePickerContent,
    },
    fetchJson,
    getState: () => state,
    isPending: () => pending || agentControlUnavailable(),
    loadState,
    reconnectStream,
    setNotice,
    withPending,
});

const inputController = createInputController({
    elements,
    apiUrl,
    fetchJson,
    getState: () => state,
    isControlUnavailable: agentControlUnavailable,
    setNotice,
    setState: (nextState) => {
        state = nextState;
        render();
    },
    withPending,
});

async function init() {
    try {
        hydrateIcons();
        applyDeviceMetrics(frameElements, bootstrapMetrics.screen, bootstrapMetrics.family);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => document.documentElement.classList.remove("awaiting-initial-paint"));
        });
        devicePicker.bind();
        bindToolbar();
        bindSelectionGuards();
        inputController.bind();
        bindScreenStatus();
        bindResize();
        await loadState();
        await devicePicker.refresh();
        connectEvents();
        startLeaseTicker();
        reconnectStream();
    } catch (error) {
        setNotice(error.message ?? String(error), true);
    }
}

void init();

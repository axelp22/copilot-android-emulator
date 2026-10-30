/**
 * Connection diagnostics: which transport is carrying the picture, whether the
 * canvas is connected, and why it fell back from gRPC video when it did.
 *
 * "Why is it slow?" is usually answered by one of those three facts, so they are
 * shown in plain words and can be copied as a short report. The report is meant
 * to be pasted into issues and chats, so it is an allowlist: every line is a
 * fixed label, a number, or a value from a known set. Free-form text (host
 * error messages, screen errors) is never copied; it is classified into a fixed
 * label instead, because no redaction can reliably spot an arbitrary device
 * name, serial or credential inside a message.
 */

const COPY_STATUS_MS = 4_000;

const TRANSPORT_LABELS = {
    grpc: "Emulator gRPC video",
    mirror: "Screen mirror video",
    screenshots: "Screenshots",
};

const CONNECTION_LABELS = {
    live: "Live",
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    offline: "Offline",
    error: "Error",
    idle: "Device not running",
};

/** Why the canvas itself chose screenshots; app.js reports one of these codes. */
export const CLIENT_FALLBACK_LABELS = {
    "decoder-unavailable": "This canvas cannot decode video",
    "first-frame-timeout": "Video did not start in time",
    stalled: "Video stalled",
    "stream-failed": "The video stream failed",
};
const UNKNOWN_CLIENT_FALLBACK = "Video unavailable";

// Matched against the host's raw gRPC error, which is never shown or copied itself.
// Order matters: the first match wins.
const GRPC_FAILURES = [
    [/cancel/i, "the stream was cancelled"],
    [/unauthori[sz]ed|unauthenticated|permission denied|forbidden|credential|\bHTTP 40[13]\b/i, "authentication was rejected"],
    [/no gRPC control connection|grpc_unavailable|discovery|not found/i, "this emulator has no gRPC endpoint"],
    [/stopped responding|timed? ?out|timeout|ETIMEDOUT|deadline/i, "the emulator stopped responding"],
    [/\bHTTP \d{3}\b/i, "the emulator returned an HTTP error"],
    [/ECONNREFUSED|refused|ECONNRESET|reset|hang up|EPIPE|EHOSTUNREACH|unreachable|connect/i, "the connection failed"],
    [/no message|empty response/i, "the emulator returned no data"],
    [/closed/i, "the channel was closed"],
];
const UNKNOWN_GRPC_FAILURE = "unrecognised error (details omitted)";

const HOST_TRANSPORTS = new Set(["grpc", "mirror"]);
const EVENT_STATES = new Set(["open", "connecting", "reconnecting", "closed"]);
const DEVICE_KINDS = new Set(["emulator", "device", "physical"]);
const DEVICE_STATES = new Set(["Booted", "Booting", "Shutdown", "ShuttingDown", "Offline", "Unauthorized", "Unavailable", "Unassigned"]);

/** A fixed label for the host's gRPC failure, or "" when there was none. */
export function classifyGrpcFailure(reason) {
    if (reason === null || reason === undefined || String(reason).trim() === "") {
        return "";
    }
    const text = String(reason);
    return GRPC_FAILURES.find(([pattern]) => pattern.test(text))?.[1] ?? UNKNOWN_GRPC_FAILURE;
}

function clientFallbackLabel(code) {
    return Object.hasOwn(CLIENT_FALLBACK_LABELS, code) ? CLIENT_FALLBACK_LABELS[code] : UNKNOWN_CLIENT_FALLBACK;
}

function allowed(value, set) {
    return set.has(value) ? value : value === null || value === undefined ? "unknown" : "other";
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function connectionState(snapshot) {
    if (snapshot.screenError) {
        return "error";
    }
    if (snapshot.events === "closed") {
        return "offline";
    }
    if (snapshot.events === "reconnecting") {
        return "reconnecting";
    }
    if (snapshot.deviceState && snapshot.deviceState !== "Booted") {
        return "idle";
    }
    if (snapshot.events !== "open" || !snapshot.lastFrameAt) {
        return "connecting";
    }
    return "live";
}

function activeTransport(snapshot) {
    if (snapshot.screenSource === "screenshots") {
        return "screenshots";
    }
    if (snapshot.screenSource === "video" && TRANSPORT_LABELS[snapshot.transport]) {
        return snapshot.transport;
    }
    return null;
}

function fallbackReason(snapshot, transport) {
    const reasons = [];
    if (snapshot.transport === "mirror" && snapshot.deviceKind === "emulator") {
        const serverReason = classifyGrpcFailure(snapshot.transportReason);
        reasons.push(serverReason ? `gRPC unavailable: ${serverReason}` : "gRPC unavailable");
    }
    if (transport === "screenshots") {
        if (snapshot.clientFallbackReason) {
            reasons.push(clientFallbackLabel(snapshot.clientFallbackReason));
        } else if (snapshot.hasVideoDecoder === false) {
            reasons.push("This canvas cannot decode video");
        }
    }
    return reasons.join("; ");
}

function roundedFps(value) {
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : null;
}

/** The view of one diagnostics snapshot, free of the DOM so it can be tested directly. */
export function describeConnection(snapshot = {}) {
    const transport = activeTransport(snapshot);
    const connection = connectionState(snapshot);
    const reason = fallbackReason(snapshot, transport);
    const reconnects = Math.max(0, Number(snapshot.streamReconnects) || 0);
    const eventErrors = Math.max(0, Number(snapshot.eventErrors) || 0);
    const fps = transport === "screenshots" ? null : roundedFps(snapshot.measuredFps);
    const transportLabel = transport ? TRANSPORT_LABELS[transport] : "Not connected yet";
    return {
        transport,
        transportLabel,
        connection,
        connectionLabel: CONNECTION_LABELS[connection],
        fallbackReason: reason,
        degraded: Boolean(reason) || connection === "error" || connection === "offline",
        reconnects,
        eventErrors,
        fps,
        summary: `${transportLabel} · ${CONNECTION_LABELS[connection]}`,
    };
}

function formatValue(value) {
    if (value === null || value === undefined || value === "") {
        return "unknown";
    }
    return String(value);
}

/**
 * A plain-text report safe to paste anywhere. Each line is built from a fixed
 * label, a number or an allowlisted value, so a new snapshot field or an
 * unexpected host message cannot reach it.
 */
export function buildDiagnosticReport(snapshot = {}, { now = new Date() } = {}) {
    const view = describeConnection(snapshot);
    const lastFrameAt = finiteOrNull(snapshot.lastFrameAt);
    const lastFrameAge =
        lastFrameAt && lastFrameAt > 0
            ? `${Math.max(0, Math.round((now.getTime() - lastFrameAt) / 100) / 10)} s ago`
            : "none yet";
    const androidVersion = /^\d{1,2}(?:\.\d{1,2}){0,2}$/.test(String(snapshot.androidVersion ?? "")) ? snapshot.androidVersion : null;
    const apiLevel = Number.isInteger(snapshot.apiLevel) ? snapshot.apiLevel : null;
    const lines = [
        "Android Emulator canvas diagnostics",
        `Generated: ${now.toISOString()}`,
        `Transport: ${view.transportLabel}`,
        `Connection: ${view.connectionLabel}`,
        `Fallback reason: ${view.fallbackReason || "none"}`,
        `Host transport: ${allowed(snapshot.transport, HOST_TRANSPORTS)}`,
        `Device kind: ${allowed(snapshot.deviceKind, DEVICE_KINDS)}`,
        `Device state: ${allowed(snapshot.deviceState, DEVICE_STATES)}`,
        `Android: ${formatValue(androidVersion)} (API ${formatValue(apiLevel)})`,
        `Requested: ${formatValue(finiteOrNull(snapshot.requestedFps))} fps at ${formatValue(finiteOrNull(snapshot.resolution))}% resolution`,
        `Measured: ${view.fps === null ? "n/a" : `${view.fps} fps`}`,
        `Last frame: ${lastFrameAge}`,
        `Video decoder: ${snapshot.hasVideoDecoder ? "available" : "unavailable"}${snapshot.decoderFailed ? " (failed for this device)" : ""}`,
        `Event stream: ${allowed(snapshot.events, EVENT_STATES)} (${view.eventErrors} errors)`,
        `Stream reconnects: ${view.reconnects}`,
        `Screen error: ${snapshot.screenError ? "shown (details omitted)" : "none"}`,
    ];
    return lines.join("\n");
}

/**
 * Renders the diagnostics panel and owns the copy flow. `getSnapshot` is read on
 * every render, so the panel never holds its own copy of connection state.
 */
export function createConnectionDiagnostics({
    elements,
    getSnapshot,
    clipboard,
    selectText = defaultSelectText,
    now = () => new Date(),
}) {
    let copyStatusTimer = null;
    let lastView = null;
    // After a blocked copy the user has to copy the selected report by hand. The
    // panel refreshes every second, and replacing the text would drop that
    // selection, so the report stays pinned until the next copy or the panel closes.
    let pinnedReport = null;

    function setOpen(open) {
        elements.panel.hidden = !open;
        elements.toggle.setAttribute("aria-expanded", String(open));
        if (open) {
            render();
        } else {
            pinnedReport = null;
        }
    }

    function selectForManualCopy(report) {
        pinnedReport = report;
        elements.report.textContent = report;
        // A selection inside a closed <details> is neither visible nor focusable.
        const details = elements.reportDetails ?? elements.report.closest?.("details");
        if (details) {
            details.open = true;
        }
        selectText(elements.report);
    }

    function setCopyStatus(message, tone = "info") {
        clearTimeout(copyStatusTimer);
        elements.copyStatus.textContent = message;
        elements.copyStatus.dataset.tone = tone;
        if (message && tone === "info") {
            copyStatusTimer = setTimeout(() => {
                elements.copyStatus.textContent = "";
            }, COPY_STATUS_MS);
            copyStatusTimer.unref?.();
        }
    }

    async function copyReport() {
        pinnedReport = null;
        const report = buildDiagnosticReport(getSnapshot(), { now: now() });
        elements.report.textContent = report;
        // Looked up per copy: the page's clipboard can appear or change after load.
        const target = clipboard === undefined ? globalThis.navigator?.clipboard : clipboard;
        if (typeof target?.writeText !== "function") {
            selectForManualCopy(report);
            setCopyStatus("Clipboard unavailable. The report is selected; copy it manually.", "error");
            return false;
        }
        try {
            await target.writeText(report);
            setCopyStatus("Diagnostic report copied.");
            return true;
        } catch {
            selectForManualCopy(report);
            setCopyStatus("Copy was blocked. The report is selected; copy it manually.", "error");
            return false;
        }
    }

    function render() {
        const snapshot = getSnapshot();
        const view = describeConnection(snapshot);
        lastView = view;
        elements.toggle.dataset.connection = view.connection;
        elements.toggle.dataset.degraded = String(view.degraded);
        elements.toggleLabel.textContent = view.transport ? TRANSPORT_LABELS[view.transport] : view.connectionLabel;
        elements.toggle.setAttribute("aria-label", `Connection diagnostics: ${view.summary}`);
        elements.toggle.title = view.fallbackReason ? `${view.summary}. ${view.fallbackReason}` : view.summary;
        if (elements.panel.hidden) {
            return view;
        }
        elements.panel.dataset.connection = view.connection;
        elements.transport.textContent = view.transportLabel;
        elements.connection.textContent = view.connectionLabel;
        elements.reason.textContent = view.fallbackReason || "None";
        elements.reconnects.textContent = String(view.reconnects);
        elements.fps.textContent = view.fps === null ? "n/a" : `${view.fps} fps`;
        if (pinnedReport === null) {
            elements.report.textContent = buildDiagnosticReport(snapshot, { now: now() });
        }
        return view;
    }

    function bind() {
        elements.toggle.setAttribute("aria-controls", elements.panel.id);
        elements.toggle.setAttribute("aria-expanded", String(!elements.panel.hidden));
        elements.toggle.addEventListener("click", () => setOpen(elements.panel.hidden));
        elements.close.addEventListener("click", () => {
            setOpen(false);
            elements.toggle.focus?.();
        });
        elements.copy.addEventListener("click", () => void copyReport());
        render();
    }

    return {
        bind,
        render,
        copyReport,
        setOpen,
        get view() {
            return lastView;
        },
        get reportPinned() {
            return pinnedReport !== null;
        },
    };
}

function defaultSelectText(element) {
    const selection = globalThis.getSelection?.();
    const range = globalThis.document?.createRange?.();
    if (!selection || !range) {
        return;
    }
    const select = () => {
        // Focus first: moving focus afterwards can collapse a selection just made.
        element.focus?.({ preventScroll: true });
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
    };
    select();
    // Chrome can ignore focus() on content of a <details> opened in the same task
    // until it has re-run style; retry once the new layout is in place.
    const doc = element.ownerDocument;
    if (doc && doc.activeElement !== element && typeof globalThis.requestAnimationFrame === "function") {
        globalThis.requestAnimationFrame(() => {
            if (element.isConnected && doc.activeElement !== element) {
                select();
            }
        });
    }
}

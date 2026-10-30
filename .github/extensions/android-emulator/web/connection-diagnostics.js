/**
 * Connection diagnostics: which transport is carrying the picture, whether the
 * canvas is connected, and why it fell back from gRPC video when it did.
 *
 * "Why is it slow?" is usually answered by one of those three facts, so they are
 * shown in plain words and can be copied as a short report. The report is meant
 * to be pasted into issues and chats, so it is built only from an allowlist of
 * fields and every free-form string goes through redactDiagnosticText first:
 * no serials, AVD names, paths, tokens or raw logs.
 */

const MAX_REASON_LENGTH = 160;
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

const REDACTIONS = [
    // JSON Web Tokens and other long dotted base64 blobs.
    [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]"],
    [/\b(bearer|basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]"],
    [
        /\b(authorization|auth|token|access[_-]?token|api[_-]?key|apikey|secret|password|passwd|pwd|cookie|session|signature|sig|key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&)]+)/gi,
        "$1$2[redacted]",
    ],
    [/\bfile:\/\/\S+/gi, "[path]"],
    // URLs keep their scheme and host but lose path and query, which can carry tokens.
    [/\b(https?|wss?|grpc):\/\/([^/\s?#]+)[^\s)]*/gi, "$1://$2"],
    [/\b[A-Za-z]:\\[^\s:;,)'"]*/g, "[path]"],
    [/\\\\[^\s:;,)'"]+/g, "[path]"],
    // Unix paths: anything rooted at / with at least one more segment.
    [/(^|[\s(="'`])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, "$1[path]"],
    [/(^|[\s(="'`])~\/[^\s:;,)'"]*/g, "$1[path]"],
    [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[email]"],
    // adb serials of physical devices and long hex identifiers.
    [/\b[0-9a-f]{16,}\b/gi, "[id]"],
];

/** Strips anything that could identify a person, a machine or a credential. */
export function redactDiagnosticText(value, { maxLength = MAX_REASON_LENGTH } = {}) {
    if (value === null || value === undefined) {
        return "";
    }
    let text = String(value).replace(/[\u0000-\u001f\u007f]+/g, " ");
    for (const [pattern, replacement] of REDACTIONS) {
        text = text.replace(pattern, replacement);
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text.length > maxLength) {
        text = `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
    }
    return text;
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
        const serverReason = redactDiagnosticText(snapshot.transportReason);
        reasons.push(serverReason ? `gRPC unavailable: ${serverReason}` : "gRPC unavailable");
    }
    if (transport === "screenshots") {
        const clientReason = redactDiagnosticText(snapshot.clientFallbackReason);
        if (clientReason) {
            reasons.push(clientReason);
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
 * A plain-text report safe to paste anywhere. Only allowlisted fields are
 * included, and free-form strings are redacted again even though describe
 * already did, so a future field cannot slip through unredacted.
 */
export function buildDiagnosticReport(snapshot = {}, { now = new Date() } = {}) {
    const view = describeConnection(snapshot);
    const lastFrameAge =
        Number.isFinite(snapshot.lastFrameAt) && snapshot.lastFrameAt > 0
            ? `${Math.max(0, Math.round((now.getTime() - snapshot.lastFrameAt) / 100) / 10)} s ago`
            : "none yet";
    const lines = [
        "Android Emulator canvas diagnostics",
        `Generated: ${now.toISOString()}`,
        `Transport: ${view.transportLabel}`,
        `Connection: ${view.connectionLabel}`,
        `Fallback reason: ${redactDiagnosticText(view.fallbackReason) || "none"}`,
        `Host transport: ${formatValue(redactDiagnosticText(snapshot.transport, { maxLength: 24 }))}`,
        `Device kind: ${formatValue(redactDiagnosticText(snapshot.deviceKind, { maxLength: 24 }))}`,
        `Device state: ${formatValue(redactDiagnosticText(snapshot.deviceState, { maxLength: 24 }))}`,
        `Android: ${formatValue(redactDiagnosticText(snapshot.androidVersion, { maxLength: 24 }))} (API ${formatValue(Number.isFinite(snapshot.apiLevel) ? snapshot.apiLevel : null)})`,
        `Requested: ${formatValue(Number.isFinite(snapshot.requestedFps) ? snapshot.requestedFps : null)} fps at ${formatValue(Number.isFinite(snapshot.resolution) ? snapshot.resolution : null)}% resolution`,
        `Measured: ${view.fps === null ? "n/a" : `${view.fps} fps`}`,
        `Last frame: ${lastFrameAge}`,
        `Video decoder: ${snapshot.hasVideoDecoder ? "available" : "unavailable"}${snapshot.decoderFailed ? " (failed for this device)" : ""}`,
        `Event stream: ${formatValue(redactDiagnosticText(snapshot.events, { maxLength: 24 }))} (${view.eventErrors} errors)`,
        `Stream reconnects: ${view.reconnects}`,
        `Screen error: ${redactDiagnosticText(snapshot.screenError) || "none"}`,
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

    function setOpen(open) {
        elements.panel.hidden = !open;
        elements.toggle.setAttribute("aria-expanded", String(open));
        if (open) {
            render();
        }
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
        const report = buildDiagnosticReport(getSnapshot(), { now: now() });
        elements.report.textContent = report;
        // Looked up per copy: the page's clipboard can appear or change after load.
        const target = clipboard === undefined ? globalThis.navigator?.clipboard : clipboard;
        if (typeof target?.writeText !== "function") {
            selectText(elements.report);
            setCopyStatus("Clipboard unavailable. The report is selected; copy it manually.", "error");
            return false;
        }
        try {
            await target.writeText(report);
            setCopyStatus("Diagnostic report copied.");
            return true;
        } catch {
            selectText(elements.report);
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
        elements.report.textContent = buildDiagnosticReport(snapshot, { now: now() });
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

    return { bind, render, copyReport, setOpen, get view() { return lastView; } };
}

function defaultSelectText(element) {
    const selection = globalThis.getSelection?.();
    const range = globalThis.document?.createRange?.();
    if (!selection || !range) {
        return;
    }
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    element.focus?.();
}

/**
 * Non-fatal feedback that must not take over the device display: build progress
 * and the outcome of controls. Errors that mean the picture itself is broken
 * still go through the screen error state in app.js; everything here leaves a
 * healthy stream running.
 *
 * All text is written with textContent. Build logs and error messages carry
 * whatever Gradle or the device printed, and must never be parsed as markup.
 */

const NOTICE_INFO_MS = 5_000;

const BUILD_TITLES = {
    running: "Building",
    succeeded: "Build finished",
    failed: "Build failed",
    cancelled: "Build cancelled",
    cancel_failed: "Cancellation not confirmed",
};

/** The view of one install status, kept free of the DOM so it can be tested directly. */
export function describeBuild(install, { controlBlocked = false } = {}) {
    if (!install) {
        return { visible: false };
    }
    const running = install.state === "running";
    const cancelling = running && install.cancelRequested === true;
    const log = Array.isArray(install.log) ? install.log : [];
    const total = Number(install.logTotal) || log.length;
    return {
        visible: true,
        stamp: `${install.id ?? install.startedAt}:${install.state}`,
        id: install.id ?? null,
        tone: running ? "running" : install.state === "succeeded" ? "success" : install.state === "cancelled" ? "cancelled" : "error",
        title: cancelling ? "Cancelling build" : (BUILD_TITLES[install.state] ?? "Build"),
        detail: String(install.message ?? ""),
        running,
        cancelling,
        canCancel: running && install.cancellable === true && !cancelling && !controlBlocked,
        logText: log.join("\n"),
        logNote: total > log.length ? `Showing the last ${log.length} of ${total} lines` : "",
        hasLog: log.length > 0,
    };
}

/**
 * @param {object} options
 * @param {object} options.elements root, title, detail, cancel, dismiss, logDetails, log, logNote
 * @param {(runId: string|null) => void} options.onCancel
 */
export function createBuildPanel({ elements, onCancel }) {
    let current = null;
    let dismissedStamp = null;
    let renderedLog = null;

    function bind() {
        elements.cancel.addEventListener("click", (event) => {
            event.preventDefault();
            if (current?.canCancel) {
                onCancel(current.id);
            }
        });
        elements.dismiss.addEventListener("click", (event) => {
            event.preventDefault();
            dismissedStamp = current?.stamp ?? null;
            elements.root.hidden = true;
        });
    }

    function render(install, options = {}) {
        const view = describeBuild(install, options);
        current = view.visible ? view : null;
        if (!view.visible || view.stamp === dismissedStamp) {
            elements.root.hidden = true;
            return view;
        }
        elements.root.hidden = false;
        elements.root.dataset.tone = view.tone;
        elements.root.setAttribute("aria-busy", String(view.running));
        elements.title.textContent = view.title;
        elements.detail.textContent = view.detail;
        elements.cancel.hidden = !view.running;
        elements.cancel.disabled = !view.canCancel;
        elements.cancel.textContent = view.cancelling ? "Cancelling…" : "Cancel";
        elements.dismiss.hidden = view.running;
        elements.logDetails.hidden = !view.hasLog;
        elements.logNote.textContent = view.logNote;
        if (renderedLog !== view.logText) {
            // Follow the tail while the reader is already at the bottom, but do not
            // yank someone scrolled up reading an earlier error.
            const log = elements.log;
            const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
            log.textContent = view.logText;
            renderedLog = view.logText;
            if (atBottom) {
                log.scrollTop = log.scrollHeight;
            }
        }
        return view;
    }

    return { bind, render };
}

/**
 * One line of feedback for a control. Information fades on its own; an error
 * stays until it is dismissed or replaced, and is announced assertively.
 */
export function createNotice({ elements, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let timer = null;

    function hide() {
        clearTimer(timer);
        timer = null;
        elements.root.hidden = true;
        elements.text.textContent = "";
    }

    function show(message, { error = false } = {}) {
        const text = String(message ?? "").trim();
        if (!text) {
            return;
        }
        clearTimer(timer);
        timer = null;
        elements.root.hidden = false;
        elements.root.dataset.tone = error ? "error" : "info";
        elements.root.setAttribute("role", error ? "alert" : "status");
        elements.root.setAttribute("aria-live", error ? "assertive" : "polite");
        elements.text.textContent = text;
        if (!error) {
            timer = setTimer(hide, NOTICE_INFO_MS);
        }
    }

    function bind() {
        elements.dismiss.addEventListener("click", (event) => {
            event.preventDefault();
            hide();
        });
    }

    return { bind, show, hide };
}

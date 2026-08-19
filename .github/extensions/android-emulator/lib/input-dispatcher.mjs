import { AppError } from "./errors.mjs";
import { adbShell } from "./adb.mjs";
import { ORIENTATIONS, orientationFromRotation, rotationFromOrientation } from "./device-model.mjs";

/** Hardware buttons the canvas and agent tools can press. */
export const BUTTON_KEYCODES = {
    home: 3,
    back: 4,
    recents: 187,
    power: 26,
    volume_up: 24,
    volume_down: 25,
    menu: 82,
    camera: 27,
};

export const SUPPORTED_BUTTONS = Object.keys(BUTTON_KEYCODES);

/** Browser `KeyboardEvent.code` values forwarded from the canvas. */
const BROWSER_KEY_CODES = {
    Enter: 66,
    NumpadEnter: 66,
    Escape: 111,
    Backspace: 67,
    Tab: 61,
    Space: 62,
    Minus: 69,
    Equal: 70,
    BracketLeft: 71,
    BracketRight: 72,
    Backslash: 73,
    Semicolon: 74,
    Quote: 75,
    Backquote: 68,
    Comma: 55,
    Period: 56,
    Slash: 76,
    ArrowUp: 19,
    ArrowDown: 20,
    ArrowLeft: 21,
    ArrowRight: 22,
    Home: 122,
    End: 123,
    PageUp: 92,
    PageDown: 93,
    Delete: 112,
    Insert: 124,
    CapsLock: 115,
};

const TAP_SLOP_PX = 12;
const DRAG_SEGMENT_MIN_MS = 16;
const DRAG_SEGMENT_MAX_MS = 400;

/** Resolve a key identifier to an Android keycode. */
export function resolveKeyCode(code) {
    if (typeof code === "number" && Number.isInteger(code)) {
        return code;
    }
    const value = String(code ?? "").trim();
    if (/^\d+$/.test(value)) {
        return Number(value);
    }
    if (/^KEYCODE_[A-Z0-9_]+$/.test(value)) {
        return value;
    }
    if (Object.hasOwn(BROWSER_KEY_CODES, value)) {
        return BROWSER_KEY_CODES[value];
    }
    const letter = value.match(/^Key([A-Z])$/);
    if (letter) {
        return `KEYCODE_${letter[1]}`;
    }
    const digit = value.match(/^Digit(\d)$/);
    if (digit) {
        return `KEYCODE_${digit[1]}`;
    }
    if (Object.hasOwn(BUTTON_KEYCODES, value.toLowerCase())) {
        return BUTTON_KEYCODES[value.toLowerCase()];
    }
    throw new AppError("unsupported_key", `Unsupported key code: ${value}`, 400);
}

/**
 * `input text` uses `%s` for spaces, and the payload is parsed by the device shell,
 * so wrap it in single quotes and escape any embedded quote.
 */
export function escapeInputText(text) {
    const value = String(text ?? "");
    if (value.length === 0) {
        throw new AppError("invalid_text", "Text input must not be empty.", 400);
    }
    const withSpaceTokens = value.replaceAll(" ", "%s");
    return `'${withSpaceTokens.replaceAll("'", "'\\''")}'`;
}

export class InputDispatcher {
    constructor({ state, ensureBooted, screenSize, refreshScreenMetrics }) {
        this.state = state;
        this.ensureBooted = ensureBooted;
        this.screenSize = screenSize;
        this.refreshScreenMetrics = refreshScreenMetrics;
        this.touchSessions = new Map();
        this.commandQueues = new Map();
    }

    /** Serialize adb commands per device so gestures never interleave. */
    enqueue(deviceId, task) {
        const previous = this.commandQueues.get(deviceId) ?? Promise.resolve();
        const next = previous.then(task, task);
        this.commandQueues.set(
            deviceId,
            next.catch(() => {}),
        );
        return next;
    }

    async shell(deviceId, command) {
        const serial = this.state.requireSerial(deviceId);
        return await adbShell(serial, command, { timeout: 30_000 });
    }

    async inputGeometry(deviceId) {
        const screen = this.state.getDeviceOrThrow(deviceId).screen;
        if (screen?.width && screen?.height) {
            return { width: screen.width, height: screen.height };
        }
        return await this.screenSize(deviceId);
    }

    async ensureInputReady(deviceId) {
        const device = this.state.getDeviceOrThrow(deviceId);
        if (device.state !== "Booted" || !device.serial) {
            await this.ensureBooted(deviceId);
        }
    }

    async toPixels(deviceId, coordinates, coordinateSpace = "normalized") {
        if (coordinateSpace === "point" || coordinateSpace === "points") {
            return coordinates.map((value) => Math.round(Number(value)));
        }
        const size = await this.inputGeometry(deviceId);
        return coordinates.map((value, index) => {
            const extent = index % 2 === 0 ? size.width : size.height;
            const clamped = Math.min(1, Math.max(0, Number(value)));
            return Math.min(extent - 1, Math.max(0, Math.round(clamped * extent)));
        });
    }

    async tap(input) {
        await this.ensureInputReady(input.deviceId);
        const [x, y] = await this.toPixels(input.deviceId, [input.x, input.y], input.coordinateSpace);
        await this.enqueue(input.deviceId, () => this.shell(input.deviceId, ["input", "tap", String(x), String(y)]));
        return { deviceId: input.deviceId, action: "tap", x, y };
    }

    async swipe(input) {
        await this.ensureInputReady(input.deviceId);
        const [startX, startY, endX, endY] = await this.toPixels(
            input.deviceId,
            [input.startX, input.startY, input.endX, input.endY],
            input.coordinateSpace,
        );
        const durationMs = Math.max(1, Math.min(60_000, Math.round(Number(input.durationMs ?? 300))));
        await this.enqueue(input.deviceId, () =>
            this.shell(input.deviceId, [
                "input",
                "swipe",
                String(startX),
                String(startY),
                String(endX),
                String(endY),
                String(durationMs),
            ]),
        );
        return { deviceId: input.deviceId, action: "swipe", startX, startY, endX, endY, durationMs };
    }

    async sendKey(input) {
        await this.ensureInputReady(input.deviceId);
        const keyCode = resolveKeyCode(input.code);
        await this.enqueue(input.deviceId, () =>
            this.shell(input.deviceId, ["input", "keyevent", String(keyCode)]),
        );
        return { deviceId: input.deviceId, action: "key", code: String(keyCode) };
    }

    async sendText(input) {
        await this.ensureInputReady(input.deviceId);
        const payload = escapeInputText(input.text);
        await this.enqueue(input.deviceId, () => this.shell(input.deviceId, ["input", "text", payload]));
        return { deviceId: input.deviceId, action: "text", length: String(input.text).length };
    }

    async pressButton(input, maybeButton) {
        const deviceId = typeof input === "string" ? input : input?.deviceId;
        const button = maybeButton ?? input?.button;
        if (!Object.hasOwn(BUTTON_KEYCODES, button)) {
            throw new AppError("unsupported_button", `Unsupported button: ${button}`, 400);
        }
        await this.ensureInputReady(deviceId);
        await this.enqueue(deviceId, () =>
            this.shell(deviceId, ["input", "keyevent", String(BUTTON_KEYCODES[button])]),
        );
        return { deviceId, action: "button", button };
    }

    goHome(input) {
        return this.pressButton(input, "home");
    }

    nextOrientation(deviceId, direction) {
        if (!["left", "right"].includes(direction)) {
            throw new AppError("invalid_rotation_direction", `Unsupported rotation direction: ${direction}`, 400);
        }
        const current = rotationFromOrientation(this.state.getDeviceOrThrow(deviceId).orientation);
        const delta = direction === "right" ? 1 : ORIENTATIONS.length - 1;
        return (current + delta) % ORIENTATIONS.length;
    }

    /**
     * Forces a fixed rotation. Apps that lock their orientation may refuse it, so the
     * caller reconciles state against the window manager afterwards.
     */
    async rotateDevice(input, maybeDirection) {
        const deviceId = typeof input === "string" ? input : input?.deviceId;
        const direction = maybeDirection ?? input?.direction;
        const rotation = this.nextOrientation(deviceId, direction);
        await this.ensureInputReady(deviceId);
        await this.enqueue(deviceId, async () => {
            await this.shell(deviceId, ["settings", "put", "system", "accelerometer_rotation", "0"]);
            await this.shell(deviceId, ["settings", "put", "system", "user_rotation", String(rotation)]);
        });
        return { deviceId, requestedOrientation: orientationFromRotation(rotation), rotation };
    }

    async performInputs(input) {
        const handlers = {
            tap: (stepInput) => this.tap(stepInput),
            swipe: (stepInput) => this.swipe(stepInput),
            key: (stepInput) => this.sendKey(stepInput),
            text: (stepInput) => this.sendText(stepInput),
            button: (stepInput) => this.pressButton(stepInput),
            wait: (stepInput) => this.wait(stepInput),
        };
        const results = [];
        for (const step of input.steps) {
            const handler = handlers[step.kind];
            if (!handler) {
                throw new AppError("unsupported_input_step", `Unsupported input step: ${step.kind}`, 400);
            }
            results.push(await handler({ deviceId: input.deviceId, ...step.input }));
        }
        return { deviceId: input.deviceId, results };
    }

    async wait({ deviceId, durationMs }) {
        const delay = Math.max(0, Math.min(10_000, Math.round(Number(durationMs ?? 250))));
        await new Promise((resolve) => setTimeout(resolve, delay));
        return { deviceId, action: "wait", durationMs: delay };
    }

    // --- Pointer streaming -------------------------------------------------
    //
    // `adb shell input` exposes no down/move/up primitive, so a manual drag is
    // approximated by chaining `input swipe` segments between coalesced pointer
    // samples. Each segment is its own gesture on the device.

    async prepareTouchStream(deviceId) {
        await this.ensureInputReady(deviceId);
        return { deviceId, ready: true };
    }

    touchSession(deviceId) {
        return this.touchSessions.get(deviceId) ?? null;
    }

    async notifyTouch(input) {
        const { deviceId, phase } = input;
        if (!["down", "move", "up", "cancel"].includes(phase)) {
            throw new AppError("invalid_touch_phase", `Unsupported touch phase: ${phase}`, 400);
        }
        if (phase !== "cancel") {
            if (typeof input.x !== "number" || typeof input.y !== "number" || Number.isNaN(input.x) || Number.isNaN(input.y)) {
                throw new AppError("invalid_touch_coordinates", "Touch coordinates must be numeric.", 400);
            }
        }

        if (phase === "cancel") {
            await this.endTouchSession(deviceId, { cancelled: true });
            return { deviceId, action: "touch", phase };
        }

        await this.ensureInputReady(deviceId);
        const [x, y] = await this.toPixels(deviceId, [input.x, input.y], input.coordinateSpace ?? "normalized");

        if (phase === "down") {
            this.touchSessions.set(deviceId, {
                anchorX: x,
                anchorY: y,
                anchorAt: Date.now(),
                startX: x,
                startY: y,
                pending: null,
                flushing: false,
                dragging: false,
            });
            return { deviceId, action: "touch", phase, x, y };
        }

        const session = this.touchSession(deviceId);
        if (!session) {
            // A move or up without a matching down (for example after a lease grab).
            return { deviceId, action: "touch", phase, ignored: true };
        }

        if (phase === "move") {
            const travelled = Math.hypot(x - session.startX, y - session.startY);
            if (!session.dragging && travelled < TAP_SLOP_PX) {
                return { deviceId, action: "touch", phase, coalesced: true };
            }
            session.dragging = true;
            session.pending = { x, y };
            void this.flushTouchSegments(deviceId);
            return { deviceId, action: "touch", phase, x, y };
        }

        // phase === "up"
        session.pending = { x, y };
        await this.endTouchSession(deviceId, { cancelled: false });
        return { deviceId, action: "touch", phase, x, y };
    }

    async flushTouchSegments(deviceId) {
        const session = this.touchSession(deviceId);
        if (!session || session.flushing) {
            return;
        }
        session.flushing = true;
        try {
            while (session.pending) {
                const target = session.pending;
                session.pending = null;
                if (target.x === session.anchorX && target.y === session.anchorY) {
                    continue;
                }
                const elapsed = Date.now() - session.anchorAt;
                const durationMs = Math.max(DRAG_SEGMENT_MIN_MS, Math.min(DRAG_SEGMENT_MAX_MS, elapsed));
                const fromX = session.anchorX;
                const fromY = session.anchorY;
                session.anchorX = target.x;
                session.anchorY = target.y;
                session.anchorAt = Date.now();
                await this.enqueue(deviceId, () =>
                    this.shell(deviceId, [
                        "input",
                        "swipe",
                        String(fromX),
                        String(fromY),
                        String(target.x),
                        String(target.y),
                        String(durationMs),
                    ]),
                ).catch(() => {});
            }
        } finally {
            session.flushing = false;
        }
    }

    async endTouchSession(deviceId, { cancelled }) {
        const session = this.touchSessions.get(deviceId);
        if (!session) {
            return;
        }
        this.touchSessions.delete(deviceId);

        if (cancelled) {
            session.pending = null;
            return;
        }

        const target = session.pending ?? { x: session.anchorX, y: session.anchorY };
        session.pending = null;
        const travelled = Math.hypot(target.x - session.startX, target.y - session.startY);

        if (!session.dragging && travelled < TAP_SLOP_PX) {
            await this.enqueue(deviceId, () =>
                this.shell(deviceId, ["input", "tap", String(session.startX), String(session.startY)]),
            );
            return;
        }

        if (target.x === session.anchorX && target.y === session.anchorY) {
            return;
        }

        const elapsed = Date.now() - session.anchorAt;
        const durationMs = Math.max(DRAG_SEGMENT_MIN_MS, Math.min(DRAG_SEGMENT_MAX_MS, elapsed));
        await this.enqueue(deviceId, () =>
            this.shell(deviceId, [
                "input",
                "swipe",
                String(session.anchorX),
                String(session.anchorY),
                String(target.x),
                String(target.y),
                String(durationMs),
            ]),
        );
    }

    /** POST fallback used when the canvas cannot open the touch WebSocket. */
    touch(input) {
        return this.notifyTouch(input);
    }

    clearTouchSessions(deviceId) {
        if (deviceId) {
            this.touchSessions.delete(deviceId);
            return;
        }
        this.touchSessions.clear();
    }
}

/**
 * Typed wrapper over the `EmulatorController` gRPC service.
 *
 * Only the messages this extension needs are modelled. Field numbers are taken
 * from `emulator_controller.proto` as shipped with the SDK; note that
 * `ImageFormat.width` is field **3**, not 2 — field 2 is the output-only
 * rotation, and getting that wrong silently returns unscaled frames.
 */
import { Writer, decodeFields, readMessage } from "./protobuf.mjs";

const SERVICE = "/android.emulation.control.EmulatorController";

export const METHODS = {
    getStatus: `${SERVICE}/getStatus`,
    getScreenshot: `${SERVICE}/getScreenshot`,
    streamScreenshot: `${SERVICE}/streamScreenshot`,
    sendTouch: `${SERVICE}/sendTouch`,
    sendKey: `${SERVICE}/sendKey`,
    setPhysicalModel: `${SERVICE}/setPhysicalModel`,
};

/** `ImageFormat.ImgFormat` */
export const IMG_FORMAT = {
    png: 0,
    rgba8888: 1,
    rgb888: 2,
};

/** `Rotation.SkinRotation`, in quarter turns clockwise from portrait. */
export const SKIN_ROTATION = {
    portrait: 0,
    landscape: 1,
    reversePortrait: 2,
    reverseLandscape: 3,
};

/** `KeyboardEvent.KeyEventType` */
export const KEY_EVENT_TYPE = {
    keydown: 0,
    keyup: 1,
    keypress: 2,
};

export const BYTES_PER_PIXEL = {
    [IMG_FORMAT.rgb888]: 3,
    [IMG_FORMAT.rgba8888]: 4,
};

/**
 * `ImageFormat { format=1, rotation=2, width=3, height=4, display=5 }`
 *
 * Width and height are *desired* bounds: the emulator preserves aspect ratio and
 * never returns more than the device's real resolution, so the response format
 * must be read back rather than assumed.
 */
export function encodeImageFormat({ format = IMG_FORMAT.rgb888, width = 0, height = 0, display = 0 } = {}) {
    return new Writer()
        .varint(1, format)
        .varint(3, Math.max(0, Math.round(width)))
        .varint(4, Math.max(0, Math.round(height)))
        .varint(5, display)
        .finish();
}

function decodeRotation(buffer) {
    const fields = decodeFields(buffer, { 1: "rotation" });
    return Number(fields.rotation ?? 0);
}

function decodeImageFormatMessage(buffer) {
    const out = { format: IMG_FORMAT.png, width: 0, height: 0, rotation: SKIN_ROTATION.portrait };
    readMessage(buffer, (fieldNo, value) => {
        if (fieldNo === 1) {
            out.format = Number(value);
        } else if (fieldNo === 2 && Buffer.isBuffer(value)) {
            out.rotation = decodeRotation(value);
        } else if (fieldNo === 3) {
            out.width = Number(value);
        } else if (fieldNo === 4) {
            out.height = Number(value);
        }
    });
    return out;
}

/**
 * `Image { format=1, image=4, seq=5, timestampUs=6 }`
 *
 * `width`/`height` (fields 2 and 3) are deprecated in favour of the nested
 * format, so the nested value is authoritative.
 */
export function decodeImage(buffer) {
    const out = { format: null, pixels: null, seq: 0, timestampUs: 0n };
    readMessage(buffer, (fieldNo, value) => {
        if (fieldNo === 1 && Buffer.isBuffer(value)) {
            out.format = decodeImageFormatMessage(value);
        } else if (fieldNo === 4 && Buffer.isBuffer(value)) {
            out.pixels = value;
        } else if (fieldNo === 5) {
            out.seq = Number(value);
        } else if (fieldNo === 6) {
            out.timestampUs = typeof value === "bigint" ? value : BigInt(value ?? 0);
        }
    });
    return out;
}

/**
 * `TouchEvent { touches=1 (repeated Touch), display=2 }`
 *
 * A touch is released by sending pressure 0 for its identifier. Omitting that
 * leaves the slot occupied until the emulator's 120s expiry, which strands the
 * pointer, so callers must always close what they open.
 */
export function encodeTouchEvent({ touches, display = 0 }) {
    const encoded = touches.map((touch) =>
        new Writer()
            .varint(1, Math.round(touch.x))
            .varint(2, Math.round(touch.y))
            .varint(3, touch.identifier ?? 0)
            .varint(4, Math.round(touch.pressure ?? 0))
            .varint(5, touch.touchMajor ?? 0)
            .varint(6, touch.touchMinor ?? 0)
            .finish(),
    );
    return new Writer().repeated(1, encoded).varint(2, display).finish();
}

/** `KeyboardEvent { codeType=1, eventType=2, keyCode=3, key=4, text=5 }` */
export function encodeKeyboardEvent({ eventType, keyCode, key, text, codeType = 0 }) {
    return new Writer()
        .varint(1, codeType)
        .varint(2, eventType ?? KEY_EVENT_TYPE.keypress)
        .varint(3, keyCode)
        .string(4, key)
        .string(5, text)
        .finish();
}

/** `EmulatorStatus { version=1, uptime=2, booted=3, heartbeat=6 }` */
export function decodeStatus(buffer) {
    const out = { version: "", uptime: 0, booted: false, heartbeat: 0 };
    readMessage(buffer, (fieldNo, value) => {
        if (fieldNo === 1 && Buffer.isBuffer(value)) {
            out.version = value.toString("utf8");
        } else if (fieldNo === 2) {
            out.uptime = Number(value);
        } else if (fieldNo === 3) {
            out.booted = Boolean(Number(value));
        } else if (fieldNo === 6) {
            out.heartbeat = Number(value);
        }
    });
    return out;
}

/** Binds the service methods to a channel. */
export function createEmulatorController(channel) {
    return {
        async getStatus({ signal, timeoutMs } = {}) {
            return decodeStatus(await channel.unary(METHODS.getStatus, Buffer.alloc(0), { signal, timeoutMs }));
        },

        async getScreenshot(format, { signal, timeoutMs } = {}) {
            return decodeImage(await channel.unary(METHODS.getScreenshot, encodeImageFormat(format), { signal, timeoutMs }));
        },

        /**
         * Frames arrive whenever the guest posts one; a still screen simply goes
         * quiet, and an inactive display yields a zero-sized image.
         */
        streamScreenshot(format, { onImage, signal }) {
            return channel.serverStream(METHODS.streamScreenshot, encodeImageFormat(format), {
                signal,
                onMessage: (message) => onImage(decodeImage(message)),
            });
        },

        async sendTouch(event, { signal } = {}) {
            await channel.unary(METHODS.sendTouch, encodeTouchEvent(event), { signal });
        },

        async sendKey(event, { signal } = {}) {
            await channel.unary(METHODS.sendKey, encodeKeyboardEvent(event), { signal });
        },
    };
}

/**
 * Canvas open/reopen helpers, kept out of `extension.mjs` (which joins the
 * session at import time) so they can be tested without a host.
 */

/** Errors meaning a device is gone or unusable right now, not a broken request. */
const STALE_DEVICE_CODES = new Set(["no_devices", "unknown_device", "device_unavailable"]);

export function isStaleDeviceError(error) {
    return STALE_DEVICE_CODES.has(error?.code);
}

/**
 * Picks the device a (re)opened canvas binds to.
 *
 * A saved binding wins, because reopening a canvas must restore what the user
 * was looking at. But that device may be unplugged, shut down and deleted, or
 * unauthorized since; failing the open would leave a canvas that can never be
 * reopened. Instead the requested device is tried, and failing that the canvas
 * opens unbound. Either way the saved binding is kept (`persist: false`): the
 * requested device is the host replaying the canvas's original input, only a
 * temporary stand-in, and only an explicit switch replaces the user's choice.
 * Replugging the saved device and reopening then restores it.
 */
export async function resolveCanvasDevice({ savedDeviceId, requestedDeviceId, resolveDeviceId, onDiagnostic = () => {} }) {
    if (savedDeviceId === undefined) {
        const deviceId = requestedDeviceId ? await resolveDeviceId(requestedDeviceId) : null;
        return { deviceId, persist: true };
    }
    if (savedDeviceId === null) {
        return { deviceId: null, persist: true };
    }
    try {
        return { deviceId: await resolveDeviceId(savedDeviceId), persist: true };
    } catch (error) {
        if (!isStaleDeviceError(error)) {
            throw error;
        }
        onDiagnostic(`Saved canvas device ${savedDeviceId} is not available (${error.code}); opening without it.`);
    }
    if (requestedDeviceId && requestedDeviceId !== savedDeviceId) {
        try {
            return { deviceId: await resolveDeviceId(requestedDeviceId), persist: false };
        } catch (error) {
            if (!isStaleDeviceError(error)) {
                throw error;
            }
        }
    }
    return { deviceId: null, persist: false };
}

/**
 * Serializes work per key. The host can deliver a second `open` for the same
 * instance (a reopen, a rebind) while the first is still creating its server;
 * without this both would create a server and one would leak.
 */
export class KeyedLock {
    constructor() {
        this.tails = new Map();
    }

    async run(key, fn) {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => current);
        this.tails.set(key, tail);
        await previous;
        try {
            return await fn();
        } finally {
            release();
            if (this.tails.get(key) === tail) {
                this.tails.delete(key);
            }
        }
    }

    has(key) {
        return this.tails.has(key);
    }
}

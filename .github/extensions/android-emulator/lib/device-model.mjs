export const DEFAULT_LEASE_TTL_SECONDS = 120;
export const MAX_LEASE_TTL_SECONDS = 900;
export const STREAM_FPS = new Set([30, 60]);
export const STREAM_RESOLUTIONS = new Set([25, 50, 100]);

export const DEVICE_STATES = {
    booted: "Booted",
    booting: "Booting",
    shutdown: "Shutdown",
    shuttingDown: "ShuttingDown",
    unauthorized: "Unauthorized",
    offline: "Offline",
};

/** Rotation index (0-3) as reported by the window manager. */
export const ORIENTATIONS = ["portrait", "landscape", "portrait-upside-down", "landscape-reverse"];

export function orientationFromRotation(rotation) {
    const index = Number(rotation);
    return ORIENTATIONS[Number.isInteger(index) && index >= 0 && index <= 3 ? index : 0];
}

export function rotationFromOrientation(orientation) {
    const index = ORIENTATIONS.indexOf(orientation);
    return index === -1 ? 0 : index;
}

export function isLandscapeOrientation(orientation) {
    return orientation === "landscape" || orientation === "landscape-reverse";
}

export function nowIso() {
    return new Date().toISOString();
}

export function timestampName() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

export function clampTtlSeconds(ttlSeconds) {
    if (typeof ttlSeconds !== "number" || Number.isNaN(ttlSeconds)) {
        return DEFAULT_LEASE_TTL_SECONDS;
    }
    return Math.max(15, Math.min(MAX_LEASE_TTL_SECONDS, Math.floor(ttlSeconds)));
}

/**
 * Devices whose smallest width is at least 600dp are treated as tablets, matching
 * the Android resource qualifier. Falls back to the device name when metrics are
 * not known yet.
 */
export function deviceFamily({ name, avdName, screen } = {}) {
    const width = Number(screen?.width);
    const height = Number(screen?.height);
    const density = Number(screen?.density);
    if (width > 0 && height > 0 && density > 0) {
        const smallestWidthDp = (Math.min(width, height) / density) * 160;
        return smallestWidthDp >= 600 ? "tablet" : "phone";
    }
    return /tablet|\btab\b|pad/i.test(`${avdName ?? ""} ${name ?? ""}`) ? "tablet" : "phone";
}

export function fallbackScreen(device) {
    if (deviceFamily(device) === "tablet") {
        return { width: 1600, height: 2560, density: 320, source: "fallback" };
    }
    return { width: 1080, height: 2400, density: 420, source: "fallback" };
}

/** Human label for an AVD name such as `Pixel_10_Pro_XL`. */
export function humanizeAvdName(avdName) {
    return String(avdName ?? "")
        .replaceAll("_", " ")
        .trim();
}

export function shortDeviceId(deviceId) {
    const value = String(deviceId ?? "");
    return value.length > 18 ? `${value.slice(0, 17)}…` : value;
}

export function androidVersionLabel({ apiLevel, androidVersion }) {
    if (androidVersion && apiLevel) {
        return `Android ${androidVersion} (API ${apiLevel})`;
    }
    if (apiLevel) {
        return `API ${apiLevel}`;
    }
    if (androidVersion) {
        return `Android ${androidVersion}`;
    }
    return "";
}

export function sortDevices(devices) {
    return [...devices].sort((a, b) => {
        const bootRankA = a.state === DEVICE_STATES.booted ? 0 : 1;
        const bootRankB = b.state === DEVICE_STATES.booted ? 0 : 1;
        if (bootRankA !== bootRankB) {
            return bootRankA - bootRankB;
        }
        if (a.kind !== b.kind) {
            return a.kind === "device" ? -1 : 1;
        }
        return String(a.name).localeCompare(String(b.name));
    });
}

/** Even dimensions keep the device encoder happy; clamp to a sane streaming envelope. */
export function clampEncoderSize(width, height) {
    const evenWidth = Math.max(160, Math.min(1920, Math.round(width / 2) * 2));
    const evenHeight = Math.max(160, Math.min(1920, Math.round(height / 2) * 2));
    return { width: evenWidth, height: evenHeight };
}

export function streamSizeFor(screen, resolutionPercent) {
    const width = Number(screen?.width) > 0 ? Number(screen.width) : 1080;
    const height = Number(screen?.height) > 0 ? Number(screen.height) : 2400;
    const scale = (STREAM_RESOLUTIONS.has(resolutionPercent) ? resolutionPercent : 100) / 100;
    return clampEncoderSize(width * scale, height * scale);
}

/**
 * `screenrecord` has no frame-rate flag, so perceived smoothness is approximated
 * through bit-rate: a higher target keeps more detail at 60 fps motion.
 */
export function streamBitRateFor(size, fps) {
    const pixels = size.width * size.height;
    const base = Math.round(pixels * (fps === 60 ? 5.5 : 3.5));
    return Math.max(800_000, Math.min(20_000_000, base));
}

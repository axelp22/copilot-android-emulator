import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.mjs";
import { nowIso, streamBitRateFor, streamSizeFor, timestampName } from "./device-model.mjs";
import { getWmDensity, getWmSize, parsePngDimensions, screencapPng } from "./adb.mjs";
import { createH264Stream } from "./h264-stream.mjs";

export class ScreenService {
    constructor({ state, artifactsRoot, ensureBooted, onDiagnostic }) {
        this.state = state;
        this.artifactsRoot = artifactsRoot;
        this.ensureBooted = ensureBooted;
        this.onDiagnostic = onDiagnostic ?? (() => {});
    }

    async captureScreen(deviceId) {
        await this.ensureBooted(deviceId);
        const artifactsRoot = this.artifactsRoot();
        if (!artifactsRoot) {
            throw new AppError("artifact_root_missing", "Artifact root path is not configured.", 500);
        }

        const serial = this.state.requireSerial(deviceId);
        const dir = path.join(artifactsRoot, deviceId.replace(/[^A-Za-z0-9._-]/g, "_"));
        await mkdir(dir, { recursive: true });
        const filePath = path.join(dir, `capture-${timestampName()}.png`);
        const image = await screencapPng(serial);
        const size = parsePngDimensions(image);
        this.state.updateScreenMetrics(deviceId, size, "screenshot");
        await writeFile(filePath, image);

        const device = this.state.getDeviceOrThrow(deviceId);
        return {
            deviceId,
            serial,
            artifactPath: filePath,
            pixelSize: size,
            density: device.screen?.density ?? null,
            orientation: device.orientation,
            capturedAt: nowIso(),
        };
    }

    async getFramePng(deviceId) {
        await this.ensureBooted(deviceId);
        const serial = this.state.requireSerial(deviceId);
        const image = await screencapPng(serial);
        this.state.updateScreenMetrics(deviceId, parsePngDimensions(image), "screenshot");
        return image;
    }

    /**
     * `wm size` reports the physical panel, but the framebuffer follows the current
     * rotation, so the capture wins for anything coordinate-related.
     */
    async refreshScreenMetrics(deviceId) {
        const serial = this.state.requireSerial(deviceId);
        const [image, density] = await Promise.all([screencapPng(serial), getWmDensity(serial)]);
        const size = parsePngDimensions(image);
        return this.state.updateScreenMetrics(deviceId, { ...size, density: density ?? undefined }, "screenshot");
    }

    async refreshPhysicalMetrics(deviceId) {
        const serial = this.state.requireSerial(deviceId);
        const [size, density] = await Promise.all([getWmSize(serial), getWmDensity(serial)]);
        if (!size) {
            return null;
        }
        return this.state.updateScreenMetrics(deviceId, { ...size, density: density ?? undefined }, "wm");
    }

    async screenSize(deviceId) {
        const serial = this.state.requireSerial(deviceId);
        return parsePngDimensions(await screencapPng(serial));
    }

    async createH264Stream({ deviceId, fps, resolution, timeLimitSeconds }) {
        await this.ensureBooted(deviceId);
        const serial = this.state.requireSerial(deviceId);
        const device = this.state.getDeviceOrThrow(deviceId);
        const size = streamSizeFor(device.screen, resolution);
        const bitRate = streamBitRateFor(size, fps);
        return await createH264Stream({
            serial,
            size,
            bitRate,
            timeLimitSeconds,
            onDiagnostic: (message) => this.onDiagnostic(`[${deviceId}] ${message}`),
        });
    }
}

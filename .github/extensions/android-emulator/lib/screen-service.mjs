import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.mjs";
import { nowIso, streamBitRateFor, streamSizeFor, timestampName } from "./device-model.mjs";
import { getWmDensity, getWmSize, parsePngDimensions, screencapPng } from "./adb.mjs";
import { createH264Stream } from "./h264-stream.mjs";
import { createGrpcFrameStream } from "./grpc-frame-stream.mjs";

export class ScreenService {
    constructor({ state, artifactsRoot, ensureBooted, onDiagnostic, controlPool = null }) {
        this.state = state;
        this.artifactsRoot = artifactsRoot;
        this.ensureBooted = ensureBooted;
        this.onDiagnostic = onDiagnostic ?? (() => {});
        /** Shared emulator gRPC connections; absent means mirror everything. */
        this.controlPool = controlPool;
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

    /**
     * The H.264 mirror, which works for every device class.
     *
     * Physical devices always take this path: they have hardware encoders, and
     * no equivalent of the emulator's control plane exists for them.
     */
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

    /**
     * Picks the best available transport for a device.
     *
     * Emulators prefer their own gRPC control plane, which measures far better
     * than mirroring (~25ms end-to-end at half size against ~200ms) and avoids
     * the `screenrecord` restart, idle-frame and orphaned-process workarounds
     * entirely. Everything else mirrors.
     *
     * Remote setups need no special handling: discovery reads the emulator's
     * local discovery file, so an emulator reached over an adb tunnel is simply
     * never found here and falls through to the mirror, which is what a
     * bandwidth-constrained link wants anyway.
     */
    async createVideoStream({ deviceId, fps, resolution, timeLimitSeconds, transport = "auto" }) {
        const device = this.state.getDeviceOrThrow(deviceId);
        if (transport !== "mirror" && device.kind === "emulator") {
            const stream = await this.#tryGrpcStream({ deviceId, fps, resolution, required: transport === "grpc" });
            if (stream) {
                return stream;
            }
        }
        return await this.createH264Stream({ deviceId, fps, resolution, timeLimitSeconds });
    }

    /**
     * Returns null when gRPC is unusable so the caller can mirror instead. The
     * emulator's gRPC surface is documented as experimental, so losing it must
     * degrade the picture quality, never the session.
     */
    async #tryGrpcStream({ deviceId, fps, resolution, required }) {
        try {
            await this.ensureBooted(deviceId);
            const serial = this.state.requireSerial(deviceId);
            // Borrow the shared connection rather than opening one per stream: the
            // JWT handshake waits for the emulator to accept a published key, and
            // paying that on every quality change would stall the first frame.
            const entry = await this.controlPool?.get(serial);
            if (!entry?.controller) {
                if (required) {
                    throw new AppError(
                        "grpc_unavailable",
                        `No local gRPC endpoint was found for ${deviceId}.`,
                        409,
                    );
                }
                return null;
            }
            const device = this.state.getDeviceOrThrow(deviceId);
            return await createGrpcFrameStream({
                controller: entry.controller,
                size: streamSizeFor(device.screen, resolution),
                fps,
                onDiagnostic: (message) => this.onDiagnostic(`[${deviceId}] ${message}`),
            });
        } catch (error) {
            if (required) {
                throw error;
            }
            this.onDiagnostic(`[${deviceId}] gRPC stream unavailable, mirroring instead: ${error?.message ?? error}`);
            return null;
        }
    }
}

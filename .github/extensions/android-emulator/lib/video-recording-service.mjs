import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.mjs";
import { adb, adbShell, spawnAdb } from "./adb.mjs";
import { nowIso, streamBitRateFor, streamSizeFor, timestampName } from "./device-model.mjs";

const RECORDING_STOP_TIMEOUT_MS = 20_000;
const COMPLETED_RECORDING_LIMIT = 32;
const COMPLETED_RECORDING_TTL_MS = 15 * 60_000;
/** `screenrecord` refuses anything longer. */
const MAX_RECORDING_SECONDS = 180;

/**
 * Records with the device-side `screenrecord`, then pulls the finished MP4 into the
 * session artifacts directory.
 */
export class VideoRecordingService {
    constructor({ state, artifactsRoot, ensureBooted }) {
        this.state = state;
        this.artifactsRoot = artifactsRoot;
        this.ensureBooted = ensureBooted;
        this.active = new Map();
        this.completed = new Map();
    }

    async start({ deviceId, leaseId, maxDurationSeconds }) {
        if (this.active.has(deviceId)) {
            throw new AppError("recording_active", "A video recording is already active for this device.", 409);
        }

        const durationSeconds = Math.max(5, Math.min(MAX_RECORDING_SECONDS, Math.round(maxDurationSeconds ?? 120)));
        const recordingId = randomUUID();
        const recording = {
            recordingId,
            deviceId,
            leaseId,
            serial: null,
            devicePath: null,
            artifactPath: null,
            startedAt: null,
            maxDurationSeconds: durationSeconds,
            child: null,
            stderr: "",
            stopPromise: null,
            timeout: null,
            unsubscribe: null,
        };
        this.active.set(deviceId, recording);

        try {
            await this.ensureBooted(deviceId);
            const artifactsRoot = this.artifactsRoot();
            if (!artifactsRoot) {
                throw new AppError("artifact_root_missing", "Artifact root path is not configured.", 500);
            }
            this.state.assertLease({ deviceId, leaseId });

            const serial = this.state.requireSerial(deviceId);
            const device = this.state.getDeviceOrThrow(deviceId);
            const size = streamSizeFor(device.screen, device.stream?.resolution ?? 100);
            const bitRate = streamBitRateFor(size, device.stream?.fps ?? 30);

            const dir = path.join(artifactsRoot, deviceId.replace(/[^A-Za-z0-9._-]/g, "_"));
            await mkdir(dir, { recursive: true });

            recording.serial = serial;
            recording.devicePath = `/sdcard/copilot-recording-${recordingId}.mp4`;
            recording.artifactPath = path.join(dir, `recording-${timestampName()}.mp4`);
            recording.startedAt = nowIso();
            recording.child = await spawnAdb([
                "-s",
                serial,
                "shell",
                "screenrecord",
                "--bit-rate",
                String(bitRate),
                "--size",
                `${size.width}x${size.height}`,
                "--time-limit",
                String(durationSeconds),
                recording.devicePath,
            ]);
            recording.child.stderr?.on("data", (chunk) => {
                recording.stderr = `${recording.stderr}${chunk}`.slice(-16_384);
            });
            recording.child.on("error", () => {});

            recording.unsubscribe = this.state.subscribe(deviceId, (snapshot) => {
                if (!snapshot.lease?.active || snapshot.lease.leaseId !== leaseId) {
                    void this.finish(recording, "lease-ended").catch(() => {});
                }
            });
            recording.timeout = setTimeout(
                () => {
                    void this.finish(recording, "timeout").catch(() => {});
                },
                (durationSeconds + 5) * 1000,
            );
            recording.timeout.unref?.();

            return this.activeMetadata(recording);
        } catch (error) {
            if (this.active.get(deviceId) === recording) {
                this.active.delete(deviceId);
            }
            recording.unsubscribe?.();
            clearTimeout(recording.timeout);
            recording.child?.kill("SIGTERM");
            throw error;
        }
    }

    async stop({ deviceId, leaseId, recordingId }) {
        const active = this.active.get(deviceId);
        if (active && active.leaseId === leaseId && active.recordingId === recordingId) {
            return await this.finish(active, "requested");
        }

        this.pruneCompleted();
        const completed = this.completed.get(recordingId);
        if (!completed || completed.deviceId !== deviceId || completed.leaseId !== leaseId) {
            throw new AppError("recording_not_found", "Video recording not found or already finalized.", 404);
        }
        this.completed.delete(recordingId);
        return completed.metadata;
    }

    async stopAll() {
        await Promise.allSettled(Array.from(this.active.values(), (recording) => this.finish(recording, "shutdown")));
        this.completed.clear();
    }

    activeMetadata(recording) {
        return {
            recordingId: recording.recordingId,
            deviceId: recording.deviceId,
            artifactPath: recording.artifactPath,
            codec: "h264",
            container: "mp4",
            startedAt: recording.startedAt,
            maxDurationSeconds: recording.maxDurationSeconds,
            recording: true,
        };
    }

    finish(recording, reason) {
        if (recording.stopPromise) {
            return recording.stopPromise;
        }
        recording.stopPromise = this.finalize(recording, reason);
        return recording.stopPromise;
    }

    async finalize(recording, reason) {
        clearTimeout(recording.timeout);
        recording.unsubscribe?.();

        try {
            // SIGINT lets screenrecord write the MP4 trailer; killing adb alone would truncate it.
            await this.interruptDeviceRecorder(recording);
            await this.waitForExit(recording);
            await adb(["-s", recording.serial, "pull", recording.devicePath, recording.artifactPath], {
                timeout: 120_000,
            });
        } finally {
            if (this.active.get(recording.deviceId) === recording) {
                this.active.delete(recording.deviceId);
            }
            await adbShell(recording.serial, ["rm", "-f", recording.devicePath], { timeout: 15_000 }).catch(() => {});
        }

        const file = await stat(recording.artifactPath).catch((error) => {
            throw new AppError(
                "recording_finalize_failed",
                recording.stderr.trim() || error.message || "Video recording was not finalized.",
                502,
            );
        });
        if (file.size === 0) {
            throw new AppError("recording_finalize_failed", "Video recording produced an empty file.", 502);
        }

        const stoppedAt = nowIso();
        const metadata = {
            recordingId: recording.recordingId,
            deviceId: recording.deviceId,
            artifactPath: recording.artifactPath,
            codec: "h264",
            container: "mp4",
            byteSize: file.size,
            startedAt: recording.startedAt,
            stoppedAt,
            durationMs: new Date(stoppedAt).getTime() - new Date(recording.startedAt).getTime(),
            stopReason: reason,
            recording: false,
        };
        if (reason === "lease-ended" || reason === "timeout") {
            this.rememberCompleted(recording, metadata);
        }
        return metadata;
    }

    async interruptDeviceRecorder(recording) {
        if (recording.child?.exitCode !== null || recording.child?.signalCode !== null) {
            return;
        }
        const attempts = [
            ["pkill", "-INT", "screenrecord"],
            ["killall", "-INT", "screenrecord"],
        ];
        for (const command of attempts) {
            try {
                await adbShell(recording.serial, command, { timeout: 15_000 });
                return;
            } catch {
                // Try the next available signal helper.
            }
        }
        recording.child?.kill("SIGINT");
    }

    waitForExit(recording) {
        const child = recording.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                child.kill("SIGTERM");
                resolve();
            }, RECORDING_STOP_TIMEOUT_MS);
            timeout.unref?.();
            child.once("exit", () => {
                clearTimeout(timeout);
                resolve();
            });
            child.once("error", () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    rememberCompleted(recording, metadata) {
        this.pruneCompleted();
        this.completed.set(recording.recordingId, {
            deviceId: recording.deviceId,
            leaseId: recording.leaseId,
            metadata,
            expiresAt: Date.now() + COMPLETED_RECORDING_TTL_MS,
        });
        while (this.completed.size > COMPLETED_RECORDING_LIMIT) {
            this.completed.delete(this.completed.keys().next().value);
        }
    }

    pruneCompleted() {
        const now = Date.now();
        for (const [recordingId, completed] of this.completed) {
            if (completed.expiresAt <= now) {
                this.completed.delete(recordingId);
            }
        }
    }
}

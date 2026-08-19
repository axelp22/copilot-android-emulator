import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { AppError } from "./errors.mjs";
import { adb, screencapPng, spawnAdb } from "./adb.mjs";

/** Wire tags shared with `web/h264-stream.js`. */
export const FRAME_TAGS = {
    config: 0x01,
    keyframe: 0x02,
    delta: 0x03,
    seed: 0x04,
};

const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_IDR = 5;
const NAL_NON_IDR = 1;
const NAL_SEI = 6;
const NAL_AUD = 9;

const MAX_CONSECUTIVE_FAILURES = 3;
const HEALTHY_RUN_MS = 1_500;
const RESTART_BACKOFF_MS = 250;
/**
 * A still screen stops producing frames, which would leave the newest picture
 * stranded behind an undelimited NAL unit. Rather than guess that a partial unit
 * is complete — a truncated sample makes the decoder reject the stream — the
 * current screen is sent once as a PNG seed frame after the encoder goes quiet.
 *
 * Exactly one seed is sent per motion-to-idle transition. Re-capturing on a timer
 * would cost a ~2MB `screencap` every interval for a screen that is not changing.
 */
const IDLE_REFRESH_MS = 800;

/**
 * Wrap one payload as `[uint32 length][uint8 tag][payload]`, where `length`
 * covers the tag byte plus the payload.
 */
export function frame(tag, payload) {
    const out = Buffer.allocUnsafe(payload.length + 5);
    out.writeUInt32BE(payload.length + 1, 0);
    out.writeUInt8(tag, 4);
    payload.copy(out, 5);
    return out;
}

/**
 * Prefix each NAL unit with its 4-byte length and wrap the result in one framed
 * packet. Building both in a single allocation avoids copying every frame twice
 * on the hot path.
 */
export function frameAvccSample(tag, nalUnits) {
    let payloadLength = 0;
    for (const nal of nalUnits) {
        payloadLength += nal.length + 4;
    }
    const out = Buffer.allocUnsafe(payloadLength + 5);
    out.writeUInt32BE(payloadLength + 1, 0);
    out.writeUInt8(tag, 4);
    let offset = 5;
    for (const nal of nalUnits) {
        out.writeUInt32BE(nal.length, offset);
        offset += 4;
        nal.copy(out, offset);
        offset += nal.length;
    }
    return out;
}

/** Build an `avcC` decoder configuration record from raw SPS/PPS NAL units. */
export function buildAvcC(sps, pps) {
    if (!isParameterSet(sps, NAL_SPS, 4) || !isParameterSet(pps, NAL_PPS, 1)) {
        return null;
    }
    return Buffer.concat([
        Buffer.from([
            0x01, // configurationVersion
            sps[1], // AVCProfileIndication
            sps[2], // profile_compatibility
            sps[3], // AVCLevelIndication
            0xff, // 6 bits reserved + lengthSizeMinusOne = 3
            0xe1, // 3 bits reserved + numOfSequenceParameterSets = 1
        ]),
        Buffer.from([(sps.length >> 8) & 0xff, sps.length & 0xff]),
        sps,
        Buffer.from([0x01]), // numOfPictureParameterSets
        Buffer.from([(pps.length >> 8) & 0xff, pps.length & 0xff]),
        pps,
    ]);
}

/**
 * A parameter set must carry the right NAL type, a zero forbidden bit and enough
 * bytes to describe a profile. A truncated SPS would otherwise yield an avcC whose
 * codec string the decoder rejects outright.
 */
function isParameterSet(nal, expectedType, minimumLength) {
    return (
        Buffer.isBuffer(nal) &&
        nal.length >= minimumLength + 1 &&
        (nal[0] & 0x80) === 0 &&
        (nal[0] & 0x1f) === expectedType
    );
}

/** Prefix each NAL unit with its 4-byte length, producing one AVCC sample. */
export function toAvccSample(nalUnits) {
    const parts = [];
    for (const nal of nalUnits) {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(nal.length, 0);
        parts.push(length, nal);
    }
    return Buffer.concat(parts);
}

/**
 * Incremental Annex-B splitter. `screenrecord` emits `00 00 00 01` / `00 00 01`
 * delimited NAL units across arbitrary chunk boundaries.
 */
export function createAnnexBParser(onNalUnit) {
    let buffer = Buffer.alloc(0);
    let started = false;
    let scanned = 0;

    function startCodeAt(data, index) {
        if (index + 3 <= data.length && data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1) {
            return 3;
        }
        if (
            index + 4 <= data.length &&
            data[index] === 0 &&
            data[index + 1] === 0 &&
            data[index + 2] === 0 &&
            data[index + 3] === 1
        ) {
            return 4;
        }
        return 0;
    }

    // rbsp_trailing_bits guarantees a non-zero final byte, so trailing zeroes are
    // Annex-B padding rather than payload.
    function trimTrailingZeroes(nal) {
        let end = nal.length;
        while (end > 0 && nal[end - 1] === 0) {
            end -= 1;
        }
        return end === nal.length ? nal : nal.subarray(0, end);
    }

    return {
        push(chunk) {
            buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);

            let index = scanned;
            while (index < buffer.length) {
                const codeLength = startCodeAt(buffer, index);
                if (codeLength === 0) {
                    index += 1;
                    continue;
                }
                if (started && index > 0) {
                    const nal = trimTrailingZeroes(buffer.subarray(0, index));
                    if (nal.length > 0) {
                        onNalUnit(Buffer.from(nal), { speculative: false });
                    }
                }
                buffer = Buffer.from(buffer.subarray(index + codeLength));
                started = true;
                index = 0;
            }

            // Re-examine the tail next time: a start code may straddle the chunk boundary.
            scanned = Math.max(0, buffer.length - 3);
        },
        /**
         * Emit the trailing NAL unit. Annex-B only delimits units by the *next* start
         * code, so a still screen would otherwise strand its last frame in the buffer.
         * Callers flush on idle and at end of stream. The unit is reported as
         * speculative because a stall mid-unit would otherwise truncate it.
         */
        flush() {
            if (!started || buffer.length === 0) {
                return false;
            }
            const nal = trimTrailingZeroes(buffer);
            buffer = Buffer.alloc(0);
            scanned = 0;
            if (nal.length === 0) {
                return false;
            }
            onNalUnit(Buffer.from(nal), { speculative: true });
            return true;
        },
        reset() {
            buffer = Buffer.alloc(0);
            started = false;
            scanned = 0;
        },
    };
}

/**
 * A `screenrecord`-backed H.264 source that presents the ChildProcess-ish surface
 * the canvas server expects (`stdout`, `kill`, `on("exit")`).
 *
 * `screenrecord` hard-stops after at most 180 seconds, so the child is respawned
 * transparently and parameter sets are re-sent on every restart. Consumers never
 * see the seam.
 */
export async function createH264Stream({
    serial,
    size,
    bitRate,
    timeLimitSeconds = 180,
    seed = true,
    onDiagnostic,
}) {
    const stdout = new PassThrough({ highWaterMark: 1 << 20 });
    // Destroying the stream with an error is how failures propagate, so guarantee a
    // listener exists: an unhandled 'error' here would take down the extension host
    // if the consumer had not attached one yet.
    stdout.on("error", () => {});
    const listeners = { error: new Set(), exit: new Set() };

    let child = null;
    let stopped = false;
    let stderrText = "";
    let consecutiveFailures = 0;
    let restartTimer = null;
    let sps = null;
    let pps = null;
    let lastConfig = null;
    let pendingPrefix = [];
    let restartCount = 0;
    let idleTimer = null;
    // Killing the local adb process does not reliably stop the device-side
    // `screenrecord`. Orphans hold an encoder slot, and enough of them wedge the
    // device so every later stream returns nothing, so the PID is recorded and
    // signalled explicitly on teardown.
    const pidPath = `/data/local/tmp/copilot-stream-${randomBytes(6).toString("hex")}.pid`;
    let reapPromise = null;
    let seedInFlight = false;
    let idleSeedSent = false;
    let videoGeneration = 0;
    let backpressured = false;
    let drainListenerAttached = false;

    const parser = createAnnexBParser(handleNalUnit);

    function scheduleIdleRefresh() {
        clearTimeout(idleTimer);
        idleTimer = null;
        // One seed per quiet period: re-armed by the next byte of video.
        if (stopped || idleSeedSent || seedInFlight || backpressured) {
            return;
        }
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (stopped || idleSeedSent || seedInFlight || backpressured) {
                return;
            }
            idleSeedSent = true;
            void sendSeedFrame();
        }, IDLE_REFRESH_MS);
        idleTimer.unref?.();
    }

    function emit(event, ...args) {
        for (const handler of listeners[event] ?? []) {
            try {
                handler(...args);
            } catch {
                // Listener failures must not tear down the stream loop.
            }
        }
    }

    /**
     * A slow consumer must throttle every producer, not just the encoder: a queued
     * PNG seed is megabytes, and one `drain` listener per failed write would pile up.
     */
    function write(buffer) {
        if (stopped || stdout.destroyed || stdout.writableEnded) {
            return;
        }
        if (stdout.write(buffer)) {
            return;
        }
        backpressured = true;
        child?.stdout?.pause();
        if (drainListenerAttached) {
            return;
        }
        drainListenerAttached = true;
        stdout.once("drain", () => {
            drainListenerAttached = false;
            backpressured = false;
            if (!stopped) {
                child?.stdout?.resume();
            }
        });
    }

    function sendConfig({ force = false } = {}) {
        const avcC = buildAvcC(sps, pps);
        if (!avcC) {
            return;
        }
        if (!force && lastConfig && avcC.equals(lastConfig)) {
            return;
        }
        lastConfig = avcC;
        write(frame(FRAME_TAGS.config, avcC));
    }

    function handleNalUnit(nal, { speculative = false } = {}) {
        const type = nal[0] & 0x1f;
        if (type === NAL_SPS || type === NAL_PPS) {
            // An idle flush fires when the pipe stalls, which can happen part-way
            // through a unit. A truncated parameter set produces an avcC whose codec
            // string the decoder rejects, so only accept delimited ones. Parameter
            // sets always precede a frame, so a real copy follows immediately.
            if (speculative) {
                return;
            }
            if (type === NAL_SPS) {
                sps = nal;
            } else {
                pps = nal;
            }
            sendConfig();
            return;
        }
        if (type === NAL_SEI || type === NAL_AUD) {
            pendingPrefix.push(nal);
            if (pendingPrefix.length > 8) {
                pendingPrefix = pendingPrefix.slice(-8);
            }
            return;
        }
        if (type !== NAL_IDR && type !== NAL_NON_IDR) {
            return;
        }

        const isKeyframe = type === NAL_IDR;
        // In-band parameter sets on every keyframe keep decoding recoverable after a restart.
        const units = isKeyframe && sps && pps ? [sps, pps, ...pendingPrefix, nal] : [...pendingPrefix, nal];
        pendingPrefix = [];
        write(frameAvccSample(isKeyframe ? FRAME_TAGS.keyframe : FRAME_TAGS.delta, units));
    }

    /**
     * The connect-time seed is sent unconditionally so the canvas paints before the
     * first decodable frame, as the streaming design requires; at worst it is
     * overwritten by the next video frame a few milliseconds later. An idle seed
     * instead guards on the video generation, because there a stale still would
     * replace a newer decoded frame for as long as the screen stays quiet.
     */
    async function sendSeedFrame({ initial = false } = {}) {
        if (seedInFlight) {
            return;
        }
        seedInFlight = true;
        const generation = videoGeneration;
        try {
            const png = await screencapPng(serial);
            const superseded = !initial && generation !== videoGeneration;
            if (!stopped && !superseded) {
                write(frame(FRAME_TAGS.seed, png));
            }
        } catch (error) {
            onDiagnostic?.(`seed frame unavailable: ${error?.message ?? error}`);
        } finally {
            seedInFlight = false;
        }
    }

    function screenrecordArgs() {
        const flags = [
            "screenrecord",
            "--output-format=h264",
            "--size",
            `${size.width}x${size.height}`,
            "--bit-rate",
            String(bitRate),
        ];
        if (timeLimitSeconds) {
            flags.push("--time-limit", String(Math.max(1, Math.min(180, Math.round(timeLimitSeconds)))));
        }
        flags.push("-");
        // The PID goes to a file, so stdout stays a clean Annex-B byte stream.
        return ["-s", serial, "exec-out", `${flags.join(" ")} & echo $! > '${pidPath}'; wait $!`];
    }

    /**
     * Reap the device-side recorder and its PID file. The returned promise must be
     * awaited during teardown: if the host process exits first the recorder survives
     * as an orphan holding an encoder slot.
     */
    function reapDeviceRecorder() {
        reapPromise = adb(
            ["-s", serial, "shell", `kill -INT $(cat '${pidPath}' 2>/dev/null) 2>/dev/null; rm -f '${pidPath}'`],
            { timeout: 10_000 },
        )
            .then(() => {})
            .catch(() => {});
        return reapPromise;
    }

    async function spawnOnce() {
        const startedAt = Date.now();
        let producedOutput = false;
        const next = await spawnAdb(screenrecordArgs());
        child = next;

        next.stdout.on("data", (chunk) => {
            producedOutput = true;
            // The screen is moving again: allow the next quiet period to seed once.
            videoGeneration += 1;
            idleSeedSent = false;
            parser.push(chunk);
            scheduleIdleRefresh();
        });
        next.stdout.on("error", () => {});
        next.stderr?.on("data", (chunk) => {
            stderrText = `${stderrText}${chunk}`.slice(-8_192);
        });
        next.on("error", (error) => {
            if (!stopped) {
                fail(new AppError("stream_spawn_failed", error.message, 502));
            }
        });
        next.on("exit", (code, signal) => {
            if (child === next) {
                child = null;
            }
            clearTimeout(idleTimer);
            idleTimer = null;
            if (!stopped && code === 0 && signal == null) {
                // A clean exit means the last unit was written in full, so it is safe
                // to deliver. A killed child may have been cut mid-unit.
                parser.flush();
            }
            if (stopped) {
                return;
            }

            const ranLongEnough = Date.now() - startedAt >= HEALTHY_RUN_MS;
            if (ranLongEnough && producedOutput) {
                // Only a genuinely healthy run clears the counter. Resetting on the
                // first output byte would let a child that emits a header and then
                // crashes respawn forever.
                consecutiveFailures = 0;
            } else if (!producedOutput || (code !== 0 && signal == null)) {
                // A device whose media encoder is stuck exits cleanly having written
                // nothing. Without counting that, the loop would respawn for ever and
                // the canvas would sit blank with no explanation.
                consecutiveFailures += 1;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    const detail = producedOutput
                        ? stderrText.trim() || `screenrecord exited with code ${code}.`
                        : stderrText.trim() ||
                          "screenrecord produced no video. The device encoder may be stuck; restart the emulator or device.";
                    fail(new AppError("stream_failed", detail, 502));
                    return;
                }
            }

            restartCount += 1;
            onDiagnostic?.(`screenrecord restart #${restartCount} (code=${code} signal=${signal ?? "none"})`);
            // Discard the truncated trailing NAL unit before the next run's parameter sets.
            parser.reset();
            pendingPrefix = [];
            restartTimer = setTimeout(() => {
                restartTimer = null;
                if (stopped) {
                    return;
                }
                void spawnOnce().then(
                    () => sendConfig({ force: true }),
                    (error) => fail(error),
                );
            }, RESTART_BACKOFF_MS);
            restartTimer.unref?.();
        });
    }

    function fail(error) {
        if (stopped) {
            return;
        }
        stopped = true;
        clearTimeout(restartTimer);
        clearTimeout(idleTimer);
        child?.kill("SIGTERM");
        child = null;
        reapDeviceRecorder();
        emit("error", error);
        stdout.destroy(error);
        emit("exit", 1, null);
    }

    await spawnOnce();
    if (seed) {
        void sendSeedFrame({ initial: true });
    }

    return {
        stdout,
        get killed() {
            return stopped;
        },
        stderrText: () => stderrText.trim(),
        restartCountValue: () => restartCount,
        /** Resolves once the device-side recorder has been signalled. */
        whenReaped: () => reapPromise ?? Promise.resolve(),
        on(event, handler) {
            listeners[event]?.add(handler);
            return this;
        },
        off(event, handler) {
            listeners[event]?.delete(handler);
            return this;
        },
        kill() {
            if (stopped) {
                return;
            }
            stopped = true;
            clearTimeout(restartTimer);
            clearTimeout(idleTimer);
            restartTimer = null;
            idleTimer = null;
            const current = child;
            child = null;
            current?.kill("SIGTERM");
            reapDeviceRecorder();
            if (!stdout.writableEnded) {
                stdout.end();
            }
            emit("exit", 0, "SIGTERM");
        },
    };
}

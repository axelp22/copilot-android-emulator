/**
 * A `streamScreenshot`-backed frame source for emulators.
 *
 * This is the embedded alternative to mirroring with `screenrecord`. Talking to
 * the emulator's own gRPC control plane removes every workaround the `adb` path
 * needs: there is no 180-second recorder limit to paper over, no orphaned
 * device-side process to reap, no encoder slot to contend for, and no idle
 * screen problem, because a still screen simply stops producing frames.
 *
 * Frames are emitted as PNG under the existing `seed` tag, so the canvas paints
 * them through the code path it already uses and no new wire format is
 * introduced. PNG measures dramatically better than raw RGB888 here: the
 * emulator encodes it host-side in single-digit milliseconds, and a half-size
 * frame is ~105KB against ~3MB raw, which is the difference between ~21fps and
 * ~2fps on the same connection.
 */
import { PassThrough } from "node:stream";
import { AppError } from "./errors.mjs";
import { FRAME_TAGS, frame } from "./h264-stream.mjs";
import { IMG_FORMAT } from "./emulator-controller.mjs";

const MAX_CONSECUTIVE_FAILURES = 3;
const RESTART_BACKOFF_MS = 400;
/** A stream that ran this long before failing counts as healthy, not flapping. */
const HEALTHY_RUN_MS = 5_000;

/**
 * @param {object} options
 * @param {object} options.controller An `EmulatorController` from the shared pool.
 *   The connection is borrowed, not owned: input uses the same one, and it must
 *   survive the stream restarts the canvas triggers on every quality change.
 * @param {{width:number,height:number}} options.size Desired frame bounds.
 * @param {number} [options.fps] Upper bound on emitted frames per second.
 */
export async function createGrpcFrameStream({ controller, size, fps = 60, onDiagnostic }) {
    if (!controller) {
        throw new AppError("grpc_unavailable", "This emulator has no gRPC control connection.", 409);
    }

    const stdout = new PassThrough({ highWaterMark: 1 << 20 });
    // Failures propagate by destroying the stream, so a listener must always
    // exist: an unhandled 'error' would take down the extension host.
    stdout.on("error", () => {});
    const listeners = { error: new Set(), exit: new Set() };

    const minFrameIntervalMs = fps > 0 ? 1000 / fps : 0;
    const imageFormat = { format: IMG_FORMAT.png, width: size?.width ?? 0, height: size?.height ?? 0 };

    let stopped = false;
    let abort = null;
    let restartTimer = null;
    let consecutiveFailures = 0;
    let restartCount = 0;
    let lastEmitAt = 0;
    let backpressured = false;
    let drainListenerAttached = false;
    let lastError = "";

    function emit(event, ...args) {
        for (const handler of listeners[event] ?? []) {
            try {
                handler(...args);
            } catch {
                // A listener must not tear down the stream loop.
            }
        }
    }

    /**
     * Every frame is a complete picture, so a slow consumer is handled by
     * dropping rather than queueing. That is only safe because these are stills:
     * the H.264 source cannot drop a delta without corrupting the decoder, but
     * here the next frame supersedes whatever was skipped.
     */
    function write(payload) {
        if (stopped || stdout.destroyed || stdout.writableEnded) {
            return;
        }
        if (stdout.write(payload)) {
            return;
        }
        backpressured = true;
        if (drainListenerAttached) {
            return;
        }
        drainListenerAttached = true;
        stdout.once("drain", () => {
            drainListenerAttached = false;
            backpressured = false;
        });
    }

    function onImage(image) {
        if (stopped || backpressured || !image?.pixels?.length) {
            return;
        }
        const now = Date.now();
        if (minFrameIntervalMs && now - lastEmitAt < minFrameIntervalMs) {
            return;
        }
        lastEmitAt = now;
        consecutiveFailures = 0;
        write(frame(FRAME_TAGS.seed, image.pixels));
    }

    function fail(error) {
        if (stopped) {
            return;
        }
        stopped = true;
        clearTimeout(restartTimer);
        abort?.abort();
        emit("error", error);
        stdout.destroy(error);
        emit("exit", 1, null);
    }

    /**
     * The emulator can drop the stream when the display reconfigures (a rotation
     * or a fold), so a failed run is retried rather than treated as fatal.
     */
    function runStream() {
        if (stopped) {
            return;
        }
        abort = new AbortController();
        const startedAt = Date.now();
        controller
            .streamScreenshot(imageFormat, { onImage, signal: abort.signal })
            .then(
                () => ({ error: null }),
                (error) => ({ error }),
            )
            .then(({ error }) => {
                if (stopped) {
                    return;
                }
                if (Date.now() - startedAt >= HEALTHY_RUN_MS) {
                    consecutiveFailures = 0;
                }
                consecutiveFailures += 1;
                lastError = error?.message ?? "screenshot stream ended";
                if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
                    fail(
                        error instanceof AppError
                            ? error
                            : new AppError("grpc_stream_failed", lastError, 502),
                    );
                    return;
                }
                restartCount += 1;
                onDiagnostic?.(`gRPC screenshot stream restart #${restartCount}: ${lastError}`);
                restartTimer = setTimeout(runStream, RESTART_BACKOFF_MS);
                restartTimer.unref?.();
            });
    }

    // Paint immediately rather than waiting for the guest to post its next frame:
    // on a still screen that could be an arbitrarily long wait. A failure here
    // means gRPC is unusable for this device, and it propagates so the caller can
    // fall back to mirroring before any bytes have been sent.
    const first = await controller.getScreenshot(imageFormat, { timeoutMs: 10_000 });
    if (first.pixels?.length) {
        lastEmitAt = Date.now();
        write(frame(FRAME_TAGS.seed, first.pixels));
    }

    runStream();

    return {
        stdout,
        /** Complete stills, so the client must not equate silence with a stall. */
        transport: "grpc",
        get killed() {
            return stopped;
        },
        stderrText: () => lastError,
        restartCountValue: () => restartCount,
        /** Kept for parity with the `screenrecord` source, which reaps a child. */
        whenReaped: () => Promise.resolve(),
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
            restartTimer = null;
            abort?.abort();
            if (!stdout.writableEnded) {
                stdout.end();
            }
            emit("exit", 0, "SIGTERM");
        },
    };
}

function avcCodecString(description) {
    if (description.length < 4) {
        return "avc1.64001f";
    }
    return `avc1.${[description[1], description[2], description[3]]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")}`;
}

/** An avcC record starts with configurationVersion 1 and carries at least one SPS. */
function looksLikeAvcC(description) {
    return description instanceof Uint8Array && description.length >= 7 && description[0] === 0x01;
}

function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) {
        return false;
    }
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) {
            return false;
        }
    }
    return true;
}

export function supportsVideoDecoder() {
    return typeof window !== "undefined" && "VideoDecoder" in window;
}

/**
 * Reads the tagged framing produced by `lib/h264-stream.mjs`:
 * `[uint32 length][uint8 tag][payload]`, where tag `0x01` is the avcC decoder
 * config, `0x02`/`0x03` are AVCC key/delta samples, and `0x04` is a PNG seed
 * frame that paints the canvas before the first keyframe arrives.
 */
export function createH264StreamController({ onFrame, onError }) {
    let abortController = null;
    let decoder = null;
    let timestamp = 0;
    let failed = false;
    let currentDescription = null;
    let lastGoodDescription = null;
    let awaitingKeyframe = false;
    let recoveryAttempts = 0;
    let recoveryWindowStartedAt = 0;

    function stop() {
        abortController?.abort();
        abortController = null;
        if (decoder) {
            try {
                decoder.close();
            } catch {
                // The decoder may already be closed.
            }
        }
        decoder = null;
        currentDescription = null;
        awaitingKeyframe = false;
    }

    function fail(error) {
        if (failed) {
            return;
        }
        failed = true;
        stop();
        onError(error);
    }

    /**
     * A corrupt sample must not blank the canvas for good. Rebuild the decoder from
     * the last known-good configuration straight away and resume at the next
     * keyframe: waiting for the stream to re-send parameter sets would freeze the
     * picture until the next `screenrecord` restart, up to 180 seconds away.
     */
    function recoverDecoder() {
        if (decoder) {
            try {
                decoder.close();
            } catch {
                // Already closed.
            }
        }
        decoder = null;
        currentDescription = null;
        awaitingKeyframe = true;

        // Bound the retries: a decoder that fails immediately every time would
        // otherwise recurse. The caller's watchdog takes over from here.
        const now = Date.now();
        if (now - recoveryWindowStartedAt > 10_000) {
            recoveryWindowStartedAt = now;
            recoveryAttempts = 0;
        }
        recoveryAttempts += 1;
        if (recoveryAttempts > 3) {
            return;
        }
        if (lastGoodDescription) {
            configureDecoder(lastGoodDescription, { recovering: true });
        }
    }

    function configureDecoder(description, { recovering = false } = {}) {
        if (!supportsVideoDecoder()) {
            throw new Error("This canvas runtime does not expose WebCodecs VideoDecoder.");
        }
        if (!looksLikeAvcC(description)) {
            return;
        }
        // The stream re-sends parameter sets after every `screenrecord` restart.
        // Reconfiguring for identical bytes would flush the decoder for no reason.
        if (decoder && sameBytes(currentDescription, description)) {
            return;
        }

        const next = new VideoDecoder({
            output: (videoFrame) => {
                try {
                    onFrame(videoFrame);
                } catch (error) {
                    fail(error);
                } finally {
                    videoFrame.close();
                }
            },
            error: recoverDecoder,
        });
        try {
            next.configure({
                codec: avcCodecString(description),
                description,
                optimizeForLatency: true,
            });
        } catch {
            // Keep decoding with the existing configuration; the stream re-sends
            // parameter sets, so a usable one should follow.
            try {
                next.close();
            } catch {
                // Already closed.
            }
            return;
        }

        if (decoder) {
            decoder.close();
        }
        timestamp = 0;
        currentDescription = description.slice();
        lastGoodDescription = currentDescription;
        // After a decode error, wait for a keyframe before feeding deltas again.
        awaitingKeyframe = recovering;
        decoder = next;
    }

    async function drawSeed(payload) {
        const bitmap = await createImageBitmap(new Blob([payload], { type: "image/png" }));
        try {
            onFrame(bitmap);
        } finally {
            bitmap.close();
        }
    }

    async function start({ url, fps }) {
        stop();
        failed = false;
        abortController = new AbortController();
        const signal = abortController.signal;

        try {
            const response = await fetch(url, { signal });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(payload?.error?.message ?? `H.264 stream failed (${response.status})`);
            }
            const reader = response.body.getReader();
            let buffer = new Uint8Array(0);
            while (!signal.aborted) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                const next = new Uint8Array(buffer.length + value.length);
                next.set(buffer);
                next.set(value, buffer.length);
                buffer = next;

                let offset = 0;
                while (buffer.length - offset >= 5) {
                    const length =
                        ((buffer[offset] << 24) |
                            (buffer[offset + 1] << 16) |
                            (buffer[offset + 2] << 8) |
                            buffer[offset + 3]) >>>
                        0;
                    if (buffer.length - offset < 4 + length) {
                        break;
                    }
                    const tag = buffer[offset + 4];
                    const payload = buffer.subarray(offset + 5, offset + 4 + length);
                    offset += 4 + length;
                    if (tag === 0x01) {
                        configureDecoder(payload);
                    } else if (tag === 0x02 || tag === 0x03) {
                        if (!decoder) {
                            continue;
                        }
                        if (awaitingKeyframe) {
                            if (tag !== 0x02) {
                                continue;
                            }
                            awaitingKeyframe = false;
                        }
                        timestamp += Math.round(1_000_000 / fps);
                        try {
                            decoder.decode(
                                new EncodedVideoChunk({
                                    type: tag === 0x02 ? "key" : "delta",
                                    timestamp,
                                    data: payload,
                                }),
                            );
                        } catch {
                            recoverDecoder();
                        }
                    } else if (tag === 0x04) {
                        await drawSeed(payload);
                    }
                }
                if (offset > 0) {
                    buffer = buffer.subarray(offset);
                }
            }
        } catch (error) {
            if (!signal.aborted) {
                fail(error);
            }
        }
    }

    return { start, stop };
}

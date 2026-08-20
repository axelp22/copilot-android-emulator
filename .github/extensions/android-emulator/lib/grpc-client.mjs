/**
 * A dependency-free gRPC client built on `node:http2`.
 *
 * `@grpc/grpc-js` would pull the extension's first runtime dependency, which the
 * install story explicitly rules out. gRPC over HTTP/2 is a thin envelope, and
 * the emulator only needs unary plus server-streaming calls, so the subset below
 * is implemented directly.
 *
 * Wire format per message: `[uint8 compressedFlag][uint32be length][payload]`.
 */
import http2 from "node:http2";
import { AppError } from "./errors.mjs";

/** The status codes this client actually reacts to. */
export const GRPC_STATUS = {
    ok: 0,
    cancelled: 1,
    invalidArgument: 3,
    deadlineExceeded: 4,
    permissionDenied: 7,
    failedPrecondition: 9,
    unimplemented: 12,
    unavailable: 14,
    unauthenticated: 16,
};

const STATUS_NAMES = Object.fromEntries(Object.entries(GRPC_STATUS).map(([name, code]) => [code, name]));

/**
 * HTTP/2 receive window, session- and stream-wide. Sized above a full-resolution
 * RGB888 frame (a 1344x2992 device is ~12MB) so a single frame can never exhaust
 * the window on its own.
 */
const WINDOW_SIZE = 32 * 1024 * 1024;

/**
 * Upper bound on a single decoded message, above the largest frame the emulator
 * sends but far below the 4GB a `uint32` length prefix can claim.
 */
const MAX_GRPC_MESSAGE_BYTES = 128 * 1024 * 1024;

function statusError(status, message, method) {
    const name = STATUS_NAMES[status] ?? `code_${status}`;
    // Auth failures are the ones worth naming precisely: they are the difference
    // between "retry later" and "this emulator will never accept us".
    const retryable = status === GRPC_STATUS.unavailable || status === GRPC_STATUS.deadlineExceeded;
    const error = new AppError(
        `grpc_${name}`,
        `${method} failed (${name})${message ? `: ${message}` : ""}`,
        status === GRPC_STATUS.unauthenticated || status === GRPC_STATUS.permissionDenied ? 403 : 502,
    );
    error.grpcStatus = status;
    error.retryable = retryable;
    return error;
}

/** Wrap one payload in the gRPC length-prefixed envelope. */
export function encodeGrpcMessage(payload) {
    const out = Buffer.allocUnsafe(payload.length + 5);
    out.writeUInt8(0, 0); // no compression
    out.writeUInt32BE(payload.length, 1);
    payload.copy(out, 5);
    return out;
}

/**
 * Incremental reader for the gRPC envelope. Messages routinely straddle HTTP/2
 * DATA frames, and a multi-megabyte screenshot always does.
 *
 * Two opposite workloads have to stay cheap, and the obvious implementations are
 * quadratic in one or the other. Concatenating on every DATA frame recopies the
 * whole message while a large one is still arriving; joining per message recopies
 * the whole remainder when one chunk holds many small messages. So chunks are
 * held unjoined until at least one message is complete, then joined once and
 * drained with an offset, copying only the trailing remainder.
 */
export function createGrpcMessageParser(onMessage) {
    let chunks = [];
    let buffered = 0;

    /** Reads one byte across the chunk boundaries, so the 5-byte header can be
     * inspected without joining what may be tens of megabytes behind it. */
    function byteAt(index) {
        let remaining = index;
        for (const chunk of chunks) {
            if (remaining < chunk.length) {
                return chunk[remaining];
            }
            remaining -= chunk.length;
        }
        return 0;
    }

    function assertLength(length) {
        if (length > MAX_GRPC_MESSAGE_BYTES) {
            // Otherwise a bad length prefix makes this buffer toward 4GB waiting
            // for a message that will never be completed.
            throw new AppError(
                "grpc_message_too_large",
                `gRPC message of ${length} bytes exceeds the ${MAX_GRPC_MESSAGE_BYTES}-byte limit.`,
                502,
            );
        }
    }

    return function push(chunk) {
        chunks.push(chunk);
        buffered += chunk.length;
        if (buffered < 5) {
            return;
        }

        // Peek the first header while still unjoined: a single large message
        // arriving over many frames must not be recopied on each one.
        const firstLength = ((byteAt(1) << 24) | (byteAt(2) << 16) | (byteAt(3) << 8) | byteAt(4)) >>> 0;
        assertLength(firstLength);
        if (buffered < 5 + firstLength) {
            return;
        }

        const joined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
        let offset = 0;
        while (buffered - offset >= 5) {
            const length = joined.readUInt32BE(offset + 1);
            assertLength(length);
            if (buffered - offset < 5 + length) {
                break;
            }
            // Copy: the caller may retain the payload, and a subarray of `joined`
            // would pin the whole backing store behind it.
            onMessage(Buffer.from(joined.subarray(offset + 5, offset + 5 + length)));
            offset += 5 + length;
        }

        const rest = joined.subarray(offset);
        chunks = rest.length > 0 ? [Buffer.from(rest)] : [];
        buffered = rest.length;
    };
}

/**
 * @param {object} options
 * @param {number} options.port gRPC port from the emulator discovery file.
 * @param {() => Promise<string|null>} [options.authorization] Bearer token provider,
 *   consulted per request so an expiring JWT can be refreshed transparently.
 */
export function createGrpcChannel({ host = "127.0.0.1", port, authorization = null, onDiagnostic }) {
    let session = null;
    let closed = false;

    function connect() {
        if (closed) {
            throw new AppError("grpc_closed", "This gRPC channel has been closed.", 500);
        }
        if (session && !session.closed && !session.destroyed) {
            return session;
        }
        const created = http2.connect(`http://${host}:${port}`, {
            // Screenshot frames are hundreds of kilobytes to tens of megabytes,
            // against a 64KB default receive window. Without a window this large
            // the server sends exactly one frame and then stalls forever waiting
            // for capacity, which looks indistinguishable from an idle screen.
            settings: { initialWindowSize: WINDOW_SIZE },
        });
        session = created;
        // The session-level window is separate from the per-stream window and is
        // not covered by the SETTINGS frame above. It can only be set once the
        // underlying handle exists, so it waits for the connect event.
        created.once("connect", (connected) => {
            try {
                connected.setLocalWindowSize(WINDOW_SIZE);
            } catch (error) {
                onDiagnostic?.(`could not widen gRPC session window: ${error?.message ?? error}`);
            }
        });
        // An unhandled 'error' on the session would take down the extension host.
        created.on("error", (error) => {
            onDiagnostic?.(`grpc session error: ${error?.message ?? error}`);
        });
        // 'close' arrives after the session is destroyed, by which time connect()
        // may already have installed a replacement. Clearing the shared reference
        // unconditionally would orphan that healthy session and leak its socket.
        created.on("close", () => {
            if (session === created) {
                session = null;
            }
        });
        return created;
    }

    async function requestHeaders(method) {
        const headers = {
            ":method": "POST",
            ":path": method,
            "content-type": "application/grpc",
            te: "trailers",
        };
        const token = await authorization?.();
        if (token) {
            headers.authorization = `Bearer ${token}`;
        }
        return headers;
    }

    /**
     * Shared call driver. `onMessage` is invoked per response message; the promise
     * settles when the RPC terminates.
     */
    async function call(method, payload, { onMessage, signal, timeoutMs = 0 } = {}) {
        const headers = await requestHeaders(method);
        const active = connect();

        return await new Promise((resolve, reject) => {
            let settled = false;
            let status = null;
            let statusMessage = "";
            let timer = null;

            const req = active.request(headers);
            const parse = createGrpcMessageParser((message) => {
                if (settled) {
                    return;
                }
                try {
                    onMessage?.(message);
                } catch (error) {
                    finish(error);
                }
            });

            function cleanup() {
                clearTimeout(timer);
                signal?.removeEventListener?.("abort", onAbort);
                if (!req.destroyed) {
                    req.destroy();
                }
            }

            function finish(error) {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                error ? reject(error) : resolve();
            }

            function onAbort() {
                finish(new AppError("grpc_cancelled", `${method} was cancelled.`, 499));
            }

            function readStatus(incoming) {
                if (incoming["grpc-status"] !== undefined) {
                    status = Number(incoming["grpc-status"]);
                }
                if (incoming["grpc-message"]) {
                    statusMessage = decodeURIComponent(incoming["grpc-message"]);
                }
            }

            if (signal?.aborted) {
                finish(new AppError("grpc_cancelled", `${method} was cancelled.`, 499));
                return;
            }
            signal?.addEventListener?.("abort", onAbort, { once: true });

            if (timeoutMs > 0) {
                timer = setTimeout(
                    () => finish(statusError(GRPC_STATUS.deadlineExceeded, `no response in ${timeoutMs}ms`, method)),
                    timeoutMs,
                );
                timer.unref?.();
            }

            req.on("response", (incoming) => {
                // A trailers-only response carries the status here; HTTP-level
                // failures (a non-200 :status) never reach the trailers event.
                readStatus(incoming);
                const httpStatus = Number(incoming[":status"]);
                if (httpStatus && httpStatus !== 200 && status === null) {
                    finish(new AppError("grpc_http_error", `${method} failed with HTTP ${httpStatus}.`, 502));
                }
            });
            req.on("trailers", readStatus);
            req.on("data", (chunk) => {
                // The parser rejects a malformed envelope by throwing, and this is a
                // raw emitter callback: an escaping throw is an uncaught exception,
                // which ends the process instead of failing this one RPC.
                try {
                    parse(chunk);
                } catch (error) {
                    finish(error);
                }
            });
            req.on("error", (error) =>
                finish(new AppError("grpc_transport_error", `${method} failed: ${error.message}`, 502)),
            );
            req.on("end", () => {
                if (status !== null && status !== GRPC_STATUS.ok) {
                    finish(statusError(status, statusMessage, method));
                    return;
                }
                finish();
            });

            req.end(encodeGrpcMessage(payload));
        });
    }

    return {
        /** Unary call: resolves with the single response message. */
        async unary(method, payload, { signal, timeoutMs = 15_000 } = {}) {
            let response = null;
            await call(method, payload, {
                signal,
                timeoutMs,
                onMessage: (message) => {
                    response ??= message;
                },
            });
            if (!response) {
                throw new AppError("grpc_empty_response", `${method} returned no message.`, 502);
            }
            return response;
        },

        /**
         * Server-streaming call. No default deadline: these streams are meant to
         * stay open for the device's lifetime.
         */
        serverStream(method, payload, { onMessage, signal, timeoutMs = 0 } = {}) {
            return call(method, payload, { onMessage, signal, timeoutMs });
        },

        close() {
            closed = true;
            session?.close();
            session = null;
        },
    };
}

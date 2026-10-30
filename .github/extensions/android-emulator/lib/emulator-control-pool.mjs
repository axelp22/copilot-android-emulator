/**
 * Shared, lazily created `EmulatorController` connections keyed by adb serial.
 *
 * Input needs a connection whose lifetime is independent of any video stream:
 * the canvas restarts the stream whenever fps or resolution changes, and a
 * pointer gesture must survive that. The frame source therefore keeps its own
 * channel, and this pool serves the short control calls.
 *
 * Entries are created on demand and dropped when a device goes away, so a
 * device that never receives input never opens a connection.
 */
import { findEmulatorBySerial } from "./emulator-discovery.mjs";
import { issuerForEmulator } from "./emulator-access.mjs";
import { createEmulatorTokenProvider } from "./emulator-jwt.mjs";
import { createGrpcChannel, GRPC_STATUS } from "./grpc-client.mjs";
import { createEmulatorController } from "./emulator-controller.mjs";

/** How long a first transient handshake failure keeps a device on the mirror. */
export const RETRY_BACKOFF_MS = 30_000;
/** Ceiling for the doubling backoff, so a flapping emulator is still retried. */
export const MAX_RETRY_BACKOFF_MS = 5 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Opens tokens, channel and controller for one emulator and proves the
 * credentials. Anything opened is closed again if the handshake fails, so a
 * timed-out cold boot does not leak a channel per retry.
 */
export async function connectEmulator(emulator, { onDiagnostic }) {
    const tokens = createEmulatorTokenProvider({
        jwksDir: emulator.jwksDir,
        token: emulator.token,
        issuer: issuerForEmulator(emulator),
        onDiagnostic,
    });
    let channel = null;
    try {
        channel = createGrpcChannel({
            port: emulator.grpcPort,
            authorization: () => tokens.getToken(),
            onDiagnostic,
        });
        const controller = createEmulatorController(channel);
        // Prove the credentials before any caller depends on them, so a broken
        // handshake surfaces here rather than mid-gesture.
        await controller.getStatus({ timeoutMs: HANDSHAKE_TIMEOUT_MS });
        return { controller, channel, tokens };
    } catch (error) {
        channel?.close();
        await Promise.resolve(tokens.dispose()).catch(() => {});
        throw error;
    }
}

export class EmulatorControlPool {
    constructor({
        onDiagnostic,
        now = Date.now,
        findEmulator = findEmulatorBySerial,
        connect = connectEmulator,
        retryBackoffMs = RETRY_BACKOFF_MS,
        maxRetryBackoffMs = MAX_RETRY_BACKOFF_MS,
    } = {}) {
        this.onDiagnostic = onDiagnostic ?? (() => {});
        this.now = now;
        this.findEmulator = findEmulator;
        this.connect = connect;
        this.retryBackoffMs = retryBackoffMs;
        this.maxRetryBackoffMs = maxRetryBackoffMs;
        this.entries = new Map();
        /**
         * Serials that recently failed, with the time they may be retried.
         * A cold-booting emulator or a loaded machine can time out the handshake,
         * and permanently pinning such a device to the mirror would be wrong.
         */
        this.unavailableUntil = new Map();
        /** Consecutive transient failures per serial, for exponential backoff. */
        this.failureCounts = new Map();
        /** The pid/port a negative verdict was reached against. */
        this.failedEndpoints = new Map();
        /** Outstanding `hold` counts per controller. */
        this.holds = new Map();
        /** Connections dropped from the cache whose close waits on a hold. */
        this.retiring = new Map();
        /**
         * Close in progress or finished, per connection, so overlapping
         * teardown paths close once and every caller awaits the same cleanup.
         */
        this.closing = new WeakMap();
        /** Closes still running, so disposeAll waits for every one of them. */
        this.pendingCloses = new Set();
        this.disposed = false;
    }

    /**
     * Returns a controller, or null when this device has no reachable gRPC
     * endpoint. Null is the normal answer for physical devices and for emulators
     * running on another host, so callers treat it as "use adb", not an error.
     */
    async get(serial) {
        if (!serial || this.disposed) {
            return null;
        }
        const retryAt = this.unavailableUntil.get(serial);
        if (retryAt !== undefined) {
            if (retryAt === Infinity || this.now() < retryAt) {
                return null;
            }
            this.unavailableUntil.delete(serial);
            // A cached null from the failed attempt must not outlive its backoff.
            this.entries.delete(serial);
        }
        const existing = this.entries.get(serial);
        if (existing) {
            const resolved = await existing;
            // Disposal may have closed this connection while we waited.
            return this.disposed ? null : resolved;
        }

        // Every cache mutation below is applied only while this attempt is still
        // the current entry: a release, a replacement or disposal that happened
        // mid-handshake must not be overwritten by an obsolete completion.
        const isCurrent = () => !this.disposed && this.entries.get(serial) === pending;
        const pending = this.#create(serial).then(
            async (outcome) => {
                if (outcome.connection) {
                    if (!isCurrent()) {
                        // Nobody can release a connection the cache never held.
                        await this.#close(outcome.connection);
                        return null;
                    }
                    this.failureCounts.delete(serial);
                    this.failedEndpoints.delete(serial);
                    return outcome.connection;
                }
                if (isCurrent()) {
                    // Not an error: this device simply has no local gRPC endpoint.
                    // Mark it permanently so every gesture does not re-scan the
                    // discovery files.
                    this.unavailableUntil.set(serial, Infinity);
                    this.failedEndpoints.set(serial, null);
                }
                return null;
            },
            (error) => {
                if (!isCurrent()) {
                    return null;
                }
                this.entries.delete(serial);
                if (error?.endpoint) {
                    this.failedEndpoints.set(serial, error.endpoint);
                }
                // Rejections we know will not change (our credentials are refused)
                // are permanent until the emulator is replaced; anything else gets a
                // growing backoff so a transient timeout does not disable gRPC.
                const permanent =
                    error?.grpcStatus === GRPC_STATUS.unauthenticated || error?.grpcStatus === GRPC_STATUS.permissionDenied;
                const failures = (this.failureCounts.get(serial) ?? 0) + 1;
                this.failureCounts.set(serial, failures);
                const delay = Math.min(this.retryBackoffMs * 2 ** (failures - 1), this.maxRetryBackoffMs);
                this.unavailableUntil.set(serial, permanent ? Infinity : this.now() + delay);
                this.onDiagnostic(`gRPC control unavailable for ${serial}: ${error?.message ?? error}`);
                return null;
            },
        );
        this.entries.set(serial, pending);
        const resolved = await pending;
        return this.disposed ? null : resolved;
    }

    /** Opens a connection without touching any cache state; `get` owns that. */
    async #create(serial) {
        const emulator = await this.findEmulator(serial);
        if (!emulator?.grpcPort) {
            return { connection: null };
        }
        const endpoint = { pid: emulator.pid, grpcPort: emulator.grpcPort };
        let connection;
        try {
            connection = await this.connect(emulator, { onDiagnostic: this.onDiagnostic });
        } catch (error) {
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), { endpoint });
        }
        // The pid and port identify this exact emulator process. adb reuses a
        // serial when an AVD is restarted, so without them a cached connection
        // would silently point at a dead endpoint.
        return { connection: { ...connection, ...endpoint } };
    }

    /**
     * Keeps `controller`'s connection open while a caller depends on it, for
     * example a touch whose finger is down. A failure reported by another
     * borrower then retires the connection from the cache immediately but
     * closes it only once every hold is released. Returns an idempotent release.
     */
    hold(controller) {
        if (!controller) {
            return () => {};
        }
        this.holds.set(controller, (this.holds.get(controller) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            const remaining = (this.holds.get(controller) ?? 1) - 1;
            if (remaining > 0) {
                this.holds.set(controller, remaining);
                return;
            }
            this.holds.delete(controller);
            const retiring = this.retiring.get(controller);
            if (retiring) {
                this.retiring.delete(controller);
                void this.#close(retiring);
            }
        };
    }

    /** Serials the pool holds state for: a cached connection or a negative verdict. */
    serials() {
        return [...new Set([...this.entries.keys(), ...this.unavailableUntil.keys()])];
    }

    /**
     * Drop a cached connection if the emulator behind it has been replaced.
     *
     * Called on the discovery path rather than on a timer: a restarted AVD keeps
     * its serial but gets a new pid, gRPC port and key directory.
     */
    async invalidateIfReplaced(serial) {
        if (!serial) {
            return;
        }
        const pending = this.entries.get(serial);
        const entry = await pending?.catch(() => null);
        if (!entry) {
            // A negative verdict has no connection to compare, so nothing below
            // would run. It was reached against an emulator that may since have
            // been replaced, and without clearing it the device is pinned to adb
            // (or to a long backoff) until this process exits.
            if (!this.unavailableUntil.has(serial)) {
                return;
            }
            const current = await this.findEmulator(serial);
            const failed = this.failedEndpoints.get(serial);
            if (current?.grpcPort && (current.pid !== failed?.pid || current.grpcPort !== failed?.grpcPort)) {
                if (this.entries.get(serial) === pending) {
                    this.entries.delete(serial);
                }
                this.unavailableUntil.delete(serial);
                this.failureCounts.delete(serial);
                this.failedEndpoints.delete(serial);
                this.onDiagnostic(`gRPC endpoint appeared for ${serial}; will retry`);
            }
            return;
        }
        const current = await this.findEmulator(serial);
        if (!current || current.pid !== entry.pid || current.grpcPort !== entry.grpcPort) {
            this.onDiagnostic(`gRPC endpoint for ${serial} was replaced; reconnecting`);
            await this.release(serial, pending);
        }
    }

    /**
     * Forget a connection that a caller saw fail mid-use (a stream reset, a
     * dead socket). The next `get` reconnects instead of reusing it.
     *
     * `borrowed` is the connection the caller saw fail. A late report from an
     * old stream must not close the healthy connection that replaced it, so a
     * report is ignored unless that exact connection is still cached.
     */
    async reportFailure(serial, error, borrowed) {
        const pending = this.entries.get(serial);
        if (!pending) {
            return;
        }
        const current = await pending.catch(() => null);
        if (!current || this.entries.get(serial) !== pending) {
            return;
        }
        if (borrowed !== undefined && borrowed !== current && borrowed !== current.controller) {
            return;
        }
        this.onDiagnostic(`gRPC control for ${serial} failed: ${error?.message ?? error}; dropping connection`);
        this.entries.delete(serial);
        if ((this.holds.get(current.controller) ?? 0) > 0) {
            // An active gesture still needs to lift its finger through it.
            this.retiring.set(current.controller, current);
            return;
        }
        await this.#close(current);
    }

    /**
     * Forget a device, for example after it disconnects or gRPC starts failing.
     * With `expected`, only that exact entry is released, so a stale caller
     * cannot close a connection someone else just reopened.
     *
     * The cache is cleared synchronously; only the close of a handshake still
     * in flight is awaited.
     */
    async release(serial, expected) {
        const entry = this.entries.get(serial);
        if (expected !== undefined && entry !== expected) {
            return;
        }
        this.entries.delete(serial);
        this.unavailableUntil.delete(serial);
        this.failureCounts.delete(serial);
        this.failedEndpoints.delete(serial);
        const resolved = await entry?.catch(() => null);
        if (resolved) {
            await this.#close(resolved);
        }
    }

    async disposeAll() {
        this.disposed = true;
        const entries = [...this.entries.values()];
        this.entries.clear();
        // Close what is already connected. A handshake still in flight must not
        // hold teardown hostage for its timeout: its completion sees `disposed`
        // and closes what it opened, and the settlement hook below covers a
        // connection that resolved after that check.
        const inFlight = Symbol("in-flight");
        await Promise.all(
            entries.map(async (entry) => {
                void entry.then((resolved) => resolved && this.#close(resolved)).catch(() => {});
                const resolved = await Promise.race([entry, Promise.resolve(inFlight)]);
                if (resolved && resolved !== inFlight) {
                    await this.#close(resolved);
                }
            }),
        );
        const retiring = [...this.retiring.values()];
        this.retiring.clear();
        await Promise.all(retiring.map((connection) => this.#close(connection)));
        // Including a close a released gesture hold started on its own.
        await Promise.allSettled([...this.pendingCloses]);
        this.unavailableUntil.clear();
        this.failureCounts.clear();
        this.failedEndpoints.clear();
    }

    #close(connection) {
        if (!connection) {
            return Promise.resolve();
        }
        let closing = this.closing.get(connection);
        if (!closing) {
            closing = closeConnection(connection);
            this.closing.set(connection, closing);
            this.pendingCloses.add(closing);
            const forget = () => this.pendingCloses.delete(closing);
            closing.then(forget, forget);
        }
        return closing;
    }
}

async function closeConnection(connection) {
    try {
        connection.channel?.close();
    } finally {
        await Promise.resolve(connection.tokens?.dispose?.()).catch(() => {});
    }
}

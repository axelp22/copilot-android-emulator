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
import { createGrpcChannel } from "./grpc-client.mjs";
import { createEmulatorController } from "./emulator-controller.mjs";
import { GRPC_STATUS } from "./grpc-client.mjs";

/** How long a transient handshake failure keeps a device on the mirror. */
const RETRY_BACKOFF_MS = 30_000;

export class EmulatorControlPool {
    constructor({ onDiagnostic } = {}) {
        this.onDiagnostic = onDiagnostic ?? (() => {});
        this.entries = new Map();
        /**
         * Serials that recently failed, with the time they may be retried.
         * A cold-booting emulator or a loaded machine can time out the handshake,
         * and permanently pinning such a device to the mirror would be wrong.
         */
        this.unavailableUntil = new Map();
    }

    /**
     * Returns a controller, or null when this device has no reachable gRPC
     * endpoint. Null is the normal answer for physical devices and for emulators
     * running on another host, so callers treat it as "use adb", not an error.
     */
    async get(serial) {
        if (!serial) {
            return null;
        }
        const retryAt = this.unavailableUntil.get(serial);
        if (retryAt !== undefined) {
            if (retryAt === Infinity || Date.now() < retryAt) {
                return null;
            }
            this.unavailableUntil.delete(serial);
        }
        const existing = this.entries.get(serial);
        if (existing) {
            return await existing;
        }

        const pending = this.#create(serial).catch((error) => {
            this.entries.delete(serial);
            // Rejections we know will not change (this device has no gRPC, or our
            // credentials are refused) are permanent; anything else gets a
            // backoff so a transient timeout does not disable gRPC for the run.
            const permanent = error?.grpcStatus === GRPC_STATUS.unauthenticated || error?.grpcStatus === GRPC_STATUS.permissionDenied;
            this.unavailableUntil.set(serial, permanent ? Infinity : Date.now() + RETRY_BACKOFF_MS);
            this.onDiagnostic(`gRPC control unavailable for ${serial}: ${error?.message ?? error}`);
            return null;
        });
        this.entries.set(serial, pending);
        return await pending;
    }

    async #create(serial) {
        const emulator = await findEmulatorBySerial(serial);
        if (!emulator?.grpcPort) {
            // Not an error: this device simply has no local gRPC endpoint. Mark it
            // permanently so every gesture does not re-scan the discovery files.
            this.unavailableUntil.set(serial, Infinity);
            return null;
        }
        const tokens = createEmulatorTokenProvider({
            jwksDir: emulator.jwksDir,
            token: emulator.token,
            issuer: issuerForEmulator(emulator),
            onDiagnostic: this.onDiagnostic,
        });
        const channel = createGrpcChannel({
            port: emulator.grpcPort,
            authorization: () => tokens.getToken(),
            onDiagnostic: this.onDiagnostic,
        });
        const controller = createEmulatorController(channel);
        // Prove the credentials before any caller depends on them, so a broken
        // handshake surfaces here rather than mid-gesture.
        await controller.getStatus({ timeoutMs: 10_000 });
        return { controller, channel, tokens };
    }

    /** Forget a device, for example after it disconnects or gRPC starts failing. */
    async release(serial) {
        const entry = this.entries.get(serial);
        this.entries.delete(serial);
        this.unavailableUntil.delete(serial);
        const resolved = await entry?.catch(() => null);
        if (resolved) {
            await resolved.tokens.dispose();
            resolved.channel.close();
        }
    }

    async disposeAll() {
        const serials = [...this.entries.keys()];
        await Promise.all(serials.map((serial) => this.release(serial)));
        this.unavailableUntil.clear();
    }
}

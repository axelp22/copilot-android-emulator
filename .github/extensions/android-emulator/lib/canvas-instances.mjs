import { KeyedLock, resolveCanvasDevice } from "./canvas-open.mjs";
import { AppError } from "./errors.mjs";

function shuttingDownError() {
    return new AppError("session_shutting_down", "The Android Emulator session is shutting down.", 503);
}

/**
 * Owns the open canvas instances and their servers. Kept out of
 * `extension.mjs` (which joins the session at import time) so open, close,
 * switch and shutdown ordering can be tested without a host.
 *
 * Every instance operation runs under a per-instance lock, so a switch's
 * binding write cannot land after the instance was closed. Booting happens
 * outside the lock: an emulator boot takes minutes, and closing the canvas
 * must not wait for it.
 */
export class CanvasInstanceController {
    constructor({ manager, createCanvasServer, getBindings = () => null, webRoot, openDeviceCanvas, onDiagnostic = () => {} }) {
        this.manager = manager;
        this.createCanvasServer = createCanvasServer;
        this.getBindings = getBindings;
        this.webRoot = webRoot;
        this.openDeviceCanvas = openDeviceCanvas;
        this.diagnostic = onDiagnostic;
        this.instances = new Map();
        this.locks = new KeyedLock();
        this.shuttingDown = false;
    }

    #assertOpen() {
        if (this.shuttingDown) {
            throw shuttingDownError();
        }
    }

    async open({ instanceId, input }) {
        this.#assertOpen();
        const opened = await this.locks.run(instanceId, async () => {
            this.#assertOpen();
            const bindings = this.getBindings();
            const existing = this.instances.get(instanceId);
            const requestedDeviceId = input?.deviceId ?? null;
            let deviceId;
            let persist;
            if (existing?.deviceId && (!requestedDeviceId || requestedDeviceId === existing.deviceId)) {
                // A duplicate open of a live, bound canvas keeps what it shows;
                // only an explicit switch changes it.
                deviceId = existing.deviceId;
                persist = false;
            } else {
                // Even for a live unbound canvas the saved binding is consulted:
                // it may be retained from a device that was missing at first
                // open and has since come back.
                const savedDeviceId = await bindings?.get(instanceId);
                this.#assertOpen();
                ({ deviceId, persist } = await resolveCanvasDevice({
                    savedDeviceId,
                    requestedDeviceId,
                    resolveDeviceId: (preferred) => this.manager.resolveDeviceId(preferred),
                    onDiagnostic: this.diagnostic,
                }));
                this.#assertOpen();
            }

            if (deviceId && this.manager.getCachedDeviceState(deviceId).state === "Booted") {
                await this.manager.refreshDeviceGeometry(deviceId).catch(() => {});
                this.#assertOpen();
            }

            if (existing && existing.deviceId !== deviceId) {
                await this.#closeEntry(instanceId);
            }

            let entry = this.instances.get(instanceId);
            if (!entry) {
                const server = await this.createCanvasServer({
                    manager: this.manager,
                    instanceId,
                    deviceId,
                    webRoot: this.webRoot,
                    openDeviceCanvas: this.openDeviceCanvas,
                    switchDeviceCanvas: (args) => this.switch(args),
                    bootAfterOpen: input?.bootAfterOpen === true,
                    onDiagnostic: this.diagnostic,
                });
                if (this.shuttingDown) {
                    await server.close();
                    throw shuttingDownError();
                }
                if (deviceId) {
                    this.manager.attachInstance(deviceId, instanceId);
                }
                entry = { deviceId, server };
                this.instances.set(instanceId, entry);
            }
            if (persist) {
                await bindings?.set(instanceId, deviceId);
            }
            if (this.shuttingDown) {
                await this.#closeEntry(instanceId);
                throw shuttingDownError();
            }
            return { deviceId, url: entry.server.url };
        });

        const { deviceId, url } = opened;
        const device = deviceId ? this.manager.getCachedDeviceState(deviceId) : null;
        // Only emulators can be booted; an offline physical device gets a
        // canvas that recovers when it is reconnected.
        const autoBoot =
            Boolean(deviceId) &&
            device?.kind === "emulator" &&
            device.state !== "Booted" &&
            input?.autoBoot !== false &&
            input?.bootAfterOpen !== true;
        if (autoBoot && !this.shuttingDown) {
            void this.manager.ensureBooted(deviceId).catch((error) => {
                this.diagnostic(`Failed to boot ${deviceId}: ${error?.message ?? String(error)}`);
            });
        }
        return {
            deviceId,
            title: deviceId ? device?.name || `Android ${deviceId}` : "Android Emulator",
            status: deviceId ? (device?.state === "Booted" ? "Ready" : "Starting") : "Choose a device",
            url,
        };
    }

    close(instanceId) {
        return this.locks.run(instanceId, async () => {
            await this.#closeEntry(instanceId);
            await this.getBindings()?.delete(instanceId);
        });
    }

    switch({ instanceId, fromDeviceId, toDeviceId }) {
        return this.locks.run(instanceId, async () => {
            this.#assertOpen();
            const entry = this.#switchableEntry(instanceId, fromDeviceId);
            const resolvedId = await this.manager.resolveDeviceId(toDeviceId);
            const target = await this.manager.assertDeviceAvailable(resolvedId);
            this.#switchableEntry(instanceId, fromDeviceId, entry);
            if (entry.deviceId) {
                this.manager.assertNoActiveLease(entry.deviceId);
            }
            this.manager.assertNoActiveLease(resolvedId);

            const bindings = this.getBindings();
            await bindings?.set(instanceId, resolvedId);
            try {
                // Revalidated after the write: an agent may have leased either
                // device, or another switch moved the canvas, meanwhile.
                this.#switchableEntry(instanceId, fromDeviceId, entry);
                if (entry.deviceId) {
                    this.manager.assertNoActiveLease(entry.deviceId);
                }
                this.manager.assertNoActiveLease(resolvedId);
            } catch (error) {
                if (this.instances.get(instanceId) === entry) {
                    try {
                        await bindings?.set(instanceId, entry.deviceId ?? null);
                    } catch (rollbackError) {
                        throw rollbackFailedError(instanceId, entry.deviceId ?? null, error, rollbackError, this.diagnostic);
                    }
                }
                throw error;
            }
            // Marked only once the switch is committed, so an aborted switch
            // cannot leave the target stuck in Booting with no boot running.
            const needsBoot = target.state !== "Booted" && target.kind === "emulator";
            if (needsBoot) {
                this.manager.prepareBoot(resolvedId);
            }
            const previousDeviceId = entry.deviceId;
            if (previousDeviceId) {
                this.manager.detachInstance(previousDeviceId, instanceId);
            }
            this.manager.attachInstance(resolvedId, instanceId);
            entry.deviceId = resolvedId;
            await entry.server.rebindDevice(resolvedId);

            if (needsBoot) {
                queueMicrotask(() => {
                    if (this.shuttingDown) {
                        return;
                    }
                    void this.manager.completePreparedBoot(resolvedId).catch((error) => {
                        this.diagnostic(`Failed to boot the switched emulator: ${error?.message ?? String(error)}`);
                    });
                });
            }

            return {
                deviceId: resolvedId,
                switching: fromDeviceId !== resolvedId,
                opening: false,
                state: needsBoot ? "Booting" : target.state,
            };
        });
    }

    /**
     * The entry a switch from `fromDeviceId` may act on. A queued switch whose
     * source is no longer what the canvas shows is stale: acting on it would
     * detach a device it never checked.
     */
    #switchableEntry(instanceId, fromDeviceId, expected) {
        this.#assertOpen();
        const entry = this.instances.get(instanceId);
        if (!entry || (expected && entry !== expected)) {
            throw new AppError("canvas_instance_missing", "The device canvas is no longer available.", 404);
        }
        if ((fromDeviceId ?? null) !== (entry.deviceId ?? null)) {
            throw new AppError(
                "canvas_switch_stale",
                "The canvas changed device before this switch ran. Choose the device again.",
                409,
            );
        }
        return entry;
    }

    /**
     * Stops accepting opens, then closes every instance under its lock, so an
     * open already running finishes (and closes what it created) first.
     */
    async shutdown() {
        this.shuttingDown = true;
        const ids = new Set([...this.instances.keys(), ...this.locks.tails.keys()]);
        await Promise.allSettled(Array.from(ids, (id) => this.locks.run(id, () => this.#closeEntry(id))));
        await Promise.allSettled(Array.from(this.instances.keys(), (id) => this.#closeEntry(id)));
    }

    async #closeEntry(instanceId) {
        const entry = this.instances.get(instanceId);
        if (!entry) {
            return;
        }
        this.instances.delete(instanceId);
        if (entry.deviceId) {
            this.manager.detachInstance(entry.deviceId, instanceId);
        }
        await entry.server.close();
    }
}

/**
 * The switch was refused but its binding write could not be undone, so the
 * saved binding no longer matches what the canvas shows. Both causes are kept.
 */
function rollbackFailedError(instanceId, deviceId, switchError, rollbackError, diagnostic) {
    const message =
        `Canvas ${instanceId} switch was rejected (${switchError?.message ?? switchError}) ` +
        `and restoring its saved binding to ${deviceId ?? "none"} failed: ${rollbackError?.message ?? rollbackError}`;
    diagnostic?.(message);
    const error = new AppError("canvas_switch_rollback_failed", message, 500, {
        switchError: { code: switchError?.code, message: switchError?.message ?? String(switchError) },
        rollbackError: { code: rollbackError?.code, message: rollbackError?.message ?? String(rollbackError) },
    });
    error.cause = new AggregateError([switchError, rollbackError], message);
    return error;
}

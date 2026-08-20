import { randomUUID } from "node:crypto";
import { AppError } from "./errors.mjs";
import {
    androidVersionLabel,
    clampTtlSeconds,
    defaultStreamResolution,
    DEVICE_STATES,
    deviceFamily,
    fallbackScreen,
    nowIso,
    shortDeviceId,
    sortDevices,
    STREAM_FPS,
    STREAM_RESOLUTIONS,
} from "./device-model.mjs";

/**
 * In-memory registry of every known Android target, keyed by the stable device id
 * (AVD name for emulators, serial for physical devices).
 */
export class DeviceRegistry {
    constructor() {
        this.devices = new Map();
        this.subscribers = new Map();
    }

    subscribe(deviceId, handler) {
        let set = this.subscribers.get(deviceId);
        if (!set) {
            set = new Set();
            this.subscribers.set(deviceId, set);
        }
        set.add(handler);
        return () => {
            const current = this.subscribers.get(deviceId);
            if (!current) {
                return;
            }
            current.delete(handler);
            if (current.size === 0) {
                this.subscribers.delete(deviceId);
            }
        };
    }

    notify(deviceId) {
        const handlers = this.subscribers.get(deviceId);
        if (!handlers || handlers.size === 0) {
            return;
        }
        const snapshot = this.snapshot(deviceId);
        for (const handler of handlers) {
            handler(snapshot);
        }
    }

    updateFromList(devices) {
        // Snapshot before mutating so only genuinely changed devices notify. Discovery
        // runs on many paths, and every notify fans out to SSE clients.
        const before = new Map();
        for (const [deviceId, device] of this.devices) {
            if (this.subscribers.has(deviceId)) {
                before.set(deviceId, JSON.stringify(this.snapshot(deviceId)));
            }
        }

        const seen = new Set();
        for (const device of devices) {
            seen.add(this.upsertDevice(device).id);
        }
        for (const [deviceId, device] of this.devices) {
            if (!seen.has(deviceId) && device.state !== DEVICE_STATES.booting) {
                device.state = device.kind === "emulator" ? DEVICE_STATES.shutdown : DEVICE_STATES.offline;
                device.serial = null;
            }
        }

        for (const deviceId of this.devices.keys()) {
            if (!this.subscribers.has(deviceId)) {
                continue;
            }
            if (before.get(deviceId) !== JSON.stringify(this.snapshot(deviceId))) {
                this.notify(deviceId);
            }
        }
    }

    upsertDevice(device) {
        const existing = this.devices.get(device.id);
        if (existing) {
            existing.serial = device.serial ?? existing.serial;
            existing.avdName = device.avdName ?? existing.avdName;
            existing.kind = device.kind ?? existing.kind;
            existing.name = device.name ?? existing.name;
            // A boot in flight owns the state until discovery observes a booted device.
            if (!(existing.state === DEVICE_STATES.booting && device.state !== DEVICE_STATES.booted)) {
                existing.state = device.state;
            }
            existing.isAvailable = device.isAvailable !== false;
            existing.apiLevel = device.apiLevel ?? existing.apiLevel;
            existing.androidVersion = device.androidVersion ?? existing.androidVersion;
            existing.canManageLifecycle = device.kind === "emulator";
            if (device.screen?.width && device.screen?.height) {
                existing.screen = { ...existing.screen, ...device.screen };
            }
            existing.screen ??= fallbackScreen(device);
            existing.deviceFamily = deviceFamily({ ...device, screen: existing.screen });
            existing.lastSeenAt = nowIso();
            this.clearExpiredLease(existing);
            return existing;
        }

        const created = {
            id: device.id,
            serial: device.serial ?? null,
            avdName: device.avdName ?? null,
            kind: device.kind ?? "emulator",
            name: device.name,
            state: device.state,
            isAvailable: device.isAvailable !== false,
            apiLevel: device.apiLevel ?? null,
            androidVersion: device.androidVersion ?? null,
            canManageLifecycle: device.kind === "emulator",
            screen: device.screen?.width ? device.screen : fallbackScreen(device),
            orientation: device.orientation ?? "portrait",
            stream: { codec: "h264", fps: 60, resolution: defaultStreamResolution(device.kind ?? "emulator") },
            lastSeenAt: nowIso(),
            lease: null,
            leaseReservation: null,
            leaseTimer: null,
            activeOperations: new Set(),
            instanceIds: new Set(),
        };
        created.deviceFamily = deviceFamily(created);
        this.devices.set(created.id, created);
        return created;
    }

    getDeviceOrThrow(deviceId) {
        const device = this.devices.get(deviceId);
        if (!device) {
            throw new AppError("unknown_device", `Android device not found: ${deviceId}`, 404);
        }
        this.clearExpiredLease(device);
        return device;
    }

    /** Throws unless the device is attached to adb and therefore addressable by serial. */
    requireSerial(deviceId) {
        const device = this.getDeviceOrThrow(deviceId);
        if (!device.serial) {
            throw new AppError(
                "device_not_running",
                `${device.name} is not running. Boot it before interacting with it.`,
                409,
            );
        }
        return device.serial;
    }

    clearExpiredLease(device) {
        if (!device.lease) {
            return;
        }
        if (new Date(device.lease.expiresAt).getTime() > Date.now()) {
            return;
        }
        if (device.leaseTimer) {
            clearTimeout(device.leaseTimer);
            device.leaseTimer = null;
        }
        device.lease = null;
        // Leases are meant to lapse without being released, so anything held on a
        // lease's behalf outside this process has to be let go here too.
        this.onLeaseDropped?.(device.id);
    }

    scheduleLeaseExpiry(device) {
        if (device.leaseTimer) {
            clearTimeout(device.leaseTimer);
            device.leaseTimer = null;
        }
        if (!device.lease) {
            return;
        }

        const msUntilExpiry = Math.max(0, new Date(device.lease.expiresAt).getTime() - Date.now());
        device.leaseTimer = setTimeout(() => {
            this.clearExpiredLease(device);
            this.notify(device.id);
        }, msUntilExpiry + 50);
        device.leaseTimer.unref?.();
    }

    snapshot(deviceId) {
        const device = this.getDeviceOrThrow(deviceId);
        const lease = device.lease
            ? {
                  leaseId: device.lease.leaseId,
                  owner: device.lease.owner,
                  ownerInstanceId: device.lease.ownerInstanceId,
                  reason: device.lease.reason,
                  acquiredAt: device.lease.acquiredAt,
                  expiresAt: device.lease.expiresAt,
                  currentOperation: device.lease.currentOperation,
                  active: true,
              }
            : { active: false };

        return {
            deviceId: device.id,
            serial: device.serial,
            avdName: device.avdName,
            kind: device.kind,
            name: device.name,
            state: device.state,
            isAvailable: device.isAvailable,
            apiLevel: device.apiLevel,
            androidVersion: device.androidVersion,
            versionLabel: androidVersionLabel(device),
            canManageLifecycle: device.canManageLifecycle,
            deviceFamily: device.deviceFamily,
            screen: device.screen,
            orientation: device.orientation,
            stream: device.stream,
            controlPending: Boolean(device.leaseReservation),
            lease,
        };
    }

    listDevicePicker(currentDeviceId) {
        const groups = { booted: [], available: [], unavailable: [] };

        for (const device of sortDevices(Array.from(this.devices.values()))) {
            const item = {
                deviceId: device.id,
                shortId: shortDeviceId(device.id),
                serial: device.serial,
                name: device.name,
                kind: device.kind,
                versionLabel: androidVersionLabel(device),
                state: device.state,
                isAvailable: device.isAvailable !== false,
                canManageLifecycle: device.canManageLifecycle,
                deviceFamily: device.deviceFamily,
                isCurrent: device.id === currentDeviceId,
                isOpen: device.instanceIds.size > 0,
                // How many canvases hold it, and whether an agent is driving it, so
                // the picker can say a device is in use before you switch to it.
                openCount: device.instanceIds.size,
                leaseActive: Boolean(device.lease),
                leaseReason: device.lease?.reason ?? null,
            };
            if (!item.isAvailable) {
                groups.unavailable.push(item);
            } else if (item.state === DEVICE_STATES.booted) {
                groups.booted.push(item);
            } else {
                groups.available.push(item);
            }
        }

        return { currentDeviceId, groups };
    }

    attachInstance(deviceId, instanceId) {
        const device = this.getDeviceOrThrow(deviceId);
        device.instanceIds.add(instanceId);
        this.notify(deviceId);
    }

    detachInstance(deviceId, instanceId) {
        const device = this.devices.get(deviceId);
        if (!device) {
            return;
        }
        device.instanceIds.delete(instanceId);
        const droppedReservation = device.leaseReservation?.ownerInstanceId === instanceId;
        if (droppedReservation) {
            device.leaseReservation = null;
        }
        const droppedLease = Boolean(device.lease && device.lease.ownerInstanceId === instanceId);
        if (droppedLease) {
            device.lease = null;
            this.scheduleLeaseExpiry(device);
        }
        if (droppedLease || droppedReservation) {
            // The canvas that owned the lease is gone, so nothing will ever release
            // it. Without this the device stays taken from every other session until
            // this one exits.
            this.onLeaseDropped?.(device.id);
        }
        this.notify(deviceId);
    }

    assertNoActiveLease(deviceId) {
        const device = this.getDeviceOrThrow(deviceId);
        if (device.lease || device.leaseReservation) {
            throw new AppError(
                "lease_active",
                `${device.name ?? deviceId} is currently controlled by an agent.`,
                423,
            );
        }
    }

    hasActiveLease(deviceId) {
        const device = this.getDeviceOrThrow(deviceId);
        return Boolean(device.lease || device.leaseReservation);
    }

    reserveLease({ deviceId, ownerInstanceId }) {
        const device = this.getDeviceOrThrow(deviceId);
        if (device.lease || device.leaseReservation) {
            throw new AppError("device_busy", `${deviceId} is currently controlled by another lease.`, 409, {
                lease: device.lease,
            });
        }
        device.leaseReservation = { ownerInstanceId };
        this.notify(deviceId);
    }

    cancelLeaseReservation(deviceId, ownerInstanceId) {
        const device = this.getDeviceOrThrow(deviceId);
        if (device.leaseReservation?.ownerInstanceId === ownerInstanceId) {
            device.leaseReservation = null;
            this.notify(deviceId);
        }
    }

    acquireLease({ deviceId, ownerInstanceId, reason, ttlSeconds }) {
        const device = this.getDeviceOrThrow(deviceId);
        if (device.lease || device.leaseReservation?.ownerInstanceId !== ownerInstanceId) {
            throw new AppError("lease_reservation_lost", "Control lease reservation is no longer available.", 409);
        }

        const ttl = clampTtlSeconds(ttlSeconds);
        const acquiredAt = new Date();
        device.lease = {
            leaseId: randomUUID(),
            owner: "agent",
            ownerInstanceId,
            reason,
            acquiredAt: acquiredAt.toISOString(),
            expiresAt: new Date(acquiredAt.getTime() + ttl * 1000).toISOString(),
            currentOperation: null,
        };
        device.leaseReservation = null;
        this.scheduleLeaseExpiry(device);
        this.notify(deviceId);
        return this.snapshot(deviceId);
    }

    renewLease({ deviceId, leaseId, ttlSeconds }) {
        const device = this.getDeviceOrThrow(deviceId);
        if (!device.lease || device.lease.leaseId !== leaseId) {
            throw new AppError("lease_not_found", "Control lease not found or already expired.", 404);
        }

        const ttl = clampTtlSeconds(ttlSeconds);
        device.lease.expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        this.scheduleLeaseExpiry(device);
        this.notify(deviceId);
        return this.snapshot(deviceId);
    }

    releaseLease({ deviceId, leaseId }) {
        const device = this.getDeviceOrThrow(deviceId);
        if (!device.lease || device.lease.leaseId !== leaseId) {
            throw new AppError("lease_not_found", "Control lease not found or already expired.", 404);
        }
        device.lease = null;
        this.scheduleLeaseExpiry(device);
        this.notify(deviceId);
        return this.snapshot(deviceId);
    }

    revokeLease(deviceId) {
        const device = this.getDeviceOrThrow(deviceId);
        if (device.lease) {
            device.lease = null;
            this.scheduleLeaseExpiry(device);
        }
        device.leaseReservation = null;
        this.notify(deviceId);
        return this.snapshot(deviceId);
    }

    assertLease({ deviceId, leaseId }) {
        const device = this.getDeviceOrThrow(deviceId);
        if (!device.lease || device.lease.leaseId !== leaseId) {
            throw new AppError("lease_revoked", "Control lease was revoked or expired.", 409);
        }
        return device;
    }

    async withLeaseOperation({ deviceId, leaseId, operation }, fn) {
        const device = this.assertLease({ deviceId, leaseId });
        device.lease.currentOperation = operation;
        this.notify(deviceId);
        // Tracked so revocation can wait for work that has already started: an
        // install or lifecycle action cannot be cancelled mid-flight.
        const pending = Promise.resolve().then(fn);
        device.activeOperations ??= new Set();
        device.activeOperations.add(pending);
        try {
            return await pending;
        } finally {
            device.activeOperations.delete(pending);
            const latest = this.devices.get(deviceId);
            if (latest?.lease && latest.lease.leaseId === leaseId) {
                latest.lease.currentOperation = null;
                this.notify(deviceId);
            }
        }
    }

    /** Resolves once any agent operation that had already started has settled. */
    async settleActiveOperations(deviceId) {
        const device = this.devices.get(deviceId);
        const pending = Array.from(device?.activeOperations ?? []);
        if (pending.length > 0) {
            await Promise.allSettled(pending);
        }
    }

    updateScreenMetrics(deviceId, size, source = "capture") {
        const device = this.getDeviceOrThrow(deviceId);
        if (!size?.width || !size?.height) {
            throw new AppError("invalid_screen_metrics", "Screen metrics must include width and height.", 500);
        }
        device.screen = {
            ...device.screen,
            width: size.width,
            height: size.height,
            density: size.density ?? device.screen?.density ?? null,
            source,
            updatedAt: nowIso(),
        };
        device.deviceFamily = deviceFamily(device);
        return device.screen;
    }

    setStreamPreferences(deviceId, { fps, resolution }) {
        const device = this.getDeviceOrThrow(deviceId);
        const nextFps = fps ?? device.stream.fps;
        const nextResolution = resolution ?? device.stream.resolution ?? 100;

        if (!STREAM_FPS.has(nextFps)) {
            throw new AppError("unsupported_stream_fps", `Unsupported stream FPS: ${nextFps}`, 400);
        }
        if (!STREAM_RESOLUTIONS.has(nextResolution)) {
            throw new AppError(
                "unsupported_stream_resolution",
                `Unsupported stream resolution: ${nextResolution}%`,
                400,
            );
        }

        device.stream = { ...device.stream, fps: nextFps, resolution: nextResolution };
        this.notify(deviceId);
        return this.snapshot(deviceId);
    }

    setDeviceState(deviceId, state) {
        const device = this.getDeviceOrThrow(deviceId);
        device.state = state;
        this.notify(deviceId);
        return this.snapshot(deviceId);
    }

    setSerial(deviceId, serial) {
        const device = this.getDeviceOrThrow(deviceId);
        device.serial = serial;
        this.notify(deviceId);
        return this.snapshot(deviceId);
    }

    setOrientation(deviceId, orientation) {
        const device = this.getDeviceOrThrow(deviceId);
        device.orientation = orientation;
        this.notify(deviceId);
        return this.snapshot(deviceId);
    }
}

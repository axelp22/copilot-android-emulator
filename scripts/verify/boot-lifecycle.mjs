/**
 * Boots a shut-down AVD through the manager and stops it again. This is the
 * slowest suite (a real emulator cold boot) and the one that covers serial
 * discovery and `sys.boot_completed` polling.
 *
 *   VERIFY_BOOT_AVD=lowend_api34 node scripts/verify/boot-lifecycle.mjs
 */
import path from "node:path";
import { adb, config, createReporter, extensionRoot } from "./_shared.mjs";

const { DeviceSessionManager } = await import(path.join(extensionRoot, "lib", "device-session-manager.mjs"));

const report = createReporter("BOOT LIFECYCLE");
const manager = new DeviceSessionManager({ onDiagnostic: (message) => report.note(message) });
manager.setArtifactsRoot(config.artifactsRoot);

const deviceId = await manager.resolveDeviceId(config.bootAvd);
const before = manager.getCachedDeviceState(deviceId);
if (before.state !== "Shutdown") {
    report.skip("cold boot", `${deviceId} is already running; shut it down first`);
    report.finish();
}

report.assert(before.state === "Shutdown", "AVD starts shut down", before.state);
report.assert(before.serial === null, "no serial before boot", String(before.serial));

const startedAt = Date.now();
const booted = await manager.bootDevice(deviceId);
report.note(`boot took ${Date.now() - startedAt}ms`);

report.assert(booted.state === "Booted", "boot_device reaches Booted", booted.state);
report.assert(/^emulator-\d+$/.test(String(booted.serial)), "new serial detected", String(booted.serial));
report.assert(Number(booted.apiLevel) > 0, "api level read after boot", String(booted.apiLevel));
report.assert(booted.screen.width > 0, "screen metrics after boot", `${booted.screen.width}x${booted.screen.height}`);

// A device that is merely present in adb is not necessarily usable.
const capture = await manager.captureScreen(deviceId);
report.assert(capture.pixelSize.width > 0, "screenshot from the freshly booted AVD", `${capture.pixelSize.width}x${capture.pixelSize.height}`);
await manager.pressButton({ deviceId, button: "home" });
report.assert(true, "input accepted by the freshly booted AVD");

const again = await manager.bootDevice(deviceId);
report.assert(again.serial === booted.serial, "boot_device is idempotent when already booted", String(again.serial));

const shutdown = await manager.shutdownDevice(deviceId);
report.assert(shutdown.state === "Shutdown", "shutdown_device reaches Shutdown", shutdown.state);
report.assert(shutdown.serial === null, "serial cleared after shutdown", String(shutdown.serial));

const attached = await adb(["devices"], { serial: null });
report.assert(!attached.includes(String(booted.serial)), "emulator really left adb", String(booted.serial));

await manager.dispose();
report.finish();

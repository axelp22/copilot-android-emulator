/**
 * Refuses to touch anything but an explicitly named, booted emulator.
 *
 * Suites that install and uninstall apps must never fall back to "whatever adb
 * picks" or to a default serial: that would be a developer's daily-driver device.
 * The caller names one emulator serial, and it is checked through `adb -s` only,
 * so no command here can reach any other device.
 *
 * `runAdb(args)` runs `adb -s <serial> ...args` and resolves its stdout. It is
 * injected so the checks can be exercised without a device.
 */
export const EMULATOR_SERIAL = /^emulator-\d+$/;

export async function checkDisposableTarget({ serial, runAdb }) {
    const name = typeof serial === "string" ? serial.trim() : "";
    if (!name) {
        return {
            ok: false,
            code: "serial_required",
            reason:
                "No target serial. Set VERIFY_AGP_SERIAL to the adb serial of a disposable emulator " +
                "(for example emulator-5580). There is deliberately no default.",
        };
    }
    if (!EMULATOR_SERIAL.test(name)) {
        return {
            ok: false,
            code: "not_emulator_serial",
            reason: `${name} is not an emulator serial (expected emulator-<port>). Physical and network devices are refused.`,
        };
    }

    const read = async (args) => String(await runAdb(args)).trim();

    let state;
    try {
        state = await read(["get-state"]);
    } catch (error) {
        return { ok: false, code: "not_connected", reason: `${name} is not attached to adb: ${error?.message ?? error}` };
    }
    if (state !== "device") {
        return { ok: false, code: "not_ready", reason: `${name} is in adb state "${state}", not "device".` };
    }

    const qemu = await read(["shell", "getprop", "ro.kernel.qemu"]).catch(() => "");
    const bootQemu = await read(["shell", "getprop", "ro.boot.qemu"]).catch(() => "");
    if (qemu !== "1" && bootQemu !== "1") {
        return { ok: false, code: "not_emulator", reason: `${name} does not report itself as an emulator (ro.kernel.qemu / ro.boot.qemu).` };
    }

    const booted = await read(["shell", "getprop", "sys.boot_completed"]).catch(() => "");
    if (booted !== "1") {
        return { ok: false, code: "not_booted", reason: `${name} has not finished booting (sys.boot_completed=${booted || "unset"}).` };
    }

    const avdName = (await read(["emu", "avd", "name"]).catch(() => "")).split(/\r?\n/)[0]?.trim() || null;
    return { ok: true, serial: name, avdName };
}

/**
 * Package safety for suites that install a fixture app on a disposable emulator.
 *
 * The suite may only remove what it installed: it refuses to start when the
 * fixture package is already present (or its presence cannot be checked), and its
 * cleanup never reports a removal it could not verify. Builds are stopped and
 * confirmed before anything is uninstalled or deleted, because a live Gradle could
 * otherwise reinstall the app after cleanup.
 *
 * `runAdb(args)` runs `adb -s <serial> ...args` and resolves its stdout; it is
 * injected so all of this is testable without a device.
 */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

/** True only for the exact `package:<name>` line; `pm list packages` filters by substring. */
export function hasPackage(output, packageName) {
    return String(output)
        .split(/\r?\n/)
        .some((line) => line.trim() === `package:${packageName}`);
}

export async function checkPackageAbsent({ packageName, runAdb }) {
    let output;
    try {
        output = await runAdb(["shell", "pm", "list", "packages", packageName]);
    } catch (error) {
        return {
            ok: false,
            code: "package_check_failed",
            reason: `could not check whether ${packageName} is already installed: ${error?.message ?? error}`,
        };
    }
    if (hasPackage(output, packageName)) {
        return {
            ok: false,
            code: "package_present",
            reason:
                `${packageName} is already installed. The suite only removes an app it installed itself, ` +
                "so it will not overwrite or delete an existing one. Use a fresh emulator, or uninstall it yourself first.",
        };
    }
    return { ok: true };
}

/**
 * Takes the device in the extension's shared cross-session queue for the whole run,
 * under an identity unique to this run. Real Copilot sessions and other fixture
 * runs use the same store, so whoever holds the serial -- a session or another run
 * -- makes this refuse rather than install alongside it. `manager` is the
 * extension's DeviceSessionManager, left on its default (shared) queue and claims.
 *
 * Resolves `{ ok: true, owner, release }`, where `release()` drops only this run's
 * hold, or `{ ok: false, code: "device_busy", reason }`.
 */
export async function holdFixtureDevice({ manager, deviceId, serial, runId = randomUUID(), reason = "AGP fixture suite" }) {
    const owner = { sessionId: `verify-agp-fixture-${runId}`, sessionLabel: `agp-fixture suite ${runId.slice(0, 8)}`, pid: process.pid };
    manager.queue.setOwner(owner);
    manager.claims.setOwner({ sessionId: owner.sessionId, pid: owner.pid });
    const ref = `agp-fixture:${runId}`;
    let held = null;
    let failure = null;
    try {
        held = await manager.takeHold(deviceId, ref, { reason, timeoutMs: 0 });
    } catch (error) {
        failure = error;
    }
    if (held?.deviceId === deviceId) {
        return { ok: true, owner, release: () => manager.dropHoldRef(deviceId, ref) };
    }
    if (held) {
        await manager.dropHoldRef(held.deviceId, ref).catch(() => {});
    }
    const [status] = await manager.queue.status([deviceId]).catch(() => []);
    const by = status?.holder
        ? `${status.holder.sessionLabel}${status.holder.reason ? ` (${status.holder.reason})` : ""} holds it`
        : failure
          ? `the shared device queue could not be used: ${failure?.message ?? failure}`
          : `${status?.waiting?.length ?? 0} session(s) are queued for it`;
    return {
        ok: false,
        code: "device_busy",
        reason: `${serial ?? deviceId} is in use: ${by}. The suite only runs on a device no Copilot session or other run is using.`,
    };
}

/** Whether two executable paths name the same file (case-insensitively on Windows). */
export async function sameExecutable(a, b, platform = process.platform) {
    if (!a || !b) {
        return false;
    }
    const resolve = (file) => realpath(file).catch(() => null);
    const [left, right] = await Promise.all([resolve(a), resolve(b)]);
    if (!left || !right) {
        return false;
    }
    return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Cleans up after the suite, in order: stop builds (confirmed), then remove the
 * package and verify, then delete the scratch directory. Returns `checks`
 * ({ ok, label, detail }) and `notes`; nothing is reported as removed unless it
 * was seen to be gone.
 *
 * - `stopBuilds()` must throw unless every build is confirmed stopped. If it does,
 *   the package is left alone and the scratch directory is kept: a live Gradle
 *   could still reinstall, so neither removal could be trusted.
 * - `installAttempted` is set once a build was started after the package was
 *   confirmed absent, so anything present afterwards is the suite's own.
 */
export async function cleanupFixture({
    packageName,
    serial,
    runAdb,
    stopBuilds = null,
    installAttempted,
    scratch,
    keepScratch = false,
    removeScratch,
}) {
    const checks = [];
    const notes = [];

    if (stopBuilds) {
        try {
            await stopBuilds();
        } catch (error) {
            checks.push({
                ok: false,
                label: "builds are confirmed stopped before cleanup",
                detail:
                    `${error?.code ? `${error.code}: ` : ""}${error?.message ?? error}. ` +
                    `${packageName} was not uninstalled and ${scratch} was kept, because Gradle may still install onto ${serial}. ` +
                    `Stop it, then run: adb -s ${serial} uninstall ${packageName}`,
            });
            notes.push(`kept ${scratch}`);
            return { checks, notes };
        }
    }

    if (installAttempted) {
        await runAdb(["shell", "am", "force-stop", packageName]).catch(() => {});
        const uninstallError = await runAdb(["uninstall", packageName]).then(
            () => null,
            (error) => error,
        );
        let left;
        try {
            left = await runAdb(["shell", "pm", "list", "packages", packageName]);
        } catch (error) {
            checks.push({
                ok: false,
                label: "the fixture is uninstalled afterwards",
                detail: `removal could not be verified: ${error?.message ?? error}`,
            });
            left = null;
        }
        if (left !== null) {
            const present = hasPackage(left, packageName);
            checks.push({
                ok: !present,
                label: "the fixture is uninstalled afterwards",
                detail: present ? `still installed${uninstallError ? `: ${uninstallError.message ?? uninstallError}` : ""}` : "",
            });
        }
    }

    if (keepScratch) {
        notes.push(`kept ${scratch}`);
    } else {
        try {
            await removeScratch();
        } catch (error) {
            checks.push({
                ok: false,
                label: "the scratch directory is removed",
                detail: `${scratch}: ${error?.message ?? error}`,
            });
        }
    }
    return { checks, notes };
}

/**
 * Ends a fixture run: cleanup, then release, then the exit report -- and never
 * exits while a build is unconfirmed.
 *
 * When `stopBuilds()` cannot confirm every build stopped, an orphaned Gradle may
 * still install onto the device. Exiting would end this process's queue heartbeat,
 * so the shared queue would soon treat the device as free while that Gradle runs.
 * Instead the process stays alive, keeping the hold, and retries `stopBuilds()`
 * every `pollMs` until it succeeds; only then does it clean up, release and exit
 * (always as a failure). A first SIGINT/SIGTERM only warns; a second abandons the
 * device explicitly, with manual-recovery steps, and exits non-zero.
 *
 * `report` is the suite reporter; its `finish()` exits the process.
 */
export async function finishFixtureRun({
    packageName,
    serial,
    runAdb,
    stopBuilds,
    installAttempted,
    scratch,
    keepScratch = false,
    removeScratch,
    releaseHold,
    dispose,
    report,
    orphanPids = () => [],
    heartbeat = async () => {},
    pollMs = 5_000,
    signals = process,
    exit = (code) => process.exit(code),
}) {
    let buildsStopped = false;
    const confirmStop = async () => {
        await stopBuilds();
        buildsStopped = true;
    };
    const cleanupOptions = { packageName, serial, runAdb, installAttempted, scratch, keepScratch, removeScratch };
    const record = ({ checks, notes }) => {
        for (const check of checks) {
            report.assert(check.ok, check.label, check.detail);
        }
        for (const note of notes) {
            report.note(note);
        }
    };

    record(await cleanupFixture({ ...cleanupOptions, stopBuilds: confirmStop }));

    if (!buildsStopped) {
        const recovery = () => {
            const pids = orphanPids().filter(Boolean);
            return (
                `Manual recovery: stop Gradle${pids.length > 0 ? ` (pid ${pids.join(", ")})` : ""} and its daemons, ` +
                `then run \`adb -s ${serial} uninstall ${packageName}\` and delete ${scratch}.`
            );
        };
        report.note(
            `FAIL: Gradle could not be confirmed stopped. This process stays alive and keeps ${serial} held in the ` +
                `shared device queue until it exits, rechecking every ${Math.round(pollMs / 1000)}s. ${recovery()}`,
        );
        let interrupts = 0;
        let abandon = null;
        const abandoned = new Promise((resolve) => {
            abandon = resolve;
        });
        const onSignal = (signal) => {
            interrupts += 1;
            if (interrupts === 1) {
                report.note(
                    `${signal} received, but Gradle is still unconfirmed: exiting now would release ${serial} to other ` +
                        "sessions while it may still install. Signal again to abandon the hold anyway.",
                );
                return;
            }
            abandon(signal);
        };
        signals.on("SIGINT", onSignal);
        signals.on("SIGTERM", onSignal);
        try {
            while (!buildsStopped) {
                let timer;
                const outcome = await Promise.race([
                    new Promise((resolve) => {
                        timer = setTimeout(() => resolve("poll"), pollMs);
                    }),
                    abandoned,
                ]);
                clearTimeout(timer);
                if (outcome !== "poll") {
                    report.assert(
                        false,
                        "the device stays held until Gradle is confirmed stopped",
                        `abandoned on ${outcome}: ${serial} is no longer protected from other sessions. ${recovery()}`,
                    );
                    exit(1);
                    return;
                }
                // The queue's own heartbeat is unref'd; renew explicitly while supervising.
                await heartbeat().catch(() => {});
                await confirmStop().catch(() => {});
            }
        } finally {
            signals.off("SIGINT", onSignal);
            signals.off("SIGTERM", onSignal);
        }
        report.note("Gradle has since exited; finishing cleanup.");
        record(await cleanupFixture(cleanupOptions));
    }

    // Only now is the device given back.
    await releaseHold().catch(() => {});
    await dispose().catch((error) => {
        report.assert(false, "the device is released after cleanup", `${error?.code ?? ""} ${error?.message ?? error}`.trim());
    });
    report.finish();
}

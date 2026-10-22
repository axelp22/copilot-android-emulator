/**
 * The device-free verification suites in scripts/verify, run as they are meant
 * to be run: as separate processes. They end with process.exit, which would cut
 * short anything else in this process, and they create their own temporary
 * roots, so each gets a private temp directory that is removed afterwards.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { repoRoot, tempDir } from "./helpers.mjs";

function runSuite(script, tmp) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "verify", script)], {
            cwd: repoRoot,
            env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
    });
}

for (const script of ["device-queue.mjs", "lease-holds.mjs"]) {
    test(`scripts/verify/${script}`, { timeout: 60_000 }, async (t) => {
        const tmp = await tempDir(t, "verify-suite-");
        const { code, output } = await runSuite(script, tmp);
        const failures = output.split("\n").filter((line) => line.startsWith("FAIL"));
        const skips = output.split("\n").filter((line) => line.startsWith("SKIP"));
        for (const skip of skips) {
            t.diagnostic(skip);
        }
        assert.deepEqual(failures, [], output);
        assert.equal(code, 0, output);
        assert.match(output, /checks passed/);
    });
}

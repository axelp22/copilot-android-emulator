import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { extensionImport } from "../scripts/verify/_shared.mjs";
import { extensionModule, repoRoot } from "./helpers.mjs";

// Windows: import("D:\\a\\x.mjs") throws ERR_UNSUPPORTED_ESM_URL_SCHEME, so absolute paths must become file: URLs.
test("a Windows absolute path becomes a file: URL for import()", () => {
    const href = pathToFileURL("D:\\a\\repo\\lib\\adb.mjs", { windows: true }).href;
    assert.equal(href, "file:///D:/a/repo/lib/adb.mjs");
});

test("both extension import helpers load modules by file: URL", async () => {
    const fromVerify = await extensionImport("lib", "adb.mjs");
    const fromTests = await extensionModule("lib", "adb.mjs");
    assert.equal(typeof fromVerify.resolveToolchain, "function");
    assert.equal(fromVerify, fromTests, "same module instance through both helpers");
});

test("no dynamic import() receives a raw filesystem path", async () => {
    const roots = ["scripts", "test", path.join(".github", "extensions", "android-emulator")];
    const offenders = [];
    for (const root of roots) {
        for (const entry of await readdir(path.join(repoRoot, root), { recursive: true, withFileTypes: true })) {
            if (!/\.m?js$/.test(entry.name) || entry.parentPath.includes("node_modules")) continue;
            const file = path.join(entry.parentPath, entry.name);
            const source = await readFile(file, "utf8");
            for (const [index, line] of source.split("\n").entries()) {
                // Allowed: string literals (relative or node: specifiers) and file: URLs (pathToFileURL / .href).
                for (const match of line.matchAll(/\bimport\(\s*([^)\s][^)]*)\)/g)) {
                    const arg = match[1];
                    if (/^["'`]/.test(arg) || /pathToFileURL|\.href\b/.test(line) || /^specifier$|^url$/.test(arg)) continue;
                    offenders.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
                }
            }
        }
    }
    assert.deepEqual(offenders, []);
});

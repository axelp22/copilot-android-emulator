/**
 * Which gRPC identity this extension may present to a given emulator.
 *
 * The SDK's stock allowlist grants blanket `EmulatorController` access to one
 * issuer only: `android-studio`. Emulators this extension launches are booted
 * with the bundled allowlist instead, which keeps the Android Studio entry
 * intact and adds a least-privilege `copilot-android-emulator` issuer.
 *
 * An emulator started by anything else still carries the stock allowlist, and
 * its policy cannot be changed from here, so the Android Studio issuer is the
 * only way to attach to it.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANDROID_STUDIO_ISSUER, COPILOT_ISSUER } from "./emulator-jwt.mjs";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to the allowlist passed via `-grpc-allowlist`. */
export function emulatorAccessPath() {
    return path.join(extensionRoot, "assets", "emulator-access.json");
}

/**
 * The launch command is recorded in the emulator's discovery file, so the
 * allowlist it booted with can be read back rather than assumed. This matters
 * after the extension restarts, when an emulator it launched earlier is
 * rediscovered with no in-memory record of how it started.
 */
export function issuerForEmulator(record) {
    return record?.cmdline?.includes(emulatorAccessPath()) ? COPILOT_ISSUER : ANDROID_STUDIO_ISSUER;
}

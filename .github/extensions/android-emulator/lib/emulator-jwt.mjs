/**
 * JWT credentials for the emulator's gRPC endpoint.
 *
 * Modern emulators default to `-grpc-use-jwt`: the stock allowlist marks nothing
 * as unprotected, so every call must carry a signed bearer token. The handshake
 * is asymmetric and file-based rather than a shared secret:
 *
 *   1. the client generates a P-256 keypair,
 *   2. writes its *public* JWK into the emulator's `grpc.jwks` directory,
 *   3. waits for the emulator's watcher to merge that key into `active.jwk`,
 *   4. signs an ES256 JWT whose `iss` the allowlist recognises.
 *
 * `node:crypto` covers all of this, so no dependency is required.
 */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.mjs";

/**
 * The only issuer the stock `emulator_access.json` grants blanket
 * `EmulatorController/.*` access. Emulators this extension launches are given a
 * custom allowlist naming `COPILOT_ISSUER` instead, so this is used only when
 * attaching to an emulator started by something else, where the allowlist cannot
 * be changed.
 */
export const ANDROID_STUDIO_ISSUER = "android-studio";
export const COPILOT_ISSUER = "copilot-android-emulator";

const KEY_ACCEPT_TIMEOUT_MS = 10_000;
const KEY_POLL_INTERVAL_MS = 100;
const TOKEN_LIFETIME_SECONDS = 900;
/** Re-sign well before expiry so a long-lived stream never fails mid-flight. */
const TOKEN_REFRESH_MARGIN_SECONDS = 120;

const base64Url = (value) => Buffer.from(value).toString("base64url");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sign an ES256 JWT the emulator will accept.
 *
 * Two details are load-bearing and were established against a live emulator:
 * the header must *omit* `typ` (the emulator rejects it with "token has type
 * header set, but validator not"), and the signature must be raw `r||s`
 * (`ieee-p1363`) rather than the DER encoding Node produces by default.
 */
export function signEmulatorJwt({ privateKey, kid, issuer, audience = null, lifetimeSeconds = TOKEN_LIFETIME_SECONDS }) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "ES256", kid }));
    const claims = {
        iss: issuer,
        // Allow for modest clock skew between this process and the emulator.
        iat: issuedAt - 5,
        exp: issuedAt + lifetimeSeconds,
    };
    if (audience) {
        claims.aud = audience;
    }
    const payload = base64Url(JSON.stringify(claims));
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
    });
    return { token: `${header}.${payload}.${base64Url(signature)}`, expiresAt: claims.exp };
}

/**
 * Creates a bearer-token provider for one emulator.
 *
 * When `jwksDir` is absent the emulator was launched with a plain `-grpc` port
 * and needs no credentials, so the provider yields the discovery file's static
 * token if present and otherwise nothing.
 */
export function createEmulatorTokenProvider({ jwksDir, token = null, issuer = ANDROID_STUDIO_ISSUER, onDiagnostic }) {
    if (!jwksDir) {
        return {
            issuer: null,
            async getToken() {
                return token;
            },
            async dispose() {},
        };
    }

    const kid = randomUUID();
    // Namespaced by kid, not just pid: two providers for the same emulator can
    // overlap while one is being disposed, and a shared filename would let the
    // old one's cleanup delete the key the new one just published — leaving it
    // holding a token the emulator no longer trusts.
    const keyFile = path.join(jwksDir, `copilot-android-emulator-${process.pid}-${kid}.jwk`);
    const activeFile = path.join(jwksDir, "active.jwk");

    let keyPair = null;
    let published = null;
    let cached = null;

    function ensureKeyPair() {
        keyPair ??= generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        return keyPair;
    }

    /**
     * Publishing is not enough: the emulator picks the file up asynchronously,
     * and calling before it lands fails with "No key set present". Waiting for
     * our `kid` to appear in `active.jwk` is the only reliable readiness signal.
     */
    async function publishKey() {
        const { publicKey } = ensureKeyPair();
        const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "ES256" };
        await writeFile(keyFile, JSON.stringify({ keys: [jwk] }), "utf8");

        const deadline = Date.now() + KEY_ACCEPT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            try {
                if ((await readFile(activeFile, "utf8")).includes(kid)) {
                    onDiagnostic?.("emulator accepted gRPC signing key");
                    return;
                }
            } catch {
                // The emulator recreates active.jwk as keys change; a transient
                // ENOENT here just means the merge has not happened yet.
            }
            await sleep(KEY_POLL_INTERVAL_MS);
        }
        throw new AppError(
            "grpc_key_rejected",
            `The emulator did not accept the gRPC signing key within ${KEY_ACCEPT_TIMEOUT_MS}ms.`,
            504,
        );
    }

    return {
        issuer,
        async getToken() {
            published ??= publishKey().catch((error) => {
                // Let the next call retry rather than caching the failure forever.
                published = null;
                throw error;
            });
            await published;

            const now = Math.floor(Date.now() / 1000);
            if (cached && cached.expiresAt - now > TOKEN_REFRESH_MARGIN_SECONDS) {
                return cached.token;
            }
            cached = signEmulatorJwt({ privateKey: ensureKeyPair().privateKey, kid, issuer });
            return cached.token;
        },

        /** Remove the published key so it does not outlive this process. */
        async dispose() {
            cached = null;
            published = null;
            try {
                await rm(keyFile, { force: true });
            } catch {
                // The emulator's temp directory disappears with the emulator.
            }
        },
    };
}

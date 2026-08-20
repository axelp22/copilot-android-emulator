import { AppError } from "./errors.mjs";

const MAX_BODY_BYTES = 64 * 1024;

export function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(body);
}

export function text(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body);
}

function isLoopbackHost(value) {
    if (!value) {
        return false;
    }
    // Parsed rather than split on ":", which mangles a bracketed IPv6 authority
    // like `[::1]:8080` into "[" and rejects a host that is on the allowlist.
    // A real Host header is only an authority, so anything carrying userinfo or a
    // path is rejected outright. Backslash is rejected explicitly because the URL
    // parser treats it as a path separator rather than part of the hostname.
    const authority = String(value).trim();
    if (authority.includes("@") || authority.includes("/") || authority.includes("\\")) {
        return false;
    }
    let parsed;
    try {
        parsed = new URL(`http://${authority}`);
    } catch {
        return false;
    }
    // Nothing but a host and an optional port may be present.
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        return false;
    }
    const hostname = parsed.hostname;
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function assertLoopbackRequest(req) {
    if (!isLoopbackHost(req.headers.host)) {
        throw new AppError("forbidden_host", "Canvas requests must target a loopback host.", 403);
    }

    const origin = req.headers.origin;
    if (origin) {
        let parsed;
        try {
            parsed = new URL(origin);
        } catch {
            throw new AppError("forbidden_origin", "Invalid Origin header.", 403);
        }
        if (!isLoopbackHost(parsed.host)) {
            throw new AppError("forbidden_origin", "Canvas requests must originate from loopback.", 403);
        }
    }
}

export async function readJsonBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
            throw new AppError("payload_too_large", "Request payload exceeds the size limit.", 413);
        }
        chunks.push(chunk);
    }

    if (chunks.length === 0) {
        return {};
    }

    const contentType = req.headers["content-type"] ?? "";
    if (!String(contentType).includes("application/json")) {
        throw new AppError("invalid_content_type", "Expected application/json request body.", 415);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new AppError("invalid_json", "Malformed JSON payload.", 400);
    }
}

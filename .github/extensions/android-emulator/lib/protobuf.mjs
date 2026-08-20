/**
 * Just enough protobuf to talk to `EmulatorController`.
 *
 * The extension ships without a package install step, so a code-generated
 * protobuf runtime is not an option. Only the wire features the emulator
 * messages actually use are implemented: varints, length-delimited fields and
 * the two fixed widths. Groups, packed repeats and zigzag ints are absent
 * because no message in `emulator_controller.proto` that this extension touches
 * needs them.
 */

export const WIRE = {
    varint: 0,
    fixed64: 1,
    bytes: 2,
    fixed32: 5,
};

/** Ten bytes is the widest a 64-bit varint can be; anything longer is corrupt. */
const MAX_VARINT_BYTES = 10;

function encodeVarint(value) {
    let remaining = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
    if (remaining < 0n) {
        // Negative int32 fields are sign-extended to 64 bits on the wire.
        remaining += 1n << 64n;
    }
    const bytes = [];
    do {
        let byte = Number(remaining & 0x7fn);
        remaining >>= 7n;
        if (remaining > 0n) {
            byte |= 0x80;
        }
        bytes.push(byte);
    } while (remaining > 0n);
    return Buffer.from(bytes);
}

/** Builds one message body. Fields are emitted in call order. */
export class Writer {
    constructor() {
        this.parts = [];
    }

    #tag(fieldNo, wireType) {
        this.parts.push(encodeVarint((fieldNo << 3) | wireType));
    }

    /**
     * Proto3 treats zero as absent, so skipping default values keeps requests
     * byte-identical to what a generated encoder would produce.
     */
    varint(fieldNo, value, { omitDefault = true } = {}) {
        if (value === undefined || value === null) {
            return this;
        }
        if (omitDefault && (value === 0 || value === 0n || value === false)) {
            return this;
        }
        this.#tag(fieldNo, WIRE.varint);
        this.parts.push(encodeVarint(typeof value === "boolean" ? (value ? 1 : 0) : value));
        return this;
    }

    bytes(fieldNo, value) {
        if (value === undefined || value === null) {
            return this;
        }
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (buf.length === 0) {
            return this;
        }
        this.#tag(fieldNo, WIRE.bytes);
        this.parts.push(encodeVarint(buf.length), buf);
        return this;
    }

    string(fieldNo, value) {
        return value ? this.bytes(fieldNo, Buffer.from(value, "utf8")) : this;
    }

    /**
     * Nested message. Accepts a Writer or an already-encoded body.
     *
     * Unlike a scalar, a present message is always emitted, even when its body is
     * empty: proto3 default-elision applies to scalar fields only. This matters
     * for repeated fields, where dropping an empty element changes the list
     * length — a touch release at pixel (0,0) encodes every field to its default
     * and would otherwise vanish, leaving the emulator holding the slot.
     */
    message(fieldNo, value) {
        if (value === undefined || value === null) {
            return this;
        }
        const body = value instanceof Writer ? value.finish() : value;
        this.#tag(fieldNo, WIRE.bytes);
        this.parts.push(encodeVarint(body.length), body);
        return this;
    }

    /** Repeated non-packed message field. */
    repeated(fieldNo, values) {
        for (const value of values ?? []) {
            this.message(fieldNo, value);
        }
        return this;
    }

    finish() {
        return Buffer.concat(this.parts);
    }
}

/**
 * Walks a message body, invoking `visit(fieldNo, value)`.
 *
 * Varints arrive as Number when exactly representable and BigInt otherwise, so
 * `Image.timestampUs` survives without forcing every caller to handle BigInt.
 * Unknown fields are skipped rather than rejected: the emulator's proto is
 * explicitly experimental, and a new field must not break decoding.
 */
export function readMessage(buffer, visit) {
    let offset = 0;
    let malformed = false;

    function varint() {
        let result = 0n;
        let shift = 0n;
        let bytes = 0;
        while (offset < buffer.length) {
            const byte = buffer[offset++];
            result |= BigInt(byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) {
                break;
            }
            // A 64-bit varint is at most ten bytes. Without this ceiling a run of
            // continuation bytes grows `result` without bound, and every shift
            // reallocates it: 400KB of 0xFF blocks the event loop for ~16 seconds.
            bytes += 1;
            if (bytes >= MAX_VARINT_BYTES) {
                malformed = true;
                return 0;
            }
            shift += 7n;
        }
        return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result;
    }

    while (offset < buffer.length) {
        const key = varint();
        if (malformed) {
            return;
        }
        const fieldNo = Number(key) >> 3;
        const wireType = Number(key) & 7;
        if (wireType === WIRE.varint) {
            const value = varint();
            if (malformed) {
                return;
            }
            visit(fieldNo, value);
        } else if (wireType === WIRE.bytes) {
            const length = Number(varint());
            if (malformed || offset + length > buffer.length) {
                return;
            }
            visit(fieldNo, buffer.subarray(offset, offset + length));
            offset += length;
        } else if (wireType === WIRE.fixed64) {
            if (offset + 8 > buffer.length) {
                return;
            }
            visit(fieldNo, buffer.readBigUInt64LE(offset));
            offset += 8;
        } else if (wireType === WIRE.fixed32) {
            if (offset + 4 > buffer.length) {
                return;
            }
            visit(fieldNo, buffer.readUInt32LE(offset));
            offset += 4;
        } else {
            // Groups are deprecated and unused here; there is no safe way to skip
            // one without a schema, so stop rather than misread the remainder.
            return;
        }
    }
}

/** Decodes a message into a plain object using a `{ fieldNo: name }` map. */
export function decodeFields(buffer, fieldNames) {
    const out = {};
    readMessage(buffer, (fieldNo, value) => {
        const name = fieldNames[fieldNo];
        if (name !== undefined) {
            out[name] = value;
        }
    });
    return out;
}

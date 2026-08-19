import { SUPPORTED_BUTTONS } from "./input-dispatcher.mjs";

const requiredDeviceId = {
    type: "object",
    additionalProperties: false,
    properties: {
        deviceId: { type: "string", minLength: 1 },
    },
    required: ["deviceId"],
};

const leaseFields = {
    deviceId: { type: "string", minLength: 1 },
    leaseId: { type: "string", minLength: 1 },
};

const coordinateSpace = {
    type: "string",
    enum: ["point", "normalized"],
    default: "normalized",
};

const textInput = {
    type: "string",
    minLength: 1,
    maxLength: 20_000,
    pattern: "^[\\u0009\\u000A\\u0020-\\u007E]+$",
};

const normalizedCoordinate = { type: "number", minimum: 0, maximum: 1 };
const pointCoordinate = { type: "number" };

function coordinateProperties(names, includeDuration = false) {
    return {
        coordinateSpace,
        ...Object.fromEntries(names.map((name) => [name, pointCoordinate])),
        ...(includeDuration ? { durationMs: { type: "integer", minimum: 0, maximum: 60_000 } } : {}),
    };
}

/** Normalized coordinates are the default, so only `point` space allows values > 1. */
function normalizedCoordinateRule(names) {
    return {
        if: {
            properties: { coordinateSpace: { const: "point" } },
            required: ["coordinateSpace"],
        },
        else: {
            properties: Object.fromEntries(names.map((name) => [name, normalizedCoordinate])),
        },
    };
}

function inputStep(kind, properties, required, rules = []) {
    return {
        type: "object",
        additionalProperties: false,
        properties: {
            kind: { const: kind },
            input: {
                type: "object",
                additionalProperties: false,
                properties,
                required,
                ...(rules.length > 0 ? { allOf: rules } : {}),
            },
        },
        required: ["kind", "input"],
    };
}

const tapCoordinates = ["x", "y"];
const swipeCoordinates = ["startX", "startY", "endX", "endY"];
const tapInputProperties = coordinateProperties(tapCoordinates, true);
const swipeInputProperties = {
    ...coordinateProperties(swipeCoordinates),
    durationMs: { type: "integer", minimum: 1, maximum: 60_000 },
};

const keyCodeSchema = {
    type: "string",
    minLength: 1,
    maxLength: 64,
    description: "Android keycode number, KEYCODE_* name, or browser KeyboardEvent.code such as KeyA.",
};

const inputSteps = [
    inputStep("tap", tapInputProperties, tapCoordinates, [normalizedCoordinateRule(tapCoordinates)]),
    inputStep("swipe", swipeInputProperties, swipeCoordinates, [normalizedCoordinateRule(swipeCoordinates)]),
    inputStep("key", { code: keyCodeSchema }, ["code"]),
    inputStep("text", { text: textInput }, ["text"]),
    inputStep("button", { button: { type: "string", enum: SUPPORTED_BUTTONS } }, ["button"]),
    inputStep("wait", { durationMs: { type: "integer", minimum: 0, maximum: 10_000 } }, ["durationMs"]),
];

export const openInputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        deviceId: {
            type: "string",
            minLength: 1,
            description: "AVD name for an emulator, or adb serial for a connected device.",
        },
        autoBoot: { type: "boolean" },
        bootAfterOpen: { type: "boolean" },
    },
};

export const actionSchemas = {
    getDeviceState: requiredDeviceId,
    captureScreen: requiredDeviceId,
    acquireControl: {
        type: "object",
        additionalProperties: false,
        properties: {
            deviceId: { type: "string", minLength: 1 },
            reason: { type: "string", minLength: 1, maxLength: 240 },
            ttlSeconds: { type: "integer", minimum: 15, maximum: 900 },
        },
        required: ["deviceId"],
    },
    renewControl: {
        type: "object",
        additionalProperties: false,
        properties: { ...leaseFields, ttlSeconds: { type: "integer", minimum: 15, maximum: 900 } },
        required: ["deviceId", "leaseId"],
    },
    releaseControl: {
        type: "object",
        additionalProperties: false,
        properties: { ...leaseFields, reason: { type: "string", minLength: 1, maxLength: 240 } },
        required: ["deviceId", "leaseId"],
    },
    startVideoRecording: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            maxDurationSeconds: { type: "integer", minimum: 5, maximum: 180, default: 120 },
        },
        required: ["deviceId", "leaseId"],
    },
    stopVideoRecording: {
        type: "object",
        additionalProperties: false,
        properties: { ...leaseFields, recordingId: { type: "string", minLength: 1 } },
        required: ["deviceId", "leaseId", "recordingId"],
    },
    bootDevice: {
        type: "object",
        additionalProperties: false,
        properties: leaseFields,
        required: ["deviceId", "leaseId"],
    },
    shutdownDevice: {
        type: "object",
        additionalProperties: false,
        properties: leaseFields,
        required: ["deviceId", "leaseId"],
    },
    restartDevice: {
        type: "object",
        additionalProperties: false,
        properties: leaseFields,
        required: ["deviceId", "leaseId"],
    },
    rotateDevice: {
        type: "object",
        additionalProperties: false,
        properties: { ...leaseFields, direction: { type: "string", enum: ["left", "right"] } },
        required: ["deviceId", "leaseId", "direction"],
    },
    pressButton: {
        type: "object",
        additionalProperties: false,
        properties: { ...leaseFields, button: { type: "string", enum: SUPPORTED_BUTTONS } },
        required: ["deviceId", "leaseId", "button"],
    },
    tap: {
        type: "object",
        additionalProperties: false,
        properties: { ...leaseFields, ...tapInputProperties },
        required: ["deviceId", "leaseId", ...tapCoordinates],
        allOf: [normalizedCoordinateRule(tapCoordinates)],
    },
    swipe: {
        type: "object",
        additionalProperties: false,
        properties: { ...leaseFields, ...swipeInputProperties },
        required: ["deviceId", "leaseId", ...swipeCoordinates],
        allOf: [normalizedCoordinateRule(swipeCoordinates)],
    },
    sendKey: {
        type: "object",
        additionalProperties: false,
        properties: { ...leaseFields, code: keyCodeSchema },
        required: ["deviceId", "leaseId", "code"],
    },
    sendText: {
        type: "object",
        additionalProperties: false,
        properties: { ...leaseFields, text: textInput },
        required: ["deviceId", "leaseId", "text"],
    },
    performInputs: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            steps: { type: "array", minItems: 1, maxItems: 50, items: { oneOf: inputSteps } },
        },
        required: ["deviceId", "leaseId", "steps"],
    },
    installApk: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            apkPath: { type: "string", minLength: 1, description: "Absolute path to an APK on this machine." },
            reinstall: { type: "boolean", default: true },
            grantPermissions: { type: "boolean", default: false },
        },
        required: ["deviceId", "leaseId", "apkPath"],
    },
    launchApp: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            packageName: { type: "string", minLength: 1 },
            activity: {
                type: "string",
                minLength: 1,
                description: "Optional component name; the launcher activity is used when omitted.",
            },
        },
        required: ["deviceId", "leaseId", "packageName"],
    },
};

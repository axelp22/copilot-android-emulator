# Verification suites

These drive the extension against real hardware. There is no mocking: every suite
talks to an actual emulator or connected device through `adb`, and the browser
suite renders the canvas in Chrome.

## Prerequisites

- A booted emulator (or connected device) and `adb` on `PATH`.
- `ffprobe` for `stream-decode.mjs` (optional; the decode check skips without it).
- Google Chrome for `rendered-canvas.mjs` (optional; the suite skips without it).

Configure targets with environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VERIFY_DEVICE_ID` | `Pixel_10_Pro_XL` | AVD name (emulator) or serial (device) under test |
| `VERIFY_SERIAL` | `emulator-5554` | adb serial of that device, for out-of-band checks |
| `VERIFY_BOOT_AVD` | `lowend_api34` | a **shut down** AVD the lifecycle suite may boot and stop |
| `VERIFY_ADB` | `adb` | path to adb |
| `VERIFY_CHROME` | macOS Chrome path | path to a Chrome binary |
| `VERIFY_ARTIFACTS` | `/tmp/android-emulator-verify` | where screenshots and recordings are written |

## Suites

```sh
node scripts/verify/device-layer.mjs     # discovery, input, rotation, stream, restart loop
node scripts/verify/canvas-server.mjs    # HTTP/SSE/security/lease gating
node scripts/verify/stream-decode.mjs    # aspect ratio + ffprobe decodability
node scripts/verify/boot-lifecycle.mjs   # cold boot and shutdown of an AVD (slow)
```

`rendered-canvas.mjs` needs a live canvas URL. Ask Copilot to open the Android
Emulator canvas, take the URL it reports, then:

```sh
node scripts/verify/rendered-canvas.mjs "http://127.0.0.1:PORT/TOKEN/"
```

It verifies WebCodecs decoding, live video, pointer input and toolbar buttons in a
real browser. If the agent happens to hold a control lease it also checks the
overlay and the "Take back control" affordance; otherwise those checks skip.

## Notes

- `boot-lifecycle.mjs` skips if its target AVD is already running, because it would
  otherwise shut down a device you are using.
- The suites move the device around (taps, swipes, Home) by design. Point them at a
  scratch emulator rather than a device mid-task.
- `device-layer.mjs` briefly sets `user_rotation`, then resets it to 0.

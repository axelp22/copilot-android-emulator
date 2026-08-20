# Android Emulator canvas — implementation spec

This repository ports the architecture of
[`cschleiden/copilot-ios-simulator`](https://github.com/cschleiden/copilot-ios-simulator)
to Android. A reference clone is available for structural comparison but **must not be
copied verbatim** — Android's device layer is entirely different.

## Key architectural difference

The iOS project needs a native Swift bridge (`native/`) because CoreSimulator has no
public streaming/HID API. **Android needs no native code at all.** `adb` provides every
capability the canvas requires, so this project is pure Node + web assets:

| Capability | iOS (Swift bridge) | Android (this project) |
| --- | --- | --- |
| List devices | `simctl list` | `adb devices -l` + `emulator -list-avds` |
| Boot | `simctl boot` | `emulator -avd <name>` (detached), then wait for `sys.boot_completed` |
| Shutdown | `simctl shutdown` | `adb -s <serial> emu kill` |
| Screenshot | private framework | `adb -s <serial> exec-out screencap -p` |
| Video stream | `H264StreamEncoder.swift` | `adb -s <serial> exec-out screenrecord --output-format=h264 -` |
| Touch/keys | `HIDController.swift` | `adb shell input tap/swipe/text/keyevent` |
| Rotation | `simctl` + prefs | `adb shell settings put system user_rotation` |

## Layout

```
.github/extensions/android-emulator/
  extension.mjs            # canvas registration, agent tools, session wiring
  copilot-extension.json
  lib/
    adb.mjs                # adb/emulator process helpers, SDK discovery
    device-registry.mjs    # discovery + cached state for emulators & devices
    device-model.mjs       # normalized device shape, timestamps
    device-session-manager.mjs  # lifecycle, leases, orchestration
    screen-service.mjs     # screenshots + transport selection
    h264-stream.mjs        # screenrecord child mgmt, Annex-B framing, restart loop
    grpc-client.mjs        # dependency-free gRPC over node:http2
    protobuf.mjs           # minimal protobuf encode/decode
    emulator-controller.mjs # EmulatorController messages and methods
    emulator-discovery.mjs # locates running emulators via their discovery files
    emulator-jwt.mjs       # ES256 JWT handshake for the emulator gRPC endpoint
    emulator-access.mjs    # gRPC allowlist path + issuer selection
    emulator-control-pool.mjs # shared per-device gRPC control connections
    grpc-frame-stream.mjs  # streamScreenshot-backed frame source
    input-dispatcher.mjs   # tap/swipe/text/key/button translation to adb or gRPC
    video-recording-service.mjs
    canvas-server.mjs      # loopback HTTP/SSE/WebSocket server for the canvas
    canvas-binding-store.mjs
    web-assets.mjs
    http-utils.mjs
    websocket-utils.mjs
    schemas.mjs
    errors.mjs
  assets/
    emulator-access.json   # gRPC allowlist for emulators this extension launches
  web/
    index.html  app.js  styles.css  api-client.js
    device-frame.js  device-picker.js  input-controller.js
    h264-stream.js  icons.js
extensions/android-emulator/extension.mjs   # shim re-export (already written)
```

## Device layer details

### Discovery

Merge two sources into one device list:

1. **Running targets** — `adb devices -l` yields serials (`emulator-5554` for an
   emulator, an opaque hardware id for a connected device). For emulator serials,
   resolve the AVD name with
   `adb -s <serial> emu avd name` (first line of output, before `OK`).
2. **Offline AVDs** — `emulator -list-avds` yields AVDs that are not booted.

Each device entry: `{ serial, avdName, kind: "emulator" | "device", name, state:
"Booted" | "Shutdown" | "Booting", apiLevel, screen: { width, height, density },
orientation, isAvailable }`.

Use the AVD name as the stable identifier for emulators (serials are reassigned on
reboot); use the serial for physical devices. The canvas open input takes `deviceId`
(either form) — mirror `resolveDeviceUdid` from the reference.

Physical devices must never be booted/shut down by the extension; expose them as
read-only lifecycle targets that still support screen, input, and screenshots.

### SDK discovery

Resolve `adb` and `emulator` in this order and cache the result:
`$ANDROID_HOME`/`$ANDROID_SDK_ROOT` → `~/Library/Android/sdk` (macOS) →
`~/Android/Sdk` (Linux) → `PATH`. Surface a clear, actionable error when missing.

### Boot

`emulator -avd <name> -no-snapshot-save` spawned detached, then poll
`adb -s <serial> shell getprop sys.boot_completed` until `1` with a timeout
(~180s). Detect the new serial by diffing `adb devices` before/after.

### Screen metrics

`adb shell wm size` → `Physical size: WxH` (prefer `Override size` when present).
`adb shell wm density` → density. Refresh after rotation.

### Streaming (the important part)

Two transports share one wire format. `screen-service.mjs` chooses per device:
emulators prefer gRPC, everything else mirrors, and any gRPC failure falls back to
mirroring rather than failing the session.

Shared framing: `[uint32 length][uint8 tag][payload]` with `0x01` = decoder config
(SPS+PPS), `0x02` = keyframe, `0x03` = delta frame, `0x04` = complete PNG still. A
gRPC stream consists entirely of `0x04` frames, so the client must paint a stream that
never carries a decoder config.

#### Emulators — `EmulatorController` gRPC

The emulator exposes the control plane Android Studio's embedded emulator uses. Current
emulators enable it by default and record the port, key directory and launch command in
a per-PID discovery file (`pid_<pid>.ini`) under the platform's temp directory.

- Auth is mandatory: the stock allowlist marks nothing unprotected. Publish an ES256
  public JWK into the `grpc.jwks` directory, **wait for the emulator to merge it into
  `active.jwk`** (calling earlier fails with `No key set present`), then send
  `authorization: Bearer <jwt>`. The JWT header must **omit `typ`**, and the signature
  must be raw `r||s` (`ieee-p1363`), not DER.
- Emulators launched here pass `-grpc-allowlist assets/emulator-access.json` so the
  extension authenticates as `copilot-android-emulator` with only the methods it needs.
  That file retains the `android-studio` entry so Studio can still attach. Emulators
  launched elsewhere keep the stock allowlist, where `android-studio` is the only issuer
  granted screen access.
- Request **PNG**, not raw. Measured on a Pixel 10 Pro XL AVD at 336x748: PNG streams
  ~24fps at ~37KB per frame, while RGB888 manages ~2fps at ~754KB. PNG is better on
  frame rate, bandwidth and latency simultaneously.
- `ImageFormat.width` is field **3** and `height` field **4**; field 2 is the output-only
  rotation. Encoding size into field 2 silently returns unscaled frames.
- Raise the HTTP/2 receive window above one full frame. Node defaults to 64KB, and a
  larger frame leaves the server stalled after exactly one message, which is
  indistinguishable from an idle screen.
- Frames arrive only when the guest posts one, so a still screen simply goes quiet. Send
  one `getScreenshot` immediately on connect so the canvas paints without waiting.

#### Physical devices — `screenrecord` mirror

`adb -s <serial> exec-out screenrecord --output-format=h264 --size <W>x<H> --bit-rate <N> -`
emits **raw Annex-B H.264** (verified: starts `00 00 00 01 67` SPS, `68` PPS, `65` IDR).

Constraints and required handling:

- `screenrecord` hard-stops at 180 seconds. Run it in a **restart loop**: when the child
  exits, respawn transparently and re-emit parameter sets so playback continues
  uninterrupted. Do not surface the restart to the client.
- `--size` must be even-numbered and within encoder limits; clamp derived sizes.
- Send a `screencap` seed frame (tag `0x04`) immediately on connect so the canvas paints
  before the first IDR arrives, and again after the encoder goes quiet.
- Web client: configure `VideoDecoder` with `codec: "avc1.<profile><compat><level>"`
  parsed from SPS. Since the payloads are Annex-B, either set
  `description` to a constructed avcC box or keep Annex-B and omit `description`
  (Chromium accepts Annex-B when `description` is absent). Pick one and be consistent.
- Stream quality controls: fps (30/60 — `screenrecord` has no fps flag, so approximate by
  bit-rate + size) and resolution scale (25 / 50 / 100 percent of physical size).

### Input mapping

| Action | adb command |
| --- | --- |
| tap | `input tap <x> <y>` |
| swipe | `input swipe <x1> <y1> <x2> <y2> <durationMs>` |
| text | `input text <escaped>` — escape space as `%s`, and `"'()<>|;&*\~^$` |
| key | `input keyevent <code>` |
| home / back / recents | `keyevent 3` / `4` / `187` |
| power / volume | `keyevent 26` / `24` / `25` |
| rotate | `settings put system accelerometer_rotation 0` then `settings put system user_rotation 0..3` |

Coordinates arrive normalized (0–1) by default, matching the reference; multiply by
current physical size. Also accept explicit `"point"` coordinate space.

For drag interaction on **physical devices**, coalesce pointer moves into `input swipe`
segments — `adb shell input` has no true down/move/up primitive without `sendevent`.
Document this limitation in the README (manual dragging is approximated).

**Emulators** route canvas pointer input through `sendTouch` instead, which gives a real
continuous gesture on one touch slot. A touch is released by sending pressure 0 for its
identifier; failing to do so leaves the slot held for 120 seconds, so cancel and error
paths must lift explicitly.

## Behavior parity to preserve

Keep these behaviors from the reference — they are the reason it feels good to use:

- **Control leasing.** Agent-driven input requires an exclusive, time-limited lease
  (`acquire_control` / `renew_control` / `release_control`). Manual canvas input is
  blocked while a lease is active, with a "Take back control" affordance that cancels it.
  `capture_screen` does **not** require a lease.
- **Loopback-only canvas server** with a random path token, `assertLoopbackRequest`
  on every route, SSE for state push, WebSocket for touch streaming.
- **Canvas bindings persisted** under the session workspace so a reopened canvas
  reattaches to the same device.
- **Graceful teardown** on `session.shutdown`: kill stream children, release leases,
  close servers.

## Agent tools

| Tool | Lease required | Notes |
| --- | --- | --- |
| `diagnose_adb` | no | Replaces `diagnose_native_backend`; validates SDK, adb server, versions |
| `list_devices` | no | Emulators + AVDs + physical devices |
| `get_device_state` | no | |
| `capture_screen` | no | PNG artifact via `screencap` |
| `acquire_control` / `renew_control` / `release_control` | — | |
| `start_video_recording` / `stop_video_recording` | yes / no | |
| `boot_device` / `shutdown_device` / `restart_device` | yes | Emulators only |
| `rotate_device` | yes | `left` / `right` |
| `press_button` | yes | `home`, `back`, `recents`, `power`, `volume_up`, `volume_down` |
| `tap` / `swipe` / `send_key` / `send_text` / `perform_inputs` | yes | |
| `install_apk` / `launch_app` | yes | Android-specific additions (`adb install -r`, `am start`) |

## Verification (required before calling this done)

A booted emulator and a physical device are both available on this machine.

1. `node --check` every `.mjs` file.
2. Exercise the device layer directly with a scratch Node script: list devices,
   screenshot, tap, rotate, and read 3 seconds of the H.264 stream, asserting that the
   framed output contains a config frame followed by a keyframe.
3. Confirm the `screenrecord` restart loop by forcing a short `--time-limit` and
   asserting the stream continues past the child's exit.
4. Load the extension in the app (`extensions_reload`), open the canvas, and confirm
   live video, manual tap, and lease hand-off.

Do not mark the task complete on syntax checks alone.

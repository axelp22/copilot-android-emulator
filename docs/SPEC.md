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
    screen-service.mjs     # screenshots + stream creation
    h264-stream.mjs        # screenrecord child mgmt, Annex-B framing, restart loop
    input-dispatcher.mjs   # tap/swipe/text/key/button translation to adb
    video-recording-service.mjs
    canvas-server.mjs      # loopback HTTP/SSE/WebSocket server for the canvas
    canvas-binding-store.mjs
    web-assets.mjs
    http-utils.mjs
    websocket-utils.mjs
    schemas.mjs
    errors.mjs
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

`adb -s <serial> exec-out screenrecord --output-format=h264 --size <W>x<H> --bit-rate <N> -`
emits **raw Annex-B H.264** (verified: starts `00 00 00 01 67` SPS, `68` PPS, `65` IDR).

Constraints and required handling:

- `screenrecord` hard-stops at 180 seconds. Run it in a **restart loop**: when the child
  exits, respawn transparently and re-emit parameter sets so playback continues
  uninterrupted. Do not surface the restart to the client.
- `--size` must be even-numbered and within encoder limits; clamp derived sizes.
- Repackage into the same length-prefixed tagged framing the reference client uses:
  `[uint32 length][uint8 tag][payload]` with `0x01` = decoder config (SPS+PPS),
  `0x02` = keyframe, `0x03` = delta frame, `0x04` = JPEG/PNG seed frame.
  Send a `screencap` seed frame (tag `0x04`) immediately on connect so the canvas paints
  before the first IDR arrives.
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

For drag interaction in the canvas, coalesce pointer moves into `input swipe` segments —
`adb shell input` has no true down/move/up primitive without `sendevent`. Document this
limitation in the README (manual dragging is approximated).

## Behavior parity to preserve

Keep these behaviors from the reference — they are the reason it feels good to use:

- **Control leasing.** Agent-driven input requires an exclusive, time-limited lease
  (`acquire_control` / `renew_control` / `release_control`). Manual canvas input is
  blocked while a lease is active, with a "Take back control" affordance that cancels it.
  `capture_screen` does **not** require a lease. A lease holds the device against other
  Copilot sessions for as long as it lasts, and an action started under a lease keeps
  holding it until that action finishes, even if the lease lapses first.
- **One rule for anything that takes time.** Agent actions, installs and emulator
  lifecycle all take the device through the cross-session queue, so none of them can
  land on a device another session is using. Manual canvas input is advisory: it is
  refused when the device is known to be held elsewhere, but that check reads a
  status poll a few seconds old rather than taking a hold.
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

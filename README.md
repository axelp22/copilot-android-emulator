# Android Emulator canvas for GitHub Copilot App

An embedded Android emulator canvas for GitHub Copilot App. It provides live device
video, emulator and device selection with lifecycle controls, touch and keyboard input,
rotation, screenshots, configurable streaming, and safe agent-control leasing.

Inspired by [`cschleiden/copilot-ios-simulator`](https://github.com/cschleiden/copilot-ios-simulator),
rebuilt on `adb`. Unlike the iOS version, this extension needs **no native code** — the
Android SDK platform tools expose everything required.

## Requirements

- macOS, Linux, or Windows with the Android SDK installed
- `adb` (platform-tools) and `emulator` on `PATH`, or a discoverable
  `ANDROID_HOME` / `ANDROID_SDK_ROOT`
- At least one AVD (`emulator -list-avds`) or a connected device with USB debugging

## Installation

### Install directly from a local checkout

In GitHub Copilot App, paste this prompt:

```text
Install the extension from <path-to-this-repo>/.github/extensions/android-emulator
```

When prompted, choose an installation scope:

- **User** makes the extension available across all your projects.
- **Project** installs it in the current repository for the whole team.
- **Session** installs it only for the current Copilot session.

### Install manually

```sh
mkdir -p <target-repository>/.github/extensions
cp -R copilot-android-emulator/.github/extensions/android-emulator \
  <target-repository>/.github/extensions/android-emulator
```

Reload extensions in GitHub Copilot after copying. No package install step is required.

## Usage

Ask GitHub Copilot to open the Android Emulator. Choose an AVD or connected device from
the dropdown, then use the canvas controls to interact with it, rotate it, configure
stream quality, restart it, or shut it down.

You can also ask Copilot to capture the screen or interact with the selected device.
Screenshots do not require control. Interactive agent actions use an exclusive,
time-limited lease so they cannot conflict with manual input.

Physical devices are supported for screen, input, and screenshots, but the extension
never boots or shuts them down.

## Known limitations

- **Manual dragging is approximated.** `adb shell input` has no down/move/up primitive,
  so pointer moves are coalesced into chained `input swipe` segments. Scrolling and
  flinging feel close to native, but each segment is a separate gesture on the device,
  so gestures that depend on a single continuous touch — drag-and-drop, pinch, or
  long-press-then-drag — will not behave the way they do on real hardware. A pointer
  that never leaves a small radius is sent as a tap instead.
- **Frame rate is approximate.** `screenrecord` has no frame-rate flag, so the FPS
  control tunes the bit-rate and capture size rather than setting a hard frame rate.
- **Emulators are much less smooth than physical devices, and get worse over time.**
  A connected Pixel 8 Pro holds ~50fps with ~20ms between frames. A Pixel 10 Pro XL
  AVD on the same code path starts around 25fps and degrades with sustained capture —
  measured falling to 12fps, then 6fps, then below 1fps, recovering only on restart.
  Neither guest CPU (idle) nor host CPU (one core) is saturated, and the GPU is
  hardware accelerated, so this is a limitation of the emulator's capture path rather
  than a resource shortage or a setting.

  **If you want a smooth interactive canvas, use a physical device.** Emulators are
  still fine for agent-driven automation, where frame rate does not matter. When an
  emulator does get sluggish, restarting it restores capture speed; the canvas says
  so when it detects the slowdown.

  Emulators default to a 50% capture, which measured fastest — larger overloads the
  encoder, and smaller does not help, because pixel count is not the limit. Physical
  devices default to 100%. Either can be changed from the canvas toolbar.
- **Input costs roughly 50-190ms per action** on both emulators and devices, because
  every `adb shell input` starts a new process on the device.
- **Rotation depends on the app.** Rotating writes `user_rotation`, which the window
  manager may ignore when the foreground app pins its orientation. `rotate_device`
  reports whether the rotation was actually applied.
- **Streams restart every 180 seconds.** `screenrecord` hard-stops at that point. The
  child is respawned transparently and parameter sets are re-sent, so the canvas keeps
  its last frame across the seam instead of dropping the video.
- **Emulator encoders can stall under heavy repeated capture.** After many streams have
  been started and stopped, an emulator may return no video at all. The extension
  detects this and reports an error rather than retrying silently; restarting the
  emulator clears it.
- **Recording is capped at 180 seconds** for the same reason.

## Agent tools

| Tool | Description |
| --- | --- |
| `diagnose_adb` | Validate the Android SDK, `adb` server, and emulator tooling. |
| `list_devices` | List AVDs, running emulators, and connected devices. |
| `get_device_state` | Get state, lease, and metadata for a device. |
| `acquire_control` | Acquire an exclusive, time-limited control lease. |
| `renew_control` | Renew an active control lease. |
| `release_control` | Release an active control lease. |
| `capture_screen` | Capture a PNG screenshot as a session artifact without acquiring control. |
| `start_video_recording` | Start a lease-bound H.264 recording while agent input continues. |
| `stop_video_recording` | Finalize an active recording as a session artifact. |
| `boot_device` | Boot an AVD and wait until `sys.boot_completed`. Emulators only. |
| `shutdown_device` | Shut down a running emulator. Emulators only. |
| `restart_device` | Shut down and boot an emulator. Emulators only. |
| `rotate_device` | Rotate the device left or right, reporting whether the app allowed it. |
| `press_button` | Press home, back, recents, power, or volume buttons. |
| `tap` | Tap at normalized coordinates by default, or explicit point coordinates. |
| `swipe` | Swipe using normalized coordinates by default, or explicit point coordinates. |
| `send_key` | Send an Android key event by keycode, `KEYCODE_*` name, or browser key code. |
| `send_text` | Send text input. |
| `perform_inputs` | Run an ordered input sequence (tap, swipe, key, text, button, wait) under one lease. |
| `install_apk` | Install an APK from this machine onto the selected device. |
| `launch_app` | Launch an installed package, optionally targeting a specific activity. |

Tools that control a device require a lease acquired with `acquire_control`;
`capture_screen` does not.

## Implementation notes

See [`docs/SPEC.md`](docs/SPEC.md) for the architecture, the `adb` capability mapping,
and the H.264 streaming design (including the `screenrecord` 180-second restart loop).

## Verifying

The suites in [`scripts/verify/`](scripts/verify/) run against real hardware — there is
no mocking. They cover the device layer, the canvas server and its security posture,
stream decodability, emulator cold boot, and the rendered canvas in a real browser.

```sh
node scripts/verify/device-layer.mjs
node scripts/verify/canvas-server.mjs
node scripts/verify/stream-decode.mjs
node scripts/verify/boot-lifecycle.mjs
node scripts/verify/rendered-canvas.mjs "<canvas url>"
```

See [`scripts/verify/README.md`](scripts/verify/README.md) for prerequisites and the
environment variables that select which device to target.

## Known gaps

Everything below is implemented but has **not** been exercised against real
hardware, so treat it as unproven rather than working:

- **Screenshot fallback for runtimes without WebCodecs.** The canvas falls back to
  polling `api/frame.png` when `VideoDecoder` is missing, and a watchdog switches to
  it if nothing paints. Every browser used during verification had WebCodecs, so
  neither path has been seen to run.
- **Tablet and landscape device chrome.** The frame adapts to tablet metrics and to
  a landscape display, but only a portrait phone has been rendered. Rotation is also
  refused by any app that pins its orientation, so landscape is hard to reach.
- **Canvas binding persistence.** Bindings are written under the session workspace so
  a reopened canvas reattaches to the same device; reattachment after a restart has
  not been verified.
- **Teardown on `session.shutdown`.** Stream children, leases and servers are closed
  on shutdown, but the handler has not been observed firing.

What *is* verified against a real emulator and a connected device is listed above
under [Verifying](#verifying); the suites in `scripts/verify/` are the source of
truth, not this list.

## License

MIT

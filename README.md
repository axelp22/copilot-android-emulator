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

For a single repository:

```sh
mkdir -p <target-repository>/.github/extensions
cp -R copilot-android-emulator/.github/extensions/android-emulator \
  <target-repository>/.github/extensions/android-emulator
```

For every project, install it at user scope:

```sh
mkdir -p ~/.copilot/extensions
cp -R copilot-android-emulator/.github/extensions/android-emulator \
  ~/.copilot/extensions/android-emulator
```

Reload extensions in GitHub Copilot after copying. No package install step is required.

The copy is a snapshot, so re-copy it to pick up later changes. Note that if a
repository *also* carries this extension under `.github/extensions/`, both are loaded
and share a canvas id, so opening the canvas there needs an explicit `extensionId`
(`user:android-emulator` or `project:android-emulator`). That only affects working
inside this repository; elsewhere the user-scope copy is unambiguous.

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
| `acquire_control` | Acquire an exclusive, time-limited control lease. Pass `waitSeconds` to queue for a busy device, or `deviceId: "any"` to take the first free one. |
| `queue_status` | Show which session is using each device and who is waiting behind it. |
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

## Knowing whether a device is free

The device picker labels every device with how it is being used, so you can tell at a
glance whether one is free before switching to it:

| Label | Meaning |
| --- | --- |
| *This canvas* | The device this canvas is showing |
| *Open* | Open in another canvas in this session |
| *Agent control* | An agent in this session holds a control lease |
| *In use · &lt;session&gt;* | **Another Copilot session** is driving it |
| *Waiting · #N* | You are queued for it, at position N |
| *In use elsewhere* | Something outside Copilot is capturing it |

Control leases live in memory, so on their own they only coordinate the canvases and
agents inside a single session — and each session runs its own extension process. Two
sessions could otherwise drive one emulator at the same time, interleaving taps and
corrupting both runs.

Sessions therefore publish a small claim file under
`~/.copilot/android-emulator/claims/` naming the session, its working directory and
what it is doing. `acquire_control` refuses a device another session is driving, and
names that session in the error. Claims carry a heartbeat and the owning process id,
so a session that crashes or is killed never leaves a device looking permanently
taken: the next session to look discards the stale claim.

Claims are cooperative, so they only reveal sessions running this extension. Capture
started by anything else — Android Studio, `scrcpy`, a bare `adb screenrecord` — is
detected separately by comparing the device's `screenrecord` processes against the
ones this extension started, and shown as *In use elsewhere*.

## Taking turns on a shared device

Refusing a busy device is safe but unhelpful when several sessions genuinely need the
same emulator. Sessions can instead queue for it, first come first served:

```
acquire_control { deviceId: "emulator-5554", waitSeconds: 300 }
```

The call waits until the device is free and then returns as usual, reporting how long
it waited. Without `waitSeconds` the behaviour is unchanged: a busy device fails
immediately, naming the session using it and how many are waiting.

Pass `deviceId: "any"` to take whichever booted device becomes free first, which is
what you want when a pool of emulators is interchangeable. The request queues for
every candidate at once and keeps the first grant.

`queue_status` shows, for each device, the session holding it and the sessions waiting
behind it. The device picker shows the same thing: the holder's name on the device,
and *Waiting · #N* on a device you are queued for.

The queue lives in files under `~/.copilot/android-emulator/queue/`, so it works
across sessions and across separate extension processes:

- A device is held by creating `holders/<device>.json` **exclusively** — two sessions
  racing for a free device cannot both win, because the second create fails.
- Waiting sessions write a ticket stamped with the time they asked. A device is only
  granted to the oldest waiting ticket, so a session that arrives later cannot jump
  the queue.
- Holders and tickets carry a heartbeat and process id. A session that crashes while
  holding a device is reclaimed rather than blocking everyone behind it.

The queue is cooperative in the same way claims are: it coordinates sessions running
this extension, not other tools on the machine.

## Implementation notes

See [`docs/SPEC.md`](docs/SPEC.md) for the architecture, the `adb` capability mapping,
and the H.264 streaming design (including the `screenrecord` 180-second restart loop).

## Verifying

The suites in [`scripts/verify/`](scripts/verify/) run against real hardware — there is
no mocking. They cover the device layer, the canvas server and its security posture,
stream decodability, emulator cold boot, cross-session sharing and queueing, and the
rendered canvas in a real browser.

```sh
node scripts/verify/device-layer.mjs
node scripts/verify/canvas-server.mjs
node scripts/verify/stream-decode.mjs
node scripts/verify/boot-lifecycle.mjs
node scripts/verify/cross-session-claims.mjs
node scripts/verify/device-queue.mjs
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

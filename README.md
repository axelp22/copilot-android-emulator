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

## How the screen is streamed

The extension picks a transport per device.

**Emulators use the emulator's own gRPC control plane** (`EmulatorController`), the same
interface Android Studio's embedded emulator uses. Frames are complete PNG stills pushed
as the guest produces them, and pointer input is delivered as real multitouch events.
Nothing goes through `adb` on this path, so none of the `screenrecord` limitations below
apply.

**Physical devices are mirrored** with `adb exec-out screenrecord`, decoded as H.264 by
WebCodecs in the canvas. Emulators fall back to this automatically whenever gRPC is not
usable — most commonly when the emulator runs on another machine, since it is reached
over an adb tunnel and its discovery file is not present locally. A bandwidth-constrained
link is exactly where the compressed mirror is the better choice anyway.

Measured on a Pixel 10 Pro XL AVD, gRPC against the mirror:

| Capture | Transport | Latency (p50) | Bandwidth |
| --- | --- | --- | --- |
| 25% | gRPC | 7ms | 0.9MB/s |
| 50% | gRPC | 25ms | 2.2MB/s |
| 50% | mirror | ~200ms | ~1MB/s |
| 100% | mirror | ~436ms | ~1MB/s |

Both transports share one wire format, so the canvas needs no knowledge of which is in
use. You can pin one for diagnosis with `?transport=grpc` or `?transport=mirror` on the
stream endpoint.

Emulators this extension launches are started with a bundled gRPC allowlist so it can
authenticate as itself with only the methods it needs, rather than borrowing Android
Studio's blanket-access identity. The bundled list keeps Android Studio's own entry, so
Studio can still attach to those emulators. An emulator started elsewhere keeps the
SDK's stock allowlist, which grants screen access to one issuer only, so the extension
presents that identity when attaching to it.

## Known limitations

- **Manual dragging is approximated on physical devices.** `adb shell input` has no
  down/move/up primitive, so pointer moves are coalesced into chained `input swipe`
  segments. Scrolling and flinging feel close to native, but each segment is a separate
  gesture on the device, so gestures that depend on a single continuous touch —
  drag-and-drop, pinch, or long-press-then-drag — will not behave the way they do on
  real hardware. A pointer that never leaves a small radius is sent as a tap instead.
  Emulators are not affected: gRPC delivers a genuine continuous touch.
- **Frame rate is approximate on the mirror.** `screenrecord` has no frame-rate flag, so
  the FPS control tunes the bit-rate and capture size rather than setting a hard frame
  rate. On the gRPC transport the FPS control is an upper bound, and frames arrive only
  when the screen actually changes.
- **Emulator capture over the mirror is slow, and degrades over time.** A connected
  Pixel 8 Pro holds ~50fps with ~20ms between frames. The same code path on a Pixel 10
  Pro XL AVD starts around 25fps and degrades with sustained capture — measured falling
  to 12fps, then 6fps, then below 1fps, recovering only on restart. This is a limitation
  of the emulator's `screenrecord` path rather than a resource shortage.

  This is the main reason the gRPC transport exists, and it is why emulators no longer
  use the mirror by default. If an emulator has fallen back to mirroring and feels
  sluggish, restarting it restores capture speed; the canvas says so when it detects the
  slowdown.

  Emulators default to a 50% capture, which measured fastest on the mirror and keeps
  gRPC latency at ~25ms. Physical devices default to 100%. Either can be changed from
  the canvas toolbar.
- **Input over adb costs roughly 50-190ms per action**, because every `adb shell input`
  starts a new process on the device. Emulator input over gRPC does not pay this.
- **Rotation depends on the app.** Rotating writes `user_rotation`, which the window
  manager may ignore when the foreground app pins its orientation. `rotate_device`
  reports whether the rotation was actually applied.
- **Mirrored streams restart every 180 seconds.** `screenrecord` hard-stops at that
  point. The child is respawned transparently and parameter sets are re-sent, so the
  canvas keeps its last frame across the seam instead of dropping the video. The gRPC
  transport has no such limit.
- **Emulator encoders can stall under heavy repeated capture.** After many mirrored
  streams have been started and stopped, an emulator may return no video at all. The
  extension detects this and reports an error rather than retrying silently; restarting
  the emulator clears it. The gRPC transport does not use the device encoder.
- **The emulator gRPC API is experimental.** Its own documentation warns the service
  definition may change without notice, so every failure on that path falls back to
  mirroring rather than surfacing an error.
- **Recording is capped at 180 seconds**, because it uses `screenrecord` on every device
  class.
- **Queue order comes from the wall clock.** Waiting sessions are ordered by the
  timestamp they wrote, so the machine's clock stepping backwards can let a newer
  ticket go first, and a large step forwards can expire a live hold early. Strict
  ordering would need a sequence handed out under a lock; on one machine with a
  stable clock this has not been a problem in practice.
- **The queue only coordinates sessions running this extension.** It is cooperative,
  like the claims it sits alongside. Capture started by Android Studio, `scrcpy` or a
  bare `adb` command is detected and shown, but nothing stops it.
- **A session waiting for "any device" queues on all of them.** It holds a place in
  every candidate's queue until one is granted. That is what makes "give me whichever
  frees first" work. A waiter that stalls no longer reserves the whole pool — a
  session asking for a specific device may pass it when another of its candidates is
  free — but it does still hold the last one.
- **A running build cannot be cancelled from the canvas.** Install runs to completion
  or failure. Closing the canvas does not stop it; only shutting the extension down
  does, which it does before giving the device up.

## Agent tools

| Tool | Description |
| --- | --- |
| `diagnose_adb` | Validate the Android SDK, `adb` server, and emulator tooling. |
| `list_devices` | List AVDs, running emulators, and connected devices. |
| `get_device_state` | Get state, lease, and metadata for a device. |
| `acquire_control` | Acquire an exclusive, time-limited control lease. Pass `waitSeconds` to queue for a busy device, or `deviceId: "any"` to take the first free one. |
| `queue_status` | Show which session is using each device and who is waiting behind it. |
| `build_install_launch` | Build the app in this session's working directory with Gradle, install it, and launch it. |
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

## Installing your app

The header has an **Install** button, next to the device picker and the stream
controls. It builds the app in this session's working directory with Gradle,
installs it on the selected device, and launches it — the loop you would otherwise
run by hand every time you want to see a change on screen.

It runs `./gradlew installDebug`, with `ANDROID_SERIAL` set to the selected device
so the app lands on the device you are looking at rather than whichever one `adb`
picks. The application id is read from the `output-metadata.json` that AGP writes
beside the APK, which is how the app is launched afterwards. Gradle's output is
streamed to the canvas, and the button stays busy until the build finishes.

Override the defaults with a config file at the root of the working directory,
named `.android-emulator.json`, `android-emulator.json` or
`.github/android-emulator.json`:

```json
{
  "gradleTask": ":app:installDebug",
  "packageName": "com.example.app",
  "activity": ".MainActivity"
}
```

The button is disabled, with the reason on hover, when there is no Gradle wrapper
in the working directory, when the device is not booted, when an agent holds a
control lease, and — the case this shares with everything else here — when
**another Copilot session is using the device**. Agents get the same thing as
`build_install_launch`, and the same refusal.

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
  the queue. A ticket records every device it would accept, so a waiter for "any"
  device does not block one it can avoid.
- Holders and tickets carry a heartbeat and process id. A session that crashes while
  holding a device is reclaimed rather than blocking everyone behind it.
- Records are replaced by an atomic rename, and a record that cannot be read is left
  alone rather than reclaimed. A reader catching a heartbeat mid-write must not
  mistake it for a dead session and take its place in line.
- Each acquisition carries a token, and renewal, release and stale cleanup all check
  it. A write still in flight from a hold that has since been given up cannot
  resurrect it or overwrite the session that took the device next.
- A device is given up when the last reason to hold it goes. Control leases are
  meant to lapse rather than be released, so a lapsed lease frees the device — but
  not while a build, a boot, or any other action this session started is still
  running against it.

Agent actions, installs and emulator lifecycle all take the device through this
queue, so none of them can land on a device another session is using. Manual input
from the canvas is advisory rather than exclusive: it is refused, with the holder
named, when the device is known to be held elsewhere, but that knowledge comes from
a status poll a few seconds old, so a session taking the device mid-interaction is
noticed shortly afterwards rather than instantly.

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
node scripts/verify/stream-lifecycle.mjs
node scripts/verify/recording-coexistence.mjs
node scripts/verify/boot-lifecycle.mjs
node scripts/verify/cross-session-claims.mjs
node scripts/verify/device-queue.mjs
node scripts/verify/lease-holds.mjs
node scripts/verify/app-install.mjs
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
- **Install against a real Android app project.** The build path is verified end to
  end — including launching the installed app and confirming it reaches the
  foreground — but against a stand-in `gradlew`, because this repository is not an
  Android project. A real AGP build has not been run through the button. Flavored and
  multi-module layouts are handled by searching the whole `outputs/apk` tree, which is
  likewise unexercised on a real flavored project.
- **Reclaiming a hold from a recycled process id.** A crashed session's hold is
  reclaimed by checking whether its process is still alive. If the operating system
  has reused that process id, the hold survives until its 60-second lease expires
  instead. The expiry path is tested; the recycled-pid case is not.


What *is* verified against a real emulator and a connected device is listed above
under [Verifying](#verifying); the suites in `scripts/verify/` are the source of
truth, not this list.

## License

MIT

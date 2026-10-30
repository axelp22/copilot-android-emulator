# Verification suites

These drive the extension against real hardware: the device suites talk to an
actual emulator or connected device through `adb`, and the browser suite renders a
live canvas in Chrome. They change the device's state, so they only run when you
start them, never in CI.

Two of them, `device-queue.mjs` and `lease-holds.mjs`, need no device: they exercise
the cross-session queue in temporary directories with discovery stubbed out. `npm
test` runs both, alongside the device-free regression suite in [`test/`](../../test/),
which uses fakes and stand-in Gradle wrappers rather than hardware. See
"Verifying" in the top-level [README](../../README.md).

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
node scripts/verify/device-layer.mjs           # discovery, input, rotation, stream, restart loop
node scripts/verify/grpc-stream.mjs            # emulator gRPC transport, JWT, PNG frames, pointer input
node scripts/verify/canvas-server.mjs          # HTTP/SSE/security/lease gating
node scripts/verify/stream-decode.mjs          # aspect ratio + ffprobe decodability
node scripts/verify/stream-lifecycle.mjs       # repeated start/stop leaves no orphaned recorders
node scripts/verify/recording-coexistence.mjs  # recording does not disturb the live stream
node scripts/verify/cross-session-claims.mjs   # cross-session claims, refusal and queueing
node scripts/verify/device-queue.mjs         # FIFO queue semantics (no device needed)
node scripts/verify/lease-holds.mjs          # lease and cross-session hold lifetimes (no device needed)
node scripts/verify/app-install.mjs            # build, install and launch, and its refusals
node scripts/verify/boot-lifecycle.mjs         # cold boot and shutdown of an AVD (slow)
VERIFY_AGP_SERIAL=emulator-5580 \
  node scripts/verify/agp-fixture.mjs          # real AGP build, install, launch (see below)
```

## Real AGP fixture (`agp-fixture.mjs`)

Builds, installs and launches the minimal app in
[`test/fixtures/agp-app/`](../../test/fixtures/agp-app/) through the extension's own
build service, using real Gradle and the Android Gradle Plugin instead of the stand-in
`gradlew` the device-free tests use. The fixture has no dependencies beyond AGP, no
secrets and no private code; its package is `dev.copilot.androidemulator.fixture`.

**It only targets a device you name.** Unlike the other suites it has no default
serial and ignores `VERIFY_SERIAL`/`VERIFY_DEVICE_ID`. Before touching anything it
checks, addressing only that serial with `adb -s`, that:

1. `VERIFY_AGP_SERIAL` is set and looks like `emulator-<port>` (USB, Wi-Fi and
   `host:port` serials are refused);
2. adb reports it as `device` (not offline or unauthorized);
3. it is an emulator (`ro.kernel.qemu` or `ro.boot.qemu` is `1`);
4. it has finished booting (`sys.boot_completed` is `1`).

Any failure exits with status 2 and a reason code, before a build starts.

Requirements:

- JDK 17 or newer (`JAVA_HOME`), and an Android SDK (`ANDROID_HOME` or
  `ANDROID_SDK_ROOT`) with platform 34 and matching build-tools installed. The suite
  never downloads SDK packages or system images.
- A system `gradle` on `PATH` (or `VERIFY_GRADLE`) to generate the wrapper; the
  wrapper itself is not checked in.
- Network access on the first run to fetch the Gradle distribution and AGP from
  Google Maven and Maven Central; later runs reuse `~/.gradle`.
- A **throwaway** emulator. Start a dedicated one on a spare port with no snapshot
  writes, so the run cannot disturb an emulator you are using:

  ```sh
  emulator -avd <throwaway_avd> -port 5580 -no-snapshot-save -read-only &
  adb -s emulator-5580 wait-for-device
  VERIFY_AGP_SERIAL=emulator-5580 node scripts/verify/agp-fixture.mjs
  adb -s emulator-5580 emu kill   # cleanup
  ```

The suite copies the fixture into a scratch directory, generates a wrapper there,
builds `installDebug`, checks that the package is installed and in the foreground,
then force-stops and uninstalls it and deletes the scratch directory (whether or not
the checks passed). Nothing is written into the repository.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VERIFY_AGP_SERIAL` | none (required) | serial of the disposable emulator, e.g. `emulator-5580` |
| `VERIFY_ADB` | `adb` | path to adb |
| `VERIFY_GRADLE` | `gradle` | Gradle used only to generate the wrapper |
| `VERIFY_AGP_GRADLE_VERSION` | `8.13` | Gradle version the wrapper pins |
| `VERIFY_AGP_VERSION` | `fixtureAgpVersion` in the fixture | override the AGP version for this run |
| `VERIFY_AGP_KEEP` | unset | `1` keeps the scratch directory for inspection |

`test/agp-fixture-harness.test.mjs` (part of `npm test`) covers the target guard and
the refusals with a fake adb, so the safety checks are exercised without hardware.

`rendered-canvas.mjs` needs a live canvas URL. Ask Copilot to open the Android
Emulator canvas, take the URL it reports, then:

```sh
node scripts/verify/rendered-canvas.mjs "http://127.0.0.1:PORT/TOKEN/"
```

It verifies WebCodecs decoding, live video, pointer input and toolbar buttons in a
real browser. If the agent happens to hold a control lease it also checks the
overlay and the "Take back control" affordance; otherwise those checks skip.

## What these suites do not cover

See the "Known gaps" section of the top-level [README](../../README.md): tablet and
landscape chrome, canvas binding persistence, `session.shutdown` teardown, and
Windows against a real emulator are implemented but not exercised on hardware.
Streaming without WebCodecs, build cancellation and shutdown are covered by the
device-free suite in [`test/`](../../test/) rather than here.

## Notes

- `boot-lifecycle.mjs` skips if its target AVD is already running, because it would
  otherwise shut down a device you are using.
- The suites move the device around (taps, swipes, Home) by design. Point them at a
  scratch emulator rather than a device mid-task.
- `device-layer.mjs` briefly sets `user_rotation`, then resets it to 0.
- **Emulator encoders stall under repeated capture.** Running these suites back to
  back can leave the emulator producing no video at all: `screenrecord` then exits
  cleanly having written nothing, and every stream looks broken. This is a device
  limitation rather than an extension bug — the stream layer detects it and reports
  an error instead of respawning silently. Leave a few seconds between suites, and
  restart the emulator if streams stop producing bytes. The extension's own
  `restart_device` clears it. This affects the mirror only; emulators now default to
  the gRPC transport, which does not touch the device encoder.
- `grpc-stream.mjs` runs its codec, framing, discovery and JWT checks without any
  device, then skips the live section when no emulator discovery file is present. Its
  live checks pin both transports explicitly (`transport: "grpc"` and
  `transport: "mirror"`) so a silent fallback cannot mask a broken gRPC path — which
  `canvas-server.mjs`, testing the default selection, deliberately tolerates.
- Assertions about the restart loop compare timestamps within a completed respawn
  generation rather than polling counters. Polling raced: the replacement child's
  keyframe lands roughly 600ms after the exit, so a late observation folded it into
  the "before" baseline and the check failed about one run in four.

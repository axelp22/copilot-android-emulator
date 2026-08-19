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
| `boot_device` | Boot an AVD and wait until `sys.boot_completed`. |
| `shutdown_device` | Shut down a running emulator. |
| `restart_device` | Shut down and boot an emulator. |
| `rotate_device` | Rotate the device left or right. |
| `press_button` | Press home, back, recents, power, or volume buttons. |
| `tap` | Tap at normalized coordinates by default, or explicit point coordinates. |
| `swipe` | Swipe using normalized coordinates by default, or explicit point coordinates. |
| `send_key` | Send an Android key event. |
| `send_text` | Send text input. |
| `perform_inputs` | Run an ordered input sequence under one lease. |
| `install_apk` | Install an APK onto the selected device. |
| `launch_app` | Launch an installed package. |

Tools that control a device require a lease acquired with `acquire_control`;
`capture_screen` does not.

## Implementation notes

See [`docs/SPEC.md`](docs/SPEC.md) for the architecture, the `adb` capability mapping,
and the H.264 streaming design (including the `screenrecord` 180-second restart loop).

## License

MIT

# Build tiny on your own iPhone/iPad

One script does everything — finds your device, finds your Apple team,
re-signs the project for you, builds, installs, launches:

```sh
git clone https://github.com/cagataycali/tiny-technology && cd tiny-technology
./ios/scripts/build-on-device.sh
```

## What you need (once)

1. **A Mac with Xcode 16+** (App Store). Open Xcode once so it finishes
   installing components, and make sure it owns the CLI tools:
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
2. **An Apple ID added to Xcode** — Xcode → Settings → Accounts → “+”.
   A free account works (see caveats below). Then Manage Certificates →
   “+” → *Apple Development* so you have a signing certificate.
3. **Your iPhone or iPad on iOS 18+**, connected **with a cable**, unlocked:
   - tap **Trust This Computer** when asked
   - enable **Settings → Privacy & Security → Developer Mode** (reboots the device)
4. First launch only: the device will block the app until you trust yourself —
   **Settings → General → VPN & Device Management → your developer → Trust**.

## What the script actually does

- Detects a connected iPhone/iPad via `devicectl` (picks the first connected
  one; override with `DEVICE_ID=<identifier>`).
- Detects your team ID from your Apple Development certificate (override with
  `DEVELOPMENT_TEAM=ABCDE12345`).
- **Retargets bundle ids**: the upstream ids (`technology.tiny.app`, its
  widgets/watch extensions, the app group, the keychain group) are registered
  to the core team at Apple and App IDs are globally unique — your account
  can't provision them. The script rewrites `technology.tiny` →
  `dev.t<yourteam>.tiny` across the project (pbxproj, plists, entitlements,
  and the few Swift files that hold the app-group string), so everything
  stays internally consistent and signs under your team.
  - This edits **tracked files in place**. Don't commit them; undo with
    `git checkout -- ios` when you're done.
  - Custom prefix: `BUNDLE_PREFIX=dev.yourname.tiny ./ios/scripts/build-on-device.sh`
  - Core-team members: the script skips the retarget automatically when it
    sees the core team (or force-skip with `SKIP_RETARGET=1`).
- Builds the `Tiny` scheme (app + widgets + watch app ride along) with
  `-allowProvisioningUpdates`, so Xcode creates the App IDs, profiles, and
  registers your device for you. The first build may prompt for your macOS
  login-keychain password — that's codesign, allow it.
- Installs with `devicectl` and launches the app.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No iPhone/iPad known to this Mac` | Cable in, device unlocked, Trust This Computer, Developer Mode on, rerun. Wi-Fi-only pairing is flaky — use the cable. |
| `Devices are paired but none is connected` | Same as above — plug it in. |
| Signing error mentioning your Apple ID / “requires a development team” | Add your Apple ID in Xcode → Settings → Accounts, create an *Apple Development* certificate, rerun. |
| Provisioning fails on **application-groups** | Some free personal teams can't get the App Groups capability. Easiest path: use a paid developer account. (Stripping the entitlement breaks widgets/watch data sharing.) |
| App installs but won't open (“Untrusted Developer”) | Settings → General → VPN & Device Management → trust your developer. |
| Built fine yesterday, “app no longer available” today | Free-account provisioning expires after **7 days** (and max 3 sideloaded apps). Rerun the script. |
| Watch app fails to install on a paired watch | Make sure the watch runs watchOS 11+; the app itself installs on the phone regardless. |
| Weird incremental-build signing errors after switching teams | `rm -rf ios/build/device` and rerun. |

## Cleaning up

```sh
git checkout -- ios     # undo the bundle-id retarget
rm -rf ios/build/device # optional: drop the derived data
```

The app talks to the production backend (`tiny.technology`) — you sign in
with your own account in-app; nothing else to configure.

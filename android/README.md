# tiny for Android

Native Android client for [tiny.technology](https://tiny.technology) — chat with your tinys,
talk to them by voice, pay per message from the built-in wallet, and run them from your wrist
with the Wear OS companion app.

Kotlin + Jetpack Compose throughout. Two Gradle modules:

| Module  | What it is |
|---------|------------|
| `app/`  | The phone app (`technology.tiny.app`) — chat, voice sessions, wallet & x402 payments, maps/location context, agent tool cards, widgets, in-app OTA updates |
| `wear/` | Wear OS companion — talks to the phone app over the Data Layer |

## Requirements

- **JDK 21** (Gradle toolchain expects it; on macOS: `brew install openjdk@21`)
- **Android SDK** with API 35 (`compileSdk = 35`, `minSdk = 29`, `targetSdk = 35`)
- Point Gradle at the SDK either with `ANDROID_HOME` or a local `local.properties`:

```properties
# android/local.properties (gitignored — create it locally)
sdk.dir=/path/to/Android/sdk
```

## Build & run

```bash
cd android

# Debug build on a connected device/emulator
JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew :app:installDebug

# Unit tests (scope to :app — the :wear module has no JVM tests)
JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew :app:testDebugUnitTest

# Release APK
JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew :app:assembleRelease
```

## Point it at your own backend

The app ships pointing at the hosted service. If you deployed your own
[web app](../web/) and [worker](../worker/), change the two constants in
[`app/src/main/java/technology/tiny/app/net/TinyApi.kt`](app/src/main/java/technology/tiny/app/net/TinyApi.kt):

```kotlin
const val BASE_URL = "https://tiny.technology"        // → your Next.js deployment
const val WORKER_URL = "https://plugin.tiny.technology" // → your Cloudflare worker
```

There is also a runtime server override in Settings (persisted via `Config.kt`), useful for
testing against a staging deployment without rebuilding.

## Code map

```
app/src/main/java/technology/tiny/app/
├── auth/      sign-in & session (passkey/WebAuthn flows)
├── chat/      conversation state, streaming, continuity/scrub logic
├── fleet/     multi-tiny management
├── geo/       location context & map sheet data
├── net/       API client (TinyApi.kt), SSE streaming
├── tools/     agent tool-call cards rendered in chat
├── ui/        Compose screens & components (Panels, Wallet, MapSheet, Markdown, theme)
├── update/    in-app OTA update checker/installer
├── voice/     voice sessions (capture, playback, realtime relay)
├── wallet/    balance, x402 payments, transfer confirm cards
├── wear/      phone-side bridge to the Wear OS app
└── widget/    home-screen widgets
```

## Distribution

Two supported paths:

- **GitHub Releases (CI):** pushing a version tag runs
  [`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds the APK/AAB
  and attaches them to the release. Signing uses the `ANDROID_KEYSTORE_B64` +
  `ANDROID_KEYSTORE_PASSWORD` repository secrets — binaries are never committed to git.
- **Self-hosted OTA:** [`scripts/push-ota.sh`](scripts/push-ota.sh) builds a release APK and
  stages it with a `manifest.json` into the web app's `public/android/`. Installed apps poll
  `/android/manifest.json` (every 15 minutes while foregrounded) and offer the update in-app —
  this is why the manifest declares `REQUEST_INSTALL_PACKAGES`.

> Signing note: OTA updates only install over an existing app if the certificate matches.
> Pick one keystore before your first distribution and keep using it.

## License

[Apache-2.0](../LICENSE), same as the rest of the repository.

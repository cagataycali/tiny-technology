# tiny — native Apple apps

The phone (and watch) as live nodes of your tiny identity: the same `/api/chat`
agent loop as the web, plus things only hardware can do — Bluetooth scans,
voice with on-device transcription, haptics, widgets, Siri.

## Targets (project.yml → XcodeGen; `Tiny.xcodeproj` is generated but committed)

| Target | Platform | Bundle id | What |
|---|---|---|---|
| `Tiny` | iOS 26+ (iPhone + iPad) | `technology.tiny.app` | the app |
| `TinyWidgets` | iOS | `…app.widgets` | home/lock widgets + Control Center button |
| `TinyWatch` | watchOS 11+ | `…app.watchkitapp` | watch app (chat, Siri) |
| `TinyWatchWidgets` | watchOS | `…app.watchkitapp.widgets` | watch-face complications |

All four share the App Group `group.technology.tiny.app` (snapshot bridge) and
`Shared/WidgetStore.swift` (`FleetSnapshot` + `Color.fromHex`). The watch also
compiles `Api/Config/Keychain` from the app target (UIKit-free files only).

## Identity & fleet

- **Auth**: CLI-token consent flow — `ASWebAuthenticationSession` →
  `/auth/cli?scheme=tinyapp` → `tinyapp://auth?code&state` →
  `POST /api/auth/cli/token` → 90-day Bearer JWT in the Keychain
  (`Session.swift`). Works on every session-gated `/api/*` route.
- **Device node**: enrolls via `POST /api/devices` (device token `tind_…`,
  shown once, hash-stored server-side). Heartbeat 30s (presence window is
  60s), relay poll 5s — the web agent's `use_device` reaches this phone and
  gets real radio/battery/DM context back (`Session.swift`, `Bluetooth.swift`).
  Locked phone = suspended app = relay dead; APNs silent push is the missing
  unlock (server work).
- **Watch link**: `WatchBridge.swift` pushes `{token, snap, accent}` over
  `WCSession.updateApplicationContext`; the watch keeps its own Keychain copy
  and works away from the phone.

## Chat pipeline

`Api.chatStream` speaks the web's SSE dialect (`modelContentBlockDeltaEvent`,
`beforeToolCallEvent`, …, `seq`-gap detection). Client-executed tools are
handled natively: `speak` (AVSpeech + card), `suggest_followups` (chips),
`render_ui` (Swift Charts / key-values from props — componentCode never runs),
`remember`/`forget` (Continuity), `spawn_agents` (TaskTree), `manage_messages`
(post-stream history surgery). Continuity (turn log + memories, per tiny)
rides a system message, byte-compatible with the web's format.

## Surfaces

- **Chat** (`Views.swift`): streaming bubbles, transcript search, slash
  commands, attachments, retry, voice mode (`Voice.swift`: on-device SFSpeech,
  3s-silence auto-send, barge-in), per-tiny accent theming (`/api/tiny`
  theme.accent → chrome, cards, watch, widgets).
- **Panels** (`Panels.swift`): Universe (search), Jobs, Memory, Devices —
  all pull-to-refresh + Retry. Messages (`Messages.swift`): DM inbox/threads.
- **Onboarding** (`Onboarding.swift`): 5-page first-launch story; replayable
  from Settings.
- **Widgets** (`TinyWidgets.swift`): fleet/unread status, one-tap voice ask,
  Control Center/Action-button control. Deep links: `tinyapp://voice|ask|messages`
  (cold-launch safe via `session.pendingRoute`).
- **Watch** (`TinyWatchApp.swift`): dictated chat with persistence, haptics,
  re-ask, read-aloud; complications with Smart Stack relevance on unread.
- **Siri/Shortcuts** (`Intents.swift`, `WatchIntents.swift`): Ask tiny,
  Fleet status, Send DM — phone and wrist-local.

## Build / ship

```sh
cd ios && xcodegen generate \
  && xcodebuild -project Tiny.xcodeproj -scheme Tiny \
       -destination 'platform=iOS Simulator,name=iPhone 17' build
```

- **Cable**: build with `-destination 'platform=iOS,id=<udid>'
  -allowProvisioningUpdates`, then `xcrun devicectl device install app …`.
- **Contributors (not on the core team)**: `scripts/build-on-device.sh` —
  one shot: finds your device + team, retargets bundle ids to your account,
  builds, installs, launches. See `BUILD_ON_DEVICE.md`.
- **OTA** (the standing channel): bump `CURRENT_PROJECT_VERSION` in
  project.yml, then `OTA_TEAM_ID=<your team> scripts/push-ota.sh "msg"` —
  Release archive → `web/public/ios/Tiny.ipa` + a generated manifest → git
  push; the in-app `Update.swift` banner installs it. Set `OTA_BASE_URL` to
  your deployment's URL (defaults to the hosted service). UDID enrollment
  for testers: `scripts/auto-enroll.sh`.
- Info.plist and the entitlements files are xcodegen output — commit them
  whenever project.yml changes. Never `git add ios/` wholesale; stage files
  explicitly (two sessions work in this tree).

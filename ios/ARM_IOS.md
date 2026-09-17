# ARM-IOS — the strands-arm as a live surface in the tiny iOS app

Lane journal. One deliverable per iteration, one pathspec commit each, no push
(owner pushes). Goal: the arm panel is installed and launched on owner-phone
(iPhone 16 Pro, devicectl `523B7CD7-F6CF-53EC-BA72-C7B1A58D0B50`) and the tests pass.

## Ground truth (read 2026-09-05 17:55Z, iteration 1)

**The arm on the wire**
- `GET /api/devices` already lists it: `fomo-the-arm`, id `70e17431-…`, kind
  `endpoint`, platform `strands-arm`, url `https://arm.example.com`, capabilities
  `[chat, telemetry, camera, arm, look, pan_tilt, photo, guard]`. `DeviceRow`
  (Panels.swift ~4135) already keeps `platform`, `capabilities`, `url` — the
  predicate is `platform == "strands-arm" || capabilities.contains("arm")`.
- `GET <url>/api/state` (public): `arm.joints[{id,name,deg,home,torque}]`,
  `arm.pose`, `nicla.{transport, stream, detect, tof_mm, imu, rssi}`,
  `guard.look {pan:[-60,60], tilt:[-60,60]}`, `guard.home {id: deg}`, `guard.busy`.
- `GET <url>/api/nicla/stream`: MJPEG when the LAN node is up; **JSON 503 right
  now** (`nicla.transport == "usb"`, `stream: null`). So the snapshot fallback is
  the path that will actually be exercised first.
- Token-gated (`Authorization: Bearer`): `GET /api/auth/me -> {required, ok}`
  (with a bad/missing token `{required:true, ok:false}`, 200 — validate on `ok`,
  not on status), `GET /api/camera/snapshot` (image/jpeg, ~7 KB, `X-Source`),
  `GET /api/telemetry` (flat: pose, joints_deg{name:deg}, torque, camera, tof_mm,
  rssi, detect, look), `POST /api/control/look {pan?, tilt?}` (deg rel. home),
  `POST /api/control/stop` (always allowed), `POST /api/control/home`,
  `POST /api/photo?caption= -> {path, bytes, source, url}` (`/snaps/<name>` is
  ALSO token-gated, so the shot must be fetched with the bearer, not AsyncImage).
- Bench at read time: pose `taught`, torque off, tilt (id 6) reads 95.4 vs home
  178.7 — hand-moved, not this lane's problem; another reason never to command
  anything but STOP and ≤15° looks from here.

**The app's existing patterns (copy, don't reinvent)**
- `EndpointPanel.swift`: pure `EndpointTelemetry` enum + `.task` polls gated on
  `scenePhase == .active`, one frame in flight, `FrameLiveness` (freshness decides
  the badge). Its `readings()` only knows printer fields → the arm currently
  renders **nothing** in the Devices sheet except the camera. Fix = an arm branch.
- `TinyLive.swift`: `TinyLive.shared` ObservableObject, MJPEG via
  `URLSessionDataDelegate` (`feedVideo` splits on JPEG SOI/EOI), `TinyLiveOverlay`
  PiP card 236×177; `WearablesLive.swift` `GlassesLiveOverlay` has the drag
  (`restingOffset + dragOffset`, `DragGesture`).
- `Views.swift` ~2038–2070: `glassesToolbarButton` / `tinyLiveToolbarButton` are
  pre-built small views (ChatView body is at the type-checker budget); the
  `ToolbarItem(placement: .topBarTrailing)` siblings live at ~2502–2513 and the
  overlay views are mounted at ~2465.
- `Keychain.swift` `set/get/delete(key)`; `Api.swift` `getBody/postBody`
  (against `Api.base` only — the arm needs its own absolute-URL requests, plain
  `URLSession`, since the base URL comes from the device row).
- Tests: `ios/Tests/*.swift` use **Swift Testing** (`import Testing`, `@Suite`,
  `@Test`, `#expect`), not XCTest. `ArmLiveTests.swift` follows the repo.
- Project: **xcodegen** (`ios/project.yml`, `xcodegen generate`); Tiny target
  sources = the `Tiny/Sources` folder, TinyTests = `Tests` folder, so new files
  are picked up by regenerating. Build number `CURRENT_PROJECT_VERSION: 68` in
  project.yml → bump to 69 there (pbxproj is generated).
- Deploy route: `xcodebuild -project ios/Tiny.xcodeproj -scheme Tiny -destination
  'id=523B7…' -derivedDataPath ios/build/device -allowProvisioningUpdates build`
  → `xcrun devicectl device install app --device 523B7… <Tiny.app>` → `… process
  launch … technology.tiny.app`. Phone shows `available (paired)` right now.

## Plan

| # | deliverable | files | done when |
|---|---|---|---|
| 1 | `ArmCore` pure enum: `isArm(DeviceRow)`, `ArmState` decode of `/api/state`, `LookRange` from `guard.look`, `lookTarget(padPoint, size, range)`, `Coalescer.shouldSend(now, last, minInterval: 0.2)`, arm telemetry readings; `ArmManager` (`.shared`, discovery from `/api/devices`, 2 Hz state poll while open, scenePhase gate, Keychain `arm.token`, `validateToken` via `/api/auth/me`, MJPEG decoder with 3 s watchdog → 1 Hz snapshot fallback, `cameraBadge` live/snapshot/no camera) | `Tiny/Sources/ArmLive.swift`, `Tests/ArmLiveTests.swift` | tests green on the simulator |
| 2 | `EndpointTelemetry.readings` arm branch (pose, tilt/pan from joints_deg vs look, tof, camera, detect) so the Devices sheet row says something true | `EndpointPanel.swift`, `Tests/EndpointPanelTests.swift` | tests green |
| 3 | `ArmLiveOverlay` PiP card (draggable, badge, expand button) + `ArmLiveScreen` full-screen: picture with drag-to-look pad, HUD pan/tilt current vs target, HOME / STOP (red, no confirm) / photo, token paste sheet, toast for 4xx guard refusals, haptics | `ArmLive.swift` (+ `ArmLiveScreen.swift` if >600 lines) | compiles for device |
| 4 | Toolbar button (`arrow.up.and.down.and.arrow.left.and.right`, green when open) as sibling of `sparkles.tv`, shown only when `ArmManager.shared.device != nil`; overlay mounted next to `tinyLiveOverlayView` | `Views.swift` | compiles; ChatView still type-checks |
| 5 | `xcodegen generate`, bump build 68→69, build for owner-phone, install, launch; run TinyTests on a simulator | `project.yml`, `Tiny.xcodeproj` | app on the phone, tests pass |
| 6 | Verify: STOP + one ≤15° look against the real arm only after a state check shows nothing near the head; notify owner; final journal | `ARM_IOS.md` | `[LOOP_DONE]` |

**Rules I hold myself to**: explicit pathspec commits, no `git add -A`, no stash,
no push; never hardcode `arm.example.com` or the token; `xcodebuild` in the
background with a log + `tail` polls; never `/api/control/home` or joints 1–4.

## Journal

### it1 — 2026-09-05 17:55Z: context + plan
Read EndpointPanel/TinyLive/WearablesLive/Views/Keychain/Api/Panels, API.md,
project.yml; probed the live arm (state, stream 503, auth/me, telemetry, snapshot
200) and the device list (fomo-the-arm present with url). No code yet. Next:
deliverable 1 (`ArmLive.swift` core + tests).

### it2 — 2026-09-05 18:20Z: deliverable 1 shipped
`ios/Tiny/Sources/ArmLive.swift` (575 lines): `ArmCore` pure enum (isArm
predicate, /api/state decode, wrap-safe currentLook from ids 5/6, pad↔look
mapping clamped to guard.look and rounded to 0.5°, 5 Hz `shouldSend`, `changed`
noise gate, refusal sentences per status, freshness camera badge live/snapshot/
no camera, MJPEG SOI/EOI splitter, arm telemetry readings for the Devices sheet)
+ `ArmManager.shared` (@MainActor: discover from /api/devices → `pick`, Keychain
`arm.token` validated on `/api/auth/me.ok`, 2 Hz state poll + 1 Hz camera loop
both gated on `sceneActive`, MJPEG URLSessionDataDelegate that cancels a non-200
response so the JSON 503 falls to snapshot polling immediately, coalesced
`requestLook` (latest target, ≤5 Hz, nothing extra on release), `stopArm`,
`home`, `photo` fetching the gated `/snaps/…` with the bearer, toasts + haptics).
`ios/Tests/ArmLiveTests.swift`: 21 Swift Testing cases on the live fixtures, all
green on the iPhone 16 Pro simulator (`-only-testing:TinyTests/ArmCoreTests`,
derivedData `ios/build/sim`, log /tmp/arm-ios-test.log). `xcodegen generate` run
(pbxproj +8 lines for the two files). Gotchas: `/api/control/*` inside a `/** */`
header opens a nested comment in Swift; a static on a @MainActor class needs
`nonisolated` to be callable from a sync test.
Next: it3 = wire `ArmCore.readings` into `EndpointTelemetry.readings` (arm branch)
with a test in EndpointPanelTests; it4 = ArmLiveScreen.swift UI.

### it3 — 2026-09-05 18:10Z: Devices sheet knows the arm
`EndpointTelemetry.readings` routes an arm-shaped payload (joints_deg / pose+look)
to `ArmCore.readings`, so fomo-the-arm's row shows pose · head pan/tilt · joints ·
distance · camera · sees instead of an empty grid under its camera. `isRunning`
for the arm = torque held or a job named (tints the pose row, like a RUNNING
printer). Two new tests in EndpointPanelTests; 39/39 green across both suites.
Next: it4 = ArmLiveScreen.swift (PiP card + full-screen joystick + token paste +
toast), it5 = toolbar wiring in Views.swift.

### it4 — 2026-09-05 18:30Z: the UI (ArmLiveScreen.swift, 330 lines)
`ArmToolbarButton` (owns discovery via `.task(id: sessionToken)`, renders nothing
without an arm row, `arrow.up.and.down.and.arrow.left.and.right`, green when open),
`ArmLiveOverlay` (236×177 draggable PiP, honest badge, STOP, expand → fullScreenCover,
scenePhase → `sceneActive`, start/stop the manager with the card), `ArmLiveScreen`
(picture IS the joystick: DragGesture(minimumDistance 0) → `ArmCore.lookTarget` →
coalesced `requestLook`; crosshair = home, white ring = current look, accent dot =
target; HUD pan/tilt current → target + transport/ToF; HOME behind a confirmation
dialog because it moves joints 1–4, STOP red one-tap, photo → sheet; SecureField
token paste validated by `saveToken`, "Forget token" in the bar; refusal toast that
clears after 3 s). Simulator build EXIT=0. Gotcha: `.labelStyle(cond ? .titleAndIcon
: .iconOnly)` does not type-check (different style types) — use an HStack.
Next: it5 = Views.swift toolbar + overlay wiring, then it6 = build 69 on owner-phone.

### it5 — 2026-09-05 18:45Z: wired + installed on owner-phone
Views.swift: `armToolbarButton` ToolbarItem right after the necklace's, and
`armLiveOverlayView` in the PiP VStack — ChatView still type-checks (no
"reasonable time" warning). Commit 62d763ab. Build bumped 68→69 in project.yml
(xcodegen regenerated). Device build (`-derivedDataPath ios/build/device`,
log /tmp/arm-ios-device.log) BUILD SUCCEEDED; `devicectl device install app`
EXIT=0 → tiny 1.0 (69) is on owner-phone. `process launch` refused: the phone is
LOCKED (FBSOpenApplicationErrorDomain 7) — owner notified; retry next pass.
Next: launch, run the full TinyTests suite on the simulator, live verification
(STOP + one ≤15° look after a state check), final journal.

### it6 — 2026-09-05 19:30Z: launched, verified, done
- `devicectl device process launch technology.tiny.app` → "Launched application"
  EXIT=0 on owner-phone (first two tries were refused only because the phone was locked).
- Full simulator suite: 1006 Swift Testing cases in 125 suites + 18 XCTest, 0 failures.
- Live contract check from this Mac with the bench token (the app never carries it):
  `POST /api/control/stop` → 200 `{ok, torque:false, job:null}`; guard refusal
  `POST /api/control/look {pan:500}` → 422 `{detail: "id 5: 680.8 outside 0.5..359.5
  (tick wrap)"}` (the toast reads `detail`, pinned in ArmLiveTests); no token → 401
  `{error:"token required"}`; `POST /api/photo` → 200 `{url:"/snaps/…"}`; stream is
  multipart/x-mixed-replace boundary=tinyframe, 25 SOI in 4 s (~6 fps) now that the
  head is on LAN. NO look move was sent: ToF read 54 mm = something right in front
  of the head, and tilt sits at 95° vs home 179° (hand-moved), so the ≤15° rule
  could not be met safely. The joystick path is exercised by the pad→look→coalesce
  tests and the refusal round-trip instead.

## Final state

**Works (1.0 build 69 on owner-phone)**
- Toolbar arrows icon appears beside the necklace button as soon as the account's
  device list has an endpoint row with platform `strands-arm` or capability `arm`
  (fomo-the-arm, url read from the row — nothing hardcoded; no row = no icon).
- Tap → PiP card: MJPEG from `<url>/api/nicla/stream` (public); if no frame for
  3 s (or the JSON 503 when the head is on USB) it polls `<url>/api/camera/snapshot`
  at 1 Hz with the arm token; badge says live / snapshot / no camera by freshness.
  STOP is on the card. Drag the card anywhere; tap the picture or ⤢ for full screen.
- Full screen: the picture is the look pad (centre = home, edges = guard.look);
  drag sends `POST /api/control/look` with only the latest target, ≤5 Hz, nothing
  on release; HUD shows pan/tilt now → target, transport, ToF. HOME (behind one
  confirmation — it moves joints 1–4), red one-tap STOP, photo (→ sheet with the
  shot fetched with the bearer). Every 4xx becomes a toast; haptics on send/refuse.
  Polls stop in the background (scenePhase), resume on return.
- Devices sheet: fomo-the-arm's row now shows pose · head · joints · distance ·
  camera · sees (arm-shaped telemetry through the tiny proxy, session-auth only).

**How the token is entered**: open the full screen once; with no token the card
shows "Arm control token" with a SecureField. Paste the dashboard's
STRANDS_ARM_TOKEN (on this Mac: `cat ~/.strands-arm/token`), Save → validated
against `GET /api/auth/me` (`ok` must be true) → kept in the Keychain as
`arm.token` (ThisDeviceOnly). "Forget token" in the bar removes it; a 401 from
any control call also drops it and re-shows the field.

**Not yet**
- Not tapped through on the phone by this lane (no screen access to iOS); the
  owner has the build and a notification. First run: the icon needs one device
  list fetch, which the button does on appear.
- Tilt sign convention on the pad is "up = positive tilt" — if the head goes the
  other way, flip the `tilt` line in `ArmCore.lookTarget`/`padPoint` (one test
  each pins the convention).
- No live `/ws` — the panel is 2 Hz `/api/state` polling, like the dashboard's own
  fallback. No chat/teach/shots from the phone (the endpoint's chat still works
  through the Devices sheet's ask path).
- Nothing pushed: commits 026d5eed, 044cb106, 354c31ef, 2406c1bd, 62d763ab,
  1d854c21 (+ this journal) sit on main for the owner to push.

## TWIN-IOS (2026-09-10) — the native twin and per-servo control

Files: `Tiny/Sources/FomoTwin.swift` (RealityKit twin), `FomoServos.swift` (Servos section + Twin tab),
`FomoTwinMath.swift` (pure math, `Tests/FomoTwinMathTests`), UI proof `UITests/FomoTwinUITests.swift`.

- **Asset**: `GET <fomo>/models/arm.usdz` (1.99 MB, ETag, immutable). One `HEAD` per launch; the file is cached at
  `Caches/fomo-twin/arm-<etag>.usdz`; offline uses the newest cached copy. Prim names come from `arm.json["usdz_nodes"]`
  and are fixed in `FomoTwinMath.joints` (`/arm/base_link/shoulder_pan/shoulder_link/...`).
- **Drive**: exactly the web twin (`docs/js/twin.js`): root rotated -pi/2 about x, and for each joint the *child link*
  Xform is rotated about the joint axis by `q = wrap(deg - home) * sign` (rad), 1..6 sign `[-1,-1,-1,-1,+1,+1]`,
  lower/upper limits from the URDF. Pivots are baked into the USDZ.
- **Two arms**: solid = `/api/state` readings; ghost (30 % opacity) = the last target *this phone* asked for
  (`FomoManager.commandedDegrees`, set by look/home/fold/servo moves, cleared by STOP). Fomo has no commanded field.
- **Servos**: `POST /api/control/move {"actions":[{"joint":"<servo>","to":<deg>}]}` in absolute servo degrees, coalesced
  latest-wins at <= 10 Hz per servo, final send on release, slider bounds = the guard's calibrated window
  (`state.windows`). A 422/409 is shown verbatim and the ghost snaps back to the reading. Torque per servo via
  `POST /api/control/torque {"on","ids":[id]}`; if Fomo echoes more ids than asked, the toast says so.
- **Where**: FomoScreen top `Camera | Twin` switch (persisted, shared with the card), `Servos` section (first),
  PiP strip `fomo-pip-view` flips the card between camera and twin.
- **Fallback**: only if RealityKit fails to load the USDZ, a WKWebView of the dash (which has the web twin) with the reason
  printed under it (`fomo-twin-fallback-why`). Never silent.
- **Lesson**: never publish an `@Published` value unconditionally from `RealityView`'s `update:` closure — SwiftUI re-runs it,
  the loop starves the main thread and XCUITest's idle wait hangs for 60 s. Publish only on change.

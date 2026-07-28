# ⚠️ iOS Beta Pipeline — KEEP RUNNING until Apple Dev account

> **Temporary infrastructure.** Delete this whole setup once we have a proper
> Apple Developer Program membership + TestFlight.

## What's running

| Piece | Where | What |
|---|---|---|
| `technology.tiny.auto-enroll` | **launchd** on this Mac mini (hourly + at boot/login) | Runs `ios/scripts/auto-enroll.sh` · logs `~/Library/Logs/tiny/auto-enroll.log` |
| `/api/udid` | Vercel edge | Serves .mobileconfig, collects UDIDs → KV, `?count=1` spots counter |
| `/ios` page | Vercel static | Install + "Join the beta" buttons, 100-spots counter |
| iOS banner | InstallPrompt.tsx | iPhone Safari visitors → "only 100 spots" → /ios |

## Flow
Visitor taps **Join the beta** → installs one-time profile → phone POSTs UDID
→ KV → hourly job diffs → (with ASC key) auto-registers + re-signs IPA +
pushes → visitor installs OTA. Zero manual steps *when the ASC key is set*.

## Must stay alive
1. **This Mac ON** — launchd agent survives reboots/logins automatically
   (`~/Library/LaunchAgents/technology.tiny.auto-enroll.plist`).
2. **ENROLL_SECRET** — `.env.local` here + Vercel prod env (machine auth).
3. **Signing certs** for your Apple Developer team in this Mac's keychain.
4. **ASC API key** (`ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_PATH`) — ⚠️ NOT
   configured yet. Until set, new UDIDs are only *reported* by the job;
   register manually: <https://developer.apple.com/account/resources/devices/list>
   then run `ios/scripts/auto-enroll.sh` again.

## Health checks
```bash
# spots taken
curl https://tiny.technology/api/udid?count=1
# launchd status + last run
launchctl list | grep tiny
tail ~/Library/Logs/tiny/auto-enroll.log
```

## Exit plan (the real fix)
Apple Developer Program ($99/yr) → upload to TestFlight → `/ios` becomes a
TestFlight link → **delete**: `launchctl unload ~/Library/LaunchAgents/technology.tiny.auto-enroll.plist` + the plist, auto-enroll.sh,
resign-with-udids.sh, the UDID profile flow. Keep `/api/udid?count=1` only if
we want the counter for the TestFlight beta too.

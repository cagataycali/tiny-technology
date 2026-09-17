# Compatible radio tuning — build86, 2026-09-13

## Installed and launched on owner's iPhone

Signed Release **86** installed on iPhone16Pro `owner-phone`. Independent app inventory
confirms `technology.tiny.app` bundleVersion86; process launch succeeded. Codesign
verification passed. Both project.yml and pbxproj record86. Source remains PRIVATE
`pineapple-native`; no main merge/public PR.

Evidence: `/tmp/pineapple-ios-device86.log`, `/tmp/pineapple-install86.json`,
`/tmp/pineapple-apps86.json`, `/tmp/pineapple-launch86.json`.

**Devices → Open Pineapple → Refresh Pager → Find networks → select authorized AP
→ review independent-radio plan → permission toggle → Start confirmation.**

- Picker consumes backend's validated independent `phy1/wlan1mon`,20MHz safe plan.
  AP frequency need NOT equal the monitor's current hopping frequency. Missing,
  malformed/shared/uplink-disruptive/mismatched plans still cannot Start.
- Request uses SELECTED plan's BSSID/channel/frequency, not the monitor's old channel.
  Sends `tuning_confirmed:true` only through explicit confirmation, along with
  existing ownership/expiry/duration/size constraints. Selection alone does nothing.
- Disclosure: temporarily pause Hak5 on the independent radio, tune, then restore;
  management/client Wi-Fi stay connected.20MHz reception may omit wider traffic.
- Manual BSSID still exists but MUST match a fresh discovered AP and safe plan;
  it cannot bypass discovery or freshness. Refresh preserves exact BSSID identity.
- Native preparing/tuning/capturing/stopping/restoring/recovery-error labels,
  error text, active-state delete/download gates. Polls more often while active.
- Explicit backend refusal clears pending Start so user can refresh/reconfirm.
  Transport-uncertain outcomes remain pending; no automatic mutation retry.
- Existing private chunk transfer/SHA256/download-cancel/native ShareLink remain.
  Packet-source caps unchanged60seconds/256KiB/fourfiles; no broad capture modes.

## Test evidence

Final run: **28/28 passed, zero failures, zero skipped** in `/tmp/pineapple-tuning86-final.xcresult`:13pure contracts +4download regressions +1real Swift/relay integration +10XCUI tests.
Initial `/tmp/pineapple-tuning86-tests.xcresult` had26pass/1failure: localized SwiftUI
integer interpolation showed `2,437`, while new off-channel disclosure assertion
expected `2437`. Switched the plan label to literal text. Final off-channel test
passes, including permission gate and full tune/restore confirmation (never accepted).

Real Swift client on simulator → actual owner relay → actual Pager:
- `network_scan` decoder passed with9safe tuning plans; no AP identifiers logged.
- Actual `overview` advertised ready tuning service.
- Existing104-byte GENERATED LOOPBACK fixture downloaded, hash verified and
  TINY-pineapple-fixture marker asserted. No wireless Start sent by integration test.
- Temporary mode0600 credential fixture removed by test and checked absent by host.

Final independent hardware read after phone installation: active=null,
radio=restored,guard_ready=true;9fresh eligible cached APs. This is a bounded
kernel-cache observation, not a full-band scan. Source backend PRIVATE
pineapple-the-wifi7685e20;13/13deployed source/init hashes matched in preceding slice.

## Honest boundary

Phone installation/version/launch are real. Automated navigation/confirmation/
share-sheet and real Swift-relay integration ran on SIMULATOR, not physical-phone
navigation. No real Wi-Fi packets recorded autonomously; owner must explicitly
select/confirm their authorized target. Coldboot/powerloss and actual RF packet
socket ownership during recording remain unverified. Restore drift, SIGKILL,
expiry, HT20/40/80 tuning and synthetic limits were tested on the real Pager.

---

## Historical build85 baseline (superseded by build86 above)

# Network picker — build85, 2026-09-13

## Installed and launched

Signed Release build **85** installed on owner's iPhone16Pro (`owner-phone`). Independent
`devicectl device info apps` confirms `technology.tiny.app`, `bundleVersion:85`;
process launch succeeded. Evidence: `/tmp/pineapple-ios-device85.log`,
`/tmp/pineapple-install85.json`, `/tmp/pineapple-apps85.json`, `/tmp/pineapple-launch85.log`.
Both project.yml and pbxproj now record85 (previous83/84 used CLI overrides).

**Devices → Open Pineapple → Find networks → select AP → review → Start confirmation.**
Rows include literal SSID, BSSID, signal, band/channel and coarse security. Duplicate
SSIDs remain separate APs; hidden names are labeled. Target scope includes exact
BSSID/channel/frequency; interface is filled automatically only when eligible.
Refresh preserves identity, never chooses a different AP; stale/missing/unsupported
selections cannot start. Advanced manual BSSID remains available. Size choices
64/128/256KiB, duration10/30/60s; existing four-file/256KiB backend caps unchanged.
No selection joins a network or starts recording. Permission toggle and explicit
confirmation remain separate from selection. No new login/confirmation barrage.

## Verification — 23 distinct tests passed across final run + one corrected teardown

- **10 pure contracts**, including malicious/control/bidi names, hidden/duplicate
  SSIDs, BSSID identity, per-observation aging, missing age, future clock, wrong
  frequency, missing selection, malformed/oversize decoder and existing metadata/chunks.
- **4 existing download regressions**: bytes/hash/permissions/progress/cancellation
  and malformed-chunk cleanup.
- **1 real Swift-client integration**: authenticated `network_scan` → actual Pager
  cache → native decoder, then retained **104-byte synthetic loopback** PCAP download
  and SHA256 verification. Only counts printed; no AP identifiers. Temporary
  mode0600 credential fixture removed by the test and independently checked absent.
- **8 XCUI tests**: Devices navigation, manual fallback, duplicate/hidden/hostile
  rows, BSSID selection and channel/frequency scope, stable refresh, stale/wrong-band
  refusal **even with permission ON**, missing/empty/unsupported states, offline gate,
  explicit Start confirmation (never accepted), private download/native share sheet.

Evidence: `/tmp/pineapple-picker-final.xcresult` has22 passes and one **test teardown**
failure: consent and confirmation assertions passed, but the test tried to tap a
nonexistent Cancel accessibility button. It now terminates the preview app without
accepting confirmation. That test passes in `/tmp/pineapple-picker-confirm-final.xcresult`.
There was no production app change between those runs or after installed build85.
Earlier test-driver fixes: scroll virtualized List rows into view; tap the nested
native switch rather than the surrounding SwiftUI row. One overlapping test run
was interrupted; final runs were serial. No image-returning tools used; screenshots
are saved as test attachments only.

## Real device scope, not a full-band scan

Backend private `pineapple-the-wifi` commit461e924 is SCP deployed,5/5 source hashes
matched, daemon restarted with no active capture.25 discovery/parser/runtime tests,
71 capture-policy cases,24 dispatch checks and12 PCAP-parser checks pass on hardware.
Independent owner relay envelope `b9aa7612-a531-406d-bab5-b2acca49f210` verified bounded
cache reply and unauthenticated401. Native live test additionally verified the real
Swift decoder/relay path, not merely a mocked response.

Discovery reads `iw dev wlan0cli scan dump` (kernel GET_SCAN), never triggers a scan
or hops/associates. UI says cache observations, not a fresh full-band survey. The
client/management link stayed unchanged; network reconnect helper remains connected.
**Current hardware limitation:** observed APs are outside the separate monitor's
frequency, so none were capture-eligible in the real read. The picker shows why;
it does not retune the radio. Channel numbers alone can alias between bands, so
wireless Start now requires exact frequency. Old app versions missing that field
fail closed. No actual nearby Wi-Fi packets were recorded.

Physical-phone navigation/export remains unautomated (installation/version/launch
are independently verified). UI assertions and the real Swift-client integration
ran on simulator. Coldboot/full-band discovery/radio retuning remain unclaimed.
Source stays on PRIVATE `pineapple-native`; no merge to main or public PR.

---

## Historical build84 capture baseline

# Pineapple native screen — 2026-09-13 final verification

## Installed on owner's phone

- Dedicated **Devices → Open Pineapple** screen, selected by platform/capabilities.
- Signed Release build **84** succeeded; installed to owner's iPhone16Pro (`owner-phone`).
- Independent `devicectl device info apps`: `technology.tiny.app`, `bundleVersion: 84`; launch succeeded.
- Evidence: `/tmp/pineapple-ios-device84.log`, `/tmp/pineapple-install84.json`, `/tmp/pineapple-apps84.json`, `/tmp/pineapple-launch84.log`.
- Installation/launch is not a physical-phone navigation/share assertion. Tests below name their actual environment.

## 14/14 tests, zero skipped

`/tmp/pineapple-ios-tests5.xcresult`, iPhone17Pro iOS26.4.1 simulator:

- **6 contract**: platform classification, offline reason, MVP compatibility, BSSID/UUID exact-length/injection refusal, metadata and chunk bounds.
- **4 download**: multi-chunk/hash/progress, mode0600 file, wrong-hash cleanup, malformed/short/empty replies, cancellation cleanup (malformed variants share one test).
- **1 real relay**: actual Swift `PineappleClient.command/download`, signed-in owner relay → real Pager's finalized generated loopback fixture → verified 104-byte PCAP. Not a mock response. The temporary mode0600 credential fixture was staged outside Git and removed in both the test and host cleanup; no credential logged.
- **3 XCUI**: actual DevicesView navigation via DEBUG-only fixture, consent/offline Start gates, explicit download confirmation → common download engine → native system share sheet with **Save to Files** visible. No person/app selected and nothing sent. Saved screenshots stay inside xcresult; only accessibility trees/assertions and JSON were inspected.

SwiftUI combines Battery label/value into one accessibility element, so tests match its label substring. Simulator does not report iOS file-protection classes; mode0600 is asserted there. Production requests `NSFileProtectionComplete`, and the protection-class assertion is active on physical-device unit-test runs only (not run here).

## Capture integration

Pager's controller is installed and `overview.capture.available` is true. Final read-only cloud envelope `28e4e422-122b-4be4-9d86-c6098453036a` showed online,87% Charging, no active capture, capture limits60sec/256KiB/4files. One generated loopback fixture is retained for the owner to download from the native screen. No real Wi-Fi capture was started.

Client: strict metadata/offset/chunk-size checks, protected local file, SHA256 verification, cancel/progress, delete confirmation, ShareLink. Export disclosure: TLS-protected chunks traverse the owner-only relay; replies become eligible for cleanup after about24h. This is not end-to-end encryption or an exact deletion-time guarantee.

Backend evidence/limits are in private pineapple-the-wifi `docs/CAPTURE.md`. Scope: exact authorized BSSID/current monitor channel or generated localhost fixture, no retuning, no rogue AP/deauth/payloads, no public PCAP URLs.

## Remaining distinctions

- Real Swift client ↔ real Pager was tested **from simulator**, not an automated physical-phone flow.
- Share sheet / Save to Files was tested with a **generated preview file**, not by saving a real capture on the owner's phone.
- Real Wi-Fi recording requires the owner to explicitly select/confirm the authorized target; intentionally not tested autonomously.
- Source stays on private `pineapple-native` branch; no main merge or public PR was made.

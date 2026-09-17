/**
 * 🔇 Why a recording won't play, in the language of the person who tapped play.
 *
 * `/voice/recording/:id` is not a file — it is a route that STITCHES a call's
 * PCM segments into one WAV on first listen, and it can decline. It has five
 * refusals, each a JSON body with a stated reason and a status:
 *
 *   424 media store not provisioned    — R2 isn't bound to this worker
 *   400 session id required            — the URL had no id (a client bug, but
 *                                        the map covers EVERY refusal or its
 *                                        own claim is false — found by the
 *                                        extractor pin, not by memory)
 *   409 call still in progress         — the call hasn't ended yet
 *   404 no replay journaled…           — events.jsonl is absent (or was
 *                                        overwritten empty by a cold teardown)
 *   404 no audio journaled             — the journal is there, the PCM isn't
 *   413 call too long to stitch        — inPcm + outPcm > 40MB
 *
 * All three clients hand that URL straight to a media player — web
 * `<audio src>`, iOS `AVPlayer(url:)`, Android `MediaPlayer.setDataSource` —
 * and a media player handed a 413 with a JSON body has exactly one thing to
 * say, which is nothing. Web's `<audio controls>` greys out its own play
 * button. iOS's `AVPlayer` sets `currentItem.status = .failed` that nobody
 * reads, so `playingId` stays set and the row shows a pause glyph over a
 * transport at 0:00. Android registers `setOnPreparedListener` and
 * `setOnCompletionListener` and NO `setOnErrorListener`, so `prepareAsync`
 * reports asynchronously into a void — `runCatching` cannot catch it, because
 * nothing throws — and the row is left mid-play forever.
 *
 * ⚠️ THE SAME THREE FILES ALREADY LEARNED THIS ON THEIR LOAD PATH, and each
 * carries a ⚠️ comment about it: "reaching past the house client is what threw
 * the status away, and a screen with no status can only guess at a cause." The
 * list is fetched through `Api.getData` / `app.api.getJson` / a deadlined
 * `fetch` precisely so a 401 reads as an expired session instead of a dead
 * connection. The PLAY path in those same files then hands a URL to a player
 * with no error channel at all — the identical defect, on the other verb.
 *
 * ⚠️ AND THE ROW ALREADY HOLDS THE NUMBER THAT PREDICTS ONE OF THEM.
 * `segment_count` is on every row (all three clients read it, only as `> 0`).
 * Segments are ~1.44MB each and the stitch guard is 40MB, so a call past ~30
 * segments CANNOT stitch — the refusal is arithmetic, knowable before the tap,
 * from a field already decoded. See `tooLongToStitch`.
 *
 * Pure and shared, like `outcome.ts` beside it: the same rule is checkable
 * without a network, and the Swift/Kotlin twins have one definition to be
 * twins OF.
 */

/** Bytes per PCM segment before `flushSegment` writes it (worker
 *  `SEGMENT_BYTES`). PCM16 @ 24 kHz mono = 48000 B/s, so ~30 s per segment. */
export const SEGMENT_BYTES = 1_440_000;

/** The stitch's worker-memory guard (`inPcm.length + outPcm.length > this`
 *  → 413). Workers cap at ~128MB and the route buffers the whole WAV. */
export const STITCH_BYTE_CAP = 40_000_000;

/**
 * Will this call's stitch certainly be refused for size?
 *
 * ⚠️ ONE-SIDED ON PURPOSE — it answers "certainly refused", never "certainly
 * fine". `segment_count` is the SUM of both directions and only the final
 * segment per direction may be short, so `(count - 2) * SEGMENT_BYTES` is the
 * guaranteed floor on the stitched bytes. At 30 segments that floor is
 * 40,320,000 > 40,000,000, so the 413 is certain; at 29 it is 38,880,000 and
 * the call may well stitch. A row under the threshold is NOT promised a
 * recording — every other refusal is invisible from here — which is why this
 * predicate only ever adds a warning and never gates the player.
 */
export function tooLongToStitch(segmentCount: number | null | undefined): boolean {
  const n = Number(segmentCount) || 0;
  if (n < 3) return false;
  return (n - 2) * SEGMENT_BYTES > STITCH_BYTE_CAP;
}

/** What the row says when a recording won't play. `known` is false when the
 *  refusal wasn't recognised: the surface knows the play failed and nothing
 *  more, and must not dress that up as a diagnosis. Mirrors
 *  `CallOutcome` in ./outcome. */
export type PlaybackRefusal = { text: string; known: boolean };

/** The generic answer for a refusal we can't read, and for a player error with
 *  no body at all (a dropped connection mid-stream reaches the same arm).
 *  Named because all three clients and their pins must agree on it. */
export const UNKNOWN_REFUSAL = "couldn't play this recording";

/**
 * The route's refusal → the person's sentence.
 *
 * ⚠️ KEYED ON THE WORKER'S OWN LITERALS. Every `json({ error: … }, 4xx)` that
 * `voiceRecording` can return has an entry here, and `voice-playback-refusal.test.ts`
 * extracts those literals out of `src/voice.ts` to prove it — so a sixth
 * refusal added upstream fails a suite instead of quietly falling to the
 * generic sentence. Pinning the five spellings I happened to think of would
 * pass forever while the map rotted (the same trap `outcome.ts` documents).
 *
 * Each sentence says what the person can DO about it, or admits there is
 * nothing — a reason with no next step is where the house failure states
 * started before `LoadFailure` ("the reason, plus something to do about it").
 */
const REFUSALS: Array<[RegExp, string]> = [
  // Still live: the ONE refusal that fixes itself. The list filter admits only
  // ended/error rows, so this arrives when the row is stale, and a reload is
  // exactly the fix.
  [/^call still in progress$/, "this call is still going — reload in a moment"],
  // The 40MB stitch guard. Nothing the person can do; saying so is the point.
  [/^call too long to stitch$/, "this call is too long to replay in one piece"],
  // events.jsonl absent: no mix markers, so there is nothing to assemble the
  // reply track against. A cold teardown used to overwrite it empty.
  [/^no replay journaled for this session$/, "this call wasn't recorded"],
  // The journal is there and the PCM is not.
  [/^no audio journaled$/, "this call's audio wasn't saved"],
  // R2 unbound — server-side, transient, and not the person's fault.
  [/^media store not provisioned$/, "recordings are unavailable right now"],
  // ⚠️ FOUND BY THE EXTRACTOR PIN, not by reading the route. All three clients
  // build the URL from a row id, so this needs a client bug to reach — but the
  // map's stated guarantee is that it covers every refusal the route can give,
  // and an exception "because that one can't happen" is how the next arm gets
  // skipped too. Deliberately shares the sentence below rather than blaming the
  // person for a URL they never typed: the honest thing to say about a bug on
  // our side is that we couldn't play it. `known: true` still distinguishes it
  // from an unrecognised refusal — we know the cause, we just have nothing
  // better to tell the person about it.
  [/^session id required$/, UNKNOWN_REFUSAL],
];

/**
 * What to say when a recording won't play, given whatever the client managed to
 * learn. Always a sentence — never null.
 *
 * ⚠️ NULL IS NOT AN OPTION HERE, and that is the difference from
 * `callOutcome`. That function describes a call, so "nothing to say" is the
 * common and correct answer. This one is called only when a play attempt
 * FAILED, and a failed play that says nothing is the whole defect: a pause
 * glyph over a transport that never moves. If we know only that it failed, we
 * say only that.
 *
 * `error` is the route's own `error` string when the client could read one, and
 * null when it couldn't — which is the normal case for a media player, whose
 * error channel carries a code and not a body. The status is passed separately
 * because it is often all a player yields.
 */
export function playbackRefusal(
  error: string | null | undefined,
  status?: number | null,
): PlaybackRefusal {
  const reason = (error || "").trim();
  if (reason) {
    for (const [re, text] of REFUSALS) {
      if (re.test(reason)) return { text, known: true };
    }
    return { text: UNKNOWN_REFUSAL, known: false };
  }
  // No body — a bare status is still more than the row said before. 409 is the
  // one worth translating blind: it is the only refusal that resolves itself,
  // so telling the person to reload is actionable even with nothing else known.
  if (status === 409) {
    return { text: "this call is still going — reload in a moment", known: true };
  }
  return { text: UNKNOWN_REFUSAL, known: false };
}

/** What `/api/voice/recording-status/[id]` answers: never a refusal of its own,
 *  always a 200 describing the worker's answer. `null` is what the client has
 *  when the request itself never completed. */
export type RecordingStatusAnswer =
  | { ok?: boolean; status?: number | null; error?: string | null }
  | null
  | undefined;

/**
 * The status route's answer → the person's sentence.
 *
 * ⚠️ EXTRACTED FROM THE COMPONENT ON PURPOSE. This lived inline in `/calls`'s
 * `playFailed` closure, where nothing could call it — so the only available pin
 * was a grep for the call site, and a mutant that asked the route WHY and then
 * discarded the answer (`playbackRefusal(null, null)`) SURVIVED the harness. The
 * grep was the design signal, not the gap: a rule worth a mutant is a rule worth
 * a name. Two facts live here and neither is obvious:
 *
 *  - `ok: true` means the recording serves audio NOW, so whatever the player hit
 *    was transient. Naming a cause there would be inventing one — the generic
 *    line is the honest answer, and `known: false` says we are not diagnosing.
 *  - a request that never completed (`null`) is not evidence of anything either,
 *    and lands on the same generic line rather than blaming the recording.
 */
export function refusalFromStatusAnswer(answer: RecordingStatusAnswer): PlaybackRefusal {
  if (answer && answer.ok) return { text: UNKNOWN_REFUSAL, known: false };
  return playbackRefusal(answer?.error, answer?.status);
}

/**
 * 🔴 Why a call ended, in the language of the person who asks.
 *
 * `voice_sessions.error` carries a reason for every abnormal end — but only
 * since the fix that wired it (`6a24d5d`); the bind was a hardcoded `null`
 * before that, so the column was NULL for every session ever recorded. Its
 * docstring states the intent plainly: "the row is what the person still has
 * tomorrow when they ask why." Two things stood between that intent and a
 * reader:
 *
 *  1. **Nothing decoded it.** `VOICE_LIST_SQL` selects `error` and
 *     /api/voice/sessions passes the rows through verbatim, so the reason
 *     reaches all three clients — and all three dropped it one line before the
 *     render, at the type boundary (web's `CallSession`, iOS's `CallSession`,
 *     Android's `CallRecording` all omitted the field). Every one of those
 *     three list filters ADMITS `status === "error"` rows, so a call OpenAI
 *     dropped 20 seconds in drew `📞 tiny · Aug 2, 14:32 · 0:20` — pixel-for-
 *     pixel identical to a 20-second call the person ended themselves.
 *
 *  2. **The reason is written for the wrong reader.** The recorded strings are
 *     `upstream closed: 1011 <reason>` and `upstream error: <exception>` —
 *     worker-tail diagnostics. Keeping them raw in the column is right (that IS
 *     the record, and the code + message are what you want when debugging), but
 *     showing one to the owner of the call would just be the same wrong-surface
 *     mistake pointing the other way. So the column stays diagnostic and the
 *     translation happens here, at the surface, where the reader is known.
 *
 * ⚠️ AN UNRECOGNISED REASON IS NOT SILENCE. A reason this map hasn't seen —
 * a new teardown arm in the worker, or a row from before the wiring landed —
 * must still tell the person the call did not end normally, without inventing
 * a cause. That is the whole lesson of the row it renders: a surface must not
 * state a conclusion it has no basis for, and "say nothing" is how the reason
 * lost its reader in the first place. `known: false` is that middle answer.
 *
 * Pure and shared so the same rule is checkable without a network, and so the
 * iOS/Android twins have one definition to be twins OF (`platform.ts`'s
 * `ownsVoiceSession` posture, `CallRecordingsLoad`'s split).
 */

/** What the call list says about how a call ended. `known` is false when the
 *  recorded reason wasn't recognised — the surface knows the end was abnormal
 *  and nothing more, and must not dress that up as a diagnosis. */
export type CallOutcome = { text: string; known: boolean };

/** The generic answer for an abnormal end with no reason we can read. Named
 *  because all three clients and their pins must agree on it. */
export const UNKNOWN_OUTCOME = "ended unexpectedly";

/**
 * The recorded reason → the person's sentence.
 *
 * ⚠️ KEYED ON THE WORKER'S OWN LITERALS. Every string `VoiceSession.teardown`
 * can receive as `reason` has an entry here, and `voice-call-outcome.test.ts`
 * extracts those literals from `src/voice.ts` to prove it — so a sixth arm
 * added upstream fails this suite instead of quietly falling to the generic
 * sentence. Pinning the five spellings I happened to think of would pass
 * forever while the map rotted.
 *
 * The two prefixes are prefixes on purpose: the diagnostic tail (`1011`, the
 * exception text) is deliberately NOT shown — it is for the worker tail, and
 * an arbitrary upstream `e.message` is not something to paint into someone's
 * call list.
 */
const REASONS: Array<[RegExp, string]> = [
  [/^upstream closed:/, "the voice service closed the connection"],
  [/^upstream error:/, "the voice service dropped"],
  [/^the client socket errored$/, "this device's connection dropped"],
  [/^the client went silent$/, "we stopped hearing this device"],
  [/^the call hit the maximum length$/, "the call hit the maximum length"],
];

/**
 * What to say about a finished call, or null when there is nothing to say.
 *
 * Null is the common case and it means "this ended the way calls end" — a
 * clean `ended` row with no recorded reason. A badge on every row would say
 * nothing; the point of this one is that it appears exactly when the person's
 * call did something they didn't ask for.
 *
 * ⚠️ `status === "error"` with no reason is NOT null. Every error row written
 * before the reason was wired looks exactly like that, and so does any future
 * arm that tears down without one — the status alone is enough to know the end
 * was abnormal, which is more than the row said yesterday.
 */
export function callOutcome(
  status: string | null | undefined,
  error: string | null | undefined,
): CallOutcome | null {
  const reason = (error || "").trim();
  if (reason) {
    for (const [re, text] of REASONS) {
      if (re.test(reason)) return { text, known: true };
    }
    return { text: UNKNOWN_OUTCOME, known: false };
  }
  if (status === "error") return { text: UNKNOWN_OUTCOME, known: false };
  return null;
}

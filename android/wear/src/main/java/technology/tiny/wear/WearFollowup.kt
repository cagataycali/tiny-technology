package technology.tiny.wear

import technology.tiny.app.wear.WatchCore

/**
 * The wrist follow-up brain (iOS FollowupIntent / W7 parity) — a pure core that
 * decides whether tiny's suggested follow-up is still worth asking from the
 * face, and how to steer it.
 *
 * tiny streams `suggest_followups` chips at the end of a turn; the top one can be
 * asked in one tap from a face surface WITHOUT opening the app. But a stale chip
 * must not stay tappable (iOS's 30-min freshness window — a follow-up to a
 * conversation from an hour ago is noise), so [resolve] gates on
 * [WatchCore.isFresh]. Pure + stateless so the gate is unit-tested, not just the
 * intent glue; the freshness window lives in the SHARED WatchCore so the chip
 * (shown) and the intent (tapped) can't drift.
 */
object WearFollowup {
    /** Steering prefix for a face-tapped follow-up — DISTINCT from the dictation
     *  [WRIST_STEER] and [WearBriefing.BRIEFING_STEER] so the server can tell a
     *  follow-up tap apart from a fresh ask or a briefing (iOS W7 wording). */
    const val FOLLOWUP_STEER = "[Followup tapped on Wear OS watch face — answer in 1-2 short sentences, no markdown]"

    /**
     * The follow-up to ask, or null if there's nothing fresh to ask. Returns a
     * trimmed non-empty [stored] chip only while it's within the freshness window
     * ([WatchCore.isFresh] of [at]); a null/blank chip, a null timestamp, or a
     * stale one all yield null (the face button decays — iOS FollowupIntent guard).
     */
    fun resolve(stored: String?, at: Long?, now: Long): String? {
        val q = stored?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return if (WatchCore.isFresh(at, now)) q else null
    }

    /** Prefix a resolved follow-up with the steer for the /api/chat POST. */
    fun steer(followup: String): String = "$FOLLOWUP_STEER $followup"

    /** What the roomy last-exchange (LONG_TEXT) complication tap should ask. iOS W7
     *  surfaces a fresh follow-up as its own face Button; the wrist has one typed
     *  slot, so it PREFERS a fresh follow-up when there is one and falls back to a
     *  briefing otherwise. Pure over the same freshness gate as [resolve] so the
     *  tap target and the intent that runs can't disagree. */
    enum class FaceTap { FOLLOWUP, BRIEFING }

    fun faceTap(stored: String?, at: Long?, now: Long): FaceTap =
        if (resolve(stored, at, now) != null) FaceTap.FOLLOWUP else FaceTap.BRIEFING
}

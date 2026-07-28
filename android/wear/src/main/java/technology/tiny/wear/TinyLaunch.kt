package technology.tiny.wear

import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/** Shared "open the watch chat" intent for surfaces that tap through to the app
 *  (complication slots use a real PendingIntent; the tile uses its own
 *  ProtoLayout LaunchAction). */
object TinyLaunch {
    /** Intent extra: when true, MainActivity fires the briefing once on launch —
     *  the headless-from-the-face analog of iOS's BriefingIntent run from a
     *  complication Button. */
    const val EXTRA_BRIEFING = "technology.tiny.wear.BRIEFING"

    /** Intent extra: when true, MainActivity asks tiny's stored top follow-up once
     *  on launch (iOS FollowupIntent / W7). No-op if none is fresh. */
    const val EXTRA_FOLLOWUP = "technology.tiny.wear.FOLLOWUP"

    /** Tap → just open the watch chat (dictate a question). */
    fun pendingIntent(context: Context): PendingIntent =
        activityPending(context, requestCode = 0, extra = null)

    /** Tap → open the app AND immediately run the briefing, so a face slot answers
     *  in one tap (iOS BriefingIntent parity — the answer then lands back in the
     *  last-exchange complication via WristSurfaces.refresh). */
    fun briefingPendingIntent(context: Context): PendingIntent =
        activityPending(context, requestCode = 1, extra = EXTRA_BRIEFING)

    /** Tap → open the app AND ask the stored top follow-up once (iOS FollowupIntent).
     *  The answer lands back in the last-exchange complication, and the follow-up is
     *  consumed so the button decays until the next turn. */
    fun followupPendingIntent(context: Context): PendingIntent =
        activityPending(context, requestCode = 2, extra = EXTRA_FOLLOWUP)

    private fun activityPending(context: Context, requestCode: Int, extra: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (extra != null) intent.putExtra(extra, true)
        // Distinct requestCodes keep the three PendingIntents separate — PendingIntent
        // equality (filterEquals) ignores extras, so same-code + FLAG_UPDATE_CURRENT
        // would otherwise collapse "open"/"brief"/"followup" into one.
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}

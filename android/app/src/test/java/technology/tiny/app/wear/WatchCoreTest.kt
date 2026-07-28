package technology.tiny.app.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WatchCore is the pure brain of the (upcoming) Wear OS companion — the Android port of
 * iOS WatchCore.swift. These pin the three decisions the wrist app leans on: the
 * Converse history filter/shape (must match TinyApi.chat's history array), restore
 * hygiene (no forever-spinning interrupted turn), and the 30-min followup freshness
 * window. All pure — no Data Layer / hardware needed. org.json is on the test classpath.
 */
class WatchCoreTest {

    private fun turn(q: String, a: String = "", done: Boolean = false) =
        WatchTurn(id = q, q = q, a = a, done = done)

    // -- history --

    @Test fun `history emits alternating user assistant text blocks`() {
        val h = WatchCore.history(listOf(turn("hi", "hello", done = true)))
        assertEquals(2, h.length())
        val u = h.getJSONObject(0)
        assertEquals("user", u.getString("role"))
        assertEquals("hi", u.getJSONArray("content").getJSONObject(0).getString("text"))
        val a = h.getJSONObject(1)
        assertEquals("assistant", a.getString("role"))
        assertEquals("hello", a.getJSONArray("content").getJSONObject(0).getString("text"))
    }

    @Test fun `history excludes an unfinished turn`() {
        val h = WatchCore.history(listOf(turn("q", "partial", done = false)))
        assertEquals(0, h.length())
    }

    @Test fun `history excludes a turn with an empty answer`() {
        assertEquals(0, WatchCore.history(listOf(turn("q", "", done = true))).length())
    }

    @Test fun `history excludes an error-prefixed answer`() {
        // A failed turn (⚠…) must not poison the context sent back up.
        assertEquals(0, WatchCore.history(listOf(turn("q", "⚠ server hiccup", done = true))).length())
    }

    @Test fun `history caps to the most recent turns`() {
        val turns = (1..15).map { turn("q$it", "a$it", done = true) }
        val h = WatchCore.history(turns, cap = 10)
        // 10 turns → 20 blocks, and the oldest kept is q6 (the last 10 of 1..15).
        assertEquals(20, h.length())
        assertEquals("q6", h.getJSONObject(0).getJSONArray("content").getJSONObject(0).getString("text"))
    }

    @Test fun `history of no eligible turns is empty`() {
        assertEquals(0, WatchCore.history(emptyList()).length())
    }

    // -- sanitize --

    @Test fun `sanitize forces an unfinished turn done and labels an empty one interrupted`() {
        val out = WatchCore.sanitize(listOf(turn("q", "", done = false)))
        assertTrue(out.single().done)
        assertEquals("(interrupted)", out.single().a)
    }

    @Test fun `sanitize keeps a partial answer but marks it done`() {
        val out = WatchCore.sanitize(listOf(turn("q", "half a thou", done = false)))
        assertTrue(out.single().done)
        assertEquals("half a thou", out.single().a)
    }

    @Test fun `sanitize leaves a completed turn untouched`() {
        val done = turn("q", "full answer", done = true)
        assertEquals(listOf(done), WatchCore.sanitize(listOf(done)))
    }

    // -- isFresh --

    @Test fun `a followup within 30 minutes is fresh`() {
        val now = 1_000_000_000L
        assertTrue(WatchCore.isFresh(now - 29 * 60 * 1000L, now))
    }

    @Test fun `a followup past 30 minutes is stale`() {
        val now = 1_000_000_000L
        assertFalse(WatchCore.isFresh(now - 31 * 60 * 1000L, now))
    }

    @Test fun `a null followup timestamp is never fresh`() {
        assertFalse(WatchCore.isFresh(null, 1_000_000_000L))
    }

    @Test fun `exactly at the boundary is stale (strict window)`() {
        val now = 1_000_000_000L
        // followupAt == now - window → NOT > (now - window), so stale.
        assertFalse(WatchCore.isFresh(now - WatchCore.FOLLOWUP_FRESH_MS, now))
    }

    // -- ellipsize --

    @Test fun `ellipsize leaves a short string untouched`() {
        assertEquals("hello", WatchCore.ellipsize("hello", 42))
    }

    @Test fun `ellipsize collapses internal whitespace and newlines to one space`() {
        assertEquals("a b c", WatchCore.ellipsize("a  \n b\tc", 42))
    }

    @Test fun `ellipsize truncates with a trailing ellipsis at max`() {
        // max 5 → 4 chars + "…"
        assertEquals("abcd…", WatchCore.ellipsize("abcdefgh", 5))
    }

    @Test fun `ellipsize trims a dangling space before the ellipsis`() {
        // "ab " would be the naive take(3); the trailing space is trimmed first.
        assertEquals("ab…", WatchCore.ellipsize("ab cdef", 4))
    }

    // -- tileSubline --

    @Test fun `tileSubline with no snapshot waits for the phone`() {
        assertEquals("Waiting for your phone", WatchCore.tileSubline(false, 0, "anything"))
    }

    @Test fun `tileSubline shows unread before the last answer`() {
        // Unread beats last-answer — there's a message to see.
        assertEquals("💬 3 unread", WatchCore.tileSubline(true, 3, "some answer"))
    }

    @Test fun `tileSubline surfaces the last answer when the fleet is quiet`() {
        assertEquals("🌱 hello there", WatchCore.tileSubline(true, 0, "hello there"))
    }

    @Test fun `tileSubline falls back to quiet when there is no last answer`() {
        assertEquals("Fleet is quiet", WatchCore.tileSubline(true, 0, null))
        assertEquals("Fleet is quiet", WatchCore.tileSubline(true, 0, "   "))
    }

    // -- lastExchangeText --

    @Test fun `lastExchangeText joins question and answer with an arrow`() {
        assertEquals("hi → hello", WatchCore.lastExchangeText("hi", "hello", 2, 5))
    }

    @Test fun `lastExchangeText falls back to presence without a full exchange`() {
        assertEquals("2/5 online", WatchCore.lastExchangeText(null, "hello", 2, 5))
        assertEquals("2/5 online", WatchCore.lastExchangeText("hi", null, 2, 5))
        assertEquals("2/5 online", WatchCore.lastExchangeText("hi", "  ", 2, 5))
    }

    // -- speakable (TTS scrub; phone Speech.scrub twin) --

    @Test fun `speakable KEEPS inline code content instead of dropping the word`() {
        // The bug the old wrist scrub had: `code` -> " " ate the word. Now kept.
        assertEquals("run ls now", WatchCore.speakable("run `ls` now"))
    }

    @Test fun `speakable keeps link text and drops the url`() {
        assertEquals("see the docs", WatchCore.speakable("see [the docs](https://x.io/y)"))
    }

    @Test fun `speakable keeps image alt text and drops the url`() {
        assertEquals("a chart", WatchCore.speakable("![a chart](https://x.io/c.png)"))
    }

    @Test fun `speakable replaces a fenced code block with a spoken placeholder`() {
        assertEquals("here code block omitted done", WatchCore.speakable("here\n```\nval x = 1\n```\ndone"))
    }

    @Test fun `speakable turns markdown-noise chars into spaces not empty (no word jam)`() {
        // "cell1|cell2" must NOT become "cell1cell2"; emphasis must not jam either.
        assertEquals("cell1 cell2", WatchCore.speakable("cell1|cell2"))
        assertEquals("bold word", WatchCore.speakable("**bold** word"))
    }

    @Test fun `speakable collapses whitespace and trims`() {
        assertEquals("a b c", WatchCore.speakable("  a\n\n b   c  "))
    }

    @Test fun `speakable caps at SPEAK_CAP`() {
        val long = "x".repeat(WatchCore.SPEAK_CAP + 500)
        assertEquals(WatchCore.SPEAK_CAP, WatchCore.speakable(long).length)
    }

    // -- accentArgb (one parse for tile/complication/app) --

    @Test fun `accentArgb parses a hashed six-digit hex to opaque ARGB`() {
        // #00FF88 (web THEME_PRESETS.tiny) → 0xFF00FF88.
        assertEquals(0xFF00FF88.toInt(), WatchCore.accentArgb("#00FF88"))
    }

    @Test fun `accentArgb tolerates a missing hash`() {
        assertEquals(0xFFBD93F9.toInt(), WatchCore.accentArgb("bd93f9")) // dracula, no #
    }

    @Test fun `accentArgb is case-insensitive`() {
        assertEquals(WatchCore.accentArgb("#FF00FF"), WatchCore.accentArgb("#ff00ff"))
    }

    @Test fun `accentArgb forces full alpha on a dark color`() {
        // #000000 must render opaque black, not transparent.
        assertEquals(0xFF000000.toInt(), WatchCore.accentArgb("#000000"))
    }

    @Test fun `accentArgb falls back to the default on null blank or malformed`() {
        val d = WatchCore.DEFAULT_ACCENT_ARGB
        assertEquals(d, WatchCore.accentArgb(null))
        assertEquals(d, WatchCore.accentArgb(""))
        assertEquals(d, WatchCore.accentArgb("#fff"))       // 3-digit shorthand — server rejects it too
        assertEquals(d, WatchCore.accentArgb("#gggggg"))    // non-hex digits
        assertEquals(d, WatchCore.accentArgb("#12345678"))  // 8-digit — not the #RRGGBB contract
    }

    // -- presenceLine (shared by chat header + tile) --

    @Test fun `presenceLine shows a green dot when someone is online`() {
        assertEquals("🟢 2/5 online", WatchCore.presenceLine(2, 5))
    }

    @Test fun `presenceLine shows a hollow dot when the fleet is dark`() {
        assertEquals("⚪️ 0/5 online", WatchCore.presenceLine(0, 5))
    }

    @Test fun `presenceLine appends an unread suffix when unread is positive`() {
        assertEquals("🟢 2/5 online  ·  💬 3", WatchCore.presenceLine(2, 5, unread = 3))
    }

    @Test fun `presenceLine omits the unread suffix at zero (the tile's case)`() {
        assertEquals("🟢 2/5 online", WatchCore.presenceLine(2, 5, unread = 0))
    }

    // -- finalizeAnswer --

    @Test fun `finalizeAnswer trims trailing stream whitespace`() {
        assertEquals("the answer", WatchCore.finalizeAnswer("the answer\n\n  "))
    }

    @Test fun `finalizeAnswer labels an empty stream (no answer)`() {
        assertEquals("(no answer)", WatchCore.finalizeAnswer(""))
        assertEquals("(no answer)", WatchCore.finalizeAnswer("   \n "))
    }

    // -- capTurns --

    @Test fun `capTurns leaves a short transcript untouched`() {
        val turns = (1..5).map { turn("q$it", "a$it", done = true) }
        assertEquals(turns, WatchCore.capTurns(turns))
    }

    @Test fun `capTurns keeps the most recent TURN_CAP turns, dropping the oldest`() {
        val turns = (1..WatchCore.TURN_CAP + 5).map { turn("q$it", "a$it", done = true) }
        val capped = WatchCore.capTurns(turns)
        assertEquals(WatchCore.TURN_CAP, capped.size)
        // oldest kept is q6 (dropped q1..q5), newest is the last.
        assertEquals("q6", capped.first().q)
        assertEquals("q${WatchCore.TURN_CAP + 5}", capped.last().q)
    }

    @Test fun `capTurns at exactly TURN_CAP keeps all`() {
        val turns = (1..WatchCore.TURN_CAP).map { turn("q$it", done = true) }
        assertEquals(WatchCore.TURN_CAP, WatchCore.capTurns(turns).size)
    }

    // -- incomingExchangeWins (phone snapshot vs wrist's own last exchange) --

    @Test fun `incomingExchangeWins when the phone exchange is strictly newer`() {
        assertTrue(WatchCore.incomingExchangeWins(incomingLastAt = 2000L, storedLastAt = 1000L))
    }

    @Test fun `incomingExchangeWins loses to a fresher wrist exchange`() {
        // The user chatted on the WATCH after the phone built this push.
        assertFalse(WatchCore.incomingExchangeWins(incomingLastAt = 1000L, storedLastAt = 2000L))
    }

    @Test fun `incomingExchangeWins loses on an equal timestamp (strict, keeps the wrist's)`() {
        assertFalse(WatchCore.incomingExchangeWins(incomingLastAt = 1000L, storedLastAt = 1000L))
    }

    @Test fun `incomingExchangeWins a real exchange beats no stored exchange`() {
        assertTrue(WatchCore.incomingExchangeWins(incomingLastAt = 1L, storedLastAt = null))
    }

    @Test fun `incomingExchangeWins a null incoming never wins (push carries no exchange)`() {
        // A presence-only push (no lastAt) must NOT wipe the stored exchange.
        assertFalse(WatchCore.incomingExchangeWins(incomingLastAt = null, storedLastAt = 5000L))
        assertFalse(WatchCore.incomingExchangeWins(incomingLastAt = null, storedLastAt = null))
    }
}

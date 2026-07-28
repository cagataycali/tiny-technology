package technology.tiny.app.fleet

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure Spotify relay helpers (iOS Media.swift parity) — link extraction and the
 * "play X on spotify" → "X" query resolver a relay prompt runs through before it
 * builds the search deep-link. Pure Kotlin, runs on the local JVM (searchUrl/open
 * touch android.net.Uri, so they're exercised on-device, not here).
 */
class MediaTest {

    // ---- musicQuery --------------------------------------------------------

    @Test fun `strips a leading play verb and a spotify suffix`() {
        assertEquals("daft punk", Media.musicQuery("play daft punk on spotify"))
    }

    @Test fun `strips play wherever it leads, not just at the start (iOS parity)`() {
        // The bug this fixes: a conversational prompt kept "can you play …" as the query.
        assertEquals("daft punk", Media.musicQuery("can you play daft punk on spotify"))
        assertEquals("lofi beats", Media.musicQuery("hey tiny, play lofi beats on the phone"))
    }

    @Test fun `does not mistake play as a substring (display)`() {
        // \bplay\s is word-boundary anchored, so "display" must not trigger the strip.
        assertEquals("display the charts", Media.musicQuery("display the charts"))
    }

    @Test fun `trims trailing punctuation (iOS punctuationCharacters)`() {
        assertEquals("daft punk", Media.musicQuery("play daft punk!"))
        assertEquals("daft punk", Media.musicQuery("play daft punk?"))
    }

    @Test fun `keeps interior punctuation`() {
        assertEquals("AC/DC", Media.musicQuery("play AC/DC on spotify"))
        assertEquals("Sgt. Pepper", Media.musicQuery("play Sgt. Pepper"))
    }

    @Test fun `strips a repeated trailing suffix (while-loop, iOS parity)`() {
        // The same suffix twice is peeled by the per-suffix `while` (iOS parity).
        assertEquals("song", Media.musicQuery("play song spotify spotify"))
    }

    @Test fun `handles the in-spotify variant`() {
        assertEquals("miles davis", Media.musicQuery("play miles davis in spotify"))
    }

    @Test fun `a bare query with no scaffolding is returned trimmed`() {
        assertEquals("radiohead", Media.musicQuery("  radiohead  "))
    }

    // ---- spotifyLinks ------------------------------------------------------

    @Test fun `extracts spotify links in order, de-duplicated`() {
        val text = "try https://open.spotify.com/track/abc and " +
            "https://open.spotify.com/album/xyz — also https://open.spotify.com/track/abc again"
        assertEquals(
            listOf("https://open.spotify.com/track/abc", "https://open.spotify.com/album/xyz"),
            Media.spotifyLinks(text),
        )
    }

    @Test fun `no spotify links yields an empty list`() {
        assertEquals(emptyList<String>(), Media.spotifyLinks("just some text with https://example.com"))
    }
}

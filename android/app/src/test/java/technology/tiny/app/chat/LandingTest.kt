package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Turn-zero landing copy — web Chat.tsx:2472-2500 parity, byte-exact. The hero
 * tagline is derived purely from the name (the /api/tiny `hook` field is NOT the
 * tagline — web only edits it in Control.tsx). Pure Kotlin — runs on the local JVM.
 */
class LandingTest {

    @Test fun `home tiny gets the create-your-own pitch`() {
        assertEquals(
            "Create your own AI by chatting — free, forever.",
            landingTagline("tiny"),
        )
    }

    @Test fun `named tiny gets the living-AI line with its URL interpolated`() {
        assertEquals(
            "A tiny — a living AI at tiny.technology/jarvis. Say anything.",
            landingTagline("jarvis"),
        )
    }

    @Test fun `starter chips match the web per branch`() {
        assertEquals(
            listOf("Create an AI named …", "What is this place?", "Show me what a tiny can do"),
            landingChips("tiny"),
        )
        assertEquals(
            listOf("What can you do?", "Who made you?", "Surprise me"),
            landingChips("jarvis"),
        )
    }
}

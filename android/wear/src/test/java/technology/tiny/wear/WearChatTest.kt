package technology.tiny.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WearChat.parse is the wrist's SSE-frame decoder — a strict subset of the
 * phone's TinyApi.parseChatEvent, sharing the SAME /api/chat wire (flat `type`
 * discriminator). These pin that the four events a watch acts on decode from the
 * real frame shapes, and that phone-only gadgets (torch, clipboard…) no-op
 * rather than leaking to the wrist. Pure + stateless — org.json on the classpath.
 */
class WearChatTest {

    private val chat = WearChat(tokenProvider = { null })

    @Test fun `text delta decodes to Text`() {
        val ev = chat.parse("""{"type":"modelContentBlockDeltaEvent","textDelta":"hi","seq":0}""")
        assertEquals(WearEvent.Text("hi"), ev)
    }

    @Test fun `reasoning delta is ignored (invisible at wrist size)`() {
        assertNull(chat.parse("""{"type":"modelContentBlockDeltaEvent","reasoningDelta":"thinking"}"""))
    }

    @Test fun `tool start decodes to Tool with the name`() {
        val ev = chat.parse("""{"type":"modelContentBlockStartEvent","toolStart":{"name":"shell","toolUseId":"t1"}}""")
        assertEquals(WearEvent.Tool("shell"), ev)
    }

    @Test fun `speak tool call decodes to Speak with its text`() {
        val ev = chat.parse(
            """{"type":"beforeToolCallEvent","toolCall":{"name":"speak","toolUseId":"t2","input":{"text":"hello there"}}}""",
        )
        assertEquals(WearEvent.Speak("hello there"), ev)
    }

    @Test fun `suggest_followups decodes chips (key is chips, capped at 4)`() {
        val ev = chat.parse(
            """{"type":"beforeToolCallEvent","toolCall":{"name":"suggest_followups","input":{"chips":["a","b","c","d","e"]}}}""",
        )
        assertTrue(ev is WearEvent.Followups)
        assertEquals(listOf("a", "b", "c", "d"), (ev as WearEvent.Followups).chips)
    }

    @Test fun `a phone-only tool call no-ops on the wrist`() {
        // flashlight/clipboard/etc. reach the phone, never the watch.
        assertNull(
            chat.parse(
                """{"type":"beforeToolCallEvent","toolCall":{"name":"flashlight","input":{"on":true}}}""",
            ),
        )
    }

    @Test fun `error frame decodes to Error`() {
        val ev = chat.parse("""{"type":"error","error":"boom"}""")
        assertEquals(WearEvent.Error("boom"), ev)
    }

    @Test fun `an unknown event type is dropped`() {
        assertNull(chat.parse("""{"type":"modelMetadataEvent","usage":{"inputTokens":5}}"""))
    }

    @Test fun `malformed json is dropped, never throws`() {
        assertNull(chat.parse("not json at all"))
    }

    @Test fun `an empty followups suggestions list decodes to an empty chip list`() {
        val ev = chat.parse(
            """{"type":"beforeToolCallEvent","toolCall":{"name":"suggest_followups","input":{"chips":[]}}}""",
        )
        assertEquals(WearEvent.Followups(emptyList()), ev)
    }

    @Test fun `an empty text delta is dropped (streams emit them routinely)`() {
        // An empty textDelta must NOT surface as an empty Text bubble.
        assertNull(chat.parse("""{"type":"modelContentBlockDeltaEvent","textDelta":"","seq":3}"""))
    }

    @Test fun `a tool start with a blank name is dropped`() {
        assertNull(chat.parse("""{"type":"modelContentBlockStartEvent","toolStart":{"name":"","toolUseId":"t1"}}"""))
    }

    @Test fun `a speak call with empty text is dropped (nothing to read aloud)`() {
        assertNull(
            chat.parse("""{"type":"beforeToolCallEvent","toolCall":{"name":"speak","input":{"text":""}}}"""),
        )
    }

    @Test fun `suggest_followups with no chips key decodes to null (distinct from empty list)`() {
        // input present but no `chips` array at all → the branch returns null, not
        // an empty Followups — the chip row simply doesn't update.
        assertNull(
            chat.parse("""{"type":"beforeToolCallEvent","toolCall":{"name":"suggest_followups","input":{}}}"""),
        )
    }

    @Test fun `suggest_followups drops blank chips interspersed in the array`() {
        val ev = chat.parse(
            """{"type":"beforeToolCallEvent","toolCall":{"name":"suggest_followups","input":{"chips":["a","","b"]}}}""",
        )
        assertEquals(WearEvent.Followups(listOf("a", "b")), ev)
    }

    @Test fun `a beforeToolCallEvent with no toolCall is dropped`() {
        assertNull(chat.parse("""{"type":"beforeToolCallEvent","seq":7}"""))
    }

    @Test fun `an error frame with no error key falls back to unknown error`() {
        assertEquals(WearEvent.Error("unknown error"), chat.parse("""{"type":"error"}"""))
    }

    @Test fun `an error frame carrying an object payload stringifies it`() {
        // The server sometimes sends a structured error object rather than a string.
        val ev = chat.parse("""{"type":"error","error":{"message":"boom","code":500}}""")
        assertTrue(ev is WearEvent.Error)
        assertTrue((ev as WearEvent.Error).message.contains("boom"))
    }

    // -- buildRequestMessages (the send-side wire contract) --

    @Test fun `buildRequestMessages appends the steered user turn after history`() {
        val history = org.json.JSONArray().put(
            org.json.JSONObject().put("role", "user")
                .put("content", org.json.JSONArray().put(org.json.JSONObject().put("text", "earlier"))),
        )
        val msgs = chat.buildRequestMessages(history, "what's the weather?")
        // history preserved at the front, new turn last.
        assertEquals(2, msgs.length())
        assertEquals("earlier", msgs.getJSONObject(0).getJSONArray("content").getJSONObject(0).getString("text"))
        val last = msgs.getJSONObject(1)
        assertEquals("user", last.getString("role"))
        val text = last.getJSONArray("content").getJSONObject(0).getString("text")
        assertTrue("steering prefix present", text.startsWith(WRIST_STEER))
        assertTrue("question preserved", text.endsWith("what's the weather?"))
    }

    @Test fun `buildRequestMessages with empty history is just the one steered turn`() {
        val msgs = chat.buildRequestMessages(org.json.JSONArray(), "hi")
        assertEquals(1, msgs.length())
        assertEquals("$WRIST_STEER hi", msgs.getJSONObject(0).getJSONArray("content").getJSONObject(0).getString("text"))
    }

    @Test fun `buildRequestMessages does not mutate the passed history array`() {
        val history = org.json.JSONArray()
        chat.buildRequestMessages(history, "q")
        assertEquals("history untouched", 0, history.length())
    }

    @Test fun `buildRequestMessages applies a custom steer (briefing) in place of the default`() {
        val msgs = chat.buildRequestMessages(org.json.JSONArray(), "anything new?", WearBriefing.BRIEFING_STEER)
        val text = msgs.getJSONObject(0).getJSONArray("content").getJSONObject(0).getString("text")
        assertEquals("${WearBriefing.BRIEFING_STEER} anything new?", text)
        assertFalse("dictation steer must not leak in", text.contains(WRIST_STEER))
    }

    // -- wearHttpError copy table --

    @Test fun `http error copy maps the actionable codes`() {
        assertTrue(wearHttpError(401).contains("re-link"))
        assertTrue(wearHttpError(402).contains("charges"))
        assertTrue(wearHttpError(429).contains("daily limit"))
        assertTrue(wearHttpError(503).contains("server"))
        assertTrue(wearHttpError(418).contains("418"))
    }
}

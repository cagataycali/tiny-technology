package technology.tiny.app.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * parseChatEvent turns one SSE data frame into a ChatEvent — the streaming core.
 * The wire shape is FLAT (a `type` discriminator with the payload at top level),
 * verified against the live server / iOS Api.swift. It uses no instance state, so
 * a bare TinyApi({ null }) exercises it; org.json is on the test classpath
 * (cycle 117). Guards each event type, the textDelta-vs-reasoningDelta split, the
 * spawn_agents json-then-text result extraction, usage/metadata mapping, and the
 * malformed/unknown → null paths.
 */
class ParseChatEventTest {

    private val api = TinyApi({ null })
    private fun parse(json: String) = api.parseChatEvent(json)

    @Test fun `malformed json is null, not a crash`() {
        assertNull(parse("not json at all"))
        assertNull(parse(""))
    }

    @Test fun `an unknown type is ignored`() {
        assertNull(parse("""{"type":"somethingNew","x":1}"""))
    }

    @Test fun `text delta becomes a TextDelta`() {
        val e = parse("""{"type":"modelContentBlockDeltaEvent","textDelta":"hello","seq":3}""")
        assertEquals(ChatEvent.TextDelta("hello"), e)
    }

    @Test fun `reasoning delta becomes a ReasoningDelta when no text is present`() {
        val e = parse("""{"type":"modelContentBlockDeltaEvent","reasoningDelta":"thinking"}""")
        assertEquals(ChatEvent.ReasoningDelta("thinking"), e)
    }

    @Test fun `a delta frame with neither field is null`() {
        // Empty textDelta AND empty reasoningDelta → nothing to emit.
        assertNull(parse("""{"type":"modelContentBlockDeltaEvent","textDelta":""}"""))
    }

    @Test fun `tool start carries name and id`() {
        val e = parse("""{"type":"modelContentBlockStartEvent","toolStart":{"name":"search","toolUseId":"t1"}}""")
        assertEquals(ChatEvent.ToolStart("search", "t1"), e)
    }

    @Test fun `before tool call carries the input object`() {
        val e = parse("""{"type":"beforeToolCallEvent","toolCall":{"name":"weather","toolUseId":"t2","input":{"city":"Paris"}}}""")
        assertTrue(e is ChatEvent.BeforeToolCall)
        e as ChatEvent.BeforeToolCall
        assertEquals("weather", e.name)
        assertEquals("t2", e.toolUseId)
        assertEquals("Paris", e.input.getString("city"))
    }

    @Test fun `before tool call with no input gets an empty object, not null`() {
        val e = parse("""{"type":"beforeToolCallEvent","toolCall":{"name":"n","toolUseId":"t"}}""") as ChatEvent.BeforeToolCall
        assertEquals(0, e.input.length())
    }

    @Test fun `after tool call maps status and blanks error to null`() {
        val e = parse("""{"type":"afterToolCallEvent","toolResult":{"name":"n","toolUseId":"t","status":"success","error":""}}""") as ChatEvent.AfterToolCall
        assertEquals("success", e.status)
        assertNull("empty error string becomes null", e.error)
    }

    @Test fun `after tool call prefers a structured json content block`() {
        // spawn_agents batch result rides the first content block; a `json` object
        // is re-serialized to string (preferred over a sibling `text`).
        val e = parse(
            """{"type":"afterToolCallEvent","toolResult":{"name":"spawn_agents","toolUseId":"t",
               "content":[{"json":{"agents":2}}]}}"""
        ) as ChatEvent.AfterToolCall
        assertTrue("json block re-serialized", e.resultText!!.contains("agents"))
    }

    @Test fun `after tool call falls back to a text content block`() {
        val e = parse(
            """{"type":"afterToolCallEvent","toolResult":{"name":"n","toolUseId":"t","content":[{"text":"done"}]}}"""
        ) as ChatEvent.AfterToolCall
        assertEquals("done", e.resultText)
    }

    @Test fun `metadata maps model id and usage tokens`() {
        val e = parse(
            """{"type":"modelMetadataEvent","modelId":"claude-opus-4-8",
               "usage":{"inputTokens":100,"outputTokens":40,"cacheReadInputTokens":80}}"""
        ) as ChatEvent.Metadata
        assertEquals("claude-opus-4-8", e.modelId)
        assertEquals(100, e.inputTokens)
        assertEquals(40, e.outputTokens)
        assertEquals(80, e.cacheReadInputTokens)
    }

    @Test fun `metadata with no usage defaults tokens to zero`() {
        val e = parse("""{"type":"modelMetadataEvent","modelId":"gpt-5"}""") as ChatEvent.Metadata
        assertEquals(0, e.inputTokens)
        assertEquals(0, e.outputTokens)
        assertEquals(0, e.cacheReadInputTokens)
    }

    @Test fun `agent result carries the stop reason`() {
        val e = parse("""{"type":"agentResultEvent","stopReason":"end_turn"}""") as ChatEvent.Result
        assertEquals("end_turn", e.stopReason)
    }

    @Test fun `error frame carries the message`() {
        val e = parse("""{"type":"error","error":"boom"}""") as ChatEvent.Error
        assertEquals("boom", e.message)
    }
}

package technology.tiny.app.chat

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import technology.tiny.app.ui.SpawnNode
import technology.tiny.app.ui.SpawnTree

/**
 * MessageCodec is the transcript codec extracted from ChatViewModel — the ChatMessage
 * list ⇄ JSON-array-string form used BOTH by chat-history-<tiny>.json and by
 * SessionStore.messagesJson. A drift here would corrupt reloads and saved sessions,
 * so these pin the round-trip: durable fields survive, transient live-stream fields are
 * dropped, older-shape histories decode with defaults, and malformed input is empty
 * (never a crash). org.json is on the test classpath (cycle 117).
 */
class MessageCodecTest {

    private fun roundTrip(m: ChatMessage): ChatMessage =
        MessageCodec.decodeString(MessageCodec.encodeToString(listOf(m))).single()

    @Test fun `a plain user message round-trips id role text`() {
        val out = roundTrip(ChatMessage(id = "u1", role = "user", text = "hello"))
        assertEquals("u1", out.id)
        assertEquals("user", out.role)
        assertEquals("hello", out.text)
    }

    @Test fun `durable rich fields survive the round-trip`() {
        val m = ChatMessage(
            id = "a1", role = "assistant", text = "answer",
            reasoning = "because",
            uiCards = listOf(UiCard(title = "Chart", propsJson = """{"data":[1,2]}""")),
            spawns = listOf(SpawnTree(id = "t1", nodes = listOf(SpawnNode(id = 1, prompt = "go", ok = true, result = "done")), elapsedMs = 12.5)),
            inTok = 100, outTok = 40, cacheReadTok = 80,
            modelId = "claude-opus-4-8",
            failedPrompt = "retry me",
        )
        val out = roundTrip(m)
        assertEquals("because", out.reasoning)
        assertEquals(1, out.uiCards.size)
        assertEquals("Chart", out.uiCards[0].title)
        assertEquals("""{"data":[1,2]}""", out.uiCards[0].propsJson)
        assertEquals(1, out.spawns.size)
        assertEquals("t1", out.spawns[0].id)
        assertEquals(12.5, out.spawns[0].elapsedMs!!, 0.0001)
        assertEquals(1, out.spawns[0].nodes.size)
        assertEquals("go", out.spawns[0].nodes[0].prompt)
        assertEquals(true, out.spawns[0].nodes[0].ok)
        assertEquals("done", out.spawns[0].nodes[0].result)
        assertEquals(100, out.inTok)
        assertEquals(40, out.outTok)
        assertEquals(80, out.cacheReadTok)
        assertEquals("claude-opus-4-8", out.modelId)
        assertEquals("retry me", out.failedPrompt)
    }

    @Test fun `transient live-stream fields are NOT persisted`() {
        val m = ChatMessage(
            id = "s1", role = "assistant", text = "streaming",
            streaming = true, toolLabel = "searching",
        )
        val out = roundTrip(m)
        // These only mean something during a live stream — they reset to defaults on reload.
        assertTrue("streaming resets to false", !out.streaming)
        assertNull(out.toolLabel)
        // ...but the durable text still survives.
        assertEquals("streaming", out.text)
    }

    @Test fun `a speak-tool card survives the round-trip (not a vanished bubble)`() {
        // The 🔊 speak card rides on a transient tool event like paySettled, so without
        // persistence it VANISHES on reload while iOS (msg.speech) and web (m.speech)
        // both restore it. SpeechCard render is tap-to-play only, so a restored value
        // re-renders silently (no surprise audio on load).
        val m = ChatMessage(id = "sp1", role = "assistant", text = "here you go", speechText = "read aloud")
        assertEquals("read aloud", roundTrip(m).speechText)
    }

    @Test fun `a message with no speak card decodes with a null speechText`() {
        val out = MessageCodec.decodeString("""[{"id":"n","role":"assistant","text":"hi"}]""").single()
        assertNull(out.speechText)
        // The key isn't emitted when absent (keeps the history file lean).
        assertTrue(!MessageCodec.encodeToString(listOf(ChatMessage(role = "assistant", text = "x"))).contains("speechText"))
    }

    @Test fun `a running spawn node omits ok as null, not false`() {
        val m = ChatMessage(
            id = "r1", role = "assistant", text = "",
            spawns = listOf(SpawnTree(id = "t", nodes = listOf(SpawnNode(id = 1, prompt = "p", ok = null)))),
        )
        val out = roundTrip(m)
        // A still-running node must reload as running (null), never as failed (false).
        assertNull(out.spawns[0].nodes[0].ok)
    }

    @Test fun `zero token counts and null modelId are omitted and default back`() {
        val out = roundTrip(ChatMessage(id = "z", role = "note", text = "x"))
        assertEquals(0, out.inTok)
        assertEquals(0, out.outTok)
        assertEquals(0, out.cacheReadTok)
        assertNull(out.modelId)
        assertNull(out.failedPrompt)
    }

    @Test fun `an untagged ui card round-trips a null title`() {
        val m = ChatMessage(
            id = "c", role = "assistant", text = "",
            uiCards = listOf(UiCard(title = null, propsJson = "{}")),
        )
        assertNull(roundTrip(m).uiCards.single().title)
    }

    @Test fun `order is preserved across a multi-message transcript`() {
        val msgs = listOf(
            ChatMessage(id = "1", role = "user", text = "q1"),
            ChatMessage(id = "2", role = "assistant", text = "a1"),
            ChatMessage(id = "3", role = "user", text = "q2"),
        )
        val out = MessageCodec.decodeString(MessageCodec.encodeToString(msgs))
        assertEquals(listOf("1", "2", "3"), out.map { it.id })
        assertEquals(listOf("q1", "a1", "q2"), out.map { it.text })
    }

    @Test fun `an older-shape entry missing rich keys decodes with defaults`() {
        // A history written by a build that predated the rich fields: just id/role/text.
        val out = MessageCodec.decodeString("""[{"id":"old","role":"user","text":"hi"}]""").single()
        assertEquals("old", out.id)
        assertEquals("", out.reasoning)
        assertTrue(out.uiCards.isEmpty())
        assertTrue(out.spawns.isEmpty())
        assertEquals(0, out.inTok)
    }

    @Test fun `an entry with no id gets a generated one`() {
        val out = MessageCodec.decodeString("""[{"role":"user","text":"hi"}]""").single()
        assertTrue("a missing id is filled, not blank", out.id.isNotEmpty())
    }

    @Test fun `malformed json decodes to empty, never crashes`() {
        assertTrue(MessageCodec.decodeString("not json").isEmpty())
        assertTrue(MessageCodec.decodeString("").isEmpty())
        assertTrue(MessageCodec.decode(null).isEmpty())
    }

    @Test fun `a non-object array element is skipped`() {
        val out = MessageCodec.decode(JSONArray("""["just a string", {"id":"ok","role":"user","text":"t"}]"""))
        assertEquals(1, out.size)
        assertEquals("ok", out.single().id)
    }

    @Test fun `empty transcript encodes to an empty array`() {
        assertEquals("[]", MessageCodec.encodeToString(emptyList()))
    }

    @Test fun `sent-attachment thumbs and doc names survive the round-trip`() {
        val m = ChatMessage(
            id = "a1", role = "user", text = "look at this",
            thumbs = listOf("BASE64THUMB1", "BASE64THUMB2"),
            docNames = listOf("report.pdf"),
        )
        val out = roundTrip(m)
        assertEquals(listOf("BASE64THUMB1", "BASE64THUMB2"), out.thumbs)
        assertEquals(listOf("report.pdf"), out.docNames)
    }

    @Test fun `a message with no attachments omits the keys and defaults to empty`() {
        val out = MessageCodec.decodeString("""[{"id":"n","role":"user","text":"hi"}]""").single()
        assertTrue(out.thumbs.isEmpty())
        assertTrue(out.docNames.isEmpty())
        // The keys aren't emitted when empty (keeps the history file lean).
        assertTrue(!MessageCodec.encodeToString(listOf(ChatMessage(role = "user", text = "x"))).contains("thumbs"))
    }

    @Test fun `a 402 paywall bubble survives the round-trip (not a blank ghost)`() {
        // The paywall reply is empty-text by design; without persistence it would reload
        // as an empty assistant bubble. Price/balance/signedOut + the retry prompt survive.
        val m = ChatMessage(
            id = "p1", role = "assistant", text = "",
            paywall = technology.tiny.app.wallet.WalletCore.Paywall(50_000L, 10_000L, signedOut = false),
            paywallPrompt = "what's the weather?",
        )
        val out = roundTrip(m)
        assertEquals(50_000L, out.paywall?.priceMicro)
        assertEquals(10_000L, out.paywall?.balanceMicro)
        assertEquals(false, out.paywall?.signedOut)
        assertEquals("what's the weather?", out.paywallPrompt)
    }

    @Test fun `a signed-out paywall preserves the signedOut flag through storage`() {
        // signed_out is stored explicitly — the durable form always writes balance_micro,
        // so re-deriving it from body shape (parsePaywall) would wrongly yield false.
        val m = ChatMessage(
            id = "p2", role = "assistant", text = "",
            paywall = technology.tiny.app.wallet.WalletCore.Paywall(50_000L, 0L, signedOut = true),
            paywallPrompt = "hi",
        )
        assertEquals(true, roundTrip(m).paywall?.signedOut)
    }

    @Test fun `a non-paywall message decodes with a null paywall`() {
        val out = MessageCodec.decodeString("""[{"id":"n","role":"assistant","text":"hi"}]""").single()
        assertNull(out.paywall)
        assertNull(out.paywallPrompt)
    }

    @Test fun `a settled pay outcome round-trips all fields including the explorer link`() {
        // The durable codec previously dropped `explorer` — so a force-stop /
        // session restore reloaded the receipt without its "View on BaseScan"
        // on-chain proof link, though PaySettled documents it "survives cold
        // reload" and iOS/web both persist it. Pin the whole map round-trip.
        val m = ChatMessage(
            id = "pay1", role = "assistant", text = "",
            paySettled = mapOf(
                "tool1" to technology.tiny.app.wallet.WalletCore.PaySettled(
                    phase = "paid", paidMicro = 500_000L, network = "base",
                    payee = "0xabc", message = null,
                    explorer = "https://basescan.org/tx/0xdeadbeef",
                ),
            ),
        )
        val out = roundTrip(m).paySettled.getValue("tool1")
        assertEquals("paid", out.phase)
        assertEquals(500_000L, out.paidMicro)
        assertEquals("base", out.network)
        assertEquals("0xabc", out.payee)
        assertEquals("https://basescan.org/tx/0xdeadbeef", out.explorer)
    }
}

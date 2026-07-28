package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import technology.tiny.app.ui.SpawnNode
import technology.tiny.app.ui.SpawnTree

/**
 * Load-time reconcile of turns killed by process death mid-stream
 * (reconcileInterrupted — web reconcileInterruptedTools parity). send() persists
 * the user msg + empty assistant placeholder before the stream launches; if the
 * process dies, that placeholder must reload as an honest "interrupted" +
 * retryable turn, and NOTHING else may be touched.
 */
class ReconcileInterruptedTest {

    private fun user(text: String) = ChatMessage(role = "user", text = text)
    private fun assistant(text: String) = ChatMessage(role = "assistant", text = text)

    @Test fun `empty placeholder after a user message becomes interrupted and retryable`() {
        val out = reconcileInterrupted(listOf(user("what is rust?"), assistant("")))
        assertEquals(INTERRUPTED_MARKER, out[1].text)
        assertEquals("what is rust?", out[1].failedPrompt)
        // The paired user message itself is untouched.
        assertEquals("what is rust?", out[0].text)
        assertNull(out[0].failedPrompt)
    }

    @Test fun `completed and already-failed turns are left untouched`() {
        val done = listOf(user("hi"), assistant("hello!"))
        assertEquals(done, reconcileInterrupted(done))
        // A turn that already carries failedPrompt (errored while the process
        // survived) keeps its own marker — no double-marking.
        val failed = listOf(
            user("hi"),
            ChatMessage(role = "assistant", text = "", failedPrompt = "hi"),
        )
        assertEquals(failed, reconcileInterrupted(failed))
    }

    @Test fun `persisted rich content counts as an answer even with blank text`() {
        val withCard = listOf(
            user("show me a chart"),
            ChatMessage(role = "assistant", text = "", uiCards = listOf(UiCard("chart", "{}"))),
        )
        assertEquals(withCard, reconcileInterrupted(withCard))
        val withSpawns = listOf(
            user("fan out"),
            ChatMessage(
                role = "assistant", text = "",
                spawns = listOf(SpawnTree("t1", listOf(SpawnNode(1, "sub")))),
            ),
        )
        assertEquals(withSpawns, reconcileInterrupted(withSpawns))
        // reasoning is durable content MessageCodec persists (:28/:72), so a
        // completed reply that streamed only a thinking trace (blank text) is a
        // real answer, not an orphan — iOS guards this too (Views.swift:634).
        val withReasoning = listOf(
            user("think about it"),
            ChatMessage(role = "assistant", text = "", reasoning = "let me reason through this…"),
        )
        assertEquals(withReasoning, reconcileInterrupted(withReasoning))
    }

    @Test fun `empty assistant not directly after a user message is left alone`() {
        // No paired prompt to retry — e.g. preceded by a note (or nothing).
        val noteFirst = listOf(
            ChatMessage(role = "note", text = "📴 offline"),
            assistant(""),
        )
        assertEquals(noteFirst, reconcileInterrupted(noteFirst))
        val headOfList = listOf(assistant(""))
        assertEquals(headOfList, reconcileInterrupted(headOfList))
    }

    @Test fun `concurrent orphans each retry their own prompt`() {
        // Two sends in flight when the process died: user,a,user,a at the tail.
        val out = reconcileInterrupted(
            listOf(user("first?"), assistant(""), user("second?"), assistant("")),
        )
        assertEquals("first?", out[1].failedPrompt)
        assertEquals("second?", out[3].failedPrompt)
        assertEquals(INTERRUPTED_MARKER, out[1].text)
        assertEquals(INTERRUPTED_MARKER, out[3].text)
    }

    @Test fun `a 402 paywall bubble is empty by design and is NOT reconciled as an orphan`() {
        // A paywall reply has blank text + no uiCards/spawns and follows a user turn —
        // structurally identical to an interrupted orphan. The paywall guard keeps it as
        // the actionable card (its own Retry re-sends), never a "⚠️ interrupted" rewrite.
        val paywall = ChatMessage(
            role = "assistant", text = "",
            paywall = technology.tiny.app.wallet.WalletCore.Paywall(50_000L, 0L, signedOut = false),
            paywallPrompt = "hi",
        )
        val input = listOf(user("hi"), paywall)
        val out = reconcileInterrupted(input)
        assertEquals(input, out) // untouched — no marker, no failedPrompt
        assertNull(out[1].failedPrompt)
        assertEquals("", out[1].text)
    }
}

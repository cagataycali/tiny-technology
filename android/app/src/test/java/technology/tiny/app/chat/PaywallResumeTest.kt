package technology.tiny.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * signedOutPaywallResumeId — the pure decision behind the signed-out paywall
 * auto-continue (ChatViewModel init observer). A 402 that says "Sign in" leaves a
 * held turn on screen; once the user logs in, iOS re-sends that turn automatically
 * (Views.swift:3383 `chat.retry(msg)`) and web reloads into an authed page
 * (Chat.tsx:3499). This selector picks WHICH held card to resume; the observer
 * fires it on the auth null→present edge.
 */
class PaywallResumeTest {

    private fun signedOut(prompt: String?) = technology.tiny.app.wallet.WalletCore.Paywall(
        priceMicro = 50_000, balanceMicro = 0, signedOut = true,
    ).let { pw -> ChatMessage(role = "assistant", text = "", paywall = pw, paywallPrompt = prompt) }

    private fun funded(prompt: String?) = technology.tiny.app.wallet.WalletCore.Paywall(
        priceMicro = 50_000, balanceMicro = 10_000, signedOut = false,
    ).let { pw -> ChatMessage(role = "assistant", text = "", paywall = pw, paywallPrompt = prompt) }

    @Test fun `picks a signed-out paywall carrying a resumable prompt`() {
        val held = signedOut("what is the meaning of life?")
        assertEquals(held.id, signedOutPaywallResumeId(listOf(held)))
    }

    @Test fun `no messages means nothing to resume`() {
        assertNull(signedOutPaywallResumeId(emptyList()))
    }

    @Test fun `a funded-but-short paywall is NOT resumed by signing in`() {
        // Its blocker is balance, not auth — logging in doesn't unblock it.
        assertNull(signedOutPaywallResumeId(listOf(funded("hello"))))
    }

    @Test fun `a signed-out card with no prompt has nothing to re-send`() {
        assertNull(signedOutPaywallResumeId(listOf(signedOut(null))))
        assertNull(signedOutPaywallResumeId(listOf(signedOut(""))))
    }

    @Test fun `a plain assistant or user message is never a resume target`() {
        val user = ChatMessage(role = "user", text = "hi")
        val assistant = ChatMessage(role = "assistant", text = "hello there")
        assertNull(signedOutPaywallResumeId(listOf(user, assistant)))
    }

    @Test fun `the LAST signed-out card wins when several are held`() {
        // The most recent blocked turn is the one the user is looking at.
        val first = signedOut("first blocked turn")
        val second = signedOut("second blocked turn")
        assertEquals(second.id, signedOutPaywallResumeId(listOf(first, second)))
    }

    @Test fun `a funded card after a signed-out card does not shadow the resumable one`() {
        // lastOrNull filters on the predicate, so a trailing funded card is skipped
        // and the signed-out card before it is still selected.
        val held = signedOut("resume me")
        val laterFunded = funded("balance-blocked, unrelated")
        assertEquals(held.id, signedOutPaywallResumeId(listOf(held, laterFunded)))
    }
}

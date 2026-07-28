package technology.tiny.app.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ModelConfigStore.buildHeaders is the pure BYO-model header builder extracted
 * from headers() — the security-critical decision that decides whether (and how)
 * a user's own API key rides the chat request. Runs on the local JVM (org.json is
 * on the test classpath). Mirrors web modelConfigHeaders(); the guards here stop a
 * key from leaking to the wrong origin, so they're worth pinning hard.
 */
class ModelConfigStoreTest {

    private fun build(
        provider: String = "openai",
        apiKey: String = "sk-abc",
        modelId: String = "",
        baseUrl: String = "",
        maxTokens: String = "",
        region: String = "us-west-2",
        additionalFields: String = "",
    ) = ModelConfigStore.buildHeaders(provider, apiKey, modelId, baseUrl, maxTokens, region, additionalFields)

    @Test fun `default tier emits no headers`() {
        assertTrue(build(provider = "default", apiKey = "sk-abc").isEmpty())
    }

    @Test fun `a provider with no key emits nothing`() {
        // Never send x-tiny-model-provider without the key — the server would just
        // reject it, and it signals intent to override without the means.
        assertTrue(build(provider = "openai", apiKey = "").isEmpty())
    }

    @Test fun `custom provider with no base url emits nothing (key-leak guard)`() {
        // The critical guard: a custom provider + key but NO base url would send the
        // key to OpenAI's default endpoint server-side → wrong origin. Emit nothing.
        assertTrue(build(provider = "custom", apiKey = "sk-secret", baseUrl = "").isEmpty())
    }

    @Test fun `custom provider with a base url emits the key and that base`() {
        val h = build(provider = "custom", apiKey = "sk-secret", baseUrl = "https://llm.example/v1")
        assertEquals("custom", h["x-tiny-model-provider"])
        assertEquals("sk-secret", h["x-tiny-model-api-key"])
        assertEquals("https://llm.example/v1", h["x-tiny-model-base-url"])
    }

    @Test fun `a preset provider resolves its base url when none is given`() {
        // anthropic preset carries a base url — it should fill in automatically.
        val h = build(provider = "anthropic", apiKey = "sk-ant-x")
        assertEquals("https://api.anthropic.com/v1/", h["x-tiny-model-base-url"])
    }

    @Test fun `an explicit base url overrides the preset`() {
        val h = build(provider = "anthropic", apiKey = "sk-ant-x", baseUrl = "https://proxy.example/v1")
        assertEquals("https://proxy.example/v1", h["x-tiny-model-base-url"])
    }

    @Test fun `region rides only for bedrock`() {
        assertEquals("us-east-1", build(provider = "bedrock", apiKey = "k", region = "us-east-1")["x-tiny-model-region"])
        // A non-bedrock provider never sends region even if one is set.
        assertNull(build(provider = "openai", apiKey = "k", region = "us-east-1")["x-tiny-model-region"])
    }

    @Test fun `optional model id and max tokens ride only when set`() {
        val bare = build(provider = "openai", apiKey = "k")
        assertNull(bare["x-tiny-model-id"])
        assertNull(bare["x-tiny-model-max-tokens"])
        val full = build(provider = "openai", apiKey = "k", modelId = "gpt-5", maxTokens = "4096")
        assertEquals("gpt-5", full["x-tiny-model-id"])
        assertEquals("4096", full["x-tiny-model-max-tokens"])
    }

    @Test fun `valid additional-fields json is re-serialized single-line`() {
        val h = build(provider = "openai", apiKey = "k", additionalFields = "{\n  \"reasoning_effort\": \"high\"\n}")
        val out = h["x-tiny-model-additional-fields"]!!
        assertTrue("re-serialized value carries the field", out.contains("reasoning_effort"))
        assertTrue("HTTP header must be single-line", !out.contains("\n"))
    }

    @Test fun `malformed or empty additional-fields is dropped`() {
        assertNull(build(provider = "openai", apiKey = "k", additionalFields = "not json")["x-tiny-model-additional-fields"])
        // An empty JSON object is not worth a header either (obj.length() == 0).
        assertNull(build(provider = "openai", apiKey = "k", additionalFields = "{}")["x-tiny-model-additional-fields"])
        assertNull(build(provider = "openai", apiKey = "k", additionalFields = "   ")["x-tiny-model-additional-fields"])
    }

    // ── buildVoiceHeaders — voice is OpenAI-ONLY, dedicated key wins over chat ──

    private fun voice(
        voiceKey: String = "",
        chatProvider: String = "default",
        chatKey: String = "",
        chatModelId: String = "",
    ) = ModelConfigStore.buildVoiceHeaders(voiceKey, chatProvider, chatKey, chatModelId)

    @Test fun `voice needs a key — none set emits nothing`() {
        assertTrue(voice().isEmpty())
        // A Bedrock chat key must NOT drive voice (server gates on provider === openai).
        assertTrue(voice(chatProvider = "bedrock", chatKey = "bedrock-key").isEmpty())
        assertTrue(voice(chatProvider = "anthropic", chatKey = "sk-ant-x").isEmpty())
    }

    @Test fun `dedicated voice key always emits an openai provider`() {
        val h = voice(voiceKey = "sk-voice", chatProvider = "bedrock", chatKey = "bedrock-key")
        assertEquals("openai", h["x-tiny-model-provider"])
        assertEquals("sk-voice", h["x-tiny-model-api-key"])
        // The Bedrock chat key never leaks into the voice request.
        assertTrue(h.values.none { it == "bedrock-key" })
    }

    @Test fun `dedicated voice key wins over an openai chat key`() {
        val h = voice(voiceKey = "sk-voice", chatProvider = "openai", chatKey = "sk-chat")
        assertEquals("sk-voice", h["x-tiny-model-api-key"])
    }

    @Test fun `chat openai key is reused when no dedicated voice key`() {
        val h = voice(voiceKey = "", chatProvider = "openai", chatKey = "sk-chat")
        assertEquals("openai", h["x-tiny-model-provider"])
        assertEquals("sk-chat", h["x-tiny-model-api-key"])
    }

    @Test fun `realtime chat model id passes through on the reuse path only`() {
        // Reuse path + realtime id → carried.
        assertEquals(
            "gpt-realtime-2.1",
            voice(chatProvider = "openai", chatKey = "k", chatModelId = "gpt-realtime-2.1")["x-tiny-model-id"],
        )
        // Non-realtime chat id → dropped (DO default realtime model is right).
        assertNull(voice(chatProvider = "openai", chatKey = "k", chatModelId = "gpt-5-mini")["x-tiny-model-id"])
        // Dedicated-key path leaves model to the DO default even if chat had a realtime id.
        assertNull(
            voice(voiceKey = "sk-voice", chatProvider = "openai", chatKey = "k", chatModelId = "gpt-realtime-2.1")["x-tiny-model-id"],
        )
    }

    @Test fun `whitespace-only voice key falls through to chat`() {
        val h = voice(voiceKey = "   ", chatProvider = "openai", chatKey = "sk-chat")
        assertEquals("sk-chat", h["x-tiny-model-api-key"])
    }
}

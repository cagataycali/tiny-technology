package technology.tiny.app.chat

// Web Chat.tsx:2378 (hero) / :2382 (logo) — https only, and none of whitespace /
// quotes / backslash / angle brackets (the worker validates on write; re-check at
// render anyway). Regex is character-for-character identical to web + iOS
// (Views.swift:400 heroURL(from:)).
private val HERO_URL = Regex("""^https://[^\s"'\\<>]+$""")

/**
 * Per-tiny hero banner URL validation — web Chat.tsx:2378/:2382 parity. The owner sets
 * a "Twitter banner" style https image URL on their tiny; /api/tiny returns it as
 * a top-level `hero` string (sibling of `theme`, absent on not-exists/error
 * fallbacks). Pure Kotlin (no android.* deps) so it unit-tests on the local JVM.
 *
 * @return the URL as given when valid, null otherwise (missing, blank, non-https,
 *   or containing a forbidden character) — null means "no banner".
 */
fun validHeroUrl(raw: String?): String? =
    raw?.takeIf { HERO_URL.matches(it) }

/**
 * Turn-zero landing tagline — web Chat.tsx:2472-2478 parity, exact copy. The web
 * has a third `unclaimed` variant ("Nobody has claimed … yet"), but that flag only
 * exists on the not-found route (app/not-found.tsx); the Android app always talks
 * to a resolved tiny, so it's out of reach here. Note: the /api/tiny `hook` field
 * is NOT the tagline — web only edits it in Control.tsx; the hero derives its copy
 * purely from the name. Pure Kotlin so it unit-tests on the local JVM.
 */
fun landingTagline(name: String): String =
    if (name == "tiny") "Create your own AI by chatting — free, forever."
    else "A tiny — a living AI at tiny.technology/$name. Say anything."

/**
 * Per-tiny custom landing subtitle — /api/tiny top-level `tagline` string. When
 * the owner sets one (e.g. "Yerli ve açık kaynaklı robotik çözümler
 * geliştiriyoruz.") it replaces the generic [landingTagline] line under the
 * tiny's name. Contract mirrors the worker's normalizeTagline: control chars
 * stripped, trimmed, ≤200 chars; blank/oversized → null = fall back to the
 * generic line. Pure Kotlin (JVM-testable).
 */
fun validTagline(raw: String?): String? {
    val s = raw?.replace(Regex("[\\u0000-\\u001F\\u007F]"), "")?.trim() ?: return null
    return s.takeIf { it.isNotEmpty() && it.length <= 200 }
}

/**
 * Turn-zero starter chips — web Chat.tsx:2486-2500 parity (recognition over
 * recall: chips beat a blank box). A chip ending in "…" prefills the composer
 * (web strips the ellipsis and focuses); any other chip sends immediately.
 */
// Pattern names the vibrate device tool understands (DeviceTools.kt `vibrate`:
// unknown names fall back to "tap" there, but the intro vibe treats an unknown
// name as "not set" — a typo'd server value should stay silent, not tap).
private val INTRO_VIBES = setOf(
    "tap", "double", "success", "warning", "error",
    "heartbeat", "sos", "long", "escalate", "wave",
)

/**
 * Per-tiny intro-vibration pattern — /api/tiny top-level `intro_vibe` string.
 * Valid only when it names a pattern the vibrate tool implements; anything else
 * (missing, blank, unknown) → null = no intro haptic. Pure Kotlin (JVM-testable).
 */
fun validIntroVibe(raw: String?): String? =
    raw?.trim()?.lowercase()?.takeIf { it in INTRO_VIBES }

/**
 * Per-tiny custom starter chips — /api/tiny top-level `chips` array. Contract:
 * 1-4 strings, each ≤60 chars after trimming. Blank entries are dropped; a list
 * that then violates the contract (empty, >4 chips, or any chip >60 chars) is
 * rejected WHOLE (null → the [landingChips] defaults), never partially shown.
 * Pure Kotlin (JVM-testable).
 */
fun validCustomChips(raw: List<String>?): List<String>? {
    val chips = raw?.map { it.trim() }?.filter { it.isNotEmpty() } ?: return null
    if (chips.isEmpty() || chips.size > 4 || chips.any { it.length > 60 }) return null
    return chips
}

// The landing-logo media picker keys off the URL PATH extension — query string
// and fragment are ignored, case-insensitive.
private fun logoPath(url: String): String =
    url.substringBefore('?').substringBefore('#').lowercase()

/**
 * True when a landing-logo URL should render through VideoView (.mp4/.webm)
 * instead of Coil. Extension sniffing is best-effort: an extensionless video
 * URL falls through to the image branch and silently draws nothing.
 */
fun isVideoLogo(url: String): Boolean =
    logoPath(url).let { it.endsWith(".mp4") || it.endsWith(".webm") }

/**
 * True when a landing-logo URL looks like a GIF — routes it through the
 * animated-capable Coil ImageDecoder loader so it plays instead of freezing on
 * frame one. Non-.gif URLs use the default loader (a mislabeled animated file
 * degrades to its first frame, never errors).
 */
fun isGifLogo(url: String): Boolean =
    logoPath(url).endsWith(".gif")

/**
 * True when a landing-logo URL is an SVG — routes it through Coil's SvgDecoder
 * loader. The worker's upsert explicitly allows svg logos and web renders them
 * natively in <img>; without this branch Coil's bitmap decoders error out and
 * the logo silently hides (hashtagrobotics' favicon.svg, seen live on device).
 */
fun isSvgLogo(url: String): Boolean =
    logoPath(url).endsWith(".svg")

fun landingChips(name: String): List<String> =
    if (name == "tiny") listOf(
        "Create an AI named …",
        "What is this place?",
        "Show me what a tiny can do",
    ) else listOf(
        "What can you do?",
        "Who made you?",
        "Surprise me",
    )

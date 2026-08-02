package technology.tiny.app.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Brand tokens from tiny.technology: ONE accent + neutral gray ramp, black bg.
val TinyAccent = Color(0xFF00FF88)
val TinyBg = Color(0xFF000000)
val TinyCore = Color(0xFF020604)
val TinySurface = Color(0xFF0A0F0C)
// Raised chrome (banners, speech cards, menu highlights). Was TinyCore, which is
// ~1% luminance over the black page — surfaces painted with it were invisible.
val TinySurfaceHigh = Color(0xFF121814)
// Mid-step of the opaque surface ramp (menus, sheet containers).
val TinySurfaceMid = Color(0xFF0D120F)
// Code cards / tool-code insets: TRANSLUCENT black (web's rgba(0,0,0,.45),
// Chat.tsx prism bg) so code reads darker than whatever surface it sits on.
// The old opaque green-dark hex inverted that (lighter than the bubble) and
// clashes on per-tiny theme.bg surfaces now that cycle 4 plumbed them.
val TinyCodeBg = Color.Black.copy(alpha = 0.45f)
val TinyGray = Color(0xFF8A8F8C)
val TinyDanger = Color(0xFFFF4D4D)
/**
 * Warning amber — iOS's `.orange`, for a signal that is not an error but that
 * you shouldn't read at face value either: a mismatched chain id, a clamped
 * amount, a camera that answered "busy". [TinyDanger] over-states all three.
 *
 * Lived in Chain.kt as a private val marked "local to this screen on purpose"
 * until a second screen needed it (RelayCameraPanel's failure reason). One hex
 * in two files is how two ambers drift apart.
 */
val TinyWarn = Color(0xFFFFB020)
val TinyText = Color(0xFFE6EAE8)
val TinyOutline = Color(0xFF242B27)

private val TinyColors = darkColorScheme(
    primary = TinyAccent,
    onPrimary = TinyBg,
    background = TinyBg,
    onBackground = TinyText,
    surface = TinySurface,
    onSurface = TinyText,
    surfaceVariant = TinySurfaceHigh,
    onSurfaceVariant = TinyGray,
    error = TinyDanger,
    secondary = TinyGray,
    onSecondary = TinyBg,
    outline = TinyOutline,
    outlineVariant = Color(0xFF171D19),
    // Sheets, dialogs, and menus pull from this ramp; unset, they fall back to
    // Material's purple-tinted dark neutrals, which clash on our pure black.
    surfaceContainerLowest = TinyCore,
    surfaceContainerLow = TinySurface,
    surfaceContainer = TinySurfaceMid,
    surfaceContainerHigh = TinySurfaceHigh,
    surfaceContainerHighest = Color(0xFF171D19),
)

// Voice rules (web + iOS parity): prose is SANS — web chat body is 16px system
// sans (Chat.tsx text-base) and iOS is 17pt SF. Mono is the ACCENT voice,
// reserved for code, slugs, and metadata (web's font-mono usage; iOS SF Mono).
// The old all-mono theme misread "brand is mono": BerkeleyMono is dead code on
// web (globals.css @font-face commented out) and was never the body face.
// All 15 styles are set so nothing falls back to raw Roboto Material defaults
// (that fallback leaked off-scale sans into dialogs, labels, and settings).
val TinyTypography = Typography(
    displayLarge = TextStyle(fontSize = 52.sp, lineHeight = 58.sp, fontWeight = FontWeight.Bold),
    displayMedium = TextStyle(fontSize = 44.sp, lineHeight = 50.sp, fontWeight = FontWeight.Bold),
    // Landing hero: the tiny's name (web text-4xl bold, iOS 40pt bold).
    displaySmall = TextStyle(fontSize = 40.sp, lineHeight = 46.sp, fontWeight = FontWeight.Bold),
    headlineLarge = TextStyle(fontSize = 30.sp, lineHeight = 38.sp, fontWeight = FontWeight.Bold),
    // Onboarding page titles.
    headlineMedium = TextStyle(fontSize = 26.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold),
    // AlertDialog titles inherit this.
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    // Markdown h1 / h2 / h3 map to titleLarge / titleMedium / titleSmall
    // (web: 20px bold / 18px bold / 16px semibold).
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold),
    titleMedium = TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    // Chat body (web 16px/1.5).
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
    // Buttons and chips.
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    // The metadata voice — mono ON PURPOSE (web's 10px font-mono token tags):
    // token/cost tags, status strips, code-card headers, "via" tags, slugs.
    labelSmall = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 16.sp),
)

// Code-block body (web prism at 14px, iOS 13pt SF Mono).
val TinyCodeStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 19.sp)

// One radius language (web: bubbles/composer 16, cards 12, buttons 8, chips
// pill). M3 draws text fields from extraSmall and chips from small — both 12
// here so stock components land on the card radius instead of M3's 4/8dp.
private val TinyShapes = Shapes(
    extraSmall = RoundedCornerShape(12.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun TinyTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = TinyColors,
        typography = TinyTypography,
        shapes = TinyShapes,
        content = content,
    )
}

/**
 * Per-tiny theme override (web `--tiny-accent`/`--tiny-bg` CSS-var parity: the
 * owner's theme re-tints ~all chrome). Everything below reading
 * colorScheme.primary — bubbles, badges, chips, send button, markdown links —
 * follows the visited tiny's accent instead of staying brand green; a non-null
 * [bg] swaps the page color and re-derives the surface/outline ramp as slight
 * lightenings of it (web gets this for free — its surfaces are translucent
 * black over --tiny-bg). onPrimary/onSurface stay black/light: themes are
 * validated dark-bg + bright-accent pairs, the same contrast assumption web
 * makes rendering black text on the accent fill.
 */
@Composable
fun TinyAccentTheme(accent: Color, bg: Color? = null, content: @Composable () -> Unit) {
    val base = MaterialTheme.colorScheme
    // Black text on bright accents (the brand default), white on dark ones —
    // web hardcodes black and gets unreadable bubbles on e.g. a #2563EB
    // accent (hashtagrobotics); luminance-aware on-colors exceed it.
    val onAccent = if (accent.luminance() > 0.4f) Color.Black else Color.White
    val scheme = if (bg == null || bg == TinyBg) {
        base.copy(primary = accent, onPrimary = onAccent)
    } else {
        // Owners can set LIGHT backgrounds too — derive the ramp toward black
        // and flip the foregrounds, or light-on-light is unreadable (web has
        // exactly that bug: text-white over a light --tiny-bg).
        val lightBg = bg.luminance() > 0.5f
        val towards = if (lightBg) Color.Black else Color.White
        val fg = if (lightBg) Color(0xFF141816) else TinyText
        val dim = if (lightBg) Color(0xFF4A524E) else TinyGray
        base.copy(
            primary = accent,
            onPrimary = onAccent,
            background = bg,
            onBackground = fg,
            surface = lerp(bg, towards, 0.045f),
            onSurface = fg,
            surfaceVariant = lerp(bg, towards, 0.09f),
            onSurfaceVariant = dim,
            surfaceContainerLowest = if (lightBg) lerp(bg, Color.White, 0.5f) else lerp(bg, Color.Black, 0.3f),
            surfaceContainerLow = lerp(bg, towards, 0.045f),
            surfaceContainer = lerp(bg, towards, 0.06f),
            surfaceContainerHigh = lerp(bg, towards, 0.09f),
            surfaceContainerHighest = lerp(bg, towards, 0.12f),
            outline = lerp(bg, towards, 0.16f),
            outlineVariant = lerp(bg, towards, 0.10f),
        )
    }
    MaterialTheme(
        colorScheme = scheme,
        typography = MaterialTheme.typography,
        shapes = MaterialTheme.shapes,
        content = content,
    )
}

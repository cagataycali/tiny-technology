package technology.tiny.app.ui

/**
 * agi-diy DARK_MAP_STYLES (docs/map.js:9-27), verbatim — shared by the
 * full-screen MapSheet and the ambient MapBackdrop so the two surfaces can
 * never drift apart in tone.
 */
internal const val TINY_MAP_DARK_STYLE = """[
  {"featureType":"all","elementType":"labels.text.fill","stylers":[{"saturation":36},{"color":"#000000"},{"lightness":40}]},
  {"featureType":"all","elementType":"labels.text.stroke","stylers":[{"visibility":"on"},{"color":"#000000"},{"lightness":16}]},
  {"featureType":"all","elementType":"labels.icon","stylers":[{"visibility":"off"}]},
  {"featureType":"administrative","elementType":"geometry.fill","stylers":[{"color":"#000000"},{"lightness":20}]},
  {"featureType":"administrative","elementType":"geometry.stroke","stylers":[{"color":"#000000"},{"lightness":17},{"weight":1.2}]},
  {"featureType":"administrative.locality","elementType":"all","stylers":[{"visibility":"on"}]},
  {"featureType":"administrative.neighborhood","elementType":"all","stylers":[{"visibility":"off"}]},
  {"featureType":"landscape","elementType":"geometry","stylers":[{"color":"#000000"},{"lightness":20}]},
  {"featureType":"poi","elementType":"geometry","stylers":[{"color":"#000000"},{"lightness":21}]},
  {"featureType":"road.highway","elementType":"all","stylers":[{"visibility":"simplified"}]},
  {"featureType":"road.highway","elementType":"geometry.fill","stylers":[{"color":"#000000"},{"lightness":17}]},
  {"featureType":"road.highway","elementType":"geometry.stroke","stylers":[{"color":"#000000"},{"lightness":29},{"weight":0.2}]},
  {"featureType":"road.highway","elementType":"labels","stylers":[{"visibility":"off"}]},
  {"featureType":"road.arterial","elementType":"geometry","stylers":[{"color":"#000000"},{"lightness":18}]},
  {"featureType":"road.local","elementType":"geometry","stylers":[{"color":"#000000"},{"lightness":16}]},
  {"featureType":"transit","elementType":"geometry","stylers":[{"color":"#000000"},{"lightness":19}]},
  {"featureType":"water","elementType":"geometry","stylers":[{"color":"#000000"},{"lightness":17}]}
]"""

/**
 * The ambient grade, Android edition (web gradeTintCss / iOS ambientGradeTint
 * parity): the map renders on a SurfaceView, so a Compose multiply overlay
 * can't blend with it — instead the multiply is BAKED INTO the style JSON.
 * Each `{"color":"#000000"},{"lightness":N}` pair becomes one explicit color:
 * gray(N%) multiplied per-channel by a tint leaned toward the tiny's accent,
 * so every tiny's ambient map glows its own color. Pure string→string.
 */
internal fun gradedMapStyle(
    accentR: Int,
    accentG: Int,
    accentB: Int,
    base: Double = 0.78,
    lean: Double = 0.30,
): String {
    val tintR = base * 255 * (1 - lean) + accentR.coerceIn(0, 255) * lean
    val tintG = base * 255 * (1 - lean) + accentG.coerceIn(0, 255) * lean
    val tintB = base * 255 * (1 - lean) + accentB.coerceIn(0, 255) * lean
    val pair = Regex("""\{"color":"#000000"\},\{"lightness":(\d+)\}""")
    return pair.replace(TINY_MAP_DARK_STYLE) { m ->
        val gray = (m.groupValues[1].toInt().coerceIn(0, 100) / 100.0) * 255
        val r = (gray * tintR / 255).toInt().coerceIn(0, 255)
        val g = (gray * tintG / 255).toInt().coerceIn(0, 255)
        val b = (gray * tintB / 255).toInt().coerceIn(0, 255)
        """{"color":"#%02x%02x%02x"}""".format(r, g, b)
    }
}

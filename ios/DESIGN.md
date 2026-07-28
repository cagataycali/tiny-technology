# tiny iOS — design language

One system, five surfaces (chat, widgets, watch, complications, Siri). The
rules that keep it reading as one thing:

## Iconography
- **Chrome speaks SF Symbols** — toolbars, nav titles, buttons, menu rows.
  Constants live in `TinyDesign` (Theme.swift); never inline emoji in chrome.
- **Emoji is content personality** — the mark, empty states, message text,
  notification titles. It's the voice, not the furniture.

## Color
- The tiny's **accent** (`Environment(\.tinyAccent)`, fed by the tiny's web
  theme) is the only brand color. Green is its default, not the brand.
- Accent usage: interactive affordances, presence dots, unread badges,
  chart marks, card hairlines. Never body text.

## Surfaces
- Cards share `.tinyCard()`: 14pt radius, `secondarySystemBackground`,
  accent hairline at 15%. Speech cards, charts, doc chips, relay rows —
  same chrome everywhere.
- Bubbles: 18pt radius; user = accent 22%, assistant = secondary background.

## Motion & gesture
- **Edge swipes mirror the toolbar**: left edge → Universe, right edge →
  Messages. A soft haptic (`TinyDesign.haptic()`) marks every gesture-open.
- Pulse animations gate on Reduce Motion. Nothing moves that doesn't mean
  something.

## Type
- System fonts only. Rounded design reserved for the wordmark moments
  (login, onboarding). Dynamic Type everywhere — labels scale, layouts flex.

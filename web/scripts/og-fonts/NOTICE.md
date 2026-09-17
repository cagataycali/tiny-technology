# Fonts vendored for OG card generation

`scripts/gen-og-cards.mjs` renders the share cards in WebKit, so the type has to
come from a font file the script can `@font-face` — not from a family name that
happens to be installed. Vendoring them is what makes a regenerated card
byte-comparable on a different machine; resolving "Roboto" through the system
would silently substitute Helvetica on this laptop and DejaVu on a CI runner, and
every card would change without a single line of the script changing.

These are the same faces Material for MkDocs loads for the site itself, so the
card and the page it links to are set in one typeface.

| File | Source | License |
|---|---|---|
| `Roboto-Regular.ttf` | [googlefonts/roboto-2](https://github.com/googlefonts/roboto-2) `src/hinted` | Apache-2.0 |
| `Roboto-Bold.ttf` | [googlefonts/roboto-2](https://github.com/googlefonts/roboto-2) `src/hinted` | Apache-2.0 |
| `RobotoMono-Regular.ttf` | [googlefonts/RobotoMono](https://github.com/googlefonts/RobotoMono) `fonts/ttf` | Apache-2.0 |

Apache-2.0 requires the notice above be kept with the files. It does not require
attribution in the rendered cards.

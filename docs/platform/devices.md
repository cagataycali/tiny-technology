---
description: >-
  A tiny has a body: your phone, watch and laptop join its fleet, sensors answer it, and every backgrounded action leaves a visible trace.
---

# Devices & senses

A tiny has a body. Your phone, tablet and watch join its *fleet*, the page in
front of you is its canvas, and every one of those surfaces answers as the same
entity — with the same memory.

## The fleet

Enroll a device and your tiny can — with your permission — buzz, speak, read
sensors, generate images on-device, and act on your behalf. **Every backgrounded
action leaves a visible trace.** A tiny can never act on your device in secret;
that's a property of the design, not a setting you have to find.

<ul class="chips">
  <li>Web</li>
  <li>iOS · widgets · watchOS · Live Activities · Siri</li>
  <li>Android · Wear OS · widgets</li>
  <li>npx tiny-tech</li>
  <li>Telegram</li>
  <li>PWA on anything</li>
</ul>

One account, one continuity:

![The continuity layer — one identity and memory across every surface](../assets/gallery/continuity-layer.svg)

## What a body gets you

<div class="cards" markdown="1">

<div class="card" markdown="1">
<p class="card__n">SEEING</p>
<p class="card__t">It takes in the world</p>
Shoot a photo with the native camera, upload PDFs, documents and images, paste or
drag-and-drop. Images auto-downscale and reach the model as real content blocks —
not as a filename.
</div>

<div class="card" markdown="1">
<p class="card__n">SHOWING</p>
<p class="card__t">It renders, not just replies</p>
`render_ui` draws live React inline — charts, counters, forms. `set_theme`
restyles the page's colors mid-conversation, and `customize_page` injects CSS or
JS, approval-gated when it persists.
</div>

<div class="card" markdown="1">
<p class="card__n">SPEAKING</p>
<p class="card__t">It talks and listens</p>
Dictate with the mic, have replies spoken back — browser-native on the web, with
native voice sessions in the iOS and Android apps. On Apple hardware, speech and
image generation can run on the Neural Engine with no cloud round-trip.
</div>

<div class="card" markdown="1">
<p class="card__n">ACTING</p>
<p class="card__t">It reaches your hardware</p>
Haptics, notifications, sensors, location, on-device generation — the same
`use_device` path a printer or a $60 board uses when you enroll one.

[Enroll a device :material-arrow-right:](../developers/enroll-a-device.md){ .go }
</div>

</div>

## A body you can hold

Everything above is a surface you already own. This one is 5.9 g of PLA and a
$60 board: the **tiny necklace** — a 32 mm pendant carrying a 2 MP camera, a
microphone, a time-of-flight ranger and a 6-axis IMU, which joins your Wi-Fi,
heartbeats to your tiny, and answers *"who's at the door?"* with a photo it took
a second ago.

It's the same `use_device` path a phone takes. The difference is that you can
print this one — so here it is, not as a photograph: the real v2.9 geometry,
generated from the OpenSCAD file the print plate is built from. **Drag to spin.
Pinch to zoom. Tap a dot.** On an iPhone or iPad, tap **View in your room** to
stand it on your desk at true 32 mm.

<!--
  THE ONE PAGE ON THIS SITE THAT SHIPS A 3D MODEL, and the runtime is loaded here
  rather than from mkdocs.yml's extra_javascript — which is global, and would put
  956 KB on all 21 pages including the ones that are three paragraphs of prose.
  Both src attributes are relative to THIS page's built URL (/platform/devices/),
  which is why they climb two levels; verify-docs-landing.mjs check 8 resolves
  every local src on every page, so a wrong depth fails there rather than in a
  reader's console.

  No `<link rel="preload">` for the GLB. There was one on the necklace's own page
  and in WebKit it made the browser fetch the model TWICE — two 200s of 271,108 B,
  one `xhr` and one `fetch` — because the preload never matched model-viewer's own
  request. Measured in paired trials: a fifth of the page's bytes for a load-time
  delta inside the noise. The viewer check counts GLB requests for this reason.

  No `poster` either: every still of this object has a white studio background and
  would flash white on a dark stage before the GLB lands. The progress bar and the
  gradient behind the canvas carry the load instead.
-->
<script type="module" src="../../assets/vendor/model-viewer.min.js"></script>

<div class="viewer">
  <model-viewer
    id="pendant"
    src="../../assets/models/tiny-necklace.glb"
    data-src-assembled="../../assets/models/tiny-necklace.glb"
    data-src-exploded="../../assets/models/tiny-necklace-exploded.glb"
    ios-src="../../assets/models/tiny-necklace.usdz"
    alt="Interactive 3D model of the tiny necklace: a rounded-square black pendant whose top stretches into a crown with a slot bored through it for a cord, a camera port on the front face and a white seven-ring tiny logo inlaid into the back."
    camera-orbit="25deg 72deg 125mm"
    min-camera-orbit="auto auto 75mm"
    max-camera-orbit="auto auto 340mm"
    field-of-view="28deg"
    camera-target="0m 0m 0m"
    exposure="1.05"
    shadow-intensity="1.1"
    shadow-softness="0.85"
    environment-image="neutral"
    tone-mapping="neutral"
    camera-controls
    touch-action="none"
    interaction-prompt="auto"
    auto-rotate
    auto-rotate-delay="2600"
    rotation-per-second="14deg"
    ar
    ar-modes="webxr scene-viewer quick-look"
    ar-scale="fixed"
    loading="lazy">

    <button slot="ar-button" class="ar-btn">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3 6.6 3.7L12 11.7 5.4 8 12 4.3ZM5 9.7l6 3.4v6.9l-6-3.3V9.7Zm8 10.3v-6.9l6-3.4v7l-6 3.3Z"/></svg>
      View in your room
    </button>

    <div slot="progress-bar" class="bar"><div class="bar-fill"></div></div>

    <!-- Replaces model-viewer 4.0.0's own pan-target dot: an invisible 8×8 hit
         target at the exact centre of the canvas that swallows any drag starting
         there — neither rotate nor pan, on the one element this block exists for.
         Its stylesheet gives `.slot.pan-target` opacity:0 but no
         pointer-events:none, and the 6px dot overflows the 0×0 wrapper. -->
    <div slot="pan-target" class="pan-dot" aria-hidden="true"></div>

    <!-- data-position values are emitted by strands-nicla's build_models.py from
         the same measured board coordinates the case cuts its holes at. They must
         stay DIRECT children of <model-viewer>: a slot only accepts direct
         children of its host, so wrapping these in a tidy <div> silently un-slots
         all three and the annotations vanish with nothing in the console. -->
    <button slot="hotspot-lens" class="hotspot" data-position="-0.00255m 0.00574m 0.00625m" data-normal="0 0 1" data-visibility-attribute="visible">
      <span class="dot"></span><span class="tip">GC2145 · 2 MP camera, ⌀5.8 port</span>
    </button>
    <button slot="hotspot-bail" class="hotspot" data-position="0.00000m 0.01630m 0.00000m" data-normal="0 1 0" data-visibility-attribute="visible">
      <span class="dot"></span><span class="tip">12 × 3.4 mm cord slot</span>
    </button>
    <button slot="hotspot-usb" class="hotspot" data-position="-0.00441m -0.01790m -0.00250m" data-normal="0 -1 0" data-visibility-attribute="visible">
      <span class="dot"></span><span class="tip">Micro-USB mouth — charge it cased</span>
    </button>
  </model-viewer>

  <!-- role=radiogroup, and the roles + aria-checked + tabindex are IN THE MARKUP
       rather than applied by tiny-viewer.js, because a reader whose JS never ran
       still gets a strip that says which item is chosen. The roving tabindex (one
       0, the rest -1) makes each strip a single Tab stop; the arrow keys in
       tiny-viewer.js are what gives back the reach it takes away. -->
  <div class="viewer__bar">
    <div class="seg" role="radiogroup" aria-label="Model">
      <button data-model="assembled" class="on" role="radio" aria-checked="true" tabindex="0">Assembled</button>
      <button data-model="exploded" role="radio" aria-checked="false" tabindex="-1">Exploded</button>
    </div>
    <!-- Named for what they show, not "front" and "back". The camera has to face
         away from the wearer, so the lens is the outward face — but the logo is
         the side most people would call the front of a pendant, and the labels
         were quietly asserting an answer. "Camera" starts on because it matches
         the camera-orbit above. -->
    <div class="seg" role="radiogroup" aria-label="View">
      <button data-view="camera" class="on" role="radio" aria-checked="true" tabindex="0">Camera</button>
      <button data-view="logo" role="radio" aria-checked="false" tabindex="-1">Logo</button>
      <button data-view="worn" role="radio" aria-checked="false" tabindex="-1">Worn</button>
      <button data-view="edge" role="radio" aria-checked="false" tabindex="-1">Edge</button>
    </div>
    <div class="seg solo"><button id="spin" aria-pressed="true">Pause spin</button></div>
    <p class="viewer__note" id="ar-note" hidden></p>
  </div>
</div>

<script src="../../js/tiny-viewer.js"></script>

??? note "What happens when you tap “View in your room”"

    There is no WebXR on iOS Safari — Apple has never shipped it — so the page
    ships **two** assets and lets the platform pick.

    - **iOS / iPadOS Safari** → the `.usdz` goes to **AR Quick Look**, the same
      system viewer the Files app uses, full-screen outside the page at real-world
      scale (`metersPerUnit = 0.001`, so 32 mm arrives as 32 mm).
    - **Android Chrome** → **Scene Viewer**, or in-page WebXR (`immersive-ar`)
      where the device supports it.
    - **Desktop, or anything else** → the AR button hides itself and you keep the
      orbit viewer, which is the whole experience anyway.

    The `<model-viewer>` runtime is [vendored into this repo](../assets/vendor/NOTICE.txt)
    rather than pulled from a CDN, so these docs work offline, off a
    `python3 -m http.server`, and off a phone on the same Wi-Fi as the necklace.

Whole build — case, cord, firmware, and the checkers that hold every number to
the hardware — is documented on its own site:
[the tiny necklace :material-arrow-right:](https://cagataycali.github.io/strands-nicla/){ .go }

## Driving it fast

The chat surface is built for people who type quickly and don't want to wait:

- **Concurrent turns** — every send streams immediately, in parallel, and each
  new question sees its siblings' in-progress answers. Per-bubble stop, plus a
  "stop all" chip.
- **`⌘⇧K`** fuzzy command palette · slash commands (`/clear /share /jobs /memory
  /save /load /auto /tools …`) · **`!expr`** instant zero-token JS eval ·
  per-message token usage · activity HUD · PWA install.

<div class="doors" markdown="1">

<div class="door" markdown="1">
<p class="door__t">Why embodiment is the guarded one</p>
Of everything a tiny has, a body is the attribute held on the shortest leash.

[Trust, security & sovereignty :material-arrow-right:](../business/trust.md){ .go }
</div>

<div class="door" markdown="1">
<p class="door__t">Put a device on the fleet</p>
The enrollment path end to end, including hardware that isn't a phone.

[Enroll a device :material-arrow-right:](../developers/enroll-a-device.md){ .go }
</div>

</div>

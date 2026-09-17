/* tiny-viewer — the 3D/AR pendant on docs/platform/devices.md.
 *
 * NOT in mkdocs.yml's extra_javascript, and neither is the 956 KB runtime beside
 * it: both are loaded by an ordinary relative <script> from the one page that has
 * a model on it. extra_javascript would put them on all 21 pages, including the
 * ones that are three paragraphs of prose.
 *
 * Ported from ~/strands-nicla/docs/assets/app.js, where this runs the necklace's
 * own page. Dependency-free and defensive on purpose: if <model-viewer> never
 * defines — an old browser, a blocked module, a bad deploy — every handler here
 * no-ops rather than throwing and taking the page's other scripts with it. The
 * page is readable without the viewer; it must not be broken by it.
 *
 * Two things it does that the original does not:
 *
 * · THE MODEL URLS COME OUT OF THE DOM (data-src-*). A docs page's depth is set by
 *   mkdocs.yml, so a hardcoded "../../assets/models/…" here would break the day
 *   the page moves in the nav — silently, because the viewer would still render
 *   its first model and only the Exploded button would go dead.
 * · REDUCED MOTION STOPS THE SPIN. A 14deg/s turntable is exactly the kind of
 *   unrequested movement that setting is for, and the landing's mark already
 *   honours it. Everything stays draggable.
 */
(function () {
  "use strict";

  var mv = document.getElementById("pendant");
  if (!mv) return;

  var MODELS = {
    assembled: mv.dataset.srcAssembled || mv.getAttribute("src"),
    exploded: mv.dataset.srcExploded,
  };

  /* Named camera poses, "theta phi radius".
   *
   * Radii are in millimetres and mean it: the GLB is exported in metres per the
   * glTF spec and model-viewer converts, so 152mm is what a caliper would measure.
   *
   * theta 0 sits over +Z, which is the DOOR — the camera face. The logo face is
   * the tray floor at -Z, so the two are 25deg and -155deg, and they must stay
   * 180deg apart or one of them shows a face half-turned rather than square on.
   * The keys say what you will see rather than "front" and "back", because which
   * face is the front of a pendant is a matter of opinion — and an earlier pass
   * had them backwards, having mistaken the ring of the inlaid logo for the lens.
   *
   * The radii are 0.82x the necklace page's, because this stage is a content
   * column and not a full-bleed hero: at the inherited 152mm the pendant covered
   * 53% of a 688x520 canvas and read as a thumbnail with a lot of void around it.
   * 125mm was measured, not guessed — the model's own alpha bounds were read off
   * the canvas for every view x model x stage (1280, 390, 320) and 112mm was the
   * first radius where the exploded model touched the bottom edge on desktop.
   * At 125mm the tightest gap in the whole matrix is ~7% of the canvas.
   *
   * A tighter frame is also why there is no per-model radius: the exploded body is
   * 32.5mm deep against 12.5mm, and the worry was that it would not fit once the
   * camera came in. Measured, it does, everywhere — so the swap keeps the camera
   * exactly as the visitor left it and nothing zooms out under them. */
  var VIEWS = {
    camera: "25deg 72deg 125mm",  // door: lens bore, ToF slot, reset pinhole
    logo: "-155deg 74deg 125mm",  // tray floor: the two-colour "tiny" inlay
    worn: "12deg 60deg 155mm",    // camera facing out, seen from above
    edge: "-92deg 88deg 118mm",   // profile: 12.5mm depth and the USB mouth
  };

  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- progress bar ---------- */
  var fill = document.querySelector(".viewer .bar-fill");
  var bar = document.querySelector(".viewer .bar");
  mv.addEventListener("progress", function (e) {
    var p = e.detail.totalProgress;
    if (fill) fill.style.width = p * 100 + "%";
    if (bar && p === 1) bar.setAttribute("hidden", "");
  });

  /* ---------- the segmented control's sliding pill ----------
   * One pill that slides between items and morphs to the width of the label it
   * lands on. CSS cannot do it alone: "Assembled" and "Camera" are different widths,
   * so there is no fixed step to translate by, and the labels are prose that will
   * change again.
   *
   * Measured in the group's own coordinates, MINUS the group's left border: `left:0`
   * on an absolutely positioned ::before resolves against the padding box while
   * getBoundingClientRect includes the border, so skipping that subtraction puts the
   * pill 1px left of its label on every group.
   *
   * ONLY A SELECTION GLIDES. `animate` is false for every placement the reader did
   * not ask for — first paint, a resize, a rotation, a webfont landing late — and
   * that is not a nicety: with the font held 2.5s (the shipped page, over a routed
   * throttle) "Assembled" measures 107.03px in the fallback and 104.20px in Roboto,
   * so the fonts.ready re-measure below fired a 380ms `width` transition on both
   * groups 2.7 SECONDS into the page. Unrequested movement, arriving latest on the
   * slowest connections, and invisible to any probe whose font was already cached.
   *
   * ONE flush does both jobs, and it took a positive control to notice. There used to
   * be a second one, guarding the first placement specifically — the load glide is the
   * older of the two bugs: `data-thumb` is what brings the transition into force, so
   * adding it in the same style resolution as the first --thumb-x transitions the pill
   * in from the left edge of the track. CSS compares the before-change style with the
   * after-change style, not the order of two mutations inside one task, so writing the
   * properties first achieves nothing. But the first placement is also a placement
   * nobody asked for, so it now comes through here with animate false and is already
   * covered; the mutation that deleted the extra flush changed no behaviour at all and
   * came back NOT CAUGHT, which is what dead code looks like from a sweep.
   *
   * So: hold `data-quiet` across one style resolution and the new geometry — first or
   * hundredth — is adopted with the transition off. Removing the attribute after that
   * flush starts nothing, because by then no transitionable value is changing. */
  function place(group, animate) {
    var on = group.querySelector("button.on");
    if (!on) return;                       // #spin is a toggle, not a selection
    var g = group.getBoundingClientRect();
    var b = on.getBoundingClientRect();
    var bx = parseFloat(getComputedStyle(group).borderLeftWidth) || 0;
    if (!animate) group.setAttribute("data-quiet", "");
    group.style.setProperty("--thumb-x", (b.left - g.left - bx) + "px");
    group.style.setProperty("--thumb-w", b.width + "px");
    group.setAttribute("data-thumb", "");   // idempotent; only the first one is a change
    if (!animate) {
      // Reading a resolved value off the pseudo-element is the flush.
      void getComputedStyle(group, "::before").width;
      group.removeAttribute("data-quiet");
    }
  }

  var segs = document.querySelectorAll(".viewer .seg");
  function pills() {
    Array.prototype.forEach.call(segs, function (g) { place(g, false); });
  }
  pills();
  /* The strip wraps at narrow widths and the labels are laid out by the font, so a
     resize, a rotation, or a webfont arriving late moves the target the pill is
     parked on. Material serves its text font with font-display: swap, so the widths
     this measured at first paint are the FALLBACK font's — re-measure when the real
     one lands. All three are re-measures, not selections, so all three jump.
     Nothing debounces any of it: this is two rects per group. */
  window.addEventListener("resize", pills);
  window.addEventListener("orientationchange", pills);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(pills);

  /* ---------- model + view switches ----------
   * Four things move together, and they are four because they are read by four
   * different consumers: `class="on"` is what the pill is drawn from, `aria-checked`
   * is the only form of "this one" that reaches a screen reader (the pill is a
   * picture), `tabindex` keeps the strip a single Tab stop — the roving pattern — and
   * place() is the picture itself. This is the one caller that passes animate: a
   * press is the only movement the reader asked for.
   *
   * `radio` is the honest role: one of a set, exactly one chosen, choosing has an
   * effect. `aria-pressed` on four buttons would announce "four toggles, any number
   * of them down", which is not what this is. #spin genuinely is a toggle and keeps
   * aria-pressed. */
  function activate(button) {
    var group = button.parentElement;
    Array.prototype.forEach.call(group.children, function (b) {
      var on = b === button;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    place(group, true);
  }

  document.querySelectorAll("[data-model]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var src = MODELS[btn.dataset.model];
      if (!src || mv.getAttribute("src") === src) return;
      // Nothing restores the camera here, because nothing needs to. There used to
      // be a `camera-orbit` save/restore around this line, on the theory that a src
      // swap reframes to the new bounding box and the exploded box is 2.6x deeper —
      // so the pendant would jump and shrink on every toggle. Measured, it doesn't:
      // across the swap the live camera holds to 0.00deg / 0.00mm, both from the
      // markup's pose AND from a dragged one (theta -86.2deg, phi 113.7deg), with
      // the line present or absent. It was a no-op, and it could not have worked
      // anyway — it read getAttribute("camera-orbit"), which is the markup's stale
      // value, not where the reader had dragged to.
      //
      // model-viewer keeps the camera itself. verify-docs-landing.mjs drags first
      // and then asserts the LIVE camera across the toggle, so if a runtime bump
      // ever changes that, it fails there rather than in a reader's hands.
      mv.setAttribute("src", src);
      activate(btn);
    });
  });

  document.querySelectorAll("[data-view]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      mv.setAttribute("camera-orbit", VIEWS[btn.dataset.view]);
      activate(btn);
    });
  });

  /* ---------- the arrows, which are the other half of a radiogroup ----------
   * The roving tabindex above takes the bar from seven Tab stops to three, and it
   * takes the four view labels OUT of Tab's reach at the same time — so a keyboard
   * visitor who could previously Tab to "Worn" and press it can now reach nothing but
   * the one already chosen. The arrow keys give that reach back. Shipping the roving
   * tabindex without them would be strictly worse than the plain buttons this
   * replaces, which is why they are in the same commit.
   *
   * Selection follows focus — the radio pattern, not the tab pattern: arriving on an
   * item IS choosing it. That is the right call here because choosing costs nothing
   * (a camera-orbit attribute, undone by the next arrow press) and because it is what
   * the native control this imitates does.
   *
   * click() rather than a shared function: the side effects — swap the src, move the
   * orbit, keep the camera where the visitor put it — live in the click handlers, and
   * a second call path into them is a second place to forget one.
   *
   * preventDefault because Left/Right scroll the page otherwise, and Up/Down scroll
   * it in a section tall enough to have somewhere to go. */
  Array.prototype.forEach.call(segs, function (group) {
    if (group.getAttribute("role") !== "radiogroup") return;
    var items = Array.prototype.filter.call(group.children, function (c) {
      return c.getAttribute("role") === "radio";
    });
    group.addEventListener("keydown", function (e) {
      var i = items.indexOf(document.activeElement);
      if (i < 0) return;
      var next;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % items.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      else return;
      e.preventDefault();
      // Disabled while the module is in flight: focus() is a no-op on a disabled
      // button, so moving the selection onto one would strand focus on the item the
      // visitor just left while `class="on"` said otherwise.
      if (items[next].disabled) return;
      items[next].focus();
      items[next].click();
    });
  });

  /* ---------- auto-rotate toggle ---------- */
  var spin = document.getElementById("spin");
  function setSpin(on) {
    if (on) mv.setAttribute("auto-rotate", "");
    else mv.removeAttribute("auto-rotate");
    if (!spin) return;
    spin.textContent = on ? "Pause spin" : "Resume spin";
    spin.setAttribute("aria-pressed", String(on));
  }
  if (still) setSpin(false);   // the attribute is in the markup; take it back out
  if (spin) {
    spin.addEventListener("click", function () {
      setSpin(!mv.hasAttribute("auto-rotate"));
    });
  }

  // Someone who has grabbed the model has said what they want to look at.
  mv.addEventListener("camera-change", function (e) {
    if (e.detail.source !== "user-interaction") return;
    if (!mv.hasAttribute("auto-rotate")) return;
    setSpin(false);
  });

  /* ---------- hotspots on touch ----------
   * :hover never fires on a touchscreen, so the annotations would be invisible on
   * exactly the devices this page is aimed at. Tap toggles instead. */
  document.querySelectorAll(".viewer .hotspot").forEach(function (h) {
    h.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var wasOpen = h.classList.contains("open");
      document.querySelectorAll(".viewer .hotspot.open").forEach(function (o) {
        o.classList.remove("open");
      });
      if (!wasOpen) h.classList.add("open");
    });
  });

  /* ---------- tell the truth about AR support ----------
   * model-viewer hides its own AR button when the platform cannot do AR, which
   * leaves a visitor on a desktop wondering whether the feature is broken. Say
   * which path they got instead. */
  var note = document.getElementById("ar-note");
  function say(text) {
    if (!note) return;
    note.textContent = text;
    note.hidden = false;
  }
  function describeAr() {
    var ua = navigator.userAgent;
    var iOS =
      /iPad|iPhone|iPod/.test(ua) ||
      // iPadOS 13+ reports as a Mac; a touch-capable "Mac" is an iPad.
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var motion = still ? " Spin is off — you asked for reduced motion." : "";

    if (mv.canActivateAR) {
      say((iOS
        ? "AR ready — opens in AR Quick Look at true 32 mm scale."
        : "AR ready — opens in Scene Viewer or WebXR.") + motion);
    } else {
      say("AR needs an iPhone, iPad, or an ARCore Android phone. " +
        "Drag and pinch works everywhere." + motion);
    }
  }

  /* ---------- don't offer controls that cannot work yet ----------
   *
   * Two bugs lived here, both invisible to any check that waits for the model
   * before looking. The viewer bar was live from first paint, so pressing
   * "Exploded" before the module arrived moved the highlight and nothing else. And
   * the AR note was written by a blind setTimeout(1200) — canActivateAR only means
   * something once the element has upgraded and probed the platform, so on a real
   * iPhone the note said "AR needs an iPhone" for six seconds: the exact false
   * claim it exists to prevent. Wait for the definition rather than a delay. */
  var controls = document.querySelectorAll("[data-model], [data-view], #spin");
  function setControls(on) {
    Array.prototype.forEach.call(controls, function (b) {
      b.disabled = !on;
    });
  }
  setControls(false);

  var ready = false;
  function viewerReady() {
    if (ready) return;
    ready = true;
    setControls(true);
    describeAr();
  }

  var ce = window.customElements;
  if (!ce || !ce.whenDefined) {
    // No custom elements at all: the viewer can never upgrade, so the controls
    // stay disabled instead of pretending. Say so rather than blaming the platform
    // for an AR gap it may not have.
    say("The 3D viewer did not load, so the model and AR are unavailable. " +
      "Everything else on this page works without it.");
  } else if (ce.get("model-viewer")) {
    viewerReady();
  } else {
    ce.whenDefined("model-viewer").then(viewerReady);
    // Only an interim message: whenDefined still resolves whenever the module
    // lands, and viewerReady() overwrites this.
    setTimeout(function () {
      if (!ready) {
        say("The 3D viewer is a 0.9 MB module and is still loading. " +
          "Everything else on this page works without it.");
      }
    }, 3000);
  }
  // canActivateAR can settle later than the definition on some platforms.
  mv.addEventListener("load", function () {
    viewerReady();
    describeAr();
  });
})();

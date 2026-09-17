/**
 * tiny — the drop. The mark, as a live object.
 *
 * Seven blobs: six on a hexagon around one centre, fused by an SVG goo filter
 * into a single surface. It has shape memory, so it always wants to be the mark
 * again — but it is liquid, so anything that moves the page's idea of "down"
 * pours it. On a phone that is real gravity; on a desktop it is the cursor.
 *
 * ⚠️ iOS is the reason this file is not four lines of CSS.
 *
 *   1. Safari 13+ hands out the motion sensors ONLY after a real tap, and ONLY
 *      on HTTPS. So the drop must already be alive BEFORE permission exists —
 *      hence IDLE below, a slow drifting gravity that needs no sensor at all.
 *      A mark that sits still until you grant a permission reads as broken, and
 *      most visitors will never grant it.
 *   2. `requestPermission()` REJECTS if it wasn't called from a gesture, and
 *      resolves "denied" if Motion & Orientation Access is off in Settings.
 *      Both are normal, neither is an error worth a console trace, and each one
 *      needs a different sentence.
 *   3. Nothing here may touch scrolling. The standalone prototype this came
 *      from set `touch-action:none` on the body because it owned the whole
 *      screen; a docs page that did that would be unscrollable on a phone, and
 *      the hero is the first thing a reader's thumb lands on.
 *
 * Everything is scoped to `[data-tiny-drop]`, so dropping that attribute on any
 * element anywhere in the site gives it a live mark and nothing else changes.
 */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── the mark ──────────────────────────────────────────────────────────────
  // Not taste: the goo filter (blur 16, alpha matrix 18/-7) reproduces a
  // Gaussian metaball field of sigma 32 at threshold 0.5 — apparent blob radius
  // 26, neighbours fusing below 74 units apart. Rest spacing is 90.24, so the
  // seven stay seven until something actually piles them.
  const CX = 124.41, CY = 115.54, SPACING = 90.24, BLOB_R = 28;
  const REST = [-120, -60, 0, 60, 120, 180]
    .map((a) => [CX + SPACING * Math.cos((a * Math.PI) / 180),
                 CY + SPACING * Math.sin((a * Math.PI) / 180)])
    .concat([[CX, CY]]);

  // ── physics, tuned against an offline metaball simulation ─────────────────
  const P = {
    SPRING: 0.012, // shape memory — it wants to be the mark again
    GRAV: 0.90,    // how liquid it is. the one dial worth touching
    DAMP: 0.90,
    REPEL: 0.50,   // the blobs have volume and won't stack
    MIND: 58,
    BOWL: 78,      // the dish it pools in — uniform gravity alone only slides
    WALL: 0.06,    // the cluster, so compression has to come from a wall
    STEP: 1 / 120,
  };

  // Ambient life, for every visitor who never taps and never hovers: a gravity
  // vector this weak (0.16 of a g) sways the surface without breaking the
  // hexagon, so the mark still reads as the mark in a screenshot. Two periods
  // that don't divide each other, so the path never visibly repeats.
  const IDLE = { MAG: 0.16, PX: 11_000, PY: 17_000 };

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function build(host) {
    if (host.dataset.dropReady === 'yes') return;
    host.dataset.dropReady = 'yes';

    const stage = host.querySelector('[data-drop-stage]') || host;
    const statusEl = host.querySelector('[data-drop-status]');
    const enableBtn = host.querySelector('[data-drop-enable]');

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '-66 -75 380 380');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'tiny — seven peers, no hub');
    svg.classList.add('drop__svg');

    // The filter id has to be unique per instance: two heroes on one page
    // sharing `#goo` is legal but means the second one silently reuses the
    // first's filter region, and a clipped mark looks like a rendering bug.
    const uid = 'goo-' + Math.random().toString(36).slice(2, 8);
    svg.innerHTML =
      '<defs><filter id="' + uid + '" x="-40%" y="-40%" width="180%" height="180%"' +
      ' color-interpolation-filters="sRGB">' +
      '<feGaussianBlur in="SourceGraphic" stdDeviation="16" result="b"/>' +
      '<feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"/>' +
      '</filter></defs>' +
      '<g filter="url(#' + uid + ')" fill="currentColor" data-drop-blobs></g>';
    stage.prepend(svg);

    const g = svg.querySelector('[data-drop-blobs]');
    const blobs = REST.map(([x, y]) => {
      const el = document.createElementNS(SVG_NS, 'ellipse');
      el.setAttribute('rx', BLOB_R);
      el.setAttribute('ry', BLOB_R);
      g.appendChild(el);
      return { el, x, y, vx: 0, vy: 0 };
    });

    const gravity = { x: 0, y: 0 };
    let source = 'idle';   // idle | pointer | gravity
    let running = false;
    let raf = 0;

    const say = (text, live) => {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.dataset.live = live ? 'yes' : 'no';
    };

    function integrate(dt) {
      const n = blobs.length;
      for (let i = 0; i < n; i++) {
        const b = blobs[i];
        let ax = gravity.x * P.GRAV + (REST[i][0] - b.x) * P.SPRING;
        let ay = gravity.y * P.GRAV + (REST[i][1] - b.y) * P.SPRING;

        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const dx = b.x - blobs[j].x, dy = b.y - blobs[j].y;
          const d = Math.hypot(dx, dy) || 1e-6;
          if (d < P.MIND) {
            const f = (1 - d / P.MIND) * P.REPEL;
            ax += (dx / d) * f; ay += (dy / d) * f;
          }
        }

        const ox = b.x - CX, oy = b.y - CY, r = Math.hypot(ox, oy);
        if (r > P.BOWL) {
          const f = (r - P.BOWL) * P.WALL;
          ax -= (ox / r) * f; ay -= (oy / r) * f;
        }

        b.vx = (b.vx + ax) * P.DAMP;
        b.vy = (b.vy + ay) * P.DAMP;
        b.x += b.vx; b.y += b.vy;
      }
    }

    function draw() {
      for (const b of blobs) {
        // A moving blob stretches along its travel, at constant area.
        const speed = Math.hypot(b.vx, b.vy);
        const s = Math.min(speed / 9, 0.45);
        const deg = s > 0.002 ? (Math.atan2(b.vy, b.vx) * 180) / Math.PI : 0;
        b.el.setAttribute('rx', (BLOB_R * (1 + s)).toFixed(2));
        b.el.setAttribute('ry', (BLOB_R / (1 + s)).toFixed(2));
        b.el.setAttribute(
          'transform',
          'translate(' + b.x.toFixed(2) + ' ' + b.y.toFixed(2) + ') rotate(' + deg.toFixed(1) + ')'
        );
      }
    }

    let acc = 0, prev = 0;
    function frame(now) {
      if (!running) return;
      if (!prev) prev = now;
      // Clamped, because a tab restored after ten minutes would otherwise hand
      // us a 600-second delta and explode the drop off-screen.
      acc += Math.min((now - prev) / 1000, 0.1);
      prev = now;

      if (source === 'idle') {
        gravity.x = Math.sin((now / IDLE.PX) * Math.PI * 2) * IDLE.MAG;
        gravity.y = Math.sin((now / IDLE.PY) * Math.PI * 2) * IDLE.MAG;
      }

      let steps = 0;
      while (acc >= P.STEP && steps < 8) { integrate(P.STEP); acc -= P.STEP; steps++; }
      draw();
      raf = requestAnimationFrame(frame);
    }

    function play() {
      if (running || reduced) return;
      running = true;
      prev = 0;   // don't carry a delta across a pause
      raf = requestAnimationFrame(frame);
    }
    function pause() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    // ── input ────────────────────────────────────────────────────────────────
    // Deliberately NOT calibrated to how you were holding the phone: a drop
    // obeys real gravity, not a remembered rest pose. Down is down.
    function onOrientation(e) {
      if (e.beta === null && e.gamma === null) return;
      let beta = Math.max(-90, Math.min(90, e.beta || 0));
      let gamma = e.gamma || 0;
      // `screen.orientation` is absent on older iOS Safari, where the angle
      // lives on the deprecated `window.orientation` — without this fallback a
      // landscape iPhone pours the drop sideways.
      const angle = (screen.orientation && screen.orientation.angle) ||
                    (typeof window.orientation === 'number' ? window.orientation : 0);
      if (angle === 90) { const t = beta; beta = -gamma; gamma = t; }
      else if (angle === 270 || angle === -90) { const t = beta; beta = gamma; gamma = -t; }
      else if (angle === 180) { beta = -beta; gamma = -gamma; }
      gravity.x = Math.sin((gamma * Math.PI) / 180);
      gravity.y = Math.sin((beta * Math.PI) / 180);
      if (source !== 'gravity') {
        source = 'gravity';
        say('Gravity on', true);
        host.dataset.dropInput = 'gravity';
      }
    }

    // Shake is the acceleration left over once gravity is removed — kick it in
    // as impulse so a flick genuinely splashes instead of just sliding.
    function onMotion(e) {
      const a = e.acceleration;
      if (!a) return;
      const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
      if (mag < 6) return;
      splash(Math.min(mag / 6, 4));
    }

    function splash(k) {
      for (const b of blobs) {
        b.vx += (Math.random() - 0.5) * k * 3;
        b.vy += (Math.random() - 0.5) * k * 3;
      }
    }

    function onPointerMove(e) {
      const r = stage.getBoundingClientRect();
      gravity.x = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)));
      gravity.y = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2)));
      if (source === 'idle') { source = 'pointer'; host.dataset.dropInput = 'pointer'; }
    }
    function onPointerLeave() {
      // Hand it back to the ambient drift rather than freezing the last vector:
      // a mark left pinned to wherever the cursor exited looks stuck.
      if (source === 'pointer') { source = 'idle'; host.dataset.dropInput = 'idle'; }
    }

    // Tap/click always splashes. No permission, no sensor, no hover — the one
    // interaction every visitor has. `pointerdown` without preventDefault, so a
    // thumb that lands here can still scroll the page away.
    stage.addEventListener('pointerdown', () => splash(1.6), { passive: true });

    function attachSensors() {
      addEventListener('deviceorientation', onOrientation, true);
      addEventListener('devicemotion', onMotion, true);
      // Permission can be granted by a device that then reports nothing (a
      // desktop Safari with the flag, an iPad on a stand). Give it 1.2s, then
      // stop promising motion and offer what actually works here.
      setTimeout(() => {
        if (source !== 'gravity') {
          say('Drag it', false);
          addEventListener('pointermove', onPointerMove, { passive: true });
          stage.addEventListener('pointerleave', onPointerLeave, { passive: true });
        }
      }, 1200);
    }

    function start() {
      if (reduced) {
        say('Holding still — reduced motion', false);
        host.dataset.dropInput = 'reduced';
        draw();
        return;
      }

      const DME = window.DeviceMotionEvent, DOE = window.DeviceOrientationEvent;
      const gated = (DME && typeof DME.requestPermission === 'function') ||
                    (DOE && typeof DOE.requestPermission === 'function');

      if (gated) {
        // iOS. The drop is already drifting on its own, so this button is an
        // upgrade offer, not a repair — worded that way on purpose.
        if (enableBtn) {
          enableBtn.hidden = false;
          enableBtn.addEventListener('click', async () => {
            enableBtn.hidden = true;
            try {
              if (DME && DME.requestPermission) await DME.requestPermission();
              const res = DOE && DOE.requestPermission ? await DOE.requestPermission() : 'granted';
              if (res === 'granted') { attachSensors(); return; }
              say('Safari kept the sensors — drag it', false);
            } catch {
              // Rejected: not a gesture, or Motion & Orientation Access is off
              // in Settings ▸ Safari. Nothing to fix from here.
              say('Motion is off in Safari settings', false);
            }
            addEventListener('pointermove', onPointerMove, { passive: true });
            stage.addEventListener('pointerleave', onPointerLeave, { passive: true });
          });
        }
        say('Tap to pour it', false);
        return;
      }

      if (DOE) { attachSensors(); return; }
      say('Drag it', false);
      addEventListener('pointermove', onPointerMove, { passive: true });
      stage.addEventListener('pointerleave', onPointerLeave, { passive: true });
    }

    draw();
    start();

    // A physics loop is not free, and a docs page is read for a long time in a
    // background tab. Run only while the mark is both on screen and looked at.
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        for (const en of entries) (en.isIntersecting && !document.hidden) ? play() : pause();
      }, { rootMargin: '80px' }).observe(stage);
    } else {
      play();
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pause();
      else if (stage.getBoundingClientRect().top < innerHeight) play();
    });
  }

  const boot = () => document.querySelectorAll('[data-tiny-drop]').forEach(build);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
  // Material can swap the DOM without a reload (instant navigation). If that
  // ever gets switched on, this keeps the mark alive; `dropReady` makes the
  // re-run a no-op today rather than a second set of blobs.
  if (window.document$ && typeof window.document$.subscribe === 'function') {
    window.document$.subscribe(boot);
  }
})();

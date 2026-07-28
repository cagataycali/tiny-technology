"use client";

/**
 * 🌌 Universe constellation — the spatial view the name always promised.
 * Builders are avatar hubs, their public tinys orbit as accent satellites;
 * node brightness/size follow the PageRank trust map (a tiny other tinys
 * consult glows brighter), so the field reads as a living economy, not a
 * decoration. Sits above the /universe card grid: the grid stays the
 * scannable record, this is the shape of the whole.
 *
 * Same force-layout grammar as chat/MemoryGraph (golden-angle seed,
 * repulsion + edge springs + weak centering, cooled rAF ticks, viewBox
 * camera, tap-to-select detail strip) — the data is structure, not
 * series, so plain SVG and no chart lib. Visual language is the iOS
 * tinyCard chrome: 14px radius, accent hairline, glows over drop shadows.
 *
 * Interaction: background drag pans, wheel zooms, drag a node to pin it,
 * tap selects (detail strip below is the text alternative + the touch
 * "tooltip"), arrows cycle tinys, +/- zoom, Escape clears. Reduced
 * motion settles the layout synchronously — no visible simulation.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { githubAvatar, hexRgb, type CommunityUser } from "@/lib/community";
import { constellationFooter } from "@/lib/chat/universe-counts";

type UNode = {
  id: string;
  kind: "builder" | "tiny";
  label: string;
  login?: string; // builder: own login; tiny: owner login
  avatar?: string;
  trust: number; // normalized 0..1 within this dataset (builders: 0)
  /** "r,g,b" of the tiny's OWN accent (true-color universe) — absent falls
      back to the page accent var. Normalizer guarantees 6-hex upstream. */
  rgb?: string;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned?: boolean;
};

type UEdge = { src: string; dst: string; kind: "owns" | "consults"; weight?: number };

export default function UniverseConstellation({
  users,
  trust,
  query,
  consults = [],
  totalPublicTinys,
  mini = false,
}: {
  users: CommunityUser[];
  trust: Record<string, number>;
  /** Live search text — matching nodes stay lit, the rest dim in place.
      Dimming (not removing) keeps the settled layout stable under typing;
      same grammar as the tap-selection neighbor highlight. */
  query?: string;
  /** Public tiny-consults-tiny edges — drawn as dashed accent lines (the
      actual economy) on top of the solid ownership spokes. */
  consults?: { src: string; dst: string; weight: number }[];
  /** The worker's real public-tiny total. The drawing shows at most 8 tinys per
      builder (the /community payload's own per-user cap), so the star count is
      a sample of this — when they differ the footer says so instead of reading
      like a census (v10 A4). Omitted → no claim about what isn't drawn. */
  totalPublicTinys?: number;
  /** Mini mode — a decorative starfield header (the Universe drawer): short,
      non-interactive (clicks fall through to the wrapping link), no labels,
      no legend/detail strip. The full physics still runs; only chrome and
      interaction are stripped. */
  mini?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<UNode[]>([]);
  const [frame, setFrame] = useState<UNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: -300, y: -300, w: 600, h: 600 });
  const dragRef = useRef<{ kind: "node" | "pan"; id?: string; lastX: number; lastY: number; moved: boolean } | null>(null);

  // Graph model: one hub per builder, one satellite per public tiny,
  // ownership edges only (consult edges live worker-side — the /community
  // payload ships just the PageRank result, so rank is what we encode).
  const { nodes, edges } = useMemo(() => {
    const maxTrust = Math.max(...Object.values(trust), 0.0001);
    const nodes: UNode[] = [];
    const edges: UEdge[] = [];
    for (const u of users) {
      const hubId = `@${u.login}`;
      nodes.push({
        id: hubId,
        kind: "builder",
        label: `@${u.login}`,
        login: u.login,
        avatar: u.avatar,
        trust: 0,
        r: Math.min(10 + u.tinys.length, 16),
        x: 0, y: 0, vx: 0, vy: 0,
      });
      for (const t of u.tinys) {
        const tNorm = (trust[t.name] || 0) / maxTrust;
        nodes.push({
          id: t.name,
          kind: "tiny",
          label: `/${t.name}`,
          login: u.login,
          trust: tNorm,
          rgb: t.accent ? hexRgb(t.accent) : undefined,
          r: 5 + tNorm * 5,
          x: 0, y: 0, vx: 0, vy: 0,
        });
        edges.push({ src: hubId, dst: t.name, kind: "owns" });
      }
    }
    // Consult edges ride on top — only when both endpoints made it into the
    // node set (edges can reference tinys beyond the builder cap or ones
    // whose owner went private; a dangling line has nowhere to draw).
    const present = new Set(nodes.map((n) => n.id));
    const seen = new Set<string>();
    for (const c of consults) {
      const key = c.src < c.dst ? `${c.src}|${c.dst}` : `${c.dst}|${c.src}`;
      if (!present.has(c.src) || !present.has(c.dst) || seen.has(key)) continue;
      seen.add(key);
      edges.push({ src: c.src, dst: c.dst, kind: "consults", weight: c.weight });
    }
    return { nodes, edges };
  }, [users, trust, consults]);

  // What the legend footer and the SVG's text alternative may claim. Derived
  // from the STARS actually in `nodes`, compared against the worker's total.
  const starsShown = nodes.length - users.length;
  const footer = constellationFooter({
    builders: users.length,
    starsShown,
    // Absent → pass the star count as the total so nothing is claimed missing:
    // a caller that didn't hand us a census has given us no evidence of one.
    totalPublicTinys: totalPublicTinys ?? starsShown,
  });

  // (Re)seed + settle. Deterministic golden-angle spiral seed (stable
  // layouts across visits beat random scatter).
  useEffect(() => {
    simRef.current = nodes.map((n, i) => {
      const a = i * 2.39996;
      const r = 16 * Math.sqrt(i + 1);
      return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
    const byId = new Map(simRef.current.map((n) => [n.id, n]));
    let alpha = 1;
    let raf = 0;
    const tick = () => {
      const sim = simRef.current;
      for (let i = 0; i < sim.length; i++) {
        for (let j = i + 1; j < sim.length; j++) {
          const a = sim[i], b = sim[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = i % 2 ? 0.5 : -0.5; dy = j % 2 ? 0.5 : -0.5; d2 = 1; }
          const f = Math.min(2200 / d2, 8) * alpha;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
          if (!b.pinned) { b.vx += fx; b.vy += fy; }
        }
      }
      // ownership springs — short rest so tinys ORBIT their builder;
      // consult springs — longer rest, weaker pull, so consulting systems
      // drift toward each other without collapsing the orbits
      for (const e of edges) {
        const a = byId.get(e.src), b = byId.get(e.dst);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const owns = e.kind === "owns";
        const f = (d - (owns ? 72 : 140)) * (owns ? 0.025 : 0.008) * alpha;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        if (!a.pinned) { a.vx += fx; a.vy += fy; }
        if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
      }
      for (const n of sim) {
        if (n.pinned) continue;
        n.vx -= n.x * 0.006 * alpha;
        n.vy -= n.y * 0.006 * alpha;
        n.vx *= 0.85; n.vy *= 0.85;
        n.x += n.vx; n.y += n.vy;
      }
      alpha *= 0.995;
    };
    const fit = () => {
      const sim = simRef.current;
      if (!sim.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of sim) {
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
      const m = 80;
      const w = Math.max(maxX - minX, maxY - minY) + m * 2;
      setView({ x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - w / 2, w, h: w });
    };
    // Reduced motion: settle synchronously — the layout appears, no
    // visible simulation (the settling animation IS motion).
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      while (alpha > 0.02) tick();
      setFrame(simRef.current.map((n) => ({ ...n })));
      fit();
      return;
    }
    // Publish stride: React re-renders the full node list per published
    // frame — fine at today's ~50 nodes, judders toward the 100-builder
    // payload cap (~800 nodes). Physics still ticks every rAF; only the
    // publish thins (30/20fps reads as identical for a settling field).
    let tickN = 0;
    const stride = nodes.length > 400 ? 3 : nodes.length > 200 ? 2 : 1;
    const step = () => {
      tick();
      if (++tickN % stride === 0) setFrame(simRef.current.map((n) => ({ ...n })));
      if (alpha > 0.02) raf = requestAnimationFrame(step);
      else {
        // final frame always lands regardless of stride phase
        setFrame(simRef.current.map((n) => ({ ...n })));
        fit();
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [nodes, edges]);

  const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const selectedSafe = selected && nodeIds.has(selected) ? selected : null;

  // Search match set: a builder hit lights their whole system; a tiny hit
  // lights the tiny + its hub (the orbit stays readable). null = no query.
  const matched = useMemo(() => {
    const q = (query ?? "").trim().toLowerCase();
    if (!q) return null;
    const s = new Set<string>();
    for (const u of users) {
      const hubId = `@${u.login}`;
      const userHit = u.login.toLowerCase().includes(q) || (u.name ?? "").toLowerCase().includes(q);
      if (userHit) s.add(hubId);
      for (const t of u.tinys) {
        if (userHit || t.name.toLowerCase().includes(q)) {
          s.add(t.name);
          s.add(hubId);
        }
      }
    }
    return s;
  }, [users, query]);

  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: view.x + ((clientX - rect.left) / rect.width) * view.w,
      y: view.y + ((clientY - rect.top) / rect.height) * view.h,
    };
  };

  const onPointerDown = (e: React.PointerEvent, nodeId?: string) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { kind: nodeId ? "node" : "pan", id: nodeId, lastX: e.clientX, lastY: e.clientY, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.moved = true;
    if (drag.kind === "node" && drag.id) {
      const n = simRef.current.find((x) => x.id === drag.id);
      if (n) {
        const p = toWorld(e.clientX, e.clientY);
        n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0; n.pinned = true;
        setFrame(simRef.current.map((x) => ({ ...x })));
      }
    } else {
      const rect = svgRef.current!.getBoundingClientRect();
      const dx = ((e.clientX - drag.lastX) / rect.width) * view.w;
      const dy = ((e.clientY - drag.lastY) / rect.height) * view.h;
      setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
    }
    drag.lastX = e.clientX; drag.lastY = e.clientY;
  };

  const onPointerUp = () => { dragRef.current = null; };

  const onWheel = (e: React.WheelEvent) => {
    const p = toWorld(e.clientX, e.clientY);
    const k = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const w = Math.min(Math.max(v.w * k, 120), 4000);
      return { x: p.x - ((p.x - v.x) / v.w) * w, y: p.y - ((p.y - v.y) / v.h) * w, w, h: w };
    });
  };

  const zoomBy = (k: number) =>
    setView((v) => {
      const w = Math.min(Math.max(v.w * k, 120), 4000);
      const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
      return { x: cx - w / 2, y: cy - w / 2, w, h: w };
    });

  const focusNode = (id: string) => {
    setSelected(id);
    const n = simRef.current.find((x) => x.id === id);
    if (!n) return;
    setView((v) => {
      const m = 60 * (v.w / 600);
      const inside = n.x > v.x + m && n.x < v.x + v.w - m && n.y > v.y + m && n.y < v.y + v.h - m;
      return inside ? v : { ...v, x: n.x - v.w / 2, y: n.y - v.h / 2 };
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!nodes.length) return;
    const idx = selectedSafe ? nodes.findIndex((n) => n.id === selectedSafe) : -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusNode(nodes[(idx + 1) % nodes.length].id);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusNode(nodes[(idx - 1 + nodes.length) % nodes.length].id);
    } else if (e.key === "Escape" && selectedSafe) {
      e.stopPropagation();
      setSelected(null);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomBy(1 / 1.2);
    } else if (e.key === "-") {
      e.preventDefault();
      zoomBy(1.2);
    }
  };

  const sim = frame;
  const byId = new Map(sim.map((n) => [n.id, n]));
  const sel = selectedSafe ? byId.get(selectedSafe) : null;
  const neighbors = useMemo(() => {
    if (!selectedSafe) return null;
    const s = new Set<string>([selectedSafe]);
    for (const e of edges) {
      if (e.src === selectedSafe) s.add(e.dst);
      if (e.dst === selectedSafe) s.add(e.src);
    }
    return s;
  }, [edges, selectedSafe]);
  // Screen-constant type while the world zooms under it
  const px = view.w / 600;

  if (nodes.length === 0) return null;

  return (
    <div
      className={`rounded-[14px] border overflow-hidden neon-card ${mini ? "" : "mb-10"}`}
      style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.15)" }}
    >
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className={mini
          ? "w-full h-[150px] pointer-events-none"
          : "w-full h-[46vh] max-h-[440px] min-h-[260px] touch-none cursor-grab active:cursor-grabbing"}
        role={mini ? undefined : "application"}
        aria-hidden={mini || undefined}
        tabIndex={mini ? undefined : 0}
        // The text alternative carries the same qualification as the visible
        // footer — a screen reader that hears "5 builders and 25 public tinys"
        // over 8 drawn stars has been told the drawing is complete.
        aria-label={mini ? undefined : `Universe constellation: ${footer.label}${footer.title ? ` — ${footer.title}` : ""}. Arrow keys move between them, plus and minus zoom, Escape clears the selection. Selecting one reads its details below.`}
        onPointerDown={mini ? undefined : (e) => { setSelected(null); onPointerDown(e); }}
        onPointerMove={mini ? undefined : onPointerMove}
        onPointerUp={mini ? undefined : onPointerUp}
        onWheel={mini ? undefined : onWheel}
        onKeyDown={mini ? undefined : onKeyDown}
      >
        <defs>
          {/* one circular clip per builder avatar */}
          {sim.filter((n) => n.kind === "builder").map((n) => (
            <clipPath key={`clip-${n.id}`} id={`uc-clip-${n.login}`}>
              <circle cx={n.x} cy={n.y} r={n.r - 1} />
            </clipPath>
          ))}
        </defs>

        {/* ownership edges — recessive ink under the nodes */}
        {edges.map((e) => {
          const a = byId.get(e.src), b = byId.get(e.dst);
          if (!a || !b) return null;
          const hot = selectedSafe && (e.src === selectedSafe || e.dst === selectedSafe);
          const faded = matched ? !(matched.has(e.src) && matched.has(e.dst)) : false;
          const consult = e.kind === "consults";
          return (
            <line
              key={`${e.kind}-${e.src}-${e.dst}`}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              opacity={faded && !hot ? 0.25 : 1}
              // consult lines are the economy — accent ink, dashed (the iOS
              // dashed-stroke motif); ownership spokes stay recessive white
              stroke={hot
                ? "rgba(var(--tiny-accent-rgb),0.9)"
                : consult ? "rgba(var(--tiny-accent-rgb),0.35)" : "rgba(255,255,255,0.14)"}
              strokeWidth={hot ? 2 : consult ? Math.min(1 + (e.weight || 1) * 0.15, 2) : 1.2}
              strokeDasharray={consult ? "3 3" : undefined}
            />
          );
        })}

        {sim.map((n, i) => {
          const isSel = n.id === selectedSafe;
          const dim = (neighbors ? !neighbors.has(n.id) : false) || (matched ? !matched.has(n.id) : false);
          const below = i % 2 === 1;
          const showLabel = !mini && (isSel || n.kind === "builder" || n.trust > 0.4 || px < 0.9 ||
            (matched?.has(n.id) ?? false));
          return (
            <g key={n.id} opacity={dim ? 0.25 : 1}>
              {/* hit target ≥ the mark */}
              <circle
                cx={n.x} cy={n.y} r={Math.max(n.r + 8, 14)}
                fill="transparent"
                className="cursor-pointer"
                onPointerDown={(e) => onPointerDown(e, n.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  // a drag that ends on the node is a pin, not a tap
                  if (!dragRef.current?.moved) setSelected(isSel ? null : n.id);
                }}
              />
              {n.kind === "builder" ? (
                <>
                  <circle
                    cx={n.x} cy={n.y} r={n.r}
                    fill="rgba(255,255,255,0.06)"
                    stroke={isSel ? "#fff" : "rgba(var(--tiny-accent-rgb),0.5)"}
                    strokeWidth={isSel ? 2 : 1}
                    style={{ pointerEvents: "none" }}
                  />
                  {n.avatar && (
                    <image
                      href={githubAvatar(n.avatar, 24)}
                      x={n.x - n.r + 1} y={n.y - n.r + 1}
                      width={(n.r - 1) * 2} height={(n.r - 1) * 2}
                      clipPath={`url(#uc-clip-${n.login})`}
                      preserveAspectRatio="xMidYMid slice"
                      style={{ pointerEvents: "none" }}
                    />
                  )}
                </>
              ) : (
                <circle
                  cx={n.x} cy={n.y} r={n.r}
                  // True-color universe: each star wears its tiny's OWN
                  // accent (same hue the tiny's page/OG card/browser chrome
                  // wear); the trust ramp stays an opacity ramp WITHIN that
                  // hue. Unthemed tinys keep the page accent.
                  fill={n.rgb
                    ? `rgba(${n.rgb},${(0.4 + n.trust * 0.55).toFixed(2)})`
                    : `rgba(var(--tiny-accent-rgb),${(0.4 + n.trust * 0.55).toFixed(2)})`}
                  stroke={isSel ? "#fff" : n.rgb ? `rgba(${n.rgb},0.9)` : "rgba(var(--tiny-accent-rgb),0.9)"}
                  strokeWidth={isSel ? 2 : 1}
                  style={{ pointerEvents: "none" }}
                />
              )}
              {showLabel && (
                <text
                  x={n.x} y={below && !isSel ? n.y + n.r + 11 * px : n.y - n.r - 4 * px}
                  fontSize={isSel ? 11 * px : 9.5 * px}
                  textAnchor="middle"
                  fill={isSel ? "#fff" : n.kind === "builder" ? "rgba(255,255,255,0.78)" : "rgba(255,255,255,0.65)"}
                  stroke="rgba(10,10,10,0.85)"
                  strokeWidth={3 * px}
                  fontWeight={isSel ? 600 : 400}
                  style={{ pointerEvents: "none", paintOrder: "stroke" }}
                >
                  {n.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* legend — identity is never color-alone (mini is decorative: the
          wrapping link + the list below carry the content). flex-wrap:
          the row's min-content width (~500px unwrapped) was wider than a
          phone viewport, which forced the card — and the whole page —
          into horizontal overflow (caught in the c10 screenshot QA). */}
      {!mini && (
      <div className="px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-400 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full border border-white/40 bg-white/10" /> builder
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: "rgba(var(--tiny-accent-rgb),0.45)" }} />
          <span className="inline-block w-2 h-2 rounded-full -ml-1.5" style={{ background: "rgba(var(--tiny-accent-rgb),0.95)" }} />
          tiny (its own color · brighter = more consulted)
        </span>
        {edges.some((e) => e.kind === "consults") && (
          <span className="flex items-center gap-1">
            <svg width="18" height="6" aria-hidden="true"><line x1="0" y1="3" x2="18" y2="3" stroke="rgba(var(--tiny-accent-rgb),0.7)" strokeWidth="1.5" strokeDasharray="3 3" /></svg>
            consults
          </span>
        )}
        {/* Stars drawn vs tinys that exist: the /community payload embeds ≤8
            tinys per builder, so this footer counted the picture under a label
            that read like a census (v10 A4). constellationFooter qualifies it
            only when the two provably differ. */}
        <span className="ml-auto opacity-60 tabular-nums" {...(footer.title ? { title: footer.title } : {})}>
          {footer.label}
        </span>
      </div>
      )}

      {/* detail strip — tap-first tooltip + the graph's text alternative */}
      {!mini && sel && (
        <div aria-live="polite" className="px-3 py-2 border-t text-[11px] text-gray-300 flex items-center gap-2" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.2)" }}>
          <span className="font-semibold text-white truncate">{sel.label}</span>
          {sel.kind === "tiny" && sel.trust > 0 && (
            <span className="opacity-60 whitespace-nowrap tabular-nums">consulted by other tinys</span>
          )}
          <Link
            href={sel.kind === "builder" ? `/@${sel.login}` : `/${sel.id}`}
            className="ml-auto px-2.5 py-1 rounded-full border text-[11px] whitespace-nowrap neon-chip transition-all hover:scale-105 active:scale-100"
          >
            {sel.kind === "builder" ? "view profile →" : "open tiny →"}
          </Link>
        </div>
      )}
    </div>
  );
}

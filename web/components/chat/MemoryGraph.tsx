"use client";

/**
 * Memory Graph — the Graph Panel viz (idea.md stage 4 UI, the spec's
 * "subgraph walk rendered as connected nodes+labeled edges instead of a
 * flat list").
 *
 * Force-directed node-link layout in plain SVG — no chart lib: the data is
 * structure (identity + relations), not series, and the whole graph is
 * bounded by the 5000-entry memory capacity. Visual grammar matches the
 * panel's chips: accent = live fact, grey = closed history (status, never
 * a categorical rainbow); WITHIN live, fill brightness encodes recency
 * (sequential: fresher = brighter) so the field reads as a timeline, not
 * a flat color. Every node carries a truncated label — at memory-graph
 * scale (~100 nodes) names ARE the point; zooming shrinks the world, not
 * the text, so crowded centers resolve on zoom. Node radius encodes
 * degree (hubs read as hubs); edges are recessive ink with the relation
 * named on selection.
 *
 * Interaction: drag a node to pin intuition into the layout, tap to select
 * (detail card + connected-edge highlight), wheel/pinch zooms, background
 * drag pans. The simulation runs ~300 cooled ticks in rAF and settles.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { pluralize } from "../../lib/utils";

export type VizNode = {
  id: string;
  wire_id: number | string;
  label: string;
  source: string | null;
  freshness: "live" | "closed";
  valid_from?: number;
  valid_to?: number | null;
};

export type VizEdge = {
  id: string;
  src: string;
  dst: string;
  rel: string;
  scope?: string | null;
  valid_to?: number | null;
};

type SimNode = VizNode & { x: number; y: number; vx: number; vy: number; r: number; pinned?: boolean };

const REL_PHRASE: Record<string, string> = {
  supersedes: "supersedes",
  part_of: "part of",
  authored: "authored",
  relates_to: "relates to",
  about: "about",
};

function when(ts?: number | null): string {
  // Coerce + validate (> 0, seconds-since-1970): `!ts` alone lets a non-numeric
  // string (valid_from/valid_to taken raw off /api/graph — MemoryPanel:173 only
  // Array.isArrays the node list, no per-field coercion) through → `ts * 1000`
  // NaN → "Invalid Date" in the selected-node detail row. The sibling
  // MemoryPanel when() / JobsPanel when() / ActivityHUD ago() all guard this;
  // this one was the holdout.
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Node captions with the dataset-common prefix stripped: memories written
 * by the same agent often share boilerplate openings ("GitHub repo
 * cagataycali/…"), and naive truncation would render 40 identical labels.
 * Extend the prefix word-by-word while ≥25% of nodes still share it, then
 * strip it from those nodes — what remains is the distinctive part.
 */
function buildCaptions(nodes: VizNode[]): Map<string, string> {
  const texts = nodes.map((n) => (n.source || n.label || "").replace(/\s+/g, " ").trim());
  let prefix = "";
  for (;;) {
    // Most COMMON next word past the prefix (not the first text's word —
    // the boilerplate cohort is rarely first in the list)
    const counts = new Map<string, number>();
    for (const t of texts) {
      if (!t.startsWith(prefix) || t.length <= prefix.length) continue;
      const m = t.slice(prefix.length).match(/^\S+\s+/);
      if (m) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
    }
    let best = "", bestN = 0;
    counts.forEach((n, word) => { if (n > bestN) { best = word; bestN = n; } });
    if (bestN < Math.max(nodes.length * 0.25, 3)) break;
    prefix += best;
  }
  const out = new Map<string, string>();
  nodes.forEach((n, i) => {
    let t = texts[i];
    if (prefix.length > 4 && t.startsWith(prefix)) t = t.slice(prefix.length);
    out.set(n.id, t.length > 26 ? t.slice(0, 25) + "…" : t);
  });
  return out;
}

export default function MemoryGraph({
  nodes,
  edges,
  onClose: _onClose,
}: {
  nodes: VizNode[];
  edges: VizEdge[];
  onClose?: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  // Physics state lives in a ref (mutated at 60fps); each tick publishes an
  // immutable snapshot into `frame`, which is the ONLY thing render reads —
  // keeps the react-compiler rules happy without copying per-force.
  const simRef = useRef<SimNode[]>([]);
  const [frame, setFrame] = useState<SimNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // viewBox camera: pan on background drag, zoom on wheel
  const [view, setView] = useState({ x: -300, y: -300, w: 600, h: 600 });
  const dragRef = useRef<{ kind: "node" | "pan"; id?: string; lastX: number; lastY: number } | null>(null);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) {
      d.set(e.src, (d.get(e.src) || 0) + 1);
      d.set(e.dst, (d.get(e.dst) || 0) + 1);
    }
    return d;
  }, [edges]);

  // (Re)seed the simulation when the data changes. Deterministic golden-angle
  // spiral seeding — stable layouts across reopens beat random scatter.
  useEffect(() => {
    simRef.current = nodes.map((n, i) => {
      const a = i * 2.39996; // golden angle
      const r = 14 * Math.sqrt(i + 1);
      return {
        ...n,
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        vx: 0,
        vy: 0,
        r: Math.min(6 + (degree.get(n.id) || 0) * 2, 14),
      };
    });

    // Force loop: repulsion + edge springs + weak centering, cooled.
    const byId = new Map(simRef.current.map((n) => [n.id, n]));
    let alpha = 1;
    let raf = 0;
    // One physics integration step — repulsion + springs + centering, cooled.
    // Mutates simRef.current + alpha only; publishing and scheduling live in
    // step()/the reduced-motion path so both can drive the same physics.
    const tick = () => {
      const sim = simRef.current;
      // pairwise repulsion (O(n²) is fine: capacity bounds n ≤ 1000, real
      // graphs are ~100 — measured ~1ms/tick at 100 nodes)
      for (let i = 0; i < sim.length; i++) {
        for (let j = i + 1; j < sim.length; j++) {
          const a = sim[i], b = sim[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = 1; }
          const f = Math.min(2600 / d2, 8) * alpha; // labels need breathing room
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
          if (!b.pinned) { b.vx += fx; b.vy += fy; }
        }
      }
      // springs
      for (const e of edges) {
        const a = byId.get(e.src), b = byId.get(e.dst);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 130) * 0.02 * alpha; // rest length sized for two stacked labels
        const fx = (dx / d) * f, fy = (dy / d) * f;
        if (!a.pinned) { a.vx += fx; a.vy += fy; }
        if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
      }
      // centering + integrate
      for (const n of sim) {
        if (n.pinned) continue;
        n.vx -= n.x * 0.005 * alpha;
        n.vy -= n.y * 0.005 * alpha;
        n.vx *= 0.85; n.vy *= 0.85;
        n.x += n.vx; n.y += n.vy;
      }
      alpha *= 0.995;
    };
    // Settled: fit the camera to the layout once (labels included — hence the
    // generous margin). User pan/zoom takes over from here.
    const fit = () => {
      const sim = simRef.current;
      if (!sim.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of sim) {
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
      const m = 90;
      const w = Math.max(maxX - minX, maxY - minY) + m * 2;
      setView({ x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - w / 2, w, h: w });
    };
    // Reduced motion (WCAG 2.3.3): settle synchronously — the layout appears,
    // no visible fly-apart-and-settle simulation (the settling animation IS
    // motion). Mirrors the guard in UniverseConstellation.tsx:187. The global
    // CSS reduced-motion reset cannot reach this loop — it's JS setState-driven
    // SVG transforms, not a CSS animation/transition.
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      while (alpha > 0.02) tick();
      setFrame(simRef.current.map((n) => ({ ...n })));
      fit();
      return;
    }
    const step = () => {
      tick();
      setFrame(simRef.current.map((n) => ({ ...n })));
      if (alpha > 0.02) raf = requestAnimationFrame(step);
      else fit();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  // Selection resets with the dataset (derived, not an effect)
  const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const selectedSafe = selected && nodeIds.has(selected) ? selected : null;

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
    dragRef.current = { kind: nodeId ? "node" : "pan", id: nodeId, lastX: e.clientX, lastY: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
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
      const h = w; // square aspect
      return { x: p.x - ((p.x - v.x) / v.w) * w, y: p.y - ((p.y - v.y) / v.h) * h, w, h };
    });
  };

  // ⌨️ Keyboard access — the graph was pointer-only. Arrows cycle facts
  // (camera follows off-screen selections), +/- zooms about the center,
  // Escape clears the selection — and only then bubbles on to close the
  // panel (stopPropagation keeps the document-level listener out of it).
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
    // Pan only when the node sits outside the (margin-inset) camera —
    // stepping between neighbors shouldn't judder the view.
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

  // Recency ramp for LIVE fills (sequential-within-status: fresher =
  // brighter accent). Normalized per dataset so the ramp always spans it.
  const captions = useMemo(() => buildCaptions(nodes), [nodes]);
  const recencySpan = useMemo(() => {
    const ts = nodes.filter((n) => n.freshness === "live" && n.valid_from).map((n) => n.valid_from!);
    if (!ts.length) return null;
    const min = Math.min(...ts), max = Math.max(...ts);
    return max > min ? { min, max } : null;
  }, [nodes]);
  const liveFill = (n: VizNode) => {
    if (!recencySpan || !n.valid_from) return "rgba(var(--tiny-accent-rgb),0.85)";
    const t = (n.valid_from - recencySpan.min) / (recencySpan.max - recencySpan.min);
    return `rgba(var(--tiny-accent-rgb),${(0.3 + t * 0.65).toFixed(2)})`;
  };

  const sim = frame;
  const byId = new Map(sim.map((n) => [n.id, n]));
  const sel = selectedSafe ? byId.get(selectedSafe) : null;
  const selEdges = selectedSafe ? edges.filter((e) => e.src === selectedSafe || e.dst === selectedSafe) : [];
  const touching = new Set(selEdges.flatMap((e) => [e.src, e.dst]));
  // Screen-constant type: world units per CSS px — labels keep their pixel
  // size while the world zooms under them.
  const px = view.w / 600;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className="flex-1 min-h-0 touch-none cursor-grab active:cursor-grabbing"
        // role="application" (not "img"): the svg is focusable and drives its
        // own arrow/zoom/Escape keys, so it must pass keystrokes through to
        // the handlers below. role="img" would prune it to a static image and
        // hide the interactivity from AT. The aria-live detail card is the
        // text alternative for the visual node positions.
        role="application"
        tabIndex={0}
        aria-label={`Memory graph: ${pluralize(nodes.length, "fact")}, ${pluralize(edges.length, "link")}. Arrow keys move between facts, plus and minus zoom, Escape clears the selection. Selecting a fact reads its details below.`}
        onPointerDown={(e) => { setSelected(null); onPointerDown(e); }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        {/* edges under nodes — recessive ink; selection lights the incident set */}
        {edges.map((e) => {
          const a = byId.get(e.src), b = byId.get(e.dst);
          if (!a || !b) return null;
          const hot = selectedSafe && (e.src === selectedSafe || e.dst === selectedSafe);
          const closed = e.valid_to != null;
          return (
            <line
              key={e.id}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={hot ? "rgba(var(--tiny-accent-rgb),0.9)" : "rgba(255,255,255,0.16)"}
              strokeWidth={hot ? 2 : 1.2}
              strokeDasharray={closed ? "3 3" : e.rel === "supersedes" ? "6 3" : undefined}
            />
          );
        })}
        {/* rel label on the selected node's edges only (selective labeling) */}
        {selEdges.slice(0, 6).map((e) => {
          const a = byId.get(e.src), b = byId.get(e.dst);
          if (!a || !b) return null;
          return (
            <text
              key={`lbl-${e.id}`}
              x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4}
              fontSize={9 * px}
              textAnchor="middle"
              fill="rgba(var(--tiny-accent-rgb),0.9)"
              stroke="rgba(10,10,10,0.85)"
              strokeWidth={3 * px}
              style={{ pointerEvents: "none", paintOrder: "stroke" }}
            >
              {REL_PHRASE[e.rel] || e.rel}{e.scope ? ` · ${e.scope}` : ""}
            </text>
          );
        })}
        {nodes.length === 0 && (
          <text x={view.x + view.w / 2} y={view.y + view.h / 2} textAnchor="middle" fontSize={14} fill="rgba(255,255,255,0.4)">
            No memories yet
          </text>
        )}
        {sim.map((n, i) => {
          const isSel = n.id === selectedSafe;
          const dim = selectedSafe && !touching.has(n.id) && !isSel;
          const closed = n.freshness === "closed";
          // Alternate label side — connected nodes cluster (springs), so
          // same-side labels collide; alternation halves that.
          const below = i % 2 === 1;
          return (
            <g key={n.id} opacity={dim ? 0.25 : 1}>
              {/* hit target ≥ the mark (interaction rule) */}
              <circle
                cx={n.x} cy={n.y} r={Math.max(n.r + 8, 14)}
                fill="transparent"
                className="cursor-pointer"
                onPointerDown={(e) => onPointerDown(e, n.id)}
                onClick={(e) => { e.stopPropagation(); setSelected(isSel ? null : n.id); }}
              />
              <circle
                cx={n.x} cy={n.y} r={n.r}
                fill={closed ? "rgba(255,255,255,0.22)" : liveFill(n)}
                stroke={isSel ? "#fff" : closed ? "rgba(255,255,255,0.35)" : "rgba(var(--tiny-accent-rgb),1)"}
                strokeWidth={isSel ? 2 : 1}
                style={{ pointerEvents: "none" }}
              />
              {/* Labels are the viz at this scale — but density-gated:
                  zoomed out, only connected nodes (the structure) and the
                  selection speak; zooming past ~2x reveals every caption.
                  Screen-constant size; paint-order stroke keeps text
                  readable over edges. */}
              {(isSel || n.r > 6 || px < 0.9) && (
                <text
                  x={n.x} y={below && !isSel ? n.y + n.r + 11 * px : n.y - n.r - 4 * px}
                  fontSize={isSel ? 11 * px : 9.5 * px}
                  textAnchor="middle"
                  fill={isSel ? "#fff" : closed ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.78)"}
                  stroke="rgba(10,10,10,0.85)"
                  strokeWidth={3 * px}
                  fontWeight={isSel ? 600 : 400}
                  style={{ pointerEvents: "none", paintOrder: "stroke" }}
                >
                  {isSel ? `#${n.wire_id} · ${captions.get(n.id)}` : captions.get(n.id)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* legend — identity is never color-alone */}
      <div className="px-3 py-1.5 flex items-center gap-3 text-[10px] text-gray-400 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: "rgba(var(--tiny-accent-rgb),0.35)" }} />
          <span className="inline-block w-2 h-2 rounded-full -ml-1.5" style={{ background: "rgba(var(--tiny-accent-rgb),0.95)" }} />
          live (brighter = newer)
        </span>
        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-white/25" /> closed</span>
        <span className="flex items-center gap-1"><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeDasharray="6 3" /></svg> supersedes</span>
        <span className="ml-auto opacity-60">{pluralize(nodes.length, "fact")} · {pluralize(edges.length, "link")}</span>
      </div>

      {/* detail card for the selected fact (the graph's "tooltip" — tap-first
          because the panel is touch-heavy; also the text alternative) */}
      {sel && (
        // aria-live: keyboard/AT users hear each selection — this card IS
        // the graph's text alternative, so it must speak when it changes
        <div aria-live="polite" className="px-3 py-2 border-t text-[11px] text-gray-300 space-y-1 max-h-28 overflow-y-auto" style={{ borderColor: "rgba(var(--tiny-accent-rgb),0.2)" }}>
          <div className="flex items-center gap-1.5 text-white">
            <span>{sel.freshness === "closed" ? "⚪" : "🟢"}</span>
            <span className="font-semibold">#{sel.wire_id}</span>
            <span className="opacity-50">
              learned {when(sel.valid_from)}{sel.valid_to ? ` · closed ${when(sel.valid_to)}` : ""}
            </span>
          </div>
          <div>{sel.source || sel.label}</div>
          {selEdges.length > 0 && (
            <div className="opacity-60">{pluralize(selEdges.length, "link")} — highlighted above</div>
          )}
        </div>
      )}
    </div>
  );
}

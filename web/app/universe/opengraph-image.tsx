import { ImageResponse } from 'next/og';
import { normalizeCommunity, compact, hexRgb } from '@/lib/community';

/**
 * 🌌 /universe OG card — a real constellation snapshot, not a stock hero.
 * Runs the same force layout the page's UniverseConstellation runs (golden-
 * angle seed → repulsion + ownership/consult springs + centering, cooled),
 * synchronously and deterministically (no randomness → stable unfurls),
 * then draws it as SVG inside ImageResponse. Follows the /og/[slug] house
 * rules: edge runtime, 10s fetch bound, never-500 branded fallback.
 */

export const runtime = 'edge';
export const alt = 'The Tiny Universe — a live constellation of builders and their public tinys';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const ACCENT = '#00FF88';

type N = { x: number; y: number; vx: number; vy: number; r: number; kind: 'b' | 't'; glow: number; rgb?: string };
type E = { a: number; b: number; consult: boolean };

function layout(users: ReturnType<typeof normalizeCommunity>['users'], trust: Record<string, number>, consults: { src: string; dst: string }[]) {
  // Cap for edge-CPU headroom: 30 builders × ≤8 tinys ≈ 270 nodes worst case,
  // 150 cooled ticks ≈ a few million float ops — comfortably under the limit.
  const capped = users.slice(0, 30);
  const maxTrust = Math.max(...Object.values(trust), 0.0001);
  const nodes: N[] = [];
  const edges: E[] = [];
  const idx = new Map<string, number>();
  for (const u of capped) {
    const hub = nodes.length;
    idx.set(`@${u.login}`, hub);
    nodes.push({ x: 0, y: 0, vx: 0, vy: 0, r: Math.min(10 + u.tinys.length, 16), kind: 'b', glow: 0 });
    for (const t of u.tinys) {
      const i = nodes.length;
      idx.set(t.name, i);
      const tn = (trust[t.name] || 0) / maxTrust;
      nodes.push({ x: 0, y: 0, vx: 0, vy: 0, r: 5 + tn * 5, kind: 't', glow: tn, rgb: t.accent ? hexRgb(t.accent) : undefined });
      edges.push({ a: hub, b: i, consult: false });
    }
  }
  for (const c of consults) {
    const a = idx.get(c.src), b = idx.get(c.dst);
    if (a !== undefined && b !== undefined) edges.push({ a, b, consult: true });
  }
  nodes.forEach((n, i) => {
    const ang = i * 2.39996;
    const rad = 16 * Math.sqrt(i + 1);
    n.x = Math.cos(ang) * rad;
    n.y = Math.sin(ang) * rad;
  });
  let alpha = 1;
  for (let tick = 0; tick < 150; tick++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = i % 2 ? 0.5 : -0.5; dy = j % 2 ? 0.5 : -0.5; d2 = 1; }
        const f = Math.min(2200 / d2, 8) * alpha;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - (e.consult ? 140 : 72)) * (e.consult ? 0.008 : 0.025) * alpha;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    for (const n of nodes) {
      n.vx -= n.x * 0.006 * alpha;
      n.vy -= n.y * 0.006 * alpha;
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
    }
    alpha *= 0.98;
  }
  // Fit into the card with margin, preserving aspect
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const m = 70;
  const s = Math.min((size.width - m * 2) / Math.max(maxX - minX, 1), (size.height - m * 2) / Math.max(maxY - minY, 1));
  for (const n of nodes) {
    n.x = (n.x - (minX + maxX) / 2) * s + size.width / 2;
    n.y = (n.y - (minY + maxY) / 2) * s + size.height / 2;
    n.r *= Math.min(s, 1.4);
  }
  return { nodes, edges };
}

export default async function Image() {
  const data = await fetch('https://plugin.tiny.technology/community?limit=100', {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json()).catch(() => null);

  try {
    const { users, trust, consults, totalMessages, totalPublicTinys, totalUsers } = normalizeCommunity(data);
    if (!users.length) throw new Error('empty');
    // `users` is one page; totalUsers is the real COUNT(*). The card printed the
    // page length as "N builders" next to a genuine totalPublicTinys total —
    // and a social card is the one surface nobody can hover for a caveat, so it
    // gets the true number with no qualifier rather than a hedge (v10 A4).
    const builderCount = totalUsers !== undefined && totalUsers >= users.length ? totalUsers : users.length;
    const { nodes, edges } = layout(users, trust, consults);

    return new ImageResponse(
      (
        <div style={{ width: '100%', height: '100%', display: 'flex', backgroundColor: '#000', fontFamily: 'sans-serif', position: 'relative' }}>
          <svg width={size.width} height={size.height} style={{ position: 'absolute', top: 0, left: 0 }}>
            {edges.map((e, i) => (
              <line
                key={`e${i}`}
                x1={nodes[e.a].x} y1={nodes[e.a].y} x2={nodes[e.b].x} y2={nodes[e.b].y}
                stroke={e.consult ? 'rgba(0,255,136,0.4)' : 'rgba(255,255,255,0.14)'}
                strokeWidth={e.consult ? 1.6 : 1.2}
                strokeDasharray={e.consult ? '4 4' : undefined}
              />
            ))}
            {nodes.map((n, i) => (
              n.kind === 'b' ? (
                <circle key={`n${i}`} cx={n.x} cy={n.y} r={n.r} fill="rgba(255,255,255,0.08)" stroke="rgba(0,255,136,0.55)" strokeWidth={1.5} />
              ) : (
                <circle key={`n${i}`} cx={n.x} cy={n.y} r={n.r} fill={`rgba(${n.rgb || '0,255,136'},${(0.4 + n.glow * 0.55).toFixed(2)})`} />
              )
            ))}
          </svg>
          {/* Text panel — bottom-left, over a dark wash so stars never fight the words */}
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', padding: '48px 64px', backgroundImage: 'linear-gradient(0deg, rgba(0,0,0,0.85), rgba(0,0,0,0))' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ width: '14px', height: '14px', borderRadius: '50%', background: ACCENT, boxShadow: '0 0 20px rgba(0,255,136,0.8)' }} />
              <div style={{ color: ACCENT, fontSize: '26px' }}>tiny.technology/universe</div>
            </div>
            <div style={{ color: '#fff', fontSize: '64px', fontWeight: 700, marginTop: '8px' }}>The Tiny Universe</div>
            <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: '28px', marginTop: '6px' }}>
              {`${totalMessages > 0 ? `${compact(totalMessages)} messages · ` : ''}${builderCount} builders · ${totalPublicTinys} public tinys — built by chatting`}
            </div>
          </div>
        </div>
      ),
      { width: size.width, height: size.height },
    );
  } catch {
    // Never 500 a social card (house rule, /og/[slug]) — branded fallback.
    return new ImageResponse(
      (
        <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', fontFamily: 'sans-serif' }}>
          <div style={{ color: ACCENT, fontSize: '64px', fontWeight: 700 }}>The Tiny Universe</div>
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '30px', marginTop: '12px' }}>tiny.technology/universe</div>
        </div>
      ),
      { width: size.width, height: size.height },
    );
  }
}

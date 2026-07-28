import { getSession } from "@/lib/auth";

export const runtime = "edge";

/**
 * Per-user trusted tool repo owners (issue #15 trust model).
 *
 * install_tool only accepts raw.githubusercontent.com URLs from the global
 * allowlist OR owners the user explicitly trusted here. Trust is a USER
 * action (slash command → this route) — the model cannot self-expand it,
 * which is the point.
 *
 * Storage: user_prefs key `trusted_tool_owners` = JSON array of GitHub
 * owner logins, hard cap 20.
 */

const PREF_KEY = "trusted_tool_owners";
const MAX_OWNERS = 20;
const OWNER_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,38})$/; // GitHub login rules

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// 10s bound on both prefs round-trips — neither had a timeout, so a hung
// worker would pin the invocation to CF wall-clock. AbortError falls into
// each fetch's existing .catch (readOwners → [], writeOwners → false → 502),
// so the degrade contract is unchanged.
const T = () => ({ signal: AbortSignal.timeout(10_000) });

async function readOwners(userId: string): Promise<string[]> {
  const r = await fetch(
    `https://plugin.tiny.technology/prefs?userId=${encodeURIComponent(userId)}&key=${PREF_KEY}`,
    { headers: { "X-Internal-Key": process.env.INTERNAL_API_KEY || "" }, ...T() }
  ).then((res) => res.json()).catch(() => ({ value: null }));
  try {
    const arr = JSON.parse(r.value || "[]");
    return Array.isArray(arr) ? arr.filter((o) => typeof o === "string") : [];
  } catch {
    return [];
  }
}

// Returns true iff the prefs write actually persisted. The worker being
// down/non-JSON must surface as a clean error, not an unhandled 500 out of
// the POST/DELETE handler (which awaits this bare) — and it must NOT report
// success for a write that didn't land.
async function writeOwners(userId: string, owners: string[]): Promise<boolean> {
  return fetch("https://plugin.tiny.technology/prefs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": process.env.INTERNAL_API_KEY || "",
    },
    body: JSON.stringify({ userId, key: PREF_KEY, value: JSON.stringify(owners) }),
    ...T(),
  }).then((r) => r.ok).catch(() => false);
}

export async function GET(req: Request) {
  const session = await getSession(req);
  if (!session) return json({ error: "login required" }, 401);
  return json({ ok: true, owners: await readOwners(session.sub) });
}

export async function POST(req: Request) {
  const session = await getSession(req);
  if (!session) return json({ error: "login required" }, 401);
  const { owner } = await req.json().catch(() => ({}));
  const o = String(owner || "").trim();
  if (!OWNER_RE.test(o)) return json({ error: "invalid GitHub owner name" }, 400);

  const owners = await readOwners(session.sub);
  if (owners.some((x) => x.toLowerCase() === o.toLowerCase())) {
    return json({ ok: true, owners, note: "already trusted" });
  }
  if (owners.length >= MAX_OWNERS) return json({ error: `max ${MAX_OWNERS} trusted owners` }, 400);
  owners.push(o);
  if (!(await writeOwners(session.sub, owners))) {
    return json({ error: "couldn't save — try again in a moment" }, 502);
  }
  return json({ ok: true, owners });
}

export async function DELETE(req: Request) {
  const session = await getSession(req);
  if (!session) return json({ error: "login required" }, 401);
  const { owner } = await req.json().catch(() => ({}));
  const o = String(owner || "").trim().toLowerCase();
  const owners = (await readOwners(session.sub)).filter((x) => x.toLowerCase() !== o);
  if (!(await writeOwners(session.sub, owners))) {
    return json({ error: "couldn't save — try again in a moment" }, 502);
  }
  return json({ ok: true, owners });
}

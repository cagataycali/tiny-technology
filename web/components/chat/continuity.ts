/**
 * Continuity layer (careless-inspired) — turn log + persistent memories.
 *
 * Both live in localStorage, scoped per-tiny. They survive /clear, page
 * reloads, and the 31-message history trim by being injected as a system
 * message on every request (the chat route folds system messages into the
 * agent system prompt).
 */

export type TurnEntry = { q: string; a: string; ts: number };
export type MemoryEntry = { id: string; content: string; tags?: string[]; ts: number };

const TURN_LOG_MAX = 200;
const TURN_LOG_INJECT = 20;
const MEMORY_MAX = 100;

const turnKey = (name: string) => `tiny_turnlog_${name}`;
const memKey = (name: string) => `tiny_memories_${name}`;

function read<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    // Shape, not just parse (getRing precedent in platform.ts): a
    // corrupted value that's valid-but-non-array JSON ({} or "5") would
    // flow to .push/.filter/.map at the call sites and throw there.
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * ⚠️ Returns WHETHER the write landed (v13 G2). It used to swallow into void,
 * and the callers above it state outcomes as fact: "🧠 Memory stored", "🧠
 * Memory forgotten", and — via `runVoiceTool` — `{ ok: true, stored: true }`
 * back to the MODEL. On a browser where `setItem` throws (Safari Private
 * Browsing, or storage full from the large `chat_messages_*` blobs — the exact
 * case `ModelSettings.tsx` already guards for) every one of those claims was
 * false.
 *
 * The forget direction is the one that does harm, measured: `forgetMemory`
 * filtered the array, saw it shrink, and returned `true` while the store was
 * untouched — so the user was told a fact was forgotten and
 * `buildContinuityContext` kept injecting it into every subsequent request.
 * "I forgot your address" followed by the address, forever.
 */
function write<T>(key: string, items: T[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

/**
 * Same, for the removals. `removeItem` throws SecurityError when site data is
 * fully blocked — and `/forgetall` runs `clearMemories` then `clearTurnLog`
 * then toasts, all inside an async IIFE, so a throw from the FIRST skipped the
 * second AND the toast and surfaced as an unhandled rejection: the user saw
 * nothing at all and half the wipe silently didn't happen.
 */
function drop(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// ── Turn log ────────────────────────────────────────────────────────────────

export function appendTurn(name: string, q: string, a: string) {
  if (!q?.trim() || !a?.trim()) return;
  const log = read<TurnEntry>(turnKey(name));
  log.push({ q: q.slice(0, 500), a: a.slice(0, 800), ts: Date.now() });
  // Deliberately still void. Nothing claims a turn was logged — it is
  // background bookkeeping after every reply, and a toast per turn would be
  // noise. A legitimate silence is a pass (G2's own rule).
  write(turnKey(name), log.slice(-TURN_LOG_MAX));
}

export function getTurnLog(name: string): TurnEntry[] {
  return read<TurnEntry>(turnKey(name));
}

export function clearTurnLog(name: string): boolean {
  return drop(turnKey(name));
}

// ── Memories ────────────────────────────────────────────────────────────────

/** True only when the memory is actually durable. An empty content is `false`
 *  too — nothing was stored, and the caller's "stored" claim would be equally
 *  untrue. */
export function addMemory(name: string, content: string, tags?: string[]): boolean {
  if (!content?.trim()) return false;
  const mems = read<MemoryEntry>(memKey(name));
  mems.push({
    id: Math.random().toString(36).slice(2),
    content: content.slice(0, 1000),
    tags,
    ts: Date.now(),
  });
  return write(memKey(name), mems.slice(-MEMORY_MAX));
}

export function getMemories(name: string): MemoryEntry[] {
  return read<MemoryEntry>(memKey(name));
}

/**
 * Why three states and not a boolean: "nothing matched" and "storage refused
 * the write" are different facts, and a caller that tells the user the wrong
 * one has diagnosed them confidently and wrongly — "couldn't forget, storage is
 * full" sends someone to clear their browser data over a typo'd match string.
 *
 * ⚠️ Only "forgotten" means the fact stopped reaching the model. Before v13 G2
 * a blocked write also reported success: the array shrank in memory, the toast
 * fired, and `buildContinuityContext` kept injecting the "forgotten" fact into
 * every later request.
 */
export type ForgetOutcome = "forgotten" | "no-match" | "blocked";

export function forgetMemoryOutcome(name: string, idOrText: string): ForgetOutcome {
  // idOrText arrives straight from the model's forget tool call —
  // undefined would throw on .toLowerCase() mid-stream, and "" substring-
  // matches EVERY memory (includes("") is always true): an empty forget
  // must not silently wipe the store.
  if (typeof idOrText !== "string" || !idOrText.trim()) return "no-match";
  const mems = read<MemoryEntry>(memKey(name));
  const filtered = mems.filter(
    (m) => m.id !== idOrText && !m.content.toLowerCase().includes(idOrText.toLowerCase())
  );
  // The shrink is NECESSARY but not sufficient — the write has to land too.
  if (filtered.length === mems.length) return "no-match";
  return write(memKey(name), filtered) ? "forgotten" : "blocked";
}

/**
 * The boolean form, kept because it IS the `forget` tool's result contract (the
 * model is told `{ removed }`). Delegates so the predicate has exactly one
 * implementation — two copies of "did this match and land?" is how the two
 * answers drift apart.
 */
export function forgetMemory(name: string, idOrText: string): boolean {
  return forgetMemoryOutcome(name, idOrText) === "forgotten";
}

export function clearMemories(name: string): boolean {
  return drop(memKey(name));
}

// ── Context injection ───────────────────────────────────────────────────────

/** Build a system-message string carrying turn log + memories. Empty if none. */
export function buildContinuityContext(name: string): string {
  const parts: string[] = [];

  const mems = getMemories(name);
  if (mems.length > 0) {
    parts.push(
      "## Persistent Memories (stored via remember tool, survives resets):\n" +
        mems.map((m) => `- ${m.content}${m.tags?.length ? ` [${m.tags.join(", ")}]` : ""}`).join("\n")
    );
  }

  const log = getTurnLog(name).slice(-TURN_LOG_INJECT);
  if (log.length > 0) {
    parts.push(
      `## Continuous Turn Log (last ${log.length} turns, survives history clears):\n` +
        log
          .map((t) => {
            const d = new Date(t.ts);
            const time = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
            return `[${time}] user: ${t.q}\n→ you: ${t.a}`;
          })
          .join("\n")
    );
  }

  return parts.join("\n\n");
}

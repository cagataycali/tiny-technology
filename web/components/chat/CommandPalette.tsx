"use client";

/**
 * Command palette (issue #11, careless pattern):
 *   Commands      — slash commands + actions (fuzzy, recent-first)
 *   Conversations — past chats in this browser (chat_messages_* scan)
 *   Tinys         — fuzzy-search the universe, jump to any tiny
 *   Ask           — send the query straight to the current tiny
 *
 * Keyboard-first: ⌘⇧K opens, arrows navigate across sections, enter runs,
 * esc closes. Recents persist per browser.
 */
import { IconChat } from "./icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOverlayExit } from "../../lib/chat/use-overlay-exit";
import { useFocusTrap } from "../../lib/chat/use-focus-trap";
import { pluralize } from "../../lib/utils";
import { chatMetaKey, deriveChatMeta } from "../../lib/chat/persist";

export type PaletteCommand = {
  name: string;
  description: string;
  shortcut?: string;
  action: () => void;
};

type Item =
  | { kind: "command"; cmd: PaletteCommand }
  | { kind: "tiny"; name: string }
  | { kind: "conversation"; conv: LocalConversation }
  | { kind: "ask"; text: string };

type LocalConversation = {
  tiny: string;
  count: number;
  snippet: string; // last user message, for fuzzy match + display
};

// Past conversations live in localStorage as chat_messages_<tiny>. The
// palette reads their chat_meta_<tiny> siblings (written on every persist,
// lib/chat/persist) — parsing full multi-MB transcripts on every ⌘K made
// open jank scale with total history size (v4 C12). A legacy transcript
// without meta is parsed ONCE and backfilled. Exported for tests.
export function getLocalConversations(currentTiny: string): LocalConversation[] {
  const out: LocalConversation[] = [];
  try {
    const tinys: string[] = [];
    const hasMeta = new Set<string>();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith("chat_meta_")) hasMeta.add(key.slice("chat_meta_".length));
      else if (key.startsWith("chat_messages_")) tinys.push(key.slice("chat_messages_".length));
    }
    for (const tiny of tinys) {
      if (!tiny || tiny === currentTiny) continue;
      if (hasMeta.has(tiny)) {
        try {
          const meta = JSON.parse(localStorage.getItem(chatMetaKey(tiny)) || "null");
          if (meta && typeof meta.count === "number") {
            if (meta.count > 0) out.push({ tiny, count: meta.count, snippet: String(meta.snippet || "") });
            continue; // valid meta answered — the transcript stays unread
          }
        } catch { /* corrupt meta → fall through to the one-time reparse */ }
      }
      try {
        const msgs = JSON.parse(localStorage.getItem(`chat_messages_${tiny}`) || "[]");
        if (!Array.isArray(msgs) || msgs.length === 0) continue;
        const meta = deriveChatMeta(msgs);
        // Backfill so the NEXT open reads only the meta blob.
        try { localStorage.setItem(chatMetaKey(tiny), JSON.stringify(meta)); } catch { }
        out.push({ tiny, count: meta.count, snippet: meta.snippet });
      } catch { }
    }
  } catch { }
  return out;
}

const RECENTS_KEY = "tiny_palette_recents";
const MAX_RECENTS = 5;

// Subsequence fuzzy match (issue #11): "shr" hits "share", "mem" hits
// "memories". Returns a score (lower = better, contiguous runs win) or
// null on no match.
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase(), t = target.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx !== -1) return idx; // substring beats scattered subsequence
  let ti = 0, gaps = 0, last = -1;
  for (let qi = 0; qi < q.length; qi++) {
    ti = t.indexOf(q[qi], ti);
    if (ti === -1) return null;
    if (last !== -1) gaps += ti - last - 1;
    last = ti;
    ti += 1;
  }
  return 100 + gaps; // any subsequence ranks below any substring hit
}

function getRecents(): string[] {
  // Shape guard: a corrupt RECENTS_KEY (valid-but-non-array JSON) would reach
  // the sections useMemo's recents.indexOf() and crash the palette on render.
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : [];
  } catch { return []; }
}
function pushRecent(name: string) {
  try {
    const r = getRecents().filter((n) => n !== name);
    r.unshift(name);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(r.slice(0, MAX_RECENTS)));
  } catch { }
}

export default function CommandPalette({
  open,
  onClose,
  commands,
  onAsk,
  currentTiny,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
  onAsk?: (text: string) => void;
  currentTiny?: string;
}) {
  // Remount per open — fresh query/selection without reset effects
  if (!open) return null;
  return <PalettePanel onClose={onClose} commands={commands} onAsk={onAsk} currentTiny={currentTiny} />;
}

function PalettePanel({
  onClose,
  commands,
  onAsk,
  currentTiny,
}: {
  onClose: () => void;
  commands: PaletteCommand[];
  onAsk?: (text: string) => void;
  currentTiny?: string;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [tinys, setTinys] = useState<string[]>([]);
  // Distinguish "universe still loading" / "couldn't reach it" from "no tiny
  // matches your query" — a silent fetch left the Tinys section invisibly
  // absent during the round-trip and forever gone on failure, so a user
  // searching a real tiny name saw "Nothing matches" with no hint it was a
  // network blip. Mirrors the loaded/failed flags in ActivityHUD/UniverseDrawer.
  const [tinysState, setTinysState] = useState<"loading" | "ready" | "failed">("loading");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Tab must not walk out of the aria-modal palette into the inert page —
  // the result rows are real <button>s, so without the trap Tab exits after
  // the last option (WCAG 2.4.3). Panel remounts per open, so always active.
  useFocusTrap(panelRef);
  // Exit choreography (shared pass-97 pattern) for DISMISSALS — running
  // an item keeps the instant onClose (focus follows the action). The
  // unmount cleanup below already restores focus to the opener.
  const { requestClose, exitClass, onAnimationEnd } = useOverlayExit(onClose);

  // Keep the keyboard selection visible — beyond ~8 items the highlight
  // would move outside the 360px viewport and arrows navigate blind.
  // 'nearest' avoids re-centering jumps; mouse moves don't scroll (hover
  // sets selection on an already-visible item).
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  // localStorage scan is sync + cheap at palette-open frequency
  const conversations = useMemo(() => getLocalConversations(currentTiny || ""), [currentTiny]);

  // Universe tiny list (public names) — one fetch per palette open
  useEffect(() => {
    // 10s bound so a hung worker can't leave the section stuck "loading…"
    // forever (the palette has no other timeout on this fetch).
    // Gate on r.ok BEFORE parsing (sibling UniverseDrawer.tsx does the same and
    // documents why): a worker 5xx/4xx carrying a JSON error body parses fine,
    // so without this its `{error}` normalizes to `d.keys=undefined → []` and
    // sets state "ready" — a masked-empty. The "failed" render branches below
    // (empty-state hint + pending-section banner) would then be unreachable on
    // the most common outage mode, and a user searching a real tiny name is
    // told "Nothing matches" instead of "couldn't reach the universe". .catch
    // alone only covers network reject / timeout / non-JSON.
    fetch("https://plugin.tiny.technology/list?limit=100", { signal: AbortSignal.timeout(10_000) })
      .then((r) => { if (!r.ok) throw new Error(`list ${r.status}`); return r.json(); })
      .then((d) => { setTinys((d.keys || []).map((k: any) => k.name)); setTinysState("ready"); })
      .catch(() => setTinysState("failed"));
  }, []);

  const sections = useMemo(() => {
    const q = query.toLowerCase().trim();
    const recents = getRecents();

    // Fuzzy on name + description, best score first, recents break ties
    const cmds = commands
      .map((c) => {
        const s = q
          ? Math.min(fuzzyScore(q, c.name) ?? Infinity, fuzzyScore(q, c.description) ?? Infinity)
          : 0;
        return { c, s };
      })
      .filter((x) => x.s !== Infinity)
      .sort((a, b) => {
        if (a.s !== b.s) return a.s - b.s;
        const ra = recents.indexOf(a.c.name), rb = recents.indexOf(b.c.name);
        return (ra === -1 ? MAX_RECENTS : ra) - (rb === -1 ? MAX_RECENTS : rb);
      })
      .map((x) => x.c);

    const tinyMatches = q
      ? tinys
          .map((t) => ({ t, s: fuzzyScore(q, t) }))
          .filter((x) => x.s !== null)
          .sort((a, b) => (a.s as number) - (b.s as number))
          .slice(0, 5)
          .map((x) => x.t)
      : tinys.slice(0, 3);

    const convMatches = q
      ? conversations
          .map((conv) => ({ conv, s: Math.min(fuzzyScore(q, conv.tiny) ?? Infinity, fuzzyScore(q, conv.snippet) ?? Infinity) }))
          .filter((x) => x.s !== Infinity)
          .sort((a, b) => a.s - b.s)
          .slice(0, 4)
          .map((x) => x.conv)
      : conversations.slice(0, 3);

    const items: { title: string; items: Item[] }[] = [];
    if (cmds.length) items.push({ title: "Commands", items: cmds.map((cmd) => ({ kind: "command", cmd })) });
    if (convMatches.length) items.push({ title: "Conversations", items: convMatches.map((conv) => ({ kind: "conversation", conv })) });
    if (tinyMatches.length) items.push({ title: "Tinys", items: tinyMatches.map((name) => ({ kind: "tiny", name })) });
    if (q && onAsk) items.push({ title: "Ask", items: [{ kind: "ask", text: query }] });
    return items;
  }, [query, commands, tinys, conversations, onAsk]);

  const flat: Item[] = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // Re-clamp the keyboard selection when the result set SHRINKS under it. flat
  // recomputes when the async `tinys` fetch resolves (dep below) or tinysState
  // flips — so after ArrowDown moved `selected` deep into a large list, a
  // narrower async result set (or a dropped Tinys section) would leave
  // `selected` past the end: aria-activedescendant points at a
  // `palette-opt-N` that no longer exists (SR announces nothing, WCAG 4.1.2)
  // and Enter no-ops (flat[selected] undefined) until the next keystroke.
  // onChange resets to 0 only on TYPING; an async list change needs this.
  useEffect(() => {
    setSelected((s) => (s > flat.length - 1 ? Math.max(0, flat.length - 1) : s));
  }, [flat.length]);

  useEffect(() => {
    // Remember the opener BEFORE stealing focus into the search input;
    // restore on close so keyboard users keep their place.
    const opener = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      clearTimeout(t);
      try { opener?.focus(); } catch { }
    };
  }, []);

  // Escape must close from ANY focus position, not just the search input. The
  // Tab-trap deliberately lets focus move onto the result <button role=option>
  // rows (WCAG 2.4.3), and those buttons have no Escape handler — so an
  // input-scoped Escape (the old onKeyDown branch) went dead the moment a
  // keyboard user Tabbed into the list, leaving no key to dismiss the modal.
  // A window-level listener (the shared grammar every sibling overlay uses —
  // UniverseDrawer:127, MemoryPanel:266, JobsPanel:171) fixes it. Panel
  // remounts per open, so plain register-on-mount is correct (no open gate).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const run = (item: Item) => {
    onClose();
    if (item.kind === "command") {
      pushRecent(item.cmd.name);
      item.cmd.action();
    } else if (item.kind === "tiny") {
      window.location.href = `/${item.name}`;
    } else if (item.kind === "conversation") {
      // History auto-loads from localStorage on that tiny's page
      window.location.href = `/${item.conv.tiny}`;
    } else {
      onAsk?.(item.text);
    }
  };

  let flatIndex = -1; // running index across sections for selection highlight

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center pt-[15vh] p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
      onClick={requestClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={`w-full max-w-lg rounded-2xl border overflow-hidden ${exitClass}`}
        onAnimationEnd={onAnimationEnd}
        style={{
          background: "rgba(10,10,10,0.97)",
          borderColor: "rgba(var(--tiny-accent-rgb),0.25)",
          boxShadow: "0 0 40px rgba(var(--tiny-accent-rgb),0.1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Search commands, tinys, and conversations"
          aria-expanded={flat.length > 0}
          aria-autocomplete="list"
          aria-controls="palette-results"
          // Point AT at the active option so ArrowUp/Down are announced —
          // without this the visual highlight moves silently for SR users.
          aria-activedescendant={flat.length ? `palette-opt-${selected}` : undefined}
          className="w-full px-5 py-4 text-base bg-transparent outline-none"
          style={{ color: "white", borderBottom: "1px solid rgba(var(--tiny-accent-rgb),0.15)" }}
          placeholder="Commands, tinys, or just ask… (⌘⇧K)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
          onKeyDown={(e) => {
            // Escape is handled by the window-level listener (works from the
            // result rows too, where this input handler never fires).
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, flat.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && flat[selected]) {
              e.preventDefault();
              run(flat[selected]);
            }
          }}
        />
        <div ref={listRef} id="palette-results" className="max-h-[360px] overflow-y-auto py-1" role="listbox" aria-label="Palette results">
          {flat.length === 0 && (
            <div className="px-5 py-4 text-sm opacity-40">
              {query
                ? tinysState === "loading"
                  ? "Searching the universe…"
                  : tinysState === "failed"
                    ? <>Nothing matches “{query}” — couldn&apos;t reach the universe to check tinys</>
                    : <>Nothing matches “{query}”</>
                : "Type to search commands, tinys, conversations"}
            </div>
          )}
          {/* When other sections DO match but the universe list is still
              settling, tell the user the Tinys section is pending rather than
              silently omitting it (they may be waiting on a tiny-name match). */}
          {flat.length > 0 && query && tinysState !== "ready" && (
            <div role="status" className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-wider opacity-40 text-white">
              Tinys · {tinysState === "loading" ? "searching the universe…" : "couldn't reach the universe"}
            </div>
          )}
          {sections.map((section) => (
            <div key={section.title}>
              <div className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-wider opacity-40 text-white">
                {section.title}
              </div>
              {section.items.map((item) => {
                flatIndex += 1;
                const i = flatIndex;
                return (
                  <button
                    key={`${section.title}-${i}`}
                    id={`palette-opt-${i}`}
                    data-idx={i}
                    role="option"
                    aria-selected={i === selected}
                    className="w-full text-left px-5 py-2.5 flex items-center justify-between transition-colors"
                    style={{ background: i === selected ? "rgba(var(--tiny-accent-rgb),0.08)" : "transparent" }}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => run(item)}
                  >
                    {item.kind === "command" ? (
                      <>
                        <div>
                          <div className="text-sm" style={{ color: "var(--tiny-accent)" }}>/{item.cmd.name}</div>
                          <div className="text-xs opacity-50 text-white">{item.cmd.description}</div>
                        </div>
                        {item.cmd.shortcut && (
                          <span className="text-[10px] opacity-40 text-white font-mono">{item.cmd.shortcut}</span>
                        )}
                      </>
                    ) : item.kind === "conversation" ? (
                      <div className="text-sm min-w-0">
                        <span style={{ color: "var(--tiny-accent)" }}>↩ /{item.conv.tiny}</span>
                        <span className="text-xs opacity-50 text-white ml-2">{pluralize(item.conv.count, "msg")}</span>
                        {item.conv.snippet && (
                          <div className="text-xs opacity-40 text-white truncate">{item.conv.snippet}</div>
                        )}
                      </div>
                    ) : item.kind === "tiny" ? (
                      <div className="text-sm" style={{ color: "var(--tiny-accent)" }}>
                        ◈ /{item.name}
                        <span className="text-xs opacity-50 text-white ml-2">open tiny</span>
                      </div>
                    ) : (
                      <div className="text-sm text-white">
                        <IconChat className="w-3.5 h-3.5 inline-block align-[-2px] mr-1" /> Ask: <span className="opacity-70">“{item.text}”</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

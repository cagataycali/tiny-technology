// NOT "use client": app/api/archives (edge route) imports buildArchive for
// the server-side redaction pass. A client directive here turns that import
// into a client-reference stub on Vercel — calling it 500s the POST handler
// (GET/DELETE never call it, which is why only saves failed). Client
// components may import this module fine without the directive; only
// downloadArchive touches browser APIs and only the client calls it.

/**
 * Session archive (issue #7, devduck SessionRecorder pattern, browser-native):
 * export the full conversation — messages, tool calls + results, UI
 * components, token usage — as a versioned JSON file; import restores it
 * exactly, on any device, and the chat continues from there.
 *
 * Replay-as-viewing is covered by the existing share flow (read-only +
 * "Continue here"); this handles the archive/resume half without needing
 * per-user R2 buckets.
 */

export const ARCHIVE_VERSION = 1;

export type SessionArchive = {
  tinyai_session: true; // discriminator so /load rejects random JSON
  version: number;
  tiny: string;
  exported: string; // ISO timestamp
  messages: any[];
};

// Keys whose values must never leave the browser in an archive. Matched by
// SUBSTRING within the key (case-insensitive) — an exact-match list once named
// "x-tiny-model-key", which is NOT the real BYOK header (x-tiny-model-api-key),
// so the actual key sailed through; substring matching also catches
// access_token / github_token / clientSecret shapes. Over-redacting an archive
// beats leaking a credential.
const SENSITIVE_KEY = /api[-_]?key|apikey|authorization|token|secret|password/i;

// A sensitive key must be blanked regardless of its value's SHAPE. The prior
// regex approach matched only a string value ("token": "sk-…"), so a secret
// held under a sensitive key as an ARRAY or OBJECT — e.g.
// {"api_keys": ["sk-LIVE-1", "sk-LIVE-2"]} or {"authorization": {"bearer":
// "sk-…"}} — was serialized verbatim (a regex can't span the balanced
// brackets). Redacting structurally, before serialization, covers every value
// type and needs no escape-aware string parsing.
//
// Numeric/boolean values under a sensitive key are KEPT: a credential is never
// a number, and the key substrings collide with legitimate usage counts
// (`{"tokens": 123}` matches `token`) — blanking those would corrupt the
// archived usage metadata for no security gain. Only string/array/object
// values (where a secret can actually hide) are blanked.
function redactSecrets(value: any): any {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && v !== null && typeof v !== 'number' && typeof v !== 'boolean'
        ? '[redacted]'
        : redactSecrets(v);
    }
    return out;
  }
  return value;
}

export function buildArchive(tiny: string, messages: any[]): string {
  const archive: SessionArchive = {
    tinyai_session: true,
    version: ARCHIVE_VERSION,
    tiny,
    exported: new Date().toISOString(),
    // Tool inputs/results could echo credentials the model saw — scrub them
    // structurally (any value shape under a sensitive key) before serializing.
    messages: redactSecrets(messages),
  };
  return JSON.stringify(archive, null, 2);
}

export function downloadArchive(tiny: string, messages: any[]) {
  const blob = new Blob([buildArchive(tiny, messages)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${tiny}-session-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Keep only well-formed message objects from any loaded source (share
 * links, localStorage). Non-arrays → []. Guards the render loop's .map()
 * against crafted/corrupt payloads that would otherwise throw and blank
 * the whole page.
 *
 * The top-level filter alone is NOT enough: it kept the original object, so a
 * crafted legacy `?chat=` link (100% attacker-authored — Chat.tsx JSON.parses
 * it with no server validation) could carry `toolCalls:"boom"`. The render
 * loop guards those nested collections with truthy + `.length > 0` only, never
 * Array.isArray — and `"boom".length` is 6, so the block runs and `.filter`/
 * `.map` throws a TypeError DURING RENDER, escaping the load-time try/catch to
 * the route error boundary → full-page blank. So coerce every nested field the
 * render reads: array collections to a real array (else drop, so the guard
 * fails cleanly) and `reasoning` to a string (a length-bearing object would
 * hit React's "Objects are not valid as a React child" throw).
 */
export function sanitizeMessages(raw: unknown): any[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m: any) => m && typeof m.id === "string" && typeof m.role === "string" && typeof m.content === "string")
    .map((m: any) => ({
      ...m,
      toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls : undefined,
      speech: Array.isArray(m.speech) ? m.speech : undefined,
      attachments: Array.isArray(m.attachments) ? m.attachments : undefined,
      followups: Array.isArray(m.followups) ? m.followups : undefined,
      reasoning: typeof m.reasoning === "string" ? m.reasoning : undefined,
    }));
}

/**
 * Resolve tool calls frozen mid-flight in a RESTORED conversation. A page
 * unload during a live stream persists toolCalls at status 'calling'; on
 * restore no stream exists to finish them, so the spinner would spin
 * forever. (The in-stream finally reconciles live aborts — this is the
 * same rule applied at the load boundary. Concurrent sends make mid-stream
 * navigation routine, so this went from edge case to common path.)
 */
export function reconcileInterruptedTools(messages: any[]): any[] {
  return messages.map((m: any) =>
    Array.isArray(m?.toolCalls) && m.toolCalls.some((t: any) => t?.status === "calling")
      ? {
          ...m,
          toolCalls: m.toolCalls.map((t: any) =>
            t?.status === "calling" ? { ...t, status: "error", error: "interrupted (page closed mid-stream)" } : t
          ),
        }
      : m
  );
}

/**
 * Build a PUBLIC share snapshot from a conversation. Privacy + safety rules:
 *   1. DROP system messages — a private tiny's owner has the real system
 *      prompt in messages[0]; it must never enter a public share.
 *   2. Keep only reader-facing TEXT fields (id/role/content + followups) —
 *      no toolCalls (raw API payloads), reasoning traces, or failure state.
 *   3. DROP uiComponents — `componentCode` is executed via `new Function` in
 *      the VIEWER's browser (DynamicUI), on the tiny.technology origin with
 *      access to their localStorage (provider API keys, share tokens). A
 *      viewer did not author that code, so a share carrying it is stored XSS
 *      / key theft. A share is a read-only transcript; interactive charts
 *      aren't worth the code-exec surface. (Live/own conversations still
 *      render their own render_ui output — that trust boundary is the user's
 *      own turn, not a foreign link.)
 * Pure + tested so the share flow can't silently regress the leak.
 */
export function shareSnapshot(messages: any[]): any[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && m.role !== "system")
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      ...(m.followups?.length ? { followups: m.followups } : {}),
    }));
}

export function parseArchive(text: string): SessionArchive {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON");
  }
  if (data?.tinyai_session !== true || !Array.isArray(data.messages)) {
    throw new Error("Not a tiny session archive");
  }
  if (typeof data.version !== "number" || data.version > ARCHIVE_VERSION) {
    throw new Error(`Archive version ${data.version} is newer than this app understands`);
  }
  // Only known message shapes survive — drops junk, keeps forward-compat.
  // Strip uiComponents: a picked .json is an UNTRUSTED file (archives get
  // passed around/emailed), and componentCode executes via new Function in
  // DynamicUI with localStorage access (API keys) — same XSS sink closed for
  // shares. Own cloud archives restore via a different path; a foreign file
  // must not carry executable code.
  const messages = data.messages
    .filter((m: any) => m && typeof m.id === "string" && typeof m.role === "string" && typeof m.content === "string")
    .map(({ uiComponents, ...m }: any) => m);
  if (messages.length === 0) throw new Error("Archive contains no messages");
  return { ...data, messages };
}

/** Open a file picker, resolve with the restored messages (or reject). */
export function pickAndLoadArchive(): Promise<SessionArchive> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error("No file selected"));
      file
        .text()
        .then((text) => resolve(parseArchive(text)))
        .catch((e) => reject(e));
    };
    // Cancel never fires onchange; let the promise dangle (no leak — GC'd)
    input.click();
  });
}

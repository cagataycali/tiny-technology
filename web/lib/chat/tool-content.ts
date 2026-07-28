/**
 * Unwrap a Strands ToolResultBlock content array to the flat tool return.
 *
 * A tool that returns an object lands on the SSE wire as `[{ json: {...} }]`;
 * a string as `[{ text: "..." }]` (which, for our JSON-returning tools, is a
 * JSON string). This is the inverse of `serializeToolContent` (lib/chat/helpers)
 * — the wrap side — and mirrors the native clients' decode (iOS `firstToolJson`,
 * Android's content-block walk in TinyApi).
 *
 * Every web consumer (PayReceipt, TaskTree, the generic tool card) reads
 * structured fields off `tool.result` as a FLAT object. Without this unwrap
 * `.ok` / `.requires_confirmation` / `.results` read off the array and come back
 * undefined — most visibly, a valid pay_x402 quote renders the DANGER "Payment
 * not sent" card and the Approve gate never appears. Falls back to the raw
 * content when no json/text block is present, so non-structured results (and
 * multi-block/media results) don't regress.
 */
export function unwrapToolContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  for (const block of content) {
    if (block && typeof block === "object" && "json" in block) {
      return (block as { json: unknown }).json;
    }
    if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
      const text = (block as { text: string }).text;
      try { return JSON.parse(text); } catch { return text; }
    }
  }
  return content;
}

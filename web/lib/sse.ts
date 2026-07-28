/**
 * SSE decoding shared by the chat client and ambient runner — extracted so
 * chunk-boundary handling is unit-testable (scrambled-streaming report:
 * events vanishing mid-stream).
 *
 * Stateful: feed() text chunks in any split pattern (TCP/proxy chunking is
 * arbitrary); complete `data:` payloads come out exactly once, in order.
 * Comment frames (`: ping` keepalives) and [DONE] markers are dropped.
 */
export type SSEDecoder = {
  /** Feed a decoded text chunk; returns the data payloads completed by it. */
  feed(text: string): string[];
  /** True once the server's terminal `data: [DONE]` marker arrived. The chat
   *  route sends it on EVERY exit path (success and error) before closing —
   *  so a body that ends without it was TRUNCATED (proxy timeout, tab-sleep
   *  connection drop), not finished, and the caller must not render the
   *  partial reply as a clean answer. */
  sawDone(): boolean;
};

/**
 * Per-stream seq-gap tracker. The server stamps every event with `seq`; a
 * gap means events were lost on the wire (scrambled-streaming report) and
 * the USER should hear about it — but exactly once per stream: a lossy
 * connection produces several gaps in one reply, and the old inline check
 * stacked an identical error toast over the composer for each. Every gap
 * still returns detail for console logging; `first` gates the toast.
 */
export function createSeqTracker() {
  let expected = 0;
  let warned = false;
  return {
    /** Feed an event's seq. Null = in order; otherwise gap detail, with
     *  `first` true only for the stream's first detected gap. */
    check(seq: unknown): { expected: number; got: number; first: boolean } | null {
      if (typeof seq !== "number") return null;
      const gap = seq !== expected ? { expected, got: seq, first: !warned } : null;
      expected = seq + 1;
      if (gap) warned = true;
      return gap;
    },
  };
}

export function createSSEDecoder(): SSEDecoder {
  let buffer = "";
  let done = false;
  return {
    sawDone() { return done; },
    feed(text: string): string[] {
      buffer += text;
      // The SSE spec terminates lines with CR, LF, or CRLF — proxies and some
      // servers emit \r\n, so a naive \n\n split never finds a frame boundary
      // and streamed events stall. Normalize CR/CRLF → LF before splitting,
      // but hold back a TRAILING lone CR: it may be the first half of a \r\n
      // that got split across chunk boundaries (converting it now would forge
      // a false \n\n once the next chunk's \n arrives).
      let trailingCR = "";
      if (buffer.endsWith("\r")) {
        // Hold back the trailing lone CR ONLY when it's genuinely ambiguous —
        // i.e. it could be the first half of a \r\n split across chunk
        // boundaries (prev char is ordinary text). If the char before it is
        // itself a terminator (\r or \n), the CR completes a blank-line frame
        // boundary right now (\r\r, \n\r); holding it back would strand that
        // final frame in the buffer forever when the stream ends here — the
        // dropped-final-bare-CR-frame bug. prev="" (CR is the whole buffer) is
        // still ambiguous → hold back.
        const prev = buffer.length >= 2 ? buffer[buffer.length - 2] : "";
        if (prev !== "\r" && prev !== "\n") { trailingCR = "\r"; buffer = buffer.slice(0, -1); }
      }
      buffer = buffer.replace(/\r\n?/g, "\n");
      const frames = buffer.split("\n\n");
      buffer = (frames.pop() || "") + trailingCR;
      const out: string[] = [];
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue; // comments, blank lines
          const data = line.slice(5).trim();
          if (data === "[DONE]") { done = true; continue; }
          if (data) out.push(data);
        }
      }
      return out;
    },
  };
}

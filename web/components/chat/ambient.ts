"use client";

/**
 * Ambient mode (issue #12 — devduck AmbientMode → careless useAmbient,
 * adapted to tiny's per-request agent):
 *
 * After IDLE_MS with no user input (and an existing conversation), fire ONE
 * quiet background exploration of the last topic via /api/chat. Findings are
 * buffered in sessionStorage and injected into the next user turn as an
 * [Ambient thinking] system note. Typing interrupts; cooldown prevents
 * loops; a session cap bounds cost on the free tier.
 */

import { createSSEDecoder } from "../../lib/sse";

export const AMBIENT_IDLE_MS = 45_000;
export const AMBIENT_COOLDOWN_MS = 5 * 60_000;
const MAX_PER_SESSION = 3;
// Autonomous mode (issue #12 second half): explicit user opt-in via /auto,
// loops until the agent emits [AMBIENT_DONE] or the iteration cap trips.
export const AMBIENT_DONE_SIGNAL = "[AMBIENT_DONE]";
const MAX_AUTONOMOUS_ITER = 5;
// Keys are namespaced PER TINY — ambient findings/count for tiny A must not
// bleed into tiny B in the same session (findings would be injected into B's
// prompt as B's own "ambient thinking", and a shared count would starve later
// tinys of their runs). Matches the per-tiny keying of continuity/kg.
const findingsKey = (tinyName: string) => `tiny_ambient_findings:${tinyName || "_"}`;
const countKey = (tinyName: string) => `tiny_ambient_count:${tinyName || "_"}`;

export type AmbientState = "off" | "idle-wait" | "running" | "cooldown" | "autonomous";

export function getAmbientFindings(tinyName: string): string {
  try { return sessionStorage.getItem(findingsKey(tinyName)) || ""; } catch { return ""; }
}

export function consumeAmbientFindings(tinyName: string): string {
  const f = getAmbientFindings(tinyName);
  try { sessionStorage.removeItem(findingsKey(tinyName)); } catch { }
  return f;
}

export class AmbientRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private cooldownUntil = 0;
  state: AmbientState = "off";

  constructor(
    private opts: {
      tinyName: string;
      getLastTopic: () => string | null; // last user message, or null if none
      isStreaming: () => boolean;
      headers: () => Record<string, string>;
      onStateChange?: (s: AmbientState) => void;
    }
  ) { }

  private setState(s: AmbientState) {
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  /** Call on every user activity (typing, sending). Cancels + re-arms. */
  poke() {
    this.cancel();
    if (this.sessionCount() >= MAX_PER_SESSION) return;
    if (Date.now() < this.cooldownUntil) { this.setState("cooldown"); return; }
    const topic = this.opts.getLastTopic();
    if (!topic) { this.setState("off"); return; }
    this.setState("idle-wait");
    this.timer = setTimeout(() => this.run(topic), AMBIENT_IDLE_MS);
  }

  /** Typing/streaming/unmount — stop everything current. */
  cancel() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.controller) { this.controller.abort(); this.controller = null; }
    if (this.visListener) {
      document.removeEventListener("visibilitychange", this.visListener);
      this.visListener = null;
    }
    this.autonomousStopped = true;
    if (this.state === "running" || this.state === "idle-wait" || this.state === "autonomous") this.setState("off");
  }

  /** Parked on visibilitychange while the tab is hidden (see run()). */
  private visListener: (() => void) | null = null;

  private autonomousStopped = false;

  /**
   * Autonomous mode: user said "/auto <task>" — loop background turns,
   * feeding each iteration's output into the next, until the agent emits
   * AMBIENT_DONE_SIGNAL or the cap trips. Findings accumulate per iteration
   * so an interrupt still surfaces partial work next turn.
   *
   * Returns BOTH halves of the outcome (c70): the last text, and whether the
   * user stopped it. `explore()` answers '' for every failure — right for the
   * idle path nobody asked for, but /auto is an explicit request, and empty
   * alone can't tell "you cancelled it" from "the provider refused". The caller
   * needs that difference to say something true.
   */
  async startAutonomous(
    task: string,
    onProgress?: (iter: number, text: string) => void,
  ): Promise<{ text: string; stopped: boolean }> {
    this.cancel();
    this.autonomousStopped = false;
    this.setState("autonomous");
    let context = "";
    let lastText = "";
    try {
      for (let iter = 1; iter <= MAX_AUTONOMOUS_ITER; iter++) {
        if (this.autonomousStopped) break;
        const prompt =
          `[AUTONOMOUS MODE iteration ${iter}/${MAX_AUTONOMOUS_ITER} — the user asked you to work on this until done; no one will reply between iterations.] ` +
          `Task: "${task.slice(0, 500)}". ` +
          (context ? `Your progress so far:\n${context.slice(-2000)}\n\nContinue the work — go deeper, don't repeat yourself. ` : `Start working. `) +
          `When (and only when) the task is genuinely complete, end your reply with ${AMBIENT_DONE_SIGNAL} on its own line.`;
        const text = await this.explore(prompt, `auto-${iter}`, false);
        if (this.autonomousStopped) break;
        if (!text.trim()) break; // provider error/empty — stop, keep partials
        lastText = text.trim();
        this.appendFinding(`[auto ${iter}] ${lastText.replace(AMBIENT_DONE_SIGNAL, "").trim()}`);
        onProgress?.(iter, lastText);
        if (lastText.includes(AMBIENT_DONE_SIGNAL)) break;
        context += `\n--- iteration ${iter} ---\n${lastText}`;
      }
    } finally {
      this.controller = null;
      this.cooldownUntil = Date.now() + AMBIENT_COOLDOWN_MS;
      this.setState(this.autonomousStopped ? "off" : "cooldown");
    }
    return { text: lastText, stopped: this.autonomousStopped };
  }

  private appendFinding(text: string) {
    const existing = getAmbientFindings(this.opts.tinyName);
    try {
      sessionStorage.setItem(findingsKey(this.opts.tinyName), existing ? `${existing}\n---\n${text}` : text);
    } catch { }
  }

  private sessionCount(): number {
    try { return Number(sessionStorage.getItem(countKey(this.opts.tinyName)) || 0); } catch { return 0; }
  }

  private async run(topic: string) {
    if (this.opts.isStreaming()) { this.poke(); return; }
    // A hidden tab is not an idle USER — it's an absent one. Running now
    // burns an idle-budget slot (MAX_PER_SESSION) + provider/BYOK money on
    // a turn nobody sees; Chrome's timer throttling can also delay this
    // exact callback to fire ON wake — an LLM call launching the moment
    // the user returns to type. Park until the tab is visible again, then
    // re-arm the full idle window (poke re-checks caps/cooldown/topic).
    if (typeof document !== "undefined" && document.hidden) {
      this.setState("idle-wait");
      const onVisible = () => {
        if (document.hidden) return; // fired for a hide, not a return
        document.removeEventListener("visibilitychange", onVisible);
        this.visListener = null;
        this.poke();
      };
      this.visListener = onVisible;
      document.addEventListener("visibilitychange", onVisible);
      return;
    }
    this.setState("running");
    try {
      const text = await this.explore(
        `[AMBIENT MODE — the user is idle; you are thinking in the background. No one will reply.] Their last topic was: "${topic.slice(0, 500)}". Explore ONE useful angle they haven't considered — a risk, a better approach, a concrete next step. Under 120 words, no questions, no greetings. This will be shown to them as background thinking when they return.`,
        "idle",
        true
      );
      if (text.trim()) this.appendFinding(text.trim());
    } finally {
      this.controller = null;
      this.cooldownUntil = Date.now() + AMBIENT_COOLDOWN_MS;
      this.setState("cooldown");
    }
  }

  /**
   * One background /api/chat turn; returns the collected text ("" on error).
   *
   * `meter` gates the free-tier idle budget: only the IDLE path (run()) counts
   * against MAX_PER_SESSION. The explicit `/auto` loop is bounded separately by
   * MAX_AUTONOMOUS_ITER, so it must NOT bump the idle counter — otherwise a
   * single /auto run (up to 5 iterations) would blow past the idle cap of 3 and
   * silently disable idle ambient for the rest of the session.
   */
  private async explore(prompt: string, tag: string, meter: boolean): Promise<string> {
    this.controller = new AbortController();
    try {
      if (meter) sessionStorage.setItem(countKey(this.opts.tinyName), String(this.sessionCount() + 1));
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tiny-name": this.opts.tinyName,
          "x-tiny-session": `ambient-${tag}-${Date.now()}`,
          ...this.opts.headers(),
        },
        signal: this.controller.signal,
        body: JSON.stringify({
          messages: [{ role: "user", content: [{ text: prompt }] }],
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      // Collect the streamed text (no UI streaming — this is background)
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const decoder = createSSEDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const data of decoder.feed(value || "")) {
          try {
            const ev = JSON.parse(data);
            if (ev.type === "modelContentBlockDeltaEvent" && ev.textDelta) text += ev.textDelta;
          } catch { }
        }
      }
      return text;
    } catch {
      // aborted or failed — silent; ambient must never disturb
      return "";
    }
  }
}

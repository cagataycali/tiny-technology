"use client";

/**
 * `!expr` bang eval (careless bang-runner pattern, §2.17) — instant,
 * zero-token JS evaluation in a sandboxed iframe. `!2**10` → 1024 without
 * a model round-trip.
 *
 * Sandbox: srcdoc iframe with `sandbox="allow-scripts"` (opaque origin —
 * no cookies, no storage, no parent DOM). Result posted back once;
 * 3s timeout kills hung evals.
 */

const TIMEOUT_MS = 3000;

export function isBangExpr(text: string): boolean {
  // "!x" but not "!!", "!=" (comparison pastes)
  return /^!(?![!=])\S/.test(text.trim());
}

export function runBang(text: string): Promise<string> {
  const expr = text.trim().slice(1);
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.setAttribute("sandbox", "allow-scripts");

    let settled = false;
    const finish = (msg: string) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      iframe.remove();
      resolve(msg);
    };

    const timer = setTimeout(() => finish("⏱ eval timeout (3s)"), TIMEOUT_MS);

    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      clearTimeout(timer);
      finish(String(e.data?.result ?? ""));
    };
    window.addEventListener("message", onMessage);

    // btoa keeps the expression inert inside the srcdoc HTML
    const encoded = btoa(encodeURIComponent(expr));
    iframe.srcdoc = `<script>
      try {
        const expr = decodeURIComponent(atob("${encoded}"));
        let out;
        try { out = eval("(" + expr + ")"); } catch { out = eval(expr); }
        Promise.resolve(out).then(v => {
          let s;
          try { s = typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch { s = String(v); }
          parent.postMessage({ result: s === undefined ? String(v) : s }, "*");
        }).catch(err => parent.postMessage({ result: "❌ " + err.message }, "*"));
      } catch (err) {
        parent.postMessage({ result: "❌ " + err.message }, "*");
      }
    <\/script>`;
    document.body.appendChild(iframe);
  });
}

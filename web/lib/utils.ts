export async function getWeatherData(location: string) {
  const key = process.env.WEATHER_API_KEY;
  if (!key) return null;
  // Timeout parity with the home/[slug] page fetches: this runs during the
  // not-found page's server render, and .catch only handles ERRORS — a hung
  // (never-resolving) connection would otherwise stall the whole 404 render
  // until Vercel's function timeout. Cap it and degrade to null.
  //
  // r.ok gate: weatherapi returns a JSON *error* body on a bad status (400
  // {"error":{"code":1006,"message":"No matching location found."}} for an
  // unknown x-vercel-ip-city, 401 on a bad key, 429 rate-limited). res.json()
  // resolves that fine, so WITHOUT the gate the error object flows through as
  // "weather metadata" — it's JSON-serialized into the x-tiny-metadata header
  // (Chat.tsx) and handed to the model as context. Treat any non-2xx as no
  // data so the model gets clean null, matching the r.ok class closed across
  // the app's other worker fetches.
  return fetch(
    `https://api.weatherapi.com/v1/current.json?key=${key}&q=${encodeURIComponent(location)}&aqi=no`,
    { next: { revalidate: 60 }, signal: AbortSignal.timeout(5_000) }
  ).then((res) => (res.ok ? res.json() : null)).catch(() => null);
}

export function parseOpenAPI(openApiJson: any, tinyName: string = 'tiny', worker: string = 'https://plugin.tiny.technology/openapi.json') {
  const chatFunctions: any = [];

  if (!openApiJson || !openApiJson.paths) {
    return [];
  }

  // Function to resolve references from components.schemas.
  // Specs come from user-controlled worker URLs — dangling refs must
  // degrade to {} rather than crash the request.
  function resolveRef(ref: any) {
    // $ref is truthy-gated at the call sites, but JSON allows a non-string
    // truthy value ({"$ref": 123}) that passes the `if (schema.$ref)` check —
    // (123).split is a TypeError that escapes .forEach and, since parseOpenAPI
    // runs unguarded in the chat-route setup, faults the whole turn. A JSON
    // Reference's value is by spec a string; anything else is a malformed ref.
    if (typeof ref !== 'string') return {};
    const refPath = ref.split('/').slice(1); // Remove the first # character
    let result = openApiJson;
    for (const part of refPath) {
      result = result?.[part];
      if (result === undefined || result === null) return {};
    }
    return result;
  }

  function resolveSchema(schema: any) {
    if (!schema || typeof schema !== 'object') return {};
    if (schema.$ref) {
      return resolveRef(schema.$ref);
    } else if (schema.type === 'array' && schema.items) {
      // Handle array type with items
      let itemsSchema = schema.items;
      if (itemsSchema.$ref) {
        itemsSchema = resolveRef(itemsSchema.$ref);
      }
      return {
        type: 'array',
        items: itemsSchema,
        description: schema.description
      };
    }
    return schema;
  }

  Object.keys(openApiJson?.paths).forEach((path) => {
    const methods = openApiJson.paths[path];
    if (!methods || typeof methods !== 'object') return;
    Object.keys(methods).forEach((method) => {
      const operation = methods[method];
      // Non-object entries (nulls, vendor extensions) aren't operations
      if (!operation || typeof operation !== 'object') return;
      const chatFunction: any = {
        name: operation.operationId || `${method}_${path}`,
        description: operation.summary || `${method.toUpperCase()} ${path}`,
        method: method,
        tinyName: tinyName,
        path: path,
        worker: worker,
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      };

      // Specs come from user/owner-controlled worker URLs — a truthy-but-not-
      // array `parameters` would throw out of .forEach and, since parseOpenAPI
      // runs unguarded in the chat-route setup, fault the whole turn. Guard it.
      if (Array.isArray(operation.parameters)) {
        operation.parameters.forEach((param: any) => {
          if (!param || typeof param !== 'object') return;
          const resolvedSchema = resolveSchema(param.schema);
          chatFunction.parameters.properties[param.name] = {
            type: resolvedSchema.type,
            description: param.description || `The ${param.name} parameter`,
            items: resolvedSchema.items // Include items for array types
          };
          if (param.required) {
            chatFunction.parameters.required.push(param.name);
          }
        });
      }

      // `content` may be missing/non-object on a malformed spec — reading
      // ['application/json'] off undefined throws. Guard before indexing.
      const jsonBody = operation.requestBody?.content?.['application/json'];
      if (jsonBody) {
        const requestBody = jsonBody;
        if (requestBody.schema) {
          let resolvedSchema = resolveSchema(requestBody.schema);
          if (resolvedSchema.type === 'object' && resolvedSchema.properties) {
            Object.keys(resolvedSchema.properties).forEach((prop) => {
              const propSchema = resolveSchema(resolvedSchema.properties[prop]);
              chatFunction.parameters.properties[prop] = {
                type: propSchema.type,
                description: propSchema.description || `The ${prop} field in the request body`,
                items: propSchema.items // Include items for array types
              };
              if (resolvedSchema.required && resolvedSchema.required.includes(prop)) {
                chatFunction.parameters.required.push(prop);
              }
            });
          }
        }
      }

      // Add handling for responses and security as needed

      chatFunctions.push(chatFunction);
    });
  });

  return chatFunctions;
}

// SSRF guard for server-side fetches of user-supplied URLs (worker specs,
// dynamic tool endpoints). https + public hostnames only.
export function validatePublicUrl(raw: unknown): { url: URL } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'URL is required' };
  let url: URL;
  try { url = new URL(raw); } catch { return { error: 'invalid URL' }; }
  if (url.protocol !== 'https:') return { error: 'URL must be https' };
  // Strip a trailing dot: `127.0.0.1.` / `localhost.` are FQDN-root forms the
  // resolver treats identically to the dotless host, but the exact-string and
  // `$`-anchored IPv4 checks below would otherwise miss them → SSRF bypass.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Any all-numeric / hex label smells like an encoded IP literal. The decimal
  // dotted-quad regex alone misses octal (0177.0.0.1), hex (0x7f.0.0.1), and
  // dotless-decimal (2130706433) forms that inet_aton still resolves to
  // loopback/private space — reject the lot rather than enumerate encodings.
  const looksNumericIp = /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/.test(host);
  const isIp = looksNumericIp || host.includes(':'); // v4 (any encoding) or v6
  if (isIp || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) {
    return { error: 'URL must be a public hostname' };
  }
  return { url };
}

/**
 * Best-effort variant: stream a body but CLIP to `limit` bytes and return
 * whatever fit (never null), plus whether it was truncated. For callers
 * that want partial content (the http tool, tool fetch) rather than the
 * all-or-nothing `readBoundedText` a JSON spec needs. Still can't OOM —
 * it stops reading at the cap.
 */
export async function readClippedText(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const t = await res.text()
    return t.length > limit ? { text: t.slice(0, limit), truncated: true } : { text: t, truncated: false }
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let out = ''
  try {
    // Keep reading until the stream ends OR we've strictly overshot the cap.
    // Breaking on `out.length < limit` would stop the instant a chunk landed
    // exactly ON the limit, so a body that then had more bytes would be
    // clipped yet reported complete — read one past to tell the two apart.
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out += dec.decode(value, { stream: true })
      if (out.length > limit) break
    }
  } finally {
    try { await reader.cancel() } catch { }
  }
  // Truncated iff we accumulated past the cap. Landing exactly on `limit` with
  // the stream then ending is NOT truncation (the loop read the next chunk and
  // saw `done`); overshooting it is.
  const truncated = out.length > limit
  return { text: out.slice(0, limit), truncated }
}

/**
 * Read a fetch Response body as text WITHOUT buffering more than `limit`
 * bytes — streams and stops early. Server-side fetches of user-supplied
 * URLs (worker specs, tool fetches) must not let a chunked oversized body
 * OOM the runtime; a declared oversized Content-Length is rejected up
 * front. Returns null when over the limit, else the (clipped) text.
 */
/**
 * micro-USDC → "$0.50" for CHARGE / BALANCE prose (Rule B: always ≥2 fraction
 * digits — "$0.50" not "$0.5" — up to 6 for sub-cent prices, thousand-grouped).
 * The single money formatter for the agent-relayed / server-rendered payment
 * strings a client surfaces to the user (chat-route paywalls, the /api/x402/pay
 * quote summary + execute-route insufficient-balance error). Keeps a price and
 * a balance in the SAME sentence from clashing formats, and stops a bare
 * `micro / 1_000_000` interpolation leaking a float artifact
 * (`0.30000000000000004`) or scientific notation (`1e-7`) into money copy.
 * Byte-identical to the client formatters (iOS NumberFormatter, Android
 * WalletCore.usd, web toLocaleString). NOT for the per-message price BADGE —
 * that's a rate and strips trailing zeros ("$1", "$0.5") separately.
 */
export function usd(micro: number): string {
  // Finite-guard, not a bare Number(): Number(undefined) and Number('abc') are
  // both NaN, and NaN.toLocaleString(currency) yields "$NaN" — which would leak
  // into agent-relayed payment prose (and every wallet surface) on a malformed
  // or absent micro. A non-finite input degrades to $0.00.
  const n = Number(micro)
  return (Number.isFinite(n) ? n / 1_000_000 : 0).toLocaleString('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6,
  })
}

/**
 * micro-USDC → a RATE string for the per-message price badge: trailing zeros
 * stripped ("$1", "$0.5", "$0.000001"). A rate is NOT a charge, so it must
 * not pad to cents the way usd() does — see usd()'s docblock. Extracted from
 * the twice-duplicated toFixed(6).replace chain in Chat.tsx's paywall badge;
 * same non-finite degradation rule as usd() ("$0", never "$NaN").
 */
export function usdRate(micro: number): string {
  const n = Number(micro)
  const v = Number.isFinite(n) ? n / 1_000_000 : 0
  return '$' + v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Parse a money amount typed into an inputMode="decimal" field to a Number.
 *
 * The catch: a comma-locale mobile keypad (de/fr/tr) renders a COMMA as the
 * decimal separator, but JS parseFloat is locale-invariant — parseFloat("10,50")
 * is 10, silently truncating the cents and making any fractional amount
 * impossible for those users. This normalizes a lone decimal comma to a dot
 * first (the same fallback iOS Wallet.swift:188-204 applies). A narrow decimal-
 * keypad money field never receives grouped-thousands input, so a comma is
 * always the decimal mark. Returns NaN for empty/garbage (callers gate on
 * Number.isFinite + their min), never throws.
 *
 * AMBIGUOUS multi-separator input (e.g. a pasted "1,234,56" or "1.234.56") is
 * REJECTED to NaN, not silently truncated. Plain parseFloat would stop at the
 * second separator ("1.234,56" → 1.234) and withdraw a number the user never
 * meant — on a money field, disabling Withdraw (Android WalletCore.kt:149
 * toDoubleOrNull + iOS Double() both reject two separators) is the safe parity.
 * A single comma OR single dot is the decimal mark and parses as before.
 */
export function parseDecimalInput(raw: string): number {
  const s = String(raw ?? '').trim()
  // More than one separator total → ambiguous (multi-comma, multi-dot, or a
  // grouped "1,234.56" no decimal keypad emits) → fail closed rather than lie.
  if ((s.match(/[.,]/g)?.length ?? 0) > 1) return NaN
  return parseFloat(s.replace(',', '.'))
}

/**
 * Count label with correct grammar: `pluralize(1, "msg")` → "1 msg",
 * `pluralize(3, "msg")` → "3 msgs", `pluralize(0, "fact")` → "0 facts".
 *
 * The house had ~19 count labels split between correct `n === 1 ? "" : "s"`
 * ternaries (Profile/Community/Directory) and hardcoded trailing `s`
 * (CommandPalette "1 msgs", MemoryGraph "1 facts · 1 links", the constellation
 * footers) — the same MemoryGraph file even got it right on one line and wrong
 * on the next. This is the single place to get English count grammar right so
 * the ad-hoc drift stops. English rule: singular ONLY at exactly 1 (0 and 2+
 * are plural — "0 facts"). Irregular plurals pass `plural` explicitly
 * (`pluralize(n, "entry", "entries")`). Coerces + finite-guards `n` so a stray
 * NaN/undefined count degrades to the plural form rather than "NaN msgs undefined".
 */
export function pluralize(n: number, singular: string, plural?: string): string {
  const count = Number(n);
  const safe = Number.isFinite(count) ? count : 0;
  const word = Math.abs(safe) === 1 ? singular : (plural ?? `${singular}s`);
  return `${safe} ${word}`;
}

export async function readBoundedText(res: Response, limit: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > limit) return null;
  if (!res.body) {
    const t = await res.text();
    return t.length > limit ? null : t;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      if (out.length > limit) { try { await reader.cancel(); } catch { } return null; }
    }
  } finally {
    try { await reader.cancel(); } catch { }
  }
  return out;
}

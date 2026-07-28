import { enforceIpDailyLimit } from "@/lib/rate-limit";
import { parseOpenAPI, validatePublicUrl, readBoundedText } from "@/lib/utils";

const MAX_SCHEMA_BYTES = 2 * 1024 * 1024; // 2 MB is plenty for an openapi.json
const FETCH_TIMEOUT_MS = 10_000;


async function retrieveOpenAPI(url: URL) {
  try {
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error', // a redirect could bounce to an internal address
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    // Stream-bounded read — a chunked spec with no Content-Length could
    // otherwise buffer past the cap before the size check.
    const text = await readBoundedText(response, MAX_SCHEMA_BYTES);
    if (text === null) return null;
    return JSON.parse(text);
  } catch (error) {
    console.error('Error fetching OpenAPI:', error);
    return null;
  }
}

// IMPORTANT! Set the runtime to edge
export const runtime = 'edge'

export async function POST(req: Request) {
  // cost: 'others' — this route FETCHES A URL THE CALLER SUPPLIES, so the window
  // is how much traffic one caller can aim at a third party's server through us.
  // Reputation with us grants no standing to point our egress at someone else,
  // and a free-account-per-window would multiply that reach. IP-keyed, base
  // allowance. See LimitCost.
  const limited = await enforceIpDailyLimit(req, { cost: 'others' });
  if (limited) return limited;


  const { name, worker } = await req.json().catch(() => ({} as any));

  const checked = validatePublicUrl(worker);
  if ('error' in checked) {
    return new Response(JSON.stringify({ message: checked.error }), {
      status: 400,
      headers: { 'content-type': 'application/json;charset=UTF-8' },
    });
  }

  const schema = await retrieveOpenAPI(checked.url);
  if (!schema || !schema.paths) {
    return new Response(JSON.stringify({
      message: 'Could not load a valid OpenAPI schema from that URL.',
    }), {
      status: 422,
      headers: { 'content-type': 'application/json;charset=UTF-8' },
    });
  }

  const parsedSchema = parseOpenAPI(schema, name, worker);

  // Return response
  return new Response(JSON.stringify({
    message: 'Worker is active.',
    schema: schema,
    skills: parsedSchema
  }), {
    headers: {
      'content-type': 'application/json;charset=UTF-8',
    },
  });
}



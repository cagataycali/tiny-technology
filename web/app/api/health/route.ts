/**
 * GET /api/health — unauthenticated liveness + public identity of this deployment.
 *
 * `tiny-tech init <url>` (and the tiny-vercel CLI) probe this to learn which
 * worker a client may read from (/retrieve, /list, /tools/browse, /media)
 * from the app URL alone, so switching backends is one setting. Only values
 * the browser bundle already ships are exposed; server-only configuration is
 * reported as booleans.
 */
export const runtime = 'edge'

export async function GET() {
  const worker = (process.env.NEXT_PUBLIC_TINY_WORKER_URL || process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology')
    .trim().replace(/\/+$/, '')
  return new Response(JSON.stringify({
    ok: true,
    service: 'web',
    sseTerminator: '[DONE]',
    siteName: process.env.NEXT_PUBLIC_SITE_NAME || 'tiny.technology',
    workerUrl: worker,
    workerConfigured: Boolean(process.env.TINY_WORKER_URL),
    paymentsEnabled: true,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  })
}

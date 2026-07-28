import { clearSessionCookie } from '@/lib/auth'

export const runtime = 'edge'

export async function POST() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() },
  })
}

export async function GET() {
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': clearSessionCookie() },
  })
}

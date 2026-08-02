/**
 * 🎙️ nicla_voice_* — named tools for the Nicla Voice necklace.
 *
 * A SEPARATE roster from nicla.ts, not a widened filter on it, and the reason is
 * the whole design of this board. The Nicla Vision is a full node: WiFi, its own
 * token, it polls the relay, so `nicla_take_photo` can send it an envelope and
 * get a JPEG back. The Nicla Voice is an nRF52832 + NDP120 — BLE only, no WiFi
 * radio at all. It has no relay mailbox to poll, so there is no envelope any
 * tool here could send it. Reusing nicla.ts's roster would hand the agent a
 * camera tool for a board with no camera and a relay tool for a board that
 * cannot poll: four confident failures instead of an absent capability.
 *
 * What the Voice actually produces is WAKES. Its NDP120 runs always-on keyword
 * inference at ~µW; on a match the firmware notifies over BLE
 * (strands-nicla firmware/voice/tiny_voice/tiny_voice.ino), the paired phone
 * forwards it (ios NiclaVoiceGateway) to POST /api/devices/event, and it lands
 * on the owner's event ring. So the board itself can only be READ:
 *
 *   nicla_voice_status — enrolled? relayed by a phone right now? what words?
 *   nicla_voice_wakes  — the recent wake history, newest first
 *
 * Note what is still deliberately NOT here: no tool that pulls audio off the
 * BOARD. It has no audio characteristic and could not gain one — 64KB of RAM
 * with ~60% spent on statics, and a 128-byte characteristic added during
 * bring-up broke every BLE connection outright. The words that follow a wake
 * come from the honest source instead: the paired PHONE's mic and on-device
 * recognizer. That is what the recorder half commands —
 *
 *   nicla_voice_record      — relay a {type:'record'} envelope to the PHONE
 *                             (platform 'ios-arm64', a pull device with a real
 *                             mailbox); it records, transcribes on-device,
 *                             uploads audio via /api/media and stores the text
 *                             at POST /api/devices/transcript
 *   nicla_voice_transcripts — list stored transcripts, newest first
 *   nicla_voice_transcript  — one transcript in full, by id
 *
 * — and every description says "phone", because "the necklace's audio" would
 * misattribute which microphone heard it.
 */
import { z } from 'zod'
import { tool } from '@strands-agents/sdk'
import { clampWait } from './nicla'

const WORKER = process.env.TINY_WORKER_URL || 'https://plugin.tiny.technology'
const ikey = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

/** The event kind the gateway writes (worker devices.ts DEVICE_EVENT_KINDS). */
export const WAKE_KIND = 'nicla_wake'

/**
 * The user's Voice necklace, the relayed one first. Null when none is enrolled.
 *
 * `online` here means something different from the Vision's: the Voice cannot
 * heartbeat for itself, so a 🟢 is the paired PHONE saying "I hold its BLE link
 * right now". Offline therefore means out of Bluetooth range (or the phone is
 * backgrounded) — not that the necklace is dead. The wording in every tool below
 * reflects that, because "offline" alone would send the user hunting for a
 * charger when the fix is to walk back into the room.
 */
export async function resolveVoice(userId: string):
    Promise<{ id: string; name: string; online: boolean; capabilities: string[] } | null> {
  const d = await fetch(`${WORKER}/device/list?userId=${encodeURIComponent(userId)}`, {
    headers: ikey(), cache: 'no-store',
  }).then(r => r.json()).catch(() => null)
  const units = (d?.devices || []).filter((x: any) => x.platform === 'nicla-voice')
  if (!units.length) return null
  const best = units.find((x: any) => x.online) || units[0]
  let capabilities: string[] = []
  try {
    const parsed = typeof best.capabilities === 'string' ? JSON.parse(best.capabilities) : best.capabilities
    if (Array.isArray(parsed)) capabilities = parsed.map((c: any) => String(c))
  } catch { /* a malformed caps blob is not worth failing a status read over */ }
  return { id: best.id, name: best.name, online: !!best.online, capabilities }
}

/** Recent wake events off the owner's ring, newest first. */
export async function recentWakes(userId: string, limit: number):
    Promise<Array<{ detail: string; created: string }>> {
  const d = await fetch(
    `${WORKER}/events?userId=${encodeURIComponent(userId)}&limit=50`,
    { headers: ikey(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => null)
  const all = Array.isArray(d?.events) ? d.events : []
  // The ring is shared with every other subsystem (scheduler fires, shares,
  // device results) and is returned oldest-last, so filter by kind then reverse
  // — the agent asked what it heard RECENTLY.
  return all
    .filter((e: any) => e?.kind === WAKE_KIND)
    .reverse()
    .slice(0, limit)
    .map((e: any) => ({ detail: String(e.detail ?? ''), created: String(e.created ?? '') }))
}

export const makeNiclaVoiceStatusTool = (userId: string | null | undefined) => tool({
  name: 'nicla_voice_status',
  description: "Check the user's tiny voice necklace (Arduino Nicla Voice): whether it is enrolled, whether a phone is currently relaying it over Bluetooth, and how many wake words its neural chip has loaded. This board has NO WiFi and NO camera — it listens for a wake word on-device and its paired phone forwards what it hears. Cheap and fast.",
  inputSchema: z.object({}),
  callback: async () => {
    if (!userId) return { ok: false, error: 'Login required — the necklace belongs to the user account.' }
    const dev = await resolveVoice(userId)
    if (!dev) return { ok: false, error: 'No Nicla Voice necklace is enrolled on this account.' }
    const wakes = await recentWakes(userId, 1)
    return {
      ok: true,
      name: dev.name,
      relayed: dev.online,
      capabilities: dev.capabilities,
      last_heard: wakes[0]?.detail || null,
      note: dev.online
        ? `"${dev.name}" is listening and a paired phone is relaying it — wake words reach the user's tiny.`
        : `"${dev.name}" is enrolled but no phone is relaying it right now: it is out of Bluetooth range, or the tiny app is closed. The necklace may still be listening — it just has no way to tell anyone. Nothing it hears while unrelayed is recoverable afterwards.`,
    }
  },
})

export const makeNiclaVoiceWakesTool = (userId: string | null | undefined) => tool({
  name: 'nicla_voice_wakes',
  description: "Read the recent wake-word events from the user's tiny voice necklace — each entry is a word its on-device neural chip recognized, with a timestamp. Use this to answer 'did my necklace hear anything?' or 'when did I last say the wake word'. This is a LOG, not live audio: the necklace reports that a word matched, never a recording of it.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(20).optional().describe('How many recent wakes to return (default 10).'),
  }),
  callback: async (input) => {
    if (!userId) return { ok: false, error: 'Login required — the necklace belongs to the user account.' }
    const dev = await resolveVoice(userId)
    if (!dev) return { ok: false, error: 'No Nicla Voice necklace is enrolled on this account.' }
    const wakes = await recentWakes(userId, input.limit ?? 10)
    if (!wakes.length) {
      // "No wakes" is ambiguous and the ambiguity matters: a necklace nobody is
      // relaying produces an empty log no matter how much it hears. Say which
      // silence this is instead of letting the agent report "you haven't spoken".
      return {
        ok: true, wakes: [],
        note: dev.online
          ? `"${dev.name}" is being relayed but has not matched a wake word recently.`
          : `No wakes recorded — and no phone is relaying "${dev.name}" right now, so anything it heard could not be reported. This is not evidence the user was silent.`,
      }
    }
    return { ok: true, relayed: dev.online, wakes }
  },
})

/**
 * The user's PHONE — the recorder. platform 'ios-arm64' (Session.swift
 * enrolls the tiny app itself as a daemon device), online preferred. This is
 * deliberately NOT resolveVoice: the necklace has no relay mailbox to send a
 * record envelope to, and pointing the recorder at it would be four confident
 * failures again. `online` here is real presence (the app heartbeats while
 * foregrounded), so offline means the app is closed or backgrounded — the
 * phone itself is almost certainly fine.
 */
export async function resolvePhone(userId: string):
    Promise<{ id: string; name: string; online: boolean } | null> {
  const d = await fetch(`${WORKER}/device/list?userId=${encodeURIComponent(userId)}`, {
    headers: ikey(), cache: 'no-store',
  }).then(r => r.json()).catch(() => null)
  const phones = (d?.devices || []).filter((x: any) => x.platform === 'ios-arm64')
  if (!phones.length) return null
  const best = phones.find((x: any) => x.online) || phones[0]
  return { id: best.id, name: best.name, online: !!best.online }
}

export const makeNiclaVoiceRecordTool = (userId: string | null | undefined, budgetS?: number) => tool({
  name: 'nicla_voice_record',
  description: "Record what the user says next and get it back as TEXT: the user's paired phone (the tiny app) records N seconds through its own mic, transcribes on-device, and answers with a transcript preview + a transcript id + the hosted audio URL. This is the phone's microphone, not the necklace's — the Nicla Voice board only spots wake words; the phone hears the words that follow. Needs the tiny app open on the phone. Takes roughly the recording length plus a few seconds.",
  inputSchema: z.object({
    seconds: z.number().int().optional().describe('How long to record, in seconds (clamped 5-120, default 10).'),
    reason: z.string().max(200).optional().describe('Optional short reason — the phone shows it while recording.'),
  }),
  callback: async (input) => {
    if (!userId) return { ok: false, error: 'Login required — the recorder belongs to the user account.' }
    const phone = await resolvePhone(userId)
    if (!phone) {
      return { ok: false, error: 'No phone is enrolled on this account — the tiny app on the phone does the recording and transcription; the necklace itself cannot.' }
    }
    if (!phone.online) {
      // Same honesty rule as the wake tools: this phone is not dead, its app
      // just isn't listening — say which, or the user reboots a healthy phone.
      return {
        ok: false,
        error: `"${phone.name}" is not listening right now — the tiny app is closed or backgrounded, so there is nothing to hand the recording to. Ask the user to open the app, then try again.`,
      }
    }
    const seconds = Math.max(5, Math.min(120, Math.round(input.seconds ?? 10)))
    const sent = await fetch(`${WORKER}/device/relay/send`, {
      method: 'POST', headers: ikey(),
      body: JSON.stringify({
        userId, toDevice: phone.id,
        payload: JSON.stringify({ type: 'record', seconds, reason: String(input.reason || '').slice(0, 200) }),
      }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }))
    if (sent.error || !sent.id) return { ok: false, error: sent.error || 'relay send failed' }

    // The recording itself takes `seconds`; +25 covers pickup on the phone's
    // 5s poll, on-device transcription, and the /api/media upload. Clamped to
    // the caller's own deadline (nicla.ts clampWait) so a scheduled job gets a
    // real explanation instead of dying mid-poll.
    const waitS = clampWait(seconds + 25, budgetS)
    for (let i = 0; i < Math.ceil(waitS / 3); i++) {
      await new Promise(r => setTimeout(r, 3000))
      const d = await fetch(
        `${WORKER}/device/relay/recv?userId=${encodeURIComponent(userId)}&inReplyTo=${encodeURIComponent(sent.id)}`,
        { headers: ikey(), cache: 'no-store' },
      ).then(r => r.json()).catch(() => null)
      if (!d?.reply?.payload) continue
      try {
        const p = JSON.parse(d.reply.payload)
        if (p.error) return { ok: false, error: String(p.error) }
        return {
          ok: true,
          result: String(p.result ?? ''),
          transcript_id: p.transcriptId ? String(p.transcriptId) : null,
          audio_url: p.audioUrl ? String(p.audioUrl) : null,
          note: 'The result is a preview — nicla_voice_transcript with the id returns the full text.',
        }
      } catch {
        return { ok: true, result: String(d.reply.payload) }
      }
    }
    // A timeout is not a failure to record: the phone may still be recording,
    // transcribing or uploading — and the transcript store outlives this poll.
    return {
      ok: false,
      error: `"${phone.name}" did not answer within ${waitS}s. The recording may still complete — the phone stores the transcript when it finishes, so check nicla_voice_transcripts in a minute rather than recording again immediately.`,
    }
  },
})

export const makeNiclaVoiceTranscriptsTool = (userId: string | null | undefined) => tool({
  name: 'nicla_voice_transcripts',
  description: "List the user's stored voice transcripts, newest first — each entry has an id, a label (the wake word or the reason that triggered it), a ~200-char text preview, the hosted audio URL and the duration. Three things file rows here: wake-word follow-ups, nicla_voice_record, and — labelled \"necklace-live\" — continuous speech the Nicla VISION necklace streamed to the phone while its live card was open, transcribed on-device. So this is the place to look for what was actually SAID near the user, not only for clips something deliberately triggered; a necklace-live row has no audio URL because that mic recorded no file on the phone. Use nicla_voice_transcript with an id to read one in full.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe('How many recent transcripts to return (default 10).'),
  }),
  callback: async (input) => {
    if (!userId) return { ok: false, error: 'Login required — transcripts belong to the user account.' }
    const d = await fetch(
      `${WORKER}/transcript/list?userId=${encodeURIComponent(userId)}&limit=${input.limit ?? 10}`,
      { headers: ikey(), cache: 'no-store' },
    ).then(r => r.json()).catch(() => null)
    if (!d || d.error || !Array.isArray(d.transcripts)) {
      return { ok: false, error: String(d?.error || 'transcript store unavailable') }
    }
    if (!d.transcripts.length) {
      return {
        ok: true, transcripts: [],
        note: 'No transcripts stored yet — nicla_voice_record makes one, and so does a wake word the phone caught and recorded after.',
      }
    }
    return { ok: true, transcripts: d.transcripts }
  },
})

export const makeNiclaVoiceTranscriptTool = (userId: string | null | undefined) => tool({
  name: 'nicla_voice_transcript',
  description: "Read one stored voice transcript IN FULL by id (ids come from nicla_voice_transcripts or a nicla_voice_record result — list previews are cut at ~200 chars).",
  inputSchema: z.object({
    id: z.string().describe('The transcript id.'),
  }),
  callback: async (input) => {
    if (!userId) return { ok: false, error: 'Login required — transcripts belong to the user account.' }
    const d = await fetch(
      `${WORKER}/transcript?userId=${encodeURIComponent(userId)}&id=${encodeURIComponent(input.id)}`,
      { headers: ikey(), cache: 'no-store' },
    ).then(r => r.json()).catch(() => null)
    if (!d?.transcript) {
      return {
        ok: false,
        error: d?.error === 'not found'
          ? 'No transcript with that id on this account — nicla_voice_transcripts lists the ones that exist.'
          : String(d?.error || 'transcript store unavailable'),
      }
    }
    return { ok: true, transcript: d.transcript }
  },
})

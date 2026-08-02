// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildVoiceTools } from '../lib/voice/tools'
import { makeSendMessageTool, makeReadMessagesTool } from '../lib/chat/tools/messages'

/**
 * The voice agent's roster is the contract the realtime model plans
 * against. The DM tools joined it after the user asked the voice agent to
 * send a message mid-call and it couldn't (chat had the tools, voice
 * didn't — on every client, noticed on Android).
 */
describe('voice tool roster', () => {
  for (const sessionType of ['tiny-ios', 'tiny-android', 'web']) {
    it(`advertises the DM tools to ${sessionType}`, () => {
      const names = buildVoiceTools(sessionType).map((t) => t.name)
      expect(names).toContain('send_message')
      expect(names).toContain('read_messages')
      // the memory trio that always rode the bridge stays
      expect(names).toContain('learn')
      expect(names).toContain('recall')
      expect(names).toContain('unlearn')
    })
  }

  it('the glasses tools ride BOTH native surfaces; meta_listen rides neither', () => {
    const ios = buildVoiceTools('tiny-ios').map((t) => t.name)
    const android = buildVoiceTools('tiny-android').map((t) => t.name)
    const web = buildVoiceTools('web').map((t) => t.name)
    for (const name of ['meta_take_photo', 'meta_record_video', 'meta_glasses_status']) {
      expect(ios).toContain(name)
      expect(android).toContain(name)
      expect(web).not.toContain(name)
    }
    // On a live call the model already hears through the glasses mic — a
    // second tap on the same input would fight the call itself.
    for (const names of [ios, android, web]) expect(names).not.toContain('meta_listen')
  })

  it('keeps generate_image iOS-only and screenshot native-only', () => {
    const ios = buildVoiceTools('tiny-ios').map((t) => t.name)
    const android = buildVoiceTools('tiny-android').map((t) => t.name)
    const web = buildVoiceTools('web').map((t) => t.name)
    expect(ios).toContain('generate_image')
    expect(android).not.toContain('generate_image')
    expect(android).toContain('screenshot')
    expect(web).not.toContain('screenshot')
  })
})

describe('DM tool factories (extracted for the voice bridge)', () => {
  it('send_message keeps its schema and refuses without a session', async () => {
    const t: any = makeSendMessageTool(null)
    expect(t.toolSpec.name).toBe('send_message')
    const schema = t._inputSchema
    expect(schema.safeParse({ to: 'mert', message: 'hi' }).success).toBe(true)
    expect(schema.safeParse({ message: 'hi' }).success).toBe(false)
    const out = await t.invoke({ to: 'mert', message: 'hi' }, {})
    expect(out.ok).toBe(false)
    expect(String(out.note || '')).toMatch(/login/i)
  })

  it('read_messages refuses without a session', async () => {
    const t: any = makeReadMessagesTool(null)
    expect(t.toolSpec.name).toBe('read_messages')
    const out = await t.invoke({}, {})
    expect(out.ok).toBe(false)
  })
})

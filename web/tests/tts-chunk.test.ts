// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { chunkSentences } from '../lib/voice/tts'

describe('chunkSentences — sentence-grouped TTS chunks', () => {
  it('keeps a short text as one chunk', () => {
    expect(chunkSentences('Hello there. How are you?')).toEqual(['Hello there. How are you?'])
  })

  it('groups sentences under the limit without splitting mid-sentence', () => {
    const chunks = chunkSentences('One two three. Four five six. Seven eight nine.', 20)
    expect(chunks).toEqual(['One two three.', 'Four five six.', 'Seven eight nine.'])
  })

  it('hard-splits a single monster sentence and keeps the remainder', () => {
    const monster = 'a'.repeat(750)
    const chunks = chunkSentences(monster, 300)
    expect(chunks.map((c) => c.length)).toEqual([300, 300, 150])
    expect(chunks.join('')).toBe(monster)
  })

  it('empty input → no chunks', () => {
    expect(chunkSentences('')).toEqual([])
    expect(chunkSentences('   ')).toEqual([])
  })
})

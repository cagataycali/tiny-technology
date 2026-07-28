// @vitest-environment jsdom
/**
 * SpeechCard — the speak-tool playback card. Its docblock hazard: the
 * useSyncExternalStore SERVER snapshot must be reference-stable or React
 * dev-warns "should be cached" and can loop during hydration. The tts store
 * is mocked; the snapshot invariant is pinned via React's own SSR warning.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { renderToString } from 'react-dom/server'

type SpeechState = { id: string | null; status: 'loading' | 'playing' | null }
let state: SpeechState = { id: null, status: null }
const listeners = new Set<() => void>()
const setState = (next: SpeechState) => {
  state = next
  act(() => { listeners.forEach((l) => l()) })
}

vi.mock('@/lib/voice/tts', () => ({
  subscribeSpeech: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) },
  getSpeechState: () => state,
  playSpeech: vi.fn(async () => {}),
  stopSpeech: vi.fn(),
}))

import SpeechCard from '../components/chat/SpeechCard'
import { playSpeech, stopSpeech } from '@/lib/voice/tts'

afterEach(() => {
  cleanup()
  state = { id: null, status: null }
  listeners.clear()
  vi.clearAllMocks()
})

describe('SpeechCard', () => {
  it('renders the idle play state for an utterance that is not playing', () => {
    render(<SpeechCard id="s1" text="hello there" voice="nova" />)
    expect(screen.getByLabelText('Play speech')).toBeTruthy()
    expect(screen.getByText('hello there')).toBeTruthy()
    expect(screen.getByText(/spoken reply/)).toBeTruthy()
  })

  it('play click hands the card to the tts store with its voice', () => {
    render(<SpeechCard id="s1" text="hi" voice="nova" />)
    fireEvent.click(screen.getByLabelText('Play speech'))
    expect(playSpeech).toHaveBeenCalledWith('s1', 'hi', { voice: 'nova', mode: 'neural' })
  })

  it('follows the EXTERNAL store: autoplay elsewhere flips this card to speaking', () => {
    render(<SpeechCard id="s1" text="hi" />)
    setState({ id: 's1', status: 'playing' })
    expect(screen.getByLabelText('Stop playback')).toBeTruthy()
    expect(screen.getByText(/speaking/)).toBeTruthy()
    // …and another utterance taking over releases it
    setState({ id: 's2', status: 'playing' })
    expect(screen.getByLabelText('Play speech')).toBeTruthy()
  })

  it('shows the loading state (cancel stays valid) while the voice model loads', () => {
    render(<SpeechCard id="s1" text="hi" />)
    setState({ id: 's1', status: 'loading' })
    expect(screen.getByText(/preparing voice/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Stop playback'))
    expect(stopSpeech).toHaveBeenCalled()
  })

  it('SSR renders without the uncached-getServerSnapshot dev warning', () => {
    const errors: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errors.push(String(args[0])) }
    try {
      const html = renderToString(createElement(SpeechCard, { id: 's1', text: 'hi' }))
      expect(html).toContain('Play speech')
      expect(errors.find((e) => /getServerSnapshot|should be cached/i.test(e))).toBeUndefined()
    } finally {
      console.error = orig
    }
  })
})

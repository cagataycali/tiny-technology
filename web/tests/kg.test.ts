// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { extractEntities, buildGraph, recallByAssociation } from '../components/chat/kg'

const mem = (id: string, content: string, ts = 1) => ({ id, content, ts })
const turn = (q: string, a: string, ts = 1) => ({ q, a, ts })

describe('extractEntities', () => {
  it('finds mid-sentence proper nouns, handles, slugs, quoted phrases', () => {
    const ents = extractEntities('I asked Cagatay about the "beach trip" via @tiny-bot on my-project yesterday.')
    expect(ents).toContain('cagatay')
    expect(ents).toContain('beach trip')
    expect(ents).toContain('@tiny-bot')
    expect(ents).toContain('my-project')
  })

  it('skips stopwords and sentence-initial capitals', () => {
    const ents = extractEntities('The weather is nice. Where should they go?')
    expect(ents).toHaveLength(0)
  })
})

describe('recallByAssociation', () => {
  it('direct entity match recalls the memory', () => {
    const g = buildGraph([mem('1', 'User works with Hawaii travel plans')], [])
    const out = recallByAssociation(g, 'tell me about Hawaii')
    expect(out).toHaveLength(1)
    expect(out[0].text).toContain('Hawaii')
  })

  it('1-hop association: prompt entity links to unmentioned memory', () => {
    // turn links "beach trip" ↔ Hawaii; memory only mentions Hawaii
    const g = buildGraph(
      [mem('1', 'Flights to Hawaii booked for June', 100)],
      [turn('planning our "beach trip"', 'Your Hawaii flights are set!', 200)]
    )
    const out = recallByAssociation(g, 'what was the "beach trip" plan?')
    // the Hawaii memory surfaces even though the prompt never says Hawaii
    expect(out.some((r) => r.text.includes('Flights to Hawaii'))).toBe(true)
  })

  it('ranks direct matches above associated ones', () => {
    const g = buildGraph(
      [
        mem('1', 'Notes about Kubernetes deployment', 100),
        mem('2', 'Kubernetes cluster linked to Grafana dashboards', 100),
        mem('3', 'Grafana alert thresholds tuned', 100),
      ],
      []
    )
    const out = recallByAssociation(g, 'how is Kubernetes doing?')
    expect(out[0].text).toMatch(/Kubernetes/)
    // Grafana-only memory may appear, but never first
    expect(out[out.length - 1].score).toBeLessThanOrEqual(out[0].score)
  })

  it('empty prompt or unknown entities → empty result', () => {
    const g = buildGraph([mem('1', 'Something about Paris')], [])
    expect(recallByAssociation(g, 'ok')).toHaveLength(0)
    expect(recallByAssociation(g, 'tell me about Tokyo')).toHaveLength(0)
  })

  it('respects the limit', () => {
    const mems = Array.from({ length: 10 }, (_, i) => mem(String(i), `Fact ${i} about Jupiter orbit`, i))
    const g = buildGraph(mems, [])
    expect(recallByAssociation(g, 'about Jupiter', 3)).toHaveLength(3)
  })
})

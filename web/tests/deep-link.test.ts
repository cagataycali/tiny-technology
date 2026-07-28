// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { decideDeepLink, stripDeepLinkParams } from '../lib/chat/deep-link'

const base = { search: '?q=hello', locked: false, viewingShare: false }

describe('decideDeepLink', () => {
  it('auto-sends a plain ?q= link', () => {
    expect(decideDeepLink({ ...base, query: 'hello' })).toEqual({ action: 'send', text: 'hello' })
  })

  it('only prefills with &send=0', () => {
    expect(decideDeepLink({ ...base, query: 'hello', search: '?q=hello&send=0' }))
      .toEqual({ action: 'prefill', text: 'hello' })
  })

  it('never auto-sends into a locked private tiny — prefill survives login', () => {
    expect(decideDeepLink({ ...base, query: 'hello', locked: true }))
      .toEqual({ action: 'prefill', text: 'hello' })
  })

  it('never auto-sends inside a share view', () => {
    expect(decideDeepLink({ ...base, query: 'hello', viewingShare: true }))
      .toEqual({ action: 'prefill', text: 'hello' })
  })

  it('does nothing without a query', () => {
    expect(decideDeepLink({ ...base, query: undefined })).toEqual({ action: 'none' })
    expect(decideDeepLink({ ...base, query: '' })).toEqual({ action: 'none' })
  })

  it('treats any send value other than "0" as auto-send', () => {
    expect(decideDeepLink({ ...base, query: 'x', search: '?q=x&send=1' }).action).toBe('send')
    expect(decideDeepLink({ ...base, query: 'x', search: '?q=x&send=' }).action).toBe('send')
  })
})

describe('stripDeepLinkParams', () => {
  it('removes q and send, keeps everything else including the hash', () => {
    expect(stripDeepLinkParams('https://x.test/scout?q=hi&send=0&chat=abc#frag'))
      .toBe('https://x.test/scout?chat=abc#frag')
  })

  it('is a no-op on a link without deep-link params', () => {
    expect(stripDeepLinkParams('https://x.test/scout?chat=abc'))
      .toBe('https://x.test/scout?chat=abc')
  })
})

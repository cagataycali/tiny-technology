// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseOpenAPI } from '../lib/utils'

const spec = (paths: any, components?: any) => ({
  openapi: '3.0.0',
  paths,
  ...(components ? { components } : {}),
})

describe('parseOpenAPI', () => {
  it('empty/malformed specs return []', () => {
    expect(parseOpenAPI(null)).toEqual([])
    expect(parseOpenAPI(undefined)).toEqual([])
    expect(parseOpenAPI({})).toEqual([])
    expect(parseOpenAPI({ paths: null })).toEqual([])
  })

  it('extracts operations with query parameters', () => {
    const fns = parseOpenAPI(spec({
      '/search': {
        get: {
          operationId: 'search',
          summary: 'Search things',
          parameters: [
            { name: 'q', description: 'Query', required: true, schema: { type: 'string' } },
          ],
        },
      },
    }), 'mytiny', 'https://worker.example.com')

    expect(fns).toHaveLength(1)
    expect(fns[0].name).toBe('search')
    expect(fns[0].method).toBe('get')
    expect(fns[0].worker).toBe('https://worker.example.com')
    expect(fns[0].parameters.properties.q.type).toBe('string')
  })

  it('falls back to method_path when operationId is missing', () => {
    const fns = parseOpenAPI(spec({ '/ping': { post: {} } }))
    expect(fns[0].name).toBe('post_/ping')
    expect(fns[0].description).toBe('POST /ping')
  })

  it('resolves $ref request bodies from components.schemas', () => {
    const fns = parseOpenAPI(spec(
      {
        '/items': {
          post: {
            operationId: 'createItem',
            requestBody: {
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Item' } },
              },
            },
          },
        },
      },
      { schemas: { Item: { type: 'object', properties: { title: { type: 'string', description: 'T' } }, required: ['title'] } } }
    ))
    expect(fns[0].parameters.properties.title.type).toBe('string')
    expect(fns[0].parameters.required).toContain('title')
  })

  it('survives a dangling $ref without throwing', () => {
    const fns = parseOpenAPI(spec({
      '/broken': {
        post: {
          operationId: 'broken',
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/DoesNotExist' } },
            },
          },
        },
      },
    }))
    // must not throw; the broken operation may have empty params but exists
    expect(fns).toHaveLength(1)
    expect(fns[0].name).toBe('broken')
  })

  it('survives operations that are not objects', () => {
    const fns = parseOpenAPI(spec({
      '/weird': { get: null, post: 'nonsense', put: { operationId: 'ok' } },
    }))
    expect(fns.some((f: any) => f.name === 'ok')).toBe(true)
  })

  it('array parameters carry items through', () => {
    const fns = parseOpenAPI(spec({
      '/tags': {
        get: {
          operationId: 'byTags',
          parameters: [
            { name: 'tags', schema: { type: 'array', items: { type: 'string' } } },
          ],
        },
      },
    }))
    expect(fns[0].parameters.properties.tags.type).toBe('array')
    expect(fns[0].parameters.properties.tags.items).toEqual({ type: 'string' })
  })

  it('survives a requestBody with missing/malformed content (no throw)', () => {
    // requestBody present but content missing, null, or non-object — reading
    // ['application/json'] off it would throw and fault the whole chat turn.
    expect(() => parseOpenAPI(spec({
      '/a': { post: { operationId: 'a', requestBody: {} } },
      '/b': { post: { operationId: 'b', requestBody: { content: null } } },
      '/c': { post: { operationId: 'c', requestBody: { content: 'nope' } } },
    }))).not.toThrow()
    const fns = parseOpenAPI(spec({
      '/a': { post: { operationId: 'a', requestBody: {} } },
    }))
    expect(fns.some((f: any) => f.name === 'a')).toBe(true)
  })

  it('survives non-array parameters (truthy but not a list)', () => {
    // A spec with `parameters` as an object/string would throw out of .forEach.
    expect(() => parseOpenAPI(spec({
      '/x': { get: { operationId: 'x', parameters: { bogus: true } } },
      '/y': { get: { operationId: 'y', parameters: 'nope' } },
    }))).not.toThrow()
    const fns = parseOpenAPI(spec({
      '/x': { get: { operationId: 'x', parameters: { bogus: true } } },
    }))
    expect(fns.some((f: any) => f.name === 'x')).toBe(true)
  })
})

/**
 * Edge-safe Bedrock model for the Strands SDK.
 *
 * Talks directly to Bedrock's ConverseStream REST endpoint using fetch()
 * with bearer-token auth (AWS_BEARER_TOKEN_BEDROCK) — no @aws-sdk/*,
 * no node:http, works on Vercel Edge runtime.
 *
 * Parses the application/vnd.amazon.eventstream binary framing and maps
 * Converse events → Strands ModelStreamEvents.
 */
import { Model } from '@strands-agents/sdk'
import type { Message } from '@strands-agents/sdk'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BedrockEdgeConfig {
  modelId?: string
  region?: string
  apiKey?: string // bearer token
  maxTokens?: number
  temperature?: number
  topP?: number
  contextWindowLimit?: number
  /**
   * Passed verbatim as Converse's `additionalModelRequestFields` — the
   * escape hatch for model-specific features, e.g. the 1M-context beta:
   * `{ anthropic_beta: ['context-1m-2025-08-07'] }`.
   */
  additionalModelRequestFields?: Record<string, unknown>
}

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'endTurn',
  tool_use: 'toolUse',
  max_tokens: 'maxTokens',
  stop_sequence: 'stopSequence',
  content_filtered: 'contentFiltered',
  guardrail_intervened: 'guardrailIntervened',
}

// ---------------------------------------------------------------------------
// AWS eventstream binary frame parser
// Frame: [4B total len][4B headers len][4B prelude CRC][headers][payload][4B CRC]
// Header: [1B name len][name][1B type(7=string)][2B value len][value]
// ---------------------------------------------------------------------------

interface EventFrame {
  headers: Record<string, string>
  payload: any
}

// Exported for tests (tests/bedrock-eventstream.test.ts) — not public API
export function parseHeaders(buf: Uint8Array): Record<string, string> {
  const headers: Record<string, string> = {}
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const dec = new TextDecoder()
  let o = 0
  while (o < buf.byteLength) {
    const nameLen = dv.getUint8(o); o += 1
    const name = dec.decode(buf.subarray(o, o + nameLen)); o += nameLen
    const type = dv.getUint8(o); o += 1
    if (type === 7) { // string
      const valLen = dv.getUint16(o); o += 2
      headers[name] = dec.decode(buf.subarray(o, o + valLen)); o += valLen
    } else {
      // skip other header types (bool=0/1 no value; ints fixed sizes)
      const sizes: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }
      if (type === 6) { const l = dv.getUint16(o); o += 2 + l } // bytes
      else o += sizes[type] ?? 0
    }
  }
  return headers
}

// Exported for tests — not public API
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<EventFrame> {
  const reader = body.getReader()
  let buf = new Uint8Array(0)
  const dec = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // append
      const next = new Uint8Array(buf.byteLength + value.byteLength)
      next.set(buf); next.set(value, buf.byteLength)
      buf = next
      // extract complete frames
      while (buf.byteLength >= 12) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
        const totalLen = dv.getUint32(0)
        const headersLen = dv.getUint32(4)
        // A frame is [12B prelude][headers][payload][4B CRC], so the smallest
        // valid totalLen is 16 and headersLen must fit inside it. A corrupt or
        // truncated frame reporting totalLen < 16 (esp. 0) would make
        // `buf.subarray(totalLen)` a no-op and spin this loop forever — bail.
        if (totalLen < 16 || headersLen > totalLen - 16) {
          throw new Error(`Bedrock stream: malformed frame (totalLen=${totalLen}, headersLen=${headersLen})`)
        }
        if (buf.byteLength < totalLen) break
        const headers = parseHeaders(buf.subarray(12, 12 + headersLen))
        const payloadBytes = buf.subarray(12 + headersLen, totalLen - 4)
        let payload: any = null
        if (payloadBytes.byteLength > 0) {
          try { payload = JSON.parse(dec.decode(payloadBytes)) } catch { payload = null }
        }
        yield { headers, payload }
        buf = buf.subarray(totalLen)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Strands message JSON → Converse content blocks
// ---------------------------------------------------------------------------

function toConverseContent(blocks: any[]): any[] {
  const out: any[] = []
  for (const b of blocks) {
    if (b.text !== undefined) out.push({ text: b.text })
    else if (b.toolUse) out.push({ toolUse: b.toolUse })
    else if (b.toolResult) {
      out.push({
        toolResult: {
          toolUseId: b.toolResult.toolUseId,
          status: b.toolResult.status,
          content: (b.toolResult.content || []).map((c: any) =>
            c.json !== undefined ? { json: c.json } : { text: c.text ?? JSON.stringify(c) }
          ),
        },
      })
    } else if (b.reasoning) {
      out.push({
        reasoningContent: {
          reasoningText: {
            text: b.reasoning.text ?? '',
            ...(b.reasoning.signature ? { signature: b.reasoning.signature } : {}),
          },
        },
      })
    } else if (b.image?.source) {
      const bytes = toBase64(b.image.source.bytes)
      if (bytes) out.push({ image: { format: b.image.format || 'jpeg', source: { bytes } } })
    } else if (b.document?.source) {
      const bytes = toBase64(b.document.source.bytes)
      if (bytes) {
        out.push({
          document: {
            name: b.document.name || 'document',
            format: b.document.format,
            source: { bytes },
          },
        })
      }
    }
  }
  return out
}

// Converse's JSON API wants blob fields as base64 strings; Strands blocks may
// carry Uint8Array (deserialized) or base64 string (raw JSON) bytes.
function toBase64(bytes: unknown): string | null {
  if (typeof bytes === 'string') return bytes
  if (bytes instanceof Uint8Array) {
    let bin = ''
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)))
    }
    return btoa(bin)
  }
  return null
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export class BedrockEdgeModel extends Model<BedrockEdgeConfig> {
  private _config: BedrockEdgeConfig

  constructor(config: BedrockEdgeConfig = {}) {
    super()
    this._config = { region: 'us-west-2', ...config }
  }

  updateConfig(config: BedrockEdgeConfig): void {
    this._config = { ...this._config, ...config }
  }

  getConfig(): BedrockEdgeConfig {
    return this._config
  }

  async *stream(messages: Message[], options?: any): AsyncIterable<any> {
    const { modelId, region, apiKey, maxTokens, temperature, topP, additionalModelRequestFields } = this._config
    if (!modelId) throw new Error('BedrockEdgeModel: modelId is required')
    if (!apiKey) throw new Error('BedrockEdgeModel: apiKey (bearer token) is required')

    const request: any = {
      messages: messages.map((m: any) => {
        const j = typeof m.toJSON === 'function' ? m.toJSON() : m
        return { role: j.role, content: toConverseContent(j.content || []) }
      }),
      inferenceConfig: {
        ...(maxTokens ? { maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(topP !== undefined ? { topP } : {}),
      },
      // Model-specific request fields (e.g. anthropic_beta for 1M context)
      ...(additionalModelRequestFields && Object.keys(additionalModelRequestFields).length
        ? { additionalModelRequestFields }
        : {}),
    }

    if (options?.systemPrompt) {
      request.system =
        typeof options.systemPrompt === 'string'
          ? [{ text: options.systemPrompt }]
          : options.systemPrompt.map((b: any) => (typeof b.toJSON === 'function' ? b.toJSON() : b))
    }

    if (options?.toolSpecs?.length) {
      request.toolConfig = {
        tools: options.toolSpecs.map((spec: any) => ({
          toolSpec: {
            name: spec.name,
            description: spec.description,
            inputSchema: { json: spec.inputSchema ?? { type: 'object', properties: {} } },
          },
        })),
        ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
      }
    }

    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse-stream`
    if (process.env.BEDROCK_EDGE_DEBUG) { const rj = JSON.stringify(request); for (let i = 0; i < rj.length; i += 3000) console.log('[bedrock-edge] REQ_CHUNK', i, rj.slice(i, i + 3000)) }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    })

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Bedrock converse-stream error ${res.status}: ${errText.slice(0, 500)}`)
    }

    const startedBlocks = new Set<number>()

    for await (const frame of parseEventStream(res.body)) {
      if (process.env.BEDROCK_EDGE_DEBUG) console.log('[bedrock-edge] frame', JSON.stringify(frame.headers), JSON.stringify(frame.payload)?.slice(0, 200))
      const msgType = frame.headers[':message-type']
      const evType = frame.headers[':event-type'] || frame.headers[':exception-type']
      const p = frame.payload

      if (msgType === 'exception' || frame.headers[':exception-type']) {
        throw new Error(`Bedrock stream exception (${evType}): ${JSON.stringify(p).slice(0, 500)}`)
      }
      if (!p) continue

      switch (evType) {
        case 'messageStart':
          yield { type: 'modelMessageStartEvent', role: p.role || 'assistant' }
          break

        case 'contentBlockStart': {
          const idx = p.contentBlockIndex ?? 0
          startedBlocks.add(idx)
          if (p.start?.toolUse) {
            yield {
              type: 'modelContentBlockStartEvent',
              start: {
                type: 'toolUseStart',
                name: p.start.toolUse.name,
                toolUseId: p.start.toolUse.toolUseId,
              },
            }
          } else {
            yield { type: 'modelContentBlockStartEvent' }
          }
          break
        }

        case 'contentBlockDelta': {
          const idx = p.contentBlockIndex ?? 0
          if (!startedBlocks.has(idx)) {
            // Bedrock omits contentBlockStart for text blocks — synthesize it
            startedBlocks.add(idx)
            yield { type: 'modelContentBlockStartEvent' }
          }
          const d = p.delta || {}
          if (d.text !== undefined) {
            yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: d.text } }
          } else if (d.toolUse?.input !== undefined) {
            yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: d.toolUse.input } }
          } else if (d.reasoningContent) {
            yield {
              type: 'modelContentBlockDeltaEvent',
              delta: {
                type: 'reasoningContentDelta',
                ...(d.reasoningContent.text !== undefined ? { text: d.reasoningContent.text } : {}),
                ...(d.reasoningContent.signature !== undefined ? { signature: d.reasoningContent.signature } : {}),
              },
            }
          }
          break
        }

        case 'contentBlockStop':
          yield { type: 'modelContentBlockStopEvent' }
          break

        case 'messageStop':
          yield {
            type: 'modelMessageStopEvent',
            stopReason: STOP_REASON_MAP[p.stopReason] || p.stopReason || 'endTurn',
          }
          break

        case 'metadata':
          if (p.usage) {
            yield {
              type: 'modelMetadataEvent',
              usage: {
                inputTokens: p.usage.inputTokens ?? 0,
                outputTokens: p.usage.outputTokens ?? 0,
                totalTokens: p.usage.totalTokens ?? 0,
              },
            }
          }
          break
      }
    }
  }
}

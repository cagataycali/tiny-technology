/**
 * Server-side memory tools (issue #14 v2, extracted from the chat route) —
 * learn/recall/unlearn against the worker's learnings store (D1 + Vectorize
 * semantic index). Factories over the request session: memories attach to
 * the signed-in user's account and follow them across devices.
 *
 * ⚠️ Memory semantics (capacity, rejection-not-eviction, scoring) are owned
 * by the memory-v2 work — this file only relocates the tool definitions.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { SessionUser } from '@/lib/auth'
import { planUnlearn, unlearnBody, unlearnNote } from '../unlearn-scope'
import { planGraphQuery, graphQueryParams, graphEmptyNote, GRAPH_RELS } from '../graph-query'

const WORKER = 'https://plugin.tiny.technology'

/** Spread a note only when there is one, so a healthy result keeps its shape. */
const noteOf = (note: string | undefined) => (note ? { note } : {})
const ikey = () => ({
  'Content-Type': 'application/json',
  'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
})

export const makeLearnTool = (session: SessionUser | null) => tool({
  name: 'learn',
  description: 'Store a durable memory about the user on the server — persists across ALL their sessions, devices and tinys (unlike remember, which is browser-local). Everything you learn is semantically indexed and findable later via recall, even when not shown in your context. When a new fact REPLACES an outdated one (moved cities, changed preference, new job), pass the old memory id(s) in supersedes — the old fact is closed (kept as history, out of recall) and linked to its successor, instead of you unlearning + learning separately. Capacity 5000 entries × 2000 chars each; when full the write is REJECTED (nothing is silently deleted) — unlearn or consolidate first. One fact per entry; make each self-contained since it may be recalled alone.',
  inputSchema: z.object({
    content: z.string().describe('The memory to store (self-contained, factual, ≤2000 chars)'),
    supersedes: z.array(z.union([z.string(), z.number()])).optional()
      .describe('Memory ids this fact replaces (from your context or recall results) — they are closed bitemporally, not deleted'),
    edges: z.array(z.object({
      rel: z.enum(['part_of', 'authored', 'relates_to', 'about']).describe('Relation type'),
      dst: z.union([z.string(), z.number()]).describe('Existing memory id this fact links to'),
      scope: z.string().optional().describe('Context qualifier (e.g. a project name) — distinguishes context-bound facts'),
    })).optional()
      .describe('Link this fact to EXISTING memories (ids from context/recall) — connected facts surface together in recall'),
    visibility: z.enum(['private', 'public']).optional()
      .describe("'public' shares this fact with the user's followers (their feed). ONLY when the user explicitly asks to share/publish — default private"),
  }),
  callback: async (input) => {
    if (!session) {
      return { ok: false, note: 'Login required — memories attach to the user account.' }
    }
    return fetch(`${WORKER}/learnings`, {
      method: 'POST',
      headers: ikey(),
      body: JSON.stringify({
        userId: session.sub,
        content: input.content,
        // Worker declares these as JSON-string fields (itty-router strips
        // undeclared/typed-mismatched body fields — AGENTS.md #8)
        ...(input.supersedes?.length ? { supersedes: JSON.stringify(input.supersedes) } : {}),
        ...(input.edges?.length ? { edges: JSON.stringify(input.edges) } : {}),
        ...(input.visibility === 'public' ? { visibility: 'public' } : {}),
      }),
    }).then(r => r.json()).catch((e) => ({ ok: false, error: String(e) }))
  },
})

export const makeRecallTool = (session: SessionUser | null) => tool({
  name: 'recall',
  description: "Semantic search across ALL the user's server-side memories — only the most recent and most relevant ones are pre-loaded in your context. Use whenever the user references something you might have stored (a past project, preference, fact) BEFORE saying you don't know or don't remember. hops=1 also walks the memory graph: facts LINKED to the matches (via learn's edges/supersedes) join the results even when they don't match the query text — use it when context matters (projects, relationships, threads).",
  inputSchema: z.object({
    query: z.string().describe('What to look for, phrased as meaning, not keywords'),
    hops: z.number().optional().describe('0 (default) = pure semantic match; 1 = expand through graph edges to connected facts'),
  }),
  callback: async (input) => {
    if (!session) return { ok: false, note: 'Login required.' }
    const hops = input.hops === 1 ? '&hops=1' : ''
    return fetch(`${WORKER}/learnings?userId=${encodeURIComponent(session.sub)}&limit=0&q=${encodeURIComponent(input.query)}${hops}`, {
      headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
    }).then(r => r.json())
      .then(d => ({ ok: true, matches: d.relevant || [], totalMemories: d.total }))
      .catch((e) => ({ ok: false, error: String(e) }))
  },
})

export const makeGraphNeighborsTool = (session: SessionUser | null) => tool({
  name: 'memory_graph',
  description: `Explore graph structure. mode 'neighbors' (default): the subgraph around one of the user's memories — supersedes trails show what replaced what ('when did I change that?'), part_of/relates_to/about clusters show context; check before consolidating. mode 'social': the PUBLIC interaction graph around a node ('user:<numeric id>' or 'tiny:<slug>' — NOT an @login) + trust scores (PageRank over tiny-consults-tiny edges) — who visits/follows/consults whom, in aggregate. mode 'feed': fresh public activity from builders the user follows — their shared memories and new public tinys/tools; check when they ask what's new in their network. Node ids and relation names are matched EXACTLY, so a malformed argument is refused rather than answered with an empty graph you might read as "no links".`,
  inputSchema: z.object({
    node: z.union([z.string(), z.number()]).optional().describe("neighbors: a memory id · social: 'user:<numeric id>' or 'tiny:<slug>' (omit ENTIRELY for the global trust ranking — an empty string is refused, not treated as omitted)"),
    mode: z.enum(['neighbors', 'social', 'feed']).optional().describe("Default 'neighbors'"),
    hops: z.number().optional().describe('neighbors: traversal depth 1 (default) or 2'),
    rels: z.array(z.enum(GRAPH_RELS)).optional().describe(`neighbors: filter to specific relations (${GRAPH_RELS.join(', ')}), e.g. ['supersedes']. An unknown name excludes every edge, so it is refused`),
  }),
  callback: async (input) => {
    if (!session) return { ok: false, note: 'Login required.' }
    const headers = { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' }
    // The worker matches node ids and rel names EXACTLY (NEIGHBOR_EDGES_SQL:
    // `src = ?2 OR dst = ?2`; relFilter.includes(e.rel)), so every malformed
    // argument used to return a healthy 200 with an EMPTY graph — which reads
    // as "that memory has no links" / "they interact with nobody". A truncated
    // id, a cut rels list, a misspelled relation and a falsy social node (which
    // fell through to the global trust ranking) were all that shape. Refuse
    // instead: an empty result must only ever mean an empty graph.
    // See lib/chat/graph-query.
    const plan = planGraphQuery(input)
    if (plan.kind === 'refuse') return { ok: false, error: plan.error }
    if (plan.kind === 'social') {
      const qs = new URLSearchParams(graphQueryParams(plan))
      return fetch(`${WORKER}/graph/social?${qs}`, { headers })
        .then(r => r.json())
        .then(d => (d.ok === false || d.error
          ? d
          : { ...d, ...noteOf(graphEmptyNote(plan, d.edges?.length || 0)) }))
        .catch((e) => ({ ok: false, error: String(e) }))
    }
    if (plan.kind === 'feed') {
      return fetch(`${WORKER}/graph/feed?userId=${encodeURIComponent(session.sub)}&limit=30`, { headers })
        .then(r => r.json())
        .then(d => ({
          ...d,
          note: (d.feed?.length || d.artifacts?.length)
            ? 'Share anything relevant naturally; feed = memories they chose to publish, artifacts = new public tinys/tools.'
            : 'Nothing new from followed builders — they may not follow anyone yet (the Follow button lives on builder profiles).',
        }))
        .catch((e) => ({ ok: false, error: String(e) }))
    }
    const qs = new URLSearchParams({ userId: session.sub, ...graphQueryParams(plan) })
    return fetch(`${WORKER}/graph/neighbors?${qs}`, { headers })
      .then(r => r.json())
      .then(d => (d.ok === false || d.error
        ? d
        : { ...d, ...noteOf(graphEmptyNote(plan, d.edges?.length || 0)) }))
      .catch((e) => ({ ok: false, error: String(e) }))
  },
})

export const makeConflictsTool = (session: SessionUser | null) => tool({
  name: 'memory_conflicts',
  description: "Detect and resolve contradictions in the user's memory graph. action:'list' surfaces conflict sets — same subject + relation pointing at DIFFERENT facts in the same scope (facts in different scopes are context-bound, never flagged). action:'resolve' keeps one candidate edge and closes the rest as history (nothing is deleted). When you spot a conflict, ASK the user which is current — one tap resolves it.",
  inputSchema: z.object({
    action: z.enum(['list', 'resolve']),
    keep: z.string().optional().describe('resolve: edge id to keep (from list results)'),
    close: z.array(z.string()).optional().describe('resolve: edge ids to close as history'),
  }),
  callback: async (input) => {
    if (!session) return { ok: false, note: 'Login required.' }
    if (input.action === 'list') {
      return fetch(`${WORKER}/graph/conflicts?userId=${encodeURIComponent(session.sub)}`, {
        headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
      }).then(r => r.json())
        .then(d => ({
          ok: true,
          conflicts: d.conflicts || [],
          note: (d.conflicts || []).length
            ? 'Present the candidates to the user and ask which is current, then resolve with keep + close.'
            : 'No contradictions in the memory graph.',
        }))
        .catch((e) => ({ ok: false, error: String(e) }))
    }
    if (!input.keep || !input.close?.length) return { ok: false, error: 'resolve needs keep + close (edge ids from list)' }
    return fetch(`${WORKER}/graph/resolve`, {
      method: 'POST',
      headers: ikey(),
      body: JSON.stringify({
        userId: session.sub,
        keep: input.keep,
        close: JSON.stringify(input.close),
      }),
    }).then(r => r.json()).catch((e) => ({ ok: false, error: String(e) }))
  },
})

export const makeUnlearnTool = (session: SessionUser | null) => tool({
  name: 'unlearn',
  description: "Close stored server-side memories about the user (bitemporal — closed facts leave listings and recall but survive as history). Pass an id (from your context or a recall result) to close ONE. Clearing everything requires scope:'all' EXPLICITLY — it also purges the semantic index and is NOT recoverable, so confirm with the user first. An omitted or empty id is refused, never treated as clear-all.",
  inputSchema: z.object({
    id: z.union([z.string(), z.number()]).optional().describe('Learning id to close (keeps it as history)'),
    scope: z.literal('all').optional().describe("Erase EVERY memory + the semantic index — irreversible. Only when the user explicitly asked to clear everything"),
  }),
  callback: async (input) => {
    if (!session) return { ok: false, note: 'Login required.' }
    // Clear-all must be REQUESTED, never inferred. The old body spread
    // (`...(input.id ? { id } : {})`) let every falsy id fall through to
    // "delete everything" — including `id: ''`, which is what a model emits
    // when it means "this one" but has no id in hand. Clear-all is also the one
    // memory op that is NOT bitemporal (it purges the vector index), while the
    // human path puts a danger confirm in front of closing a single RECOVERABLE
    // memory. See lib/chat/unlearn-scope.
    const plan = planUnlearn(input)
    if (plan.kind === 'refuse') return { ok: false, error: plan.error }
    return fetch(`${WORKER}/learnings`, {
      method: 'DELETE',
      headers: ikey(),
      body: JSON.stringify(unlearnBody(session.sub, plan)),
    }).then(r => r.json())
      .then(d => (d.ok === false ? d : { ...d, note: unlearnNote(plan) }))
      .catch((e) => ({ ok: false, error: String(e) }))
  },
})

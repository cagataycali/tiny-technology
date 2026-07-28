"use client";

/**
 * Knowledge-graph memory (COMPARISON.md §2.12, careless graphology-lite) —
 * association recall over the CLIENT-side continuity layer (localStorage
 * memories + turn log). Server-side learnings/memory-v2 are untouched.
 *
 * Graph model, rebuilt on demand (no persistence — source data is small):
 *   nodes = entities (proper-ish nouns, @handles, tiny/slug names, quoted
 *           phrases) extracted heuristically, lowercased
 *   edges = co-occurrence in the same memory or turn, weighted by count
 *
 * Recall: entities in the prompt seed a spreading activation — 1 hop for
 * strong direct matches, 2 hops when weak. Returns memories/turns ranked
 * by activation that substring matching would miss (ask about "the beach
 * trip" → recalls the memory mentioning Hawaii because a turn linked them).
 */

import { getMemories, getTurnLog, type MemoryEntry, type TurnEntry } from "./continuity";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "with",
  "about", "into", "over", "under", "this", "that", "these", "those", "it",
  "its", "his", "her", "their", "your", "our", "you", "she", "him", "them",
  "what", "which", "who", "whom", "when", "where", "why", "how", "all",
  "each", "both", "more", "most", "some", "such", "not", "only", "own",
  "same", "than", "too", "very", "can", "will", "just", "should", "now",
  "also", "was", "are", "were", "been", "being", "have", "has", "had",
  "does", "did", "doing", "would", "could", "there", "here", "user", "they",
]);

/** Heuristic entity extraction — cheap, deterministic, no model calls. */
export function extractEntities(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  // @handles and slug-like tokens (my-tiny, tool_name)
  const handles = text.match(/@[a-zA-Z0-9-_]{2,30}/g) || [];
  handles.forEach((h) => found.add(h.toLowerCase()));

  // "quoted phrases" — explicit naming is a strong signal
  const quoted = text.match(/"([^"]{2,40})"/g) || [];
  quoted.forEach((q) => found.add(q.replace(/"/g, "").trim().toLowerCase()));

  // Capitalized words not at sentence start (proper-noun-ish); plus
  // sentence-initial capitals that repeat elsewhere lowercase-free
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^[^a-zA-Z@]+|[^a-zA-Z0-9-_]+$/g, "");
    if (w.length < 3 || w.length > 30) continue;
    const lower = w.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    const isCapitalized = /^[A-Z]/.test(w);
    const prevEndsSentence = i === 0 || /[.!?]$/.test(words[i - 1]);
    if (isCapitalized && !prevEndsSentence) found.add(lower);
    // hyphen/underscore slugs are entity-ish regardless of case
    else if (/[-_]/.test(w) && /^[a-z0-9-_]+$/i.test(w)) found.add(lower);
  }

  return Array.from(found);
}

type Doc = { id: string; text: string; ts: number; kind: "memory" | "turn" };

type Graph = {
  // entity → set of doc ids containing it
  entityDocs: Map<string, Set<string>>;
  // entity → co-occurring entity → weight
  edges: Map<string, Map<string, number>>;
  docs: Map<string, Doc>;
};

export function buildGraph(memories: MemoryEntry[], turns: TurnEntry[]): Graph {
  const entityDocs = new Map<string, Set<string>>();
  const edges = new Map<string, Map<string, number>>();
  const docs = new Map<string, Doc>();

  const addDoc = (doc: Doc) => {
    docs.set(doc.id, doc);
    const ents = extractEntities(doc.text);
    ents.forEach((e) => {
      if (!entityDocs.has(e)) entityDocs.set(e, new Set());
      entityDocs.get(e)!.add(doc.id);
    });
    // co-occurrence edges (undirected, weight += 1 per shared doc)
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < ents.length; j++) {
        const [a, b] = [ents[i], ents[j]];
        if (!edges.has(a)) edges.set(a, new Map());
        if (!edges.has(b)) edges.set(b, new Map());
        edges.get(a)!.set(b, (edges.get(a)!.get(b) || 0) + 1);
        edges.get(b)!.set(a, (edges.get(b)!.get(a) || 0) + 1);
      }
    }
  };

  memories.forEach((m) => addDoc({ id: `m:${m.id}`, text: m.content + (m.tags?.length ? " " + m.tags.join(" ") : ""), ts: m.ts, kind: "memory" }));
  turns.forEach((t, i) => addDoc({ id: `t:${i}`, text: `${t.q} ${t.a}`, ts: t.ts, kind: "turn" }));

  return { entityDocs, edges, docs };
}

/**
 * Association recall: activate prompt entities, spread 1 hop (dampened),
 * rank docs by total activation of the entities they contain. Docs that
 * only match via association (no direct entity overlap) still surface.
 */
export function recallByAssociation(
  graph: Graph,
  prompt: string,
  limit = 4
): { text: string; kind: "memory" | "turn"; score: number }[] {
  const seeds = extractEntities(prompt);
  if (seeds.length === 0) return [];

  // activation: seed = 1.0, neighbors = 0.4 * edgeWeight/maxWeight
  const activation = new Map<string, number>();
  seeds.forEach((s) => { if (graph.entityDocs.has(s)) activation.set(s, 1.0); });

  seeds.forEach((s) => {
    const nbrs = graph.edges.get(s);
    if (!nbrs) return;
    let max = 0;
    nbrs.forEach((w) => { if (w > max) max = w; });
    nbrs.forEach((w, nbr) => {
      const spread = 0.4 * (w / max);
      activation.set(nbr, Math.max(activation.get(nbr) || 0, spread));
    });
  });

  if (activation.size === 0) return [];

  // score docs by summed activation of contained entities
  const docScores = new Map<string, number>();
  activation.forEach((act, entity) => {
    const docIds = graph.entityDocs.get(entity);
    if (!docIds) return;
    docIds.forEach((id) => docScores.set(id, (docScores.get(id) || 0) + act));
  });

  return Array.from(docScores.entries())
    .map(([id, score]) => ({ doc: graph.docs.get(id)!, score }))
    .filter((x) => x.doc)
    .sort((a, b) => b.score - a.score || b.doc.ts - a.doc.ts)
    .slice(0, limit)
    .map((x) => ({
      text: x.doc.kind === "turn" ? x.doc.text.slice(0, 300) : x.doc.text,
      kind: x.doc.kind,
      score: Number(x.score.toFixed(2)),
    }));
}

/** One-call helper for the chat path: graph over this tiny's local data. */
export function kgRecall(tinyName: string, prompt: string, limit = 4) {
  try {
    const graph = buildGraph(getMemories(tinyName), getTurnLog(tinyName));
    return recallByAssociation(graph, prompt, limit);
  } catch {
    return [];
  }
}

/**
 * Turn-pair removal (extracted from four hand-rolled copies in Chat.tsx) —
 * a retryable assistant bubble (paywall card, failed stream, stale signed-out
 * paywall on resume) is dropped TOGETHER with the user prompt directly above
 * it, because send() re-adds both. The user message's attachments are handed
 * back so the retry carries them.
 *
 * Out-of-range index (findIndex miss) is a no-op returning the SAME array —
 * retry sites still send without dropping, matching the old inline behavior.
 */
export type TurnMessage = { role: string; attachments?: unknown }

export function dropTurnPairAt<M extends TurnMessage>(
  msgs: M[],
  idx: number,
): { messages: M[]; attachments: M['attachments'] } {
  if (idx < 0 || idx >= msgs.length) return { messages: msgs, attachments: undefined }
  const userIdx = idx > 0 && msgs[idx - 1].role === 'user' ? idx - 1 : idx
  const attachments = userIdx !== idx ? msgs[userIdx].attachments : undefined
  return { messages: msgs.filter((_, i) => i !== idx && i !== userIdx), attachments }
}

export function dropTurnPair<M extends TurnMessage & { id: string }>(
  msgs: M[],
  asstId: string,
): { messages: M[]; attachments: M['attachments'] } {
  return dropTurnPairAt(msgs, msgs.findIndex((m) => m.id === asstId))
}

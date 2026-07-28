package technology.tiny.app.chat

/**
 * Pure visibility rule for the up-front "💵 $X/msg" price badge on the chat top
 * bar. Kept out of the (concurrent-churned) MainActivity Compose tree so the
 * gate is unit-tested once and can't drift from iOS/web.
 *
 * The badge warns that a paid tiny charges per message BEFORE a 402 bounces
 * mid-send. It shows only when:
 *  - the tiny actually has a price ([priceMicro] non-null; the lookup only sets
 *    it when price > 0, so a free tiny is null), AND
 *  - the room is reachable — a private tiny this device hasn't been vouched for
 *    replaces the composer with the lock panel, so a visitor can't send anyway;
 *    a badge over the lock is a control that dead-ends.
 *
 * Byte-identical to web `priceMicro !== null && !(priv && !isAuthorized)`
 * (Chat.tsx:2386) and iOS `let price = chat.priceMicro, !(chat.isPrivate &&
 * !chat.isAuthorized)` (Views.swift:1607). Android showed it regardless of the
 * private lock before this — the divergence this closes.
 */
fun shouldShowPriceBadge(priceMicro: Long?, isPrivate: Boolean, isAuthorized: Boolean): Boolean =
    priceMicro != null && !(isPrivate && !isAuthorized)

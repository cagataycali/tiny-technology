/**
 * Relay SQL shared by relay.ts (the routes) and push.ts (the notify fan-out).
 *
 * A deliberate leaf module: relay.ts calls sendPushToUser from push.ts (a late
 * device reply pushes — RelayReplyCall), and push.ts writes {type:'notify'}
 * envelopes with this INSERT. If each imported the other directly, that pair
 * would be an import cycle; both import THIS instead. relay.ts re-exports the
 * statement so existing importers (worker-gated tests) keep one source of truth.
 */
export const RELAY_INSERT_SQL = `
  INSERT INTO relay_messages (id, user_id, to_device, in_reply_to, payload, created_at, delivered)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)`;

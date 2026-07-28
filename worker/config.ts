// Secrets now live in Cloudflare Worker secrets (wrangler secret put):
//   OPENAI_API_KEY     — embeddings
//   INTERNAL_API_KEY   — guards internal /user/* + /credential/* endpoints
// Stripe has been fully removed — tiny.technology is a free platform.
export const OPENAI_MODEL_NAME = "gpt-5-2025-08-07";
export const OPENAI_TEMPERATURE = 1;

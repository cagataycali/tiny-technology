/**
 * Shared SQL helpers for the worker's D1 queries.
 */

/**
 * Escape the LIKE wildcards `% _` (and the escape char `\` itself) so a
 * user-supplied search/prefix matches LITERALLY. MUST be paired with
 * `LIKE ? ESCAPE '\'` in the query — otherwise a `%` or `_` in the input acts
 * as a wildcard, silently ignoring the caller's filter (a `%` prefix would
 * match every row). Used by /list (name prefix) and /tools/browse (q).
 *
 * escapeLike('a%b_c') → 'a\\%b\\_c'
 */
export function escapeLike(input: string): string {
  return String(input ?? '').replace(/[\\%_]/g, (m) => `\\${m}`);
}

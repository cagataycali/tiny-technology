// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { isBangExpr } from '../components/chat/bang'

// isBangExpr is the ROUTING gate: true → the input runs through the sandboxed
// -iframe eval (runBang), false → it goes to the model as a normal message.
// A false positive would silently eval a user's prose; a false negative loses
// the zero-token shortcut. The regex must accept `!expr` but reject the paste
// artifacts `!!`, `!=`, `!==`, bare `!`, and `! ` (space).
describe('isBangExpr — bang-eval routing gate', () => {
  it.each([
    '!2**10',
    '!Math.sqrt(2)',
    '!true',
    '!"a"+"b"',
    '  !5 + 5  ',   // leading/trailing space is trimmed
    '!fetch',       // still a bang expr (eval decides what it does)
  ])('accepts %s', (s) => {
    expect(isBangExpr(s)).toBe(true)
  })

  it.each([
    '!!x',          // double-bang boolean coercion, not an eval
    '!= 5',         // comparison paste
    '!==',
    '! 5',          // space after ! — \S requires a non-space next
    '!',            // bare bang
    '',             // empty
    'hello world',  // plain prose
    'x!5',          // ! not at the start
    'wait! really', // ! mid-sentence
  ])('rejects %s', (s) => {
    expect(isBangExpr(s)).toBe(false)
  })
})

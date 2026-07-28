// @vitest-environment jsdom
/**
 * DynamicUI realm shadowing (backlog v4 C4): render_ui executes
 * agent-authored componentCode via new Function — the page globals it must
 * never reach (localStorage holds BYOK keys; fetch exfiltrates; document/
 * window walk to both) are shadowed to undefined. Charts get React +
 * recharts and nothing else.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import DynamicUI from '../components/chat/DynamicUI'

afterEach(cleanup)

const probe = (expr: string) =>
  `() => React.createElement('div', { 'data-testid': 'probe' }, String(${expr}))`

describe('DynamicUI realm shadowing', () => {
  it('agent code cannot see storage, network, or the document', () => {
    render(<DynamicUI id="t1" componentCode={probe(
      'typeof localStorage + "|" + typeof sessionStorage + "|" + typeof fetch + "|" + ' +
      'typeof XMLHttpRequest + "|" + typeof document + "|" + typeof window + "|" + typeof globalThis'
    )} />)
    expect(screen.getByTestId('probe').textContent)
      .toBe('undefined|undefined|undefined|undefined|undefined|undefined|undefined')
  })

  it('React and recharts still work — the two real capabilities', () => {
    render(<DynamicUI id="t1" componentCode={
      `() => {
        const [n] = useState(41);
        return React.createElement('div', { 'data-testid': 'probe' }, String(n + 1) + '|' + typeof recharts.LineChart);
      }`
    } />)
    // recharts components are memo/forwardRef-wrapped — typeof 'object'
    expect(screen.getByTestId('probe').textContent).toBe('42|object')
  })

  it('strict mode blocks the sloppy-mode global escape (implicit this)', () => {
    // Without "use strict", a plain function's `this` is the global object —
    // the classic sandbox escape around shadowed params.
    render(<DynamicUI id="t1" componentCode={
      `() => {
        const leak = (function () { return this; })();
        return React.createElement('div', { 'data-testid': 'probe' }, String(leak));
      }`
    } />)
    expect(screen.getByTestId('probe').textContent).toBe('undefined')
  })
})

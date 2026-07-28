"use client";

/**
 * Roving-tabindex + arrow-key movement for an ARIA radiogroup.
 *
 * Several pickers (Onboarding + ModelSettings on-device model, Onboarding
 * BYOK provider) render single-select as role="radiogroup" with role="radio"
 * buttons + aria-checked — the correct roles, but each radio was
 * independently Tab-focusable with no arrow handling. The ARIA radio pattern
 * promises ONE tab stop with arrow keys moving between options; without it,
 * keyboard/SR users get behavior that contradicts the announced role.
 *
 * Usage:
 *   const rg = useRadioGroup(items.map(i => i.id), selected, setSelected);
 *   <div role="radiogroup" onKeyDown={rg.onKeyDown} …>
 *     {items.map(i => (
 *       <button role="radio" aria-checked={selected === i.id}
 *               tabIndex={rg.tabIndex(i.id)} onClick={() => setSelected(i.id)} …/>
 *     ))}
 *   </div>
 *
 * No container ref needed: onKeyDown's `e.currentTarget` IS the radiogroup,
 * so the next radio is found from there. (Reading a hook-returned ref during
 * render trips eslint-plugin-react-hooks' `refs` rule; sidestepping it via
 * currentTarget keeps the hook's return value ref-free.) Focus works
 * synchronously because every radio is already in the DOM (only the tabindex
 * roves) — arrow selects the next id AND moves focus to it.
 */
import { type KeyboardEvent } from "react";

export function useRadioGroup(
  ids: string[],
  selected: string | null | undefined,
  onSelect: (id: string) => void,
) {
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const k = e.key;
    if (k !== "ArrowRight" && k !== "ArrowDown" && k !== "ArrowLeft" && k !== "ArrowUp") return;
    if (!ids.length) return;
    e.preventDefault();
    const dir: 1 | -1 = k === "ArrowRight" || k === "ArrowDown" ? 1 : -1;
    // Delegate the "which id is next?" decision to the pure, tested core rather
    // than re-deriving it inline — otherwise the hook and nextRadioId can drift.
    const nextId = nextRadioId(ids, selected, dir);
    if (nextId == null) return;
    onSelect(nextId);
    // Radios render in `ids` order → the nth [role=radio] is ids[next]. The
    // event's currentTarget IS the radiogroup container.
    const next = ids.indexOf(nextId);
    const radios = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    radios?.[next]?.focus();
  };

  // Roving: the checked radio is the single tab stop; if none is checked yet,
  // the first radio takes it so the group is still reachable by Tab. Same
  // pure core (rovingTabStop) the tests pin, so the two can't diverge.
  const tabIndex = (id: string): 0 | -1 => (rovingTabStop(ids, selected) === id ? 0 : -1);

  return { onKeyDown, tabIndex };
}

/**
 * Pure core of the roving-tabindex decision, extracted for testing:
 * which id should be the group's single tab stop (tabIndex 0)?
 */
export function rovingTabStop(ids: string[], selected: string | null | undefined): string | null {
  if (!ids.length) return null;
  if (selected != null && ids.indexOf(selected) !== -1) return selected;
  return ids[0];
}

/**
 * Pure core of arrow-key movement, extracted for testing: given the current
 * selection and an arrow direction, which id is next?
 */
export function nextRadioId(
  ids: string[],
  selected: string | null | undefined,
  dir: 1 | -1,
): string | null {
  if (!ids.length) return null;
  const cur = selected ? ids.indexOf(selected) : -1;
  const base = cur === -1 ? 0 : cur;
  return ids[(base + dir + ids.length) % ids.length];
}

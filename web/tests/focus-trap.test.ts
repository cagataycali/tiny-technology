import { describe, it, expect } from "vitest";
import { trapTarget, FOCUSABLE_SELECTOR } from "../lib/chat/focus-trap";

describe("trapTarget — Tab wrap math for the aria-modal focus trap", () => {
  it("no focusables → null (hook holds focus on the container)", () => {
    expect(trapTarget(0, -1, false)).toBe(null);
    expect(trapTarget(0, -1, true)).toBe(null);
  });

  it("focus on the container (index -1) pulls to the near edge", () => {
    expect(trapTarget(3, -1, false)).toBe(0); // Tab → first
    expect(trapTarget(3, -1, true)).toBe(2); // Shift+Tab → last
  });

  it("focus escaped outside the list (index -1) is pulled back in", () => {
    // activeIndex resolves to -1 when the focused node isn't in the trap
    expect(trapTarget(5, -1, false)).toBe(0);
    expect(trapTarget(5, -1, true)).toBe(4);
  });

  it("Tab on the last element wraps to first", () => {
    expect(trapTarget(3, 2, false)).toBe(0);
  });

  it("Shift+Tab on the first element wraps to last", () => {
    expect(trapTarget(3, 0, true)).toBe(2);
  });

  it("interior Tab / Shift+Tab returns null (let the browser move naturally)", () => {
    expect(trapTarget(3, 0, false)).toBe(null); // first, forward → interior
    expect(trapTarget(3, 1, false)).toBe(null);
    expect(trapTarget(3, 1, true)).toBe(null);
    expect(trapTarget(3, 2, true)).toBe(null); // last, backward → interior
  });

  it("single focusable: Tab and Shift+Tab both wrap to itself", () => {
    expect(trapTarget(1, 0, false)).toBe(0); // last === first
    expect(trapTarget(1, 0, true)).toBe(0);
  });

  it("negative/garbage count is treated as empty", () => {
    expect(trapTarget(-1, 0, false)).toBe(null);
  });

  it("selector excludes the container and roving-parked controls (tabindex=-1)", () => {
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
    // must not naively include disabled controls
    expect(FOCUSABLE_SELECTOR).not.toContain("button,");
  });
});

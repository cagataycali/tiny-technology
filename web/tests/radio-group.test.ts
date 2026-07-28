import { describe, it, expect } from "vitest";
import { rovingTabStop, nextRadioId } from "../lib/chat/use-radio-group";

describe("rovingTabStop — which radio is the single tab stop", () => {
  const ids = ["a", "b", "c"];

  it("is the selected id when one is selected", () => {
    expect(rovingTabStop(ids, "b")).toBe("b");
  });

  it("falls back to the first id when nothing is selected", () => {
    expect(rovingTabStop(ids, null)).toBe("a");
    expect(rovingTabStop(ids, undefined)).toBe("a");
  });

  it("falls back to the first id when the selection isn't in the list", () => {
    expect(rovingTabStop(ids, "zzz")).toBe("a");
  });

  it("returns null for an empty group", () => {
    expect(rovingTabStop([], "a")).toBeNull();
  });
});

describe("nextRadioId — arrow-key movement", () => {
  const ids = ["a", "b", "c"];

  it("moves forward and wraps past the end", () => {
    expect(nextRadioId(ids, "a", 1)).toBe("b");
    expect(nextRadioId(ids, "c", 1)).toBe("a");
  });

  it("moves backward and wraps past the start", () => {
    expect(nextRadioId(ids, "b", -1)).toBe("a");
    expect(nextRadioId(ids, "a", -1)).toBe("c");
  });

  it("starts from the first id when nothing is selected", () => {
    // base index 0 → forward lands on ids[1], backward wraps to last
    expect(nextRadioId(ids, null, 1)).toBe("b");
    expect(nextRadioId(ids, null, -1)).toBe("c");
  });

  it("treats an unknown selection like no selection", () => {
    expect(nextRadioId(ids, "zzz", 1)).toBe("b");
  });

  it("returns null for an empty group", () => {
    expect(nextRadioId([], null, 1)).toBeNull();
  });

  it("stays put in a single-item group", () => {
    expect(nextRadioId(["only"], "only", 1)).toBe("only");
    expect(nextRadioId(["only"], "only", -1)).toBe("only");
  });
});

import { describe, expect, test } from "bun:test";
import { admit } from "./writeLimiter";

describe("admit", () => {
  test("admits up to the limit inside the window, then refuses", () => {
    let hits: number[] = [];
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      const r = admit(hits, 1_000 + i, 5, 60_000);
      hits = r.hits;
      results.push(r.allowed);
    }
    expect(results).toEqual([true, true, true, true, true, false, false]);
  });

  test("refused attempts do not extend the block", () => {
    const full = [0, 1, 2, 3, 4];
    expect(admit(full, 59_999, 5, 60_000)).toEqual({ allowed: false, hits: full });
    expect(admit(full, 60_000, 5, 60_000).allowed).toBe(true);
  });
});

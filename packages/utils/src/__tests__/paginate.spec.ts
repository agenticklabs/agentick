/**
 * `paginate` — the shared offset-pagination mechanism.
 *
 * These pin the semantics the `@agentick/resources` harness shipped when it
 * hand-rolled this (the shape precedent every other wire surface now follows):
 * opaque decimal-offset cursors, `nextCursor` absent on the last page, and a
 * garbage cursor starting over rather than throwing.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE, paginate } from "../paginate.js";

const items = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => i);

describe("paginate", () => {
  it("returns the whole list with no cursor when it fits in one page", () => {
    const { page, nextCursor } = paginate(items(3), undefined, 10);
    expect(page).toEqual([0, 1, 2]);
    expect(nextCursor).toBeUndefined();
  });

  it("walks every item exactly once across pages", () => {
    const all = items(7);
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const p = paginate(all, cursor, 3);
      seen.push(...p.page);
      cursor = p.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual([...all]);
  });

  it("emits the next OFFSET as the cursor", () => {
    expect(paginate(items(7), undefined, 3).nextCursor).toBe("3");
    expect(paginate(items(7), "3", 3).nextCursor).toBe("6");
  });

  it("omits nextCursor when the page ends exactly at the boundary", () => {
    // 6 items, page size 3: the second page consumes the tail, so there is no
    // third (empty) page to advertise.
    expect(paginate(items(6), "3", 3).nextCursor).toBeUndefined();
  });

  it("treats a garbage, negative, or empty cursor as the start", () => {
    for (const bad of ["nope", "-4", "", " "]) {
      expect(paginate(items(5), bad, 2).page).toEqual([0, 1]);
    }
  });

  it("decodes a leading-numeric cursor by its prefix (parseInt semantics)", () => {
    expect(paginate(items(5), "3x", 2).page).toEqual([3, 4]);
  });

  it("returns an empty page past the end, with no cursor", () => {
    const { page, nextCursor } = paginate(items(3), "99", 10);
    expect(page).toEqual([]);
    expect(nextCursor).toBeUndefined();
  });

  it("defaults to DEFAULT_PAGE_SIZE", () => {
    const { page, nextCursor } = paginate(items(DEFAULT_PAGE_SIZE + 1), undefined);
    expect(page).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(nextCursor).toBe(String(DEFAULT_PAGE_SIZE));
  });

  it("never mutates the input", () => {
    const all = items(4);
    paginate(all, "2", 2);
    expect(all).toEqual([0, 1, 2, 3]);
  });
});

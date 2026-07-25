import { describe, expect, it } from "vitest";

import { createSourceInterner } from "../source-interner.js";

describe("createSourceInterner", () => {
  it("mints turn-stable ids in first-seen order and drops undefined fields", () => {
    const interner = createSourceInterner();
    const a = interner.intern({ url: "https://a.example", title: "A" });
    const b = interner.intern({ documentIndex: 2 });
    expect(a).toEqual({ id: "s0", url: "https://a.example", title: "A" });
    expect(b).toEqual({ id: "s1", documentIndex: 2 });
    // no `title`/`documentIndex` key leaks onto `a`; no `url`/`title` onto `b`
    expect(Object.keys(a).sort()).toEqual(["id", "title", "url"]);
    expect(Object.keys(b).sort()).toEqual(["documentIndex", "id"]);
  });

  it("reuses one Source (one id) for a repeated url — dedupe by natural key", () => {
    const interner = createSourceInterner();
    const first = interner.intern({ url: "https://x.example", title: "X" });
    const again = interner.intern({ url: "https://x.example", title: "X (again)" });
    expect(again).toBe(first); // same object, same id — title of the FIRST wins
    expect(again.id).toBe("s0");
    expect(interner.all()).toEqual([first]);
  });

  it("dedupes documents by documentIndex", () => {
    const interner = createSourceInterner();
    const d0 = interner.intern({ documentIndex: 0, title: "doc" });
    const d0again = interner.intern({ documentIndex: 0 });
    const d1 = interner.intern({ documentIndex: 1 });
    expect(d0again).toBe(d0);
    expect(d1.id).toBe("s1");
    expect(interner.all().map((s) => s.id)).toEqual(["s0", "s1"]);
  });

  it("treats a source with no natural key (no url, no documentIndex) as distinct each time", () => {
    const interner = createSourceInterner();
    const a = interner.intern({ title: "untethered" });
    const b = interner.intern({ title: "untethered" });
    expect(a.id).toBe("s0");
    expect(b.id).toBe("s1"); // no key to share → two entities
    expect(interner.all()).toHaveLength(2);
  });

  it("all() reflects first-seen order across interleaved interns", () => {
    const interner = createSourceInterner();
    interner.intern({ url: "https://1.example" });
    interner.intern({ url: "https://2.example" });
    interner.intern({ url: "https://1.example" }); // dedup — no new entry
    interner.intern({ url: "https://3.example" });
    expect(interner.all().map((s) => s.url)).toEqual([
      "https://1.example",
      "https://2.example",
      "https://3.example",
    ]);
  });
});

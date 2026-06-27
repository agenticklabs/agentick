/**
 * `<format formatter={ref} purpose?>` — formatter-scope intrinsic.
 *
 * Pins:
 *  - `<format>` contributes no IR fragment of its own (passthrough)
 *  - The active scope's formatter is stamped on direct-child
 *    section/message entries as `renderedWith`
 *  - Nested `<format>` swaps the binding for the inner scope; outer
 *    scope is restored once we leave the inner subtree
 *  - `purpose="section"` scopes the swap to sections only; messages
 *    inside the same `<format>` use the parent scope
 *  - Malformed `<format>` (missing/invalid `formatter`) surfaces a
 *    walker diagnostic but does NOT crash; descendants render under
 *    the parent scope
 */

import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { compileToTree } from "../index.js";

const md = { id: "markdown", format: "markdown" as const };
const xml = { id: "xml", format: "xml" as const };
const text = { id: "text", format: "text" as const };

function format(props: Record<string, unknown>, ...children: ReactNode[]) {
  return createElement("format" as never, props, ...children);
}

describe("<format> — formatter scope provider", () => {
  it("contributes no IR fragment — purely a scope provider", async () => {
    const tree = await compileToTree(
      format({ formatter: md }, createElement("message" as never, { role: "user" }, "hi")),
    );
    expect(tree.context.entries).toHaveLength(1);
    const m = tree.context.entries[0]!;
    if (m.kind !== "message") throw new Error("expected message entry");
    expect(m.role).toBe("user");
  });

  it("stamps `renderedWith` from the active scope on a section", async () => {
    const tree = await compileToTree(
      format({ formatter: xml }, createElement("section" as never, { id: "s" }, "body")),
    );
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
    expect(s.renderedWith?.id).toBe("xml");
    expect(s.renderedWith?.format).toBe("xml");
  });

  it("stamps `renderedWith` on a message too", async () => {
    const tree = await compileToTree(
      format(
        { formatter: text },
        createElement("message" as never, { role: "assistant", id: "m1" }, "reply"),
      ),
    );
    const m = tree.context.entries[0]!;
    if (m.kind !== "message") throw new Error("expected message");
    expect(m.renderedWith?.id).toBe("text");
    expect(m.renderedWith?.format).toBe("text");
  });

  it("section outside any <format> has no `renderedWith` stamp", async () => {
    const tree = await compileToTree(createElement("section" as never, { id: "s" }, "body"));
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
    expect(s.renderedWith).toBeUndefined();
  });

  it("nested <format> swaps the binding — innermost wins for the inner subtree", async () => {
    const tree = await compileToTree(
      format(
        { formatter: md },
        createElement(
          "section" as never,
          { id: "outer" },
          "outer body",
          format(
            { formatter: xml },
            createElement("section" as never, { id: "inner" }, "inner body"),
          ),
        ),
      ),
    );
    // Outer + inner both come out; outer is stamped markdown, inner xml.
    const [outer, inner] = tree.context.entries;
    if (outer?.kind !== "section" || inner?.kind !== "section") {
      throw new Error("expected two sections");
    }
    expect(outer.id).toBe("outer");
    expect(outer.renderedWith?.id).toBe("markdown");
    expect(inner.id).toBe("inner");
    expect(inner.renderedWith?.id).toBe("xml");
  });

  it("outer scope is restored after a nested <format> ends", async () => {
    const tree = await compileToTree(
      format(
        { formatter: md },
        createElement(
          "section" as never,
          { id: "a" },
          format({ formatter: xml }, createElement("section" as never, { id: "b" }, "x")),
        ),
        createElement("section" as never, { id: "c" }, "after"),
      ),
    );
    const ids = tree.context.entries.map((e) => (e.kind === "section" ? e.id : null));
    expect(ids).toEqual(["a", "b", "c"]);
    const [a, b, c] = tree.context.entries;
    if (a?.kind !== "section" || b?.kind !== "section" || c?.kind !== "section") {
      throw new Error("expected three sections");
    }
    expect(a.renderedWith?.id).toBe("markdown");
    expect(b.renderedWith?.id).toBe("xml");
    expect(c.renderedWith?.id).toBe("markdown");
  });

  it('purpose="section" scopes the swap to sections only — messages use parent scope', async () => {
    const tree = await compileToTree(
      format(
        { formatter: md },
        format(
          { formatter: xml, purpose: "section" },
          createElement("section" as never, { id: "s" }, "section body"),
          createElement("message" as never, { role: "user" }, "msg body"),
        ),
      ),
    );
    const [s, m] = tree.context.entries;
    if (s?.kind !== "section" || m?.kind !== "message") {
      throw new Error("expected section + message");
    }
    expect(s.renderedWith?.id).toBe("xml");
    expect(m.renderedWith?.id).toBe("markdown");
  });

  it("malformed <format> (missing formatter prop) emits a diagnostic and falls through", async () => {
    const tree = await compileToTree(
      format(
        {
          /* formatter missing */
        },
        createElement("section" as never, { id: "s" }, "body"),
      ),
    );
    expect(tree.context.entries).toHaveLength(1);
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
    expect(s.renderedWith).toBeUndefined(); // parent scope was empty
    expect(tree.diagnostics?.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "format-missing-formatter",
      }),
    );
  });

  it("unknown purpose is ignored — binding replaces default", async () => {
    const tree = await compileToTree(
      format(
        { formatter: xml, purpose: "not-a-purpose" },
        createElement("section" as never, { id: "s" }, "body"),
      ),
    );
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
    expect(s.renderedWith?.id).toBe("xml");
  });

  it("spec-valid but unsupported purpose downgrades to default replacement", async () => {
    // "resource" is in the FormatPurpose union but no walker dispatch
    // site reads `resolveFormatter(scope, "resource")` yet. The binding
    // should land as the scope DEFAULT, so section dispatch (which asks
    // for purpose="section") still picks it up via the default fallback.
    const tree = await compileToTree(
      format(
        { formatter: xml, purpose: "resource" },
        createElement("section" as never, { id: "s" }, "body"),
      ),
    );
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
    expect(s.renderedWith?.id).toBe("xml");
  });

  it("<format> with multiple direct children walks all of them", async () => {
    // Regression guard: the original `format(props, child)` helper arity
    // would have silently dropped extra children. Forces the dispatch
    // through the multi-child path.
    const tree = await compileToTree(
      format(
        { formatter: xml },
        createElement("section" as never, { id: "a" }, "alpha"),
        createElement("section" as never, { id: "b" }, "bravo"),
        createElement("section" as never, { id: "c" }, "charlie"),
      ),
    );
    const ids = tree.context.entries.map((e) => (e.kind === "section" ? e.id : null));
    expect(ids).toEqual(["a", "b", "c"]);
    for (const e of tree.context.entries) {
      if (e.kind !== "section") throw new Error("expected section");
      expect(e.renderedWith?.id).toBe("xml");
    }
  });

  it("semantic-html descendants render unaffected under <format> scope", async () => {
    // dispatch-semantic accepts WalkScope but produces no entries —
    // there's nothing for renderedWith to stamp onto. This test pins
    // that semantic-mode recursion still works (the scope threading
    // through dispatch-semantic is not a no-op of the WRONG kind:
    // it doesn't drop or corrupt semantic children).
    const tree = await compileToTree(
      format(
        { formatter: xml },
        createElement(
          "section" as never,
          { id: "s" },
          createElement("h2" as never, null, "Heading"),
          createElement("p" as never, null, "Paragraph body."),
        ),
      ),
    );
    const s = tree.context.entries[0]!;
    if (s.kind !== "section") throw new Error("expected section");
    expect(s.renderedWith?.id).toBe("xml");
    // Section's content carries the semantic-html children as blocks.
    expect(s.content.length).toBeGreaterThan(0);
  });
});

describe("walker diagnostics — surfaced via RenderedTree.diagnostics", () => {
  it("media block without a valid source emits a diagnostic", async () => {
    // Force a malformed media source by passing undefined.
    const tree = await compileToTree(
      createElement(
        "section" as never,
        { id: "s" },
        createElement("image" as never, {
          /* source missing */
        }),
      ),
    );
    expect(tree.diagnostics?.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "media-missing-source",
      }),
    );
  });

  it("system_event without `event` emits a diagnostic", async () => {
    const tree = await compileToTree(
      createElement(
        "section" as never,
        { id: "s" },
        createElement("system_event" as never, {
          /* event missing */
        }),
      ),
    );
    expect(tree.diagnostics?.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "system-event-missing-event",
      }),
    );
  });

  it("clean tree (section root) has no diagnostics field at all", async () => {
    const tree = await compileToTree(createElement("section" as never, { id: "s" }, "fine"));
    expect(tree.diagnostics).toBeUndefined();
  });

  it("clean tree (message root) has no diagnostics field", async () => {
    const tree = await compileToTree(createElement("message" as never, { role: "user" }, "ok"));
    expect(tree.diagnostics).toBeUndefined();
  });

  it("clean tree (code block root) has no diagnostics field", async () => {
    const tree = await compileToTree(
      createElement("code" as never, { language: "ts" }, "const x = 1;"),
    );
    expect(tree.diagnostics).toBeUndefined();
  });

  it("clean tree (free-root text only) has no diagnostics field", async () => {
    const tree = await compileToTree("plain text at root");
    expect(tree.diagnostics).toBeUndefined();
  });
});

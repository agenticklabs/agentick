/**
 * `compileTemplate(element, opts)` — JSX → IR.
 * `renderTemplate(element, opts)` — JSX → formatted string.
 *
 * Pins for compileTemplate:
 *  - Static element renders → entries on tree.context.entries
 *  - useData suspends → render-until-stable resolves; final IR carries
 *    fetched data
 *  - useData rejection → throws RenderFailed
 *  - maxIterations cap → surfaces `max-iterations` diagnostic
 *  - Multiple sections / messages in render order
 *  - No session/journal/bridges leakage — each call is fresh
 *  - defaultFormatter stamps `renderedWith` on section entries
 *  - <tool> declarations land on tree.declarations.tools
 *
 * Pins for renderTemplate:
 *  - Default markdown formatter produces sensible output
 *  - Section title framing (markdown `## title`)
 *  - Message role framing (`**user:** ...`)
 *  - useData-resolved content reaches the final string
 */

import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { markdownFormatter, xmlFormatter, textFormatter } from "@agentick/formatters";

import { useData } from "../react/hooks/use-data.js";

import { compileTemplate, renderTemplate } from "../template.js";

describe("compileTemplate — JSX → IR", () => {
  it("renders a single <section> with inline text", async () => {
    const Template = () => createElement("section" as never, { id: "intro" }, "Hello, world.");
    const { tree, diagnostics, iterations } = await compileTemplate(createElement(Template));
    expect(diagnostics).toHaveLength(0);
    expect(iterations).toBe(1);
    expect(tree.context.entries).toHaveLength(1);
    const entry = tree.context.entries[0]!;
    expect(entry.kind).toBe("section");
    if (entry.kind !== "section") throw new Error("expected section");
    expect(entry.id).toBe("intro");
  });

  it("renders multiple entries in declaration order", async () => {
    const Tpl = () => (
      <>
        {createElement("section" as never, { id: "a" }, "alpha")}
        {createElement("message" as never, { role: "user" }, "bravo")}
        {createElement("section" as never, { id: "c" }, "charlie")}
      </>
    );
    const { tree } = await compileTemplate(createElement(Tpl));
    expect(tree.context.entries).toHaveLength(3);
    const ids = tree.context.entries.map((e) => (e.kind === "section" ? e.id : `msg:${e.role}`));
    expect(ids).toEqual(["a", "msg:user", "c"]);
  });

  it("awaits useData and re-renders until stable", async () => {
    const Template = () => {
      const greeting = useData("greet", async () => "Hello, async");
      return createElement("section" as never, { id: "greet" }, greeting);
    };
    const { tree, iterations } = await compileTemplate(createElement(Template));
    expect(iterations).toBeGreaterThan(1);
    expect(tree.context.entries).toHaveLength(1);
    const entry = tree.context.entries[0]!;
    if (entry.kind !== "section") throw new Error("expected section");
    expect(entry.content.some((b) => b.type === "text" && b.text.includes("Hello, async"))).toBe(
      true,
    );
  });

  it("dedupes useData calls with the same key across renders", async () => {
    let fetchCount = 0;
    const Template = () => {
      const a = useData("shared", async () => {
        fetchCount++;
        return "shared value";
      });
      const b = useData("shared", async () => {
        fetchCount++;
        return "DIFFERENT";
      });
      return createElement("section" as never, { id: "x" }, `${a}/${b}`);
    };
    await compileTemplate(createElement(Template));
    expect(fetchCount).toBe(1);
  });

  it("each call is fresh — no shared cache across compileTemplate invocations", async () => {
    let firstCount = 0;
    let secondCount = 0;
    const T1 = () => {
      useData("k", async () => {
        firstCount++;
        return "1";
      });
      return createElement("section" as never, { id: "x" }, "ok");
    };
    const T2 = () => {
      useData("k", async () => {
        secondCount++;
        return "2";
      });
      return createElement("section" as never, { id: "x" }, "ok");
    };
    await compileTemplate(createElement(T1));
    await compileTemplate(createElement(T2));
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
  });

  it("surfaces a useData rejection as RenderFailed", async () => {
    const Template = () => {
      useData("boom", async () => {
        throw new Error("kaboom");
      });
      return createElement("section" as never, { id: "x" }, "never reached");
    };
    await expect(compileTemplate(createElement(Template))).rejects.toMatchObject({
      _tag: "RenderFailed",
    });
  });

  it("surfaces max-iterations diagnostic when the loop can't stabilize", async () => {
    let counter = 0;
    const Template = () => {
      const k = `k-${counter++}`;
      useData(k, async () => k);
      return createElement("section" as never, { id: "x" }, "loop");
    };
    const { diagnostics, iterations } = await compileTemplate(createElement(Template), {
      maxIterations: 3,
    });
    expect(iterations).toBe(3);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "max-iterations" }),
    );
  });

  it("respects defaultFormatter — stamps `renderedWith` on section entries", async () => {
    const Template = () => createElement("section" as never, { id: "x" }, "body");
    const { tree } = await compileTemplate(createElement(Template), {
      defaultFormatter: { id: "xml", format: "xml" },
    });
    const entry = tree.context.entries[0]!;
    if (entry.kind !== "section") throw new Error("expected section");
    expect(entry.renderedWith?.id).toBe("xml");
  });

  it("walker dispatches a <tool> declaration into tree.declarations.tools", async () => {
    const inputSchema = {
      "~standard": {
        vendor: "test",
        version: 1,
        validate: (i: unknown) => ({ value: i }),
      },
    };
    const Template = () =>
      createElement("tool" as never, {
        name: "search",
        inputSchema: inputSchema as never,
      });
    const { tree } = await compileTemplate(createElement(Template));
    expect(tree.declarations?.tools).toHaveLength(1);
    expect(tree.declarations!.tools![0]!.name).toBe("search");
  });
});

describe("renderTemplate — JSX → formatted string", () => {
  it("produces markdown by default with section framing", async () => {
    const Template = () =>
      createElement("section" as never, { id: "intro", title: "Greeting" }, "Hello.");
    const { output, diagnostics } = await renderTemplate(createElement(Template));
    expect(diagnostics).toHaveLength(0);
    expect(output).toContain("## Greeting");
    expect(output).toContain("Hello.");
  });

  it("frames messages with role prefix in markdown mode", async () => {
    const Tpl = () => (
      <>
        {createElement("message" as never, { role: "user" }, "ping")}
        {createElement("message" as never, { role: "assistant" }, "pong")}
      </>
    );
    const { output } = await renderTemplate(createElement(Tpl));
    expect(output).toContain("**user:** ping");
    expect(output).toContain("**assistant:** pong");
  });

  it("honors xmlFormatter — wraps sections in <section> tags", async () => {
    const Template = () => createElement("section" as never, { id: "intro" }, "body");
    const { output } = await renderTemplate(createElement(Template), {
      formatter: xmlFormatter,
    });
    expect(output).toContain('<section id="intro">');
    expect(output).toContain("body");
    expect(output).toContain("</section>");
  });

  it("honors textFormatter — minimal framing", async () => {
    const Template = () => createElement("section" as never, { id: "intro", title: "Hi" }, "body");
    const { output } = await renderTemplate(createElement(Template), {
      formatter: textFormatter,
    });
    expect(output).toContain("Hi");
    expect(output).toContain("body");
    expect(output).not.toContain("##");
  });

  it("awaited useData content reaches the final string", async () => {
    const Template = () => {
      const greeting = useData("greet", async () => "from-server");
      return createElement("section" as never, { id: "x" }, greeting);
    };
    const { output, iterations } = await renderTemplate(createElement(Template));
    expect(iterations).toBeGreaterThan(1);
    expect(output).toContain("from-server");
  });

  it("explicit markdownFormatter matches the default", async () => {
    const Template = () => createElement("section" as never, { id: "x" }, "hi");
    const explicit = await renderTemplate(createElement(Template), {
      formatter: markdownFormatter,
    });
    const implicit = await renderTemplate(createElement(Template));
    expect(explicit.output).toBe(implicit.output);
  });
});

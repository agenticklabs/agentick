/**
 * Contributor regression suite — props in → spec value out.
 *
 * Guards the derivation pass: every contributor derives its props from a
 * spec type and forwards ALL of them. The motivating regression is the
 * `<tool>` contributor silently dropping `ToolDeclaration.aliases` (Pass A)
 * and `ToolDeclaration.providerOptions` (Pass D); `ToolAnnotations.executedBy`
 * (landed in commit b4c21596) rides the same spread and is asserted here too.
 *
 * These run the FULL `collect()` path (walker → contributors → fold), so
 * they also cover the `provider-tool` contributor's fold onto
 * `RenderedTree.declarations.providerTools`.
 */

import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@agentick/spec";

import {
  createElementInstance,
  createTextInstance,
  type HostInstance,
} from "../host/host-instance.js";
import { rootScope } from "../host/host-context.js";
import { collect } from "../collect/collect.js";
import { createBuiltInRegistry } from "../collect/contributors/built-ins.js";

function el(
  type: string,
  props: Record<string, unknown>,
  children: readonly HostInstance[] = [],
): HostInstance {
  const inst = createElementInstance(type, props, rootScope);
  for (const child of children) {
    (child as { parent: HostInstance | null }).parent = inst;
    inst.children.push(child);
  }
  return inst;
}

function run(root: HostInstance) {
  return collect({ roots: [root], registry: createBuiltInRegistry(), rootScope });
}

const SCHEMA = {} as StandardSchemaV1;

describe("tool contributor — the motivating bug", () => {
  it("forwards aliases + providerOptions + annotations.executedBy (previously dropped)", () => {
    const { tree } = run(
      el("tool", {
        name: "search",
        inputSchema: SCHEMA,
        aliases: ["find", "lookup"],
        providerOptions: { openai: { strict: true } },
        annotations: { executedBy: "mcp:server1", title: "Search" },
        exposure: ["model", "dispatch"],
        outputSchema: SCHEMA,
        metadata: { team: "core" },
      }),
    );
    const tool = tree.declarations?.tools?.[0];
    expect(tool?.name).toBe("search");
    // Pass A — was silently dropped by the hand-declared ToolProps.
    expect(tool?.aliases).toEqual(["find", "lookup"]);
    // Pass D — was silently dropped by the hand-declared ToolProps.
    expect(tool?.providerOptions).toEqual({ openai: { strict: true } });
    // b4c21596 — flows through the derivation automatically.
    expect(tool?.annotations?.executedBy).toBe("mcp:server1");
    expect(tool?.annotations?.title).toBe("Search");
    expect(tool?.exposure).toEqual(["model", "dispatch"]);
    expect(tool?.outputSchema).toBe(SCHEMA);
    expect(tool?.metadata).toEqual({ team: "core" });
  });

  it("defaults id / description / exposure and folds child text into description", () => {
    const { tree } = run(
      el("tool", { name: "t", inputSchema: SCHEMA }, [createTextInstance("Use this when stuck")]),
    );
    const tool = tree.declarations?.tools?.[0];
    expect(tool?.description).toBe("Use this when stuck");
    expect(tool?.exposure).toEqual(["model"]);
    expect(typeof tool?.id).toBe("string");
  });
});

describe("provider-tool contributor — Pass D sugar (new)", () => {
  it("folds onto declarations.providerTools", () => {
    const { tree } = run(
      el("provider-tool", {
        provider: "openai",
        type: "web_search_preview",
        name: "web_search",
        config: { maxResults: 5 },
      }),
    );
    expect(tree.declarations?.providerTools).toEqual([
      {
        provider: "openai",
        type: "web_search_preview",
        name: "web_search",
        config: { maxResults: 5 },
      },
    ]);
    // Provider tools are NOT dispatchable tool sources.
    expect(tree.declarations?.tools).toBeUndefined();
  });
});

describe("model contributor — generation-knob gap fixed", () => {
  it("forwards topP / frequencyPenalty / presencePenalty / stopSequences", () => {
    const { tree } = run(
      el("model", {
        id: "gpt-4o",
        temperature: 0.5,
        topP: 0.9,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
        stopSequences: ["STOP"],
      }),
    );
    expect(tree.config?.model).toEqual({ kind: "by-id", id: "gpt-4o" });
    expect(tree.config?.temperature).toBe(0.5);
    expect(tree.config?.topP).toBe(0.9);
    expect(tree.config?.frequencyPenalty).toBe(0.1);
    expect(tree.config?.presencePenalty).toBe(0.2);
    expect(tree.config?.stopSequences).toEqual(["STOP"]);
  });
});

describe("declaration contributors align with spec", () => {
  it("mcp forwards a spec-valid transport + exposes", () => {
    const { tree } = run(
      el("mcp", {
        serverName: "fs",
        transport: "streamable-http",
        config: { url: "http://x" },
        exposes: ["tools", "resources"],
      }),
    );
    const mcp = tree.declarations?.mcp?.[0];
    expect(mcp?.transport).toBe("streamable-http");
    expect(mcp?.exposes).toEqual(["tools", "resources"]);
    expect(mcp?.config).toEqual({ url: "http://x" });
  });

  it("resource + output forward all fields", () => {
    const r = run(el("resource", { uri: "file:///a", name: "A", mimeType: "text/plain" })).tree;
    expect(r.declarations?.resources?.[0]).toMatchObject({
      uri: "file:///a",
      name: "A",
      mimeType: "text/plain",
    });
    const o = run(el("output", { schema: SCHEMA, mode: "json_schema" })).tree;
    expect(o.declarations?.outputs?.[0]).toMatchObject({ schema: SCHEMA, mode: "json_schema" });
  });
});

describe("block contributors — jsx-drift fields land", () => {
  it("csv forwards text + headers (not the drifted `data` prop)", () => {
    const { tree } = run(
      // The wrapper is a `<message>`, not a `<section>`: a section lowers a
      // title into a leading text block of its own (ADR 94), which would put
      // the block under test at index 1 for reasons that have nothing to do
      // with the block contributor these tests are about.
      el("message", { role: "user" }, [el("csv", { text: "a,b\n1,2", headers: ["a", "b"] })]),
    );
    const block = tree.context.entries[0]!;
    expect(block.role).toBe("user");
    const csv = block.content[0] as {
      type: string;
      text: string;
      headers: string[];
    };
    expect(csv.type).toBe("csv");
    expect(csv.text).toBe("a,b\n1,2");
    expect(csv.headers).toEqual(["a", "b"]);
  });

  it("custom forwards tag / content / attrs (not the drifted `kind`/`data`)", () => {
    const { tree } = run(
      el("message", { role: "user" }, [
        el("custom", { tag: "cite", content: "RFC", attrs: { href: "x" }, selfClosing: true }),
      ]),
    );
    const custom = tree.context.entries[0]!.content[0];
    expect(custom).toMatchObject({
      type: "custom",
      tag: "cite",
      content: "RFC",
      attrs: { href: "x" },
      selfClosing: true,
    });
  });

  it("hyphenated intrinsic lowers as a custom block (tag = element name, attrs = primitive props)", () => {
    const { tree } = run(
      el("message", { role: "user" }, [
        el("relevant-context", { source: "rag", limit: 3, fresh: true, skipped: { deep: 1 } }, [
          createTextInstance("the retrieved facts"),
        ]),
      ]),
    );
    const custom = tree.context.entries[0]!.content[0];
    expect(custom).toMatchObject({
      type: "custom",
      tag: "relevant-context",
      content: "the retrieved facts",
      attrs: { source: "rag", limit: "3", fresh: "true" },
    });
  });

  it("hyphenated intrinsics nest — child tags survive as structure, not scraped words", () => {
    const { tree } = run(
      el("message", { role: "user" }, [
        el("relevant-context", { source: "rag" }, [
          el("about-user", { name: "ryan" }, [createTextInstance("prefers terse")]),
        ]),
      ]),
    );
    interface Node {
      semantic?: string;
      props?: { tag?: string; attrs?: Record<string, string> };
      children?: readonly Node[];
      text?: string;
    }
    const custom = tree.context.entries[0]!.content[0] as { semanticNode?: Node };
    // The coalesced block carries a root wrapper node; its first child is
    // the outer custom tag.
    expect(custom.semanticNode?.children?.[0]).toMatchObject({
      semantic: "custom",
      props: { tag: "relevant-context", attrs: { source: "rag" } },
    });
    expect(custom.semanticNode?.children?.[0]?.children?.[0]).toMatchObject({
      semantic: "custom",
      props: { tag: "about-user", attrs: { name: "ryan" } },
      children: [{ text: "prefers terse" }],
    });
  });

  it("single-word unknown intrinsics remain transparent passthrough", () => {
    const { tree } = run(
      el("message", { role: "user" }, [el("about", {}, [createTextInstance("just words")])]),
    );
    const first = tree.context.entries[0]!.content[0];
    expect(first).toMatchObject({ type: "text", text: "just words" });
  });

  it("media forwards shared BaseContentBlock fields (metadata / providerMetadata)", () => {
    const { tree } = run(
      el("message", { role: "user" }, [
        el("image", {
          source: { type: "url", url: "http://img" },
          altText: "alt",
          metadata: { k: 1 },
          providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
        }),
      ]),
    );
    const img = tree.context.entries[0]!.content[0];
    expect(img).toMatchObject({
      type: "image",
      altText: "alt",
      metadata: { k: 1 },
      providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });
});

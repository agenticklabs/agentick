/**
 * Phase 2 — Completions
 *
 * Tests `completion/complete` handler dispatch, capability advertisement,
 * `MCPCompletionContext.resolvedArguments`, the 100-value cap, and the
 * sugar builders (`completeFromList`, `completeFromEnum`,
 * `completePrefixMatch`, `completeDependent`, `completeFromAsync`).
 *
 * Adversarial: unknown refs, missing handlers, oversized loaders,
 * dependent-arg gating, sync vs async loaders, schema variants, error
 * propagation.
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { InMemoryTransport } from "../../transport/index.js";
import { MCPServer } from "../server.js";
import type { MCPPromptDefinition, MCPResourceTemplateDefinition } from "../../protocol/types.js";
import {
  completeFromList,
  completeFromEnum,
  completePrefixMatch,
  completeDependent,
  completeFromAsync,
} from "../../protocol/completions.js";

// ============================================================================
// Helpers
// ============================================================================

async function setup(opts: {
  prompts?: MCPPromptDefinition[];
  resourceTemplates?: MCPResourceTemplateDefinition[];
}): Promise<{
  server: MCPServer;
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const server = new MCPServer({
    name: "test-server",
    version: "1.0.0",
    prompts: opts.prompts,
    resourceTemplates: opts.resourceTemplates,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    server,
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ============================================================================
// Capability advertisement
// ============================================================================

describe("MCPServer — completions capability", () => {
  it("advertises completions capability when a prompt has `complete`", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "brief-me",
          description: "Brief on a project",
          arguments: [{ name: "projectId", required: true }],
          complete: {
            projectId: completeFromList(["proj-001", "proj-002"]),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "brief" } }],
          }),
        },
      ],
    });

    const caps = client.getServerCapabilities();
    expect(caps?.completions).toBeDefined();
    await cleanup();
  });

  it("advertises completions capability when a template has `complete`", async () => {
    const { client, cleanup } = await setup({
      resourceTemplates: [
        {
          name: "table-schema",
          uriTemplate: "db://schema/{table}",
          complete: {
            table: completeFromList(["users", "orders"]),
          },
          read: async () => ({
            contents: [{ uri: "db://schema/users", text: "..." }],
          }),
        },
      ],
    });

    const caps = client.getServerCapabilities();
    expect(caps?.completions).toBeDefined();
    await cleanup();
  });

  it("does NOT advertise completions when no handlers are registered", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "no-complete",
          arguments: [{ name: "x" }],
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const caps = client.getServerCapabilities();
    expect(caps?.completions).toBeUndefined();
    await cleanup();
  });
});

// ============================================================================
// Completion request dispatch
// ============================================================================

describe("MCPServer — completion/complete dispatch", () => {
  it("returns values for a registered prompt argument completer", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "brief-me",
          arguments: [{ name: "projectId", required: true }],
          complete: {
            projectId: completeFromList(["proj-001", "proj-002", "proj-003"]),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "brief-me" },
      argument: { name: "projectId", value: "proj-" },
    });

    expect(result.completion.values).toEqual(["proj-001", "proj-002", "proj-003"]);
    await cleanup();
  });

  it("returns values for a registered resource template variable completer", async () => {
    const { client, cleanup } = await setup({
      resourceTemplates: [
        {
          name: "table-schema",
          uriTemplate: "db://schema/{table}",
          complete: {
            table: completeFromList(["users", "orders", "invoices"]),
          },
          read: async () => ({
            contents: [{ uri: "db://schema/users", text: "..." }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/resource", uri: "db://schema/{table}" },
      argument: { name: "table", value: "" },
    });

    expect(result.completion.values).toEqual(["users", "orders", "invoices"]);
    await cleanup();
  });

  it("returns empty completion for unknown prompt name", async () => {
    // Capability must be advertised for the request to dispatch — add a
    // sentinel prompt with a complete handler so completions are enabled.
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "sentinel",
          arguments: [{ name: "x" }],
          complete: { x: completeFromList(["a"]) },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "unknown-prompt" },
      argument: { name: "x", value: "" },
    });

    expect(result.completion.values).toEqual([]);
    await cleanup();
  });

  it("returns empty completion for unknown argument name", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "known" }],
          complete: { known: completeFromList(["a", "b"]) },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "unknown", value: "" },
    });

    expect(result.completion.values).toEqual([]);
    await cleanup();
  });

  it("returns empty completion for prompt without any complete handlers", async () => {
    // Coexistence: one prompt has completions (enabling the capability),
    // another doesn't. Targeting the bare prompt should return empty
    // values rather than dispatch to the sibling's handler.
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "with-complete",
          arguments: [{ name: "y" }],
          complete: { y: completeFromList(["foo"]) },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
        {
          name: "no-complete",
          arguments: [{ name: "x" }],
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "no-complete" },
      argument: { name: "x", value: "" },
    });

    expect(result.completion.values).toEqual([]);
    await cleanup();
  });

  it("surfaces context.arguments as resolvedArguments to handler", async () => {
    let captured: Record<string, string> | null = null;
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "tenant" }, { name: "projectId" }],
          complete: {
            projectId: async (_value, ctx) => {
              captured = ctx.resolvedArguments;
              return { values: [] };
            },
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "projectId", value: "" },
      context: { arguments: { tenant: "acme-corp" } },
    });

    expect(captured).toEqual({ tenant: "acme-corp" });
    await cleanup();
  });

  it("surfaces empty resolvedArguments when context omitted", async () => {
    let captured: Record<string, string> | null = null;
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "x" }],
          complete: {
            x: async (_value, ctx) => {
              captured = ctx.resolvedArguments;
              return { values: [] };
            },
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "x", value: "" },
    });

    expect(captured).toEqual({});
    await cleanup();
  });
});

// ============================================================================
// 100-value cap
// ============================================================================

describe("MCPServer — completion 100-value cap", () => {
  it("truncates to 100 values and sets hasMore: true when loader returns more", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "id" }],
          complete: {
            id: completeFromList(
              Array.from({ length: 200 }, (_, i) => `id-${String(i).padStart(4, "0")}`),
            ),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "id", value: "id-" },
    });

    expect(result.completion.values).toHaveLength(100);
    expect(result.completion.hasMore).toBe(true);
    await cleanup();
  });

  it("does NOT set hasMore when loader returns ≤100 values", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "id" }],
          complete: {
            id: completeFromList(["a", "b", "c"]),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "id", value: "" },
    });

    expect(result.completion.values).toHaveLength(3);
    expect(result.completion.hasMore).toBeFalsy();
    await cleanup();
  });

  it("respects hasMore from completeFromAsync handlers", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "id" }],
          complete: {
            id: completeFromAsync(async () => ({
              values: ["a", "b"],
              total: 1000,
              hasMore: true,
            })),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "id", value: "" },
    });

    expect(result.completion.values).toEqual(["a", "b"]);
    expect(result.completion.total).toBe(1000);
    expect(result.completion.hasMore).toBe(true);
    await cleanup();
  });

  it("truncates completeFromAsync output to 100 even if handler returns more", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "id" }],
          complete: {
            id: completeFromAsync(async () => ({
              values: Array.from({ length: 250 }, (_, i) => `v-${i}`),
            })),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "id", value: "" },
    });

    expect(result.completion.values).toHaveLength(100);
    expect(result.completion.hasMore).toBe(true);
    await cleanup();
  });
});

// ============================================================================
// Sugar builders
// ============================================================================

describe("Sugar — completeFromList", () => {
  it("prefix-filters case-sensitively against the typed value", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "name" }],
          complete: {
            name: completeFromList(["alpha", "beta", "gamma", "alphabet", "Alaska"]),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "name", value: "alp" },
    });

    expect(result.completion.values.sort()).toEqual(["alpha", "alphabet"]);
    await cleanup();
  });

  it("returns full list when value is empty", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "x" }],
          complete: { x: completeFromList(["a", "b", "c"]) },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "x", value: "" },
    });

    expect(result.completion.values).toEqual(["a", "b", "c"]);
    await cleanup();
  });

  it("returns empty when no values match the prefix", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "x" }],
          complete: { x: completeFromList(["alpha", "beta"]) },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "x", value: "z" },
    });

    expect(result.completion.values).toEqual([]);
    await cleanup();
  });
});

describe("Sugar — completeFromEnum", () => {
  it("extracts and prefix-filters Zod enum values", async () => {
    const Status = z.enum(["open", "closed", "in_progress", "on_hold"]);
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "status" }],
          complete: { status: completeFromEnum(Status) },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "status", value: "o" },
    });

    expect(result.completion.values.sort()).toEqual(["on_hold", "open"]);
    await cleanup();
  });
});

describe("Sugar — completePrefixMatch", () => {
  it("works with sync loader", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "x" }],
          complete: {
            x: completePrefixMatch(() => ["red", "green", "blue", "ruby"]),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "x", value: "r" },
    });

    expect(result.completion.values.sort()).toEqual(["red", "ruby"]);
    await cleanup();
  });

  it("works with async loader", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "x" }],
          complete: {
            x: completePrefixMatch(async () => {
              await new Promise((r) => setTimeout(r, 5));
              return ["foo", "bar", "foobar"];
            }),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "x", value: "foo" },
    });

    expect(result.completion.values.sort()).toEqual(["foo", "foobar"]);
    await cleanup();
  });
});

describe("Sugar — completeDependent", () => {
  it("invokes loader with declared sibling args", async () => {
    let receivedDeps: Record<string, string> | null = null;

    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "tenant" }, { name: "projectId" }],
          complete: {
            projectId: completeDependent({ requires: ["tenant"] }, (_value, deps) => {
              receivedDeps = deps;
              return ["proj-1", "proj-2"];
            }),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "projectId", value: "" },
      context: { arguments: { tenant: "acme" } },
    });

    expect(receivedDeps).toEqual({ tenant: "acme" });
    expect(result.completion.values).toEqual(["proj-1", "proj-2"]);
    await cleanup();
  });

  it("returns empty without invoking loader when required arg is missing", async () => {
    let invoked = false;

    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "tenant" }, { name: "projectId" }],
          complete: {
            projectId: completeDependent({ requires: ["tenant"] }, () => {
              invoked = true;
              return ["proj-1"];
            }),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "projectId", value: "" },
      // No context.arguments — tenant unresolved
    });

    expect(invoked).toBe(false);
    expect(result.completion.values).toEqual([]);
    await cleanup();
  });

  it("supports async loader returning a promise", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "a" }, { name: "b" }],
          complete: {
            b: completeDependent({ requires: ["a"] }, async (_value, deps) => {
              await new Promise((r) => setTimeout(r, 5));
              return [`${deps.a}-x`, `${deps.a}-y`];
            }),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "b", value: "" },
      context: { arguments: { a: "alpha" } },
    });

    expect(result.completion.values).toEqual(["alpha-x", "alpha-y"]);
    await cleanup();
  });
});

describe("Sugar — completeFromAsync (escape hatch)", () => {
  it("passes through values, total, hasMore as-returned (capped at 100)", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "x" }],
          complete: {
            x: completeFromAsync(async () => ({
              values: ["a", "b", "c"],
              total: 3,
              hasMore: false,
            })),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "x", value: "" },
    });

    expect(result.completion.values).toEqual(["a", "b", "c"]);
    expect(result.completion.total).toBe(3);
    await cleanup();
  });

  it("receives the typed value and ctx", async () => {
    let receivedValue = "";
    let receivedResolved: Record<string, string> | null = null;

    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "tenant" }, { name: "id" }],
          complete: {
            id: completeFromAsync(async (value, ctx) => {
              receivedValue = value;
              receivedResolved = ctx.resolvedArguments;
              return { values: [] };
            }),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "id", value: "partial-typed-value" },
      context: { arguments: { tenant: "t1" } },
    });

    expect(receivedValue).toBe("partial-typed-value");
    expect(receivedResolved).toEqual({ tenant: "t1" });
    await cleanup();
  });
});

// ============================================================================
// Adversarial
// ============================================================================

describe("MCPServer — completion adversarial", () => {
  it("handler that throws produces a protocol error (not a tool execution error)", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "x" }],
          complete: {
            x: async () => {
              throw new Error("boom");
            },
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    await expect(
      client.complete({
        ref: { type: "ref/prompt", name: "p" },
        argument: { name: "x", value: "" },
      }),
    ).rejects.toThrow(/boom|completion|internal/i);

    await cleanup();
  });

  it("error message has single MCP error prefix (no double-prefix bug)", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "x" }],
          complete: {
            x: async () => {
              throw new Error("specific failure");
            },
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    let captured = "";
    try {
      await client.complete({
        ref: { type: "ref/prompt", name: "p" },
        argument: { name: "x", value: "" },
      });
    } catch (err) {
      captured = (err as Error).message;
    }

    const prefixCount = (captured.match(/MCP error -?\d+:/g) ?? []).length;
    expect(prefixCount).toBeLessThanOrEqual(1);

    await cleanup();
  });

  it("template `complete` handler returning string array (legacy shape) is coerced", async () => {
    // Backward-compat: pre-Phase-2 shape returned string[] directly.
    const { client, cleanup } = await setup({
      resourceTemplates: [
        {
          name: "t",
          uriTemplate: "x://{var}",
          complete: {
            // Cast: shape predates Phase 2's CompletionResult return.
            var: ((_value: string) => ["a", "b", "c"]) as never,
          },
          read: async () => ({ contents: [{ uri: "x://a", text: "" }] }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/resource", uri: "x://{var}" },
      argument: { name: "var", value: "" },
    });

    expect(result.completion.values).toEqual(["a", "b", "c"]);
    await cleanup();
  });

  it("dependent loader uses fresh resolvedArguments per call", async () => {
    const calls: Array<Record<string, string>> = [];

    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "tenant" }, { name: "id" }],
          complete: {
            id: completeDependent({ requires: ["tenant"] }, (_v, deps) => {
              calls.push({ ...deps });
              return ["x"];
            }),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "id", value: "" },
      context: { arguments: { tenant: "a" } },
    });
    await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "id", value: "" },
      context: { arguments: { tenant: "b" } },
    });

    expect(calls).toEqual([{ tenant: "a" }, { tenant: "b" }]);
    await cleanup();
  });

  it("completeFromList handles empty source list", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "x" }],
          complete: { x: completeFromList([]) },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "x", value: "anything" },
    });

    expect(result.completion.values).toEqual([]);
    expect(result.completion.hasMore).toBeFalsy();
    await cleanup();
  });

  it("cap clamps to exactly 100 (not 99 or 101) on edge", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "x" }],
          complete: {
            x: completeFromList(Array.from({ length: 101 }, (_, i) => `v${i}`)),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "x", value: "" },
    });

    expect(result.completion.values).toHaveLength(100);
    expect(result.completion.hasMore).toBe(true);
    await cleanup();
  });

  it("exactly-100 result does NOT set hasMore", async () => {
    const { client, cleanup } = await setup({
      prompts: [
        {
          name: "p",
          arguments: [{ name: "x" }],
          complete: {
            x: completeFromList(Array.from({ length: 100 }, (_, i) => `v${i}`)),
          },
          handler: async () => ({
            messages: [{ role: "user", content: { type: "text", text: "x" } }],
          }),
        },
      ],
    });

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "x", value: "" },
    });

    expect(result.completion.values).toHaveLength(100);
    expect(result.completion.hasMore).toBeFalsy();
    await cleanup();
  });
});

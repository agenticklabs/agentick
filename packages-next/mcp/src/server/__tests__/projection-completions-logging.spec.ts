/**
 * Conformance for MCP Wave 3a — server-side completion + logging +
 * the lifecycle capability-gating bug regression.
 *
 * Real in-memory server↔client round-trips (no fakes), mirroring the
 * projection-prompts / end-to-end suites.
 *
 * Pins:
 *  - completion: `completion/complete` (ref/prompt) routes to the
 *    configured sugar handler; unknown ref → empty; ref/resource →
 *    empty (Wave 4 not wired); `context.arguments` reaches the handler.
 *  - completions capability advertised iff a handler is wired; opt-out
 *    suppresses it.
 *  - logging: advertised by default; `setLoggingLevel` reaches the
 *    handler (proven by the filter flipping); `ctx.log("info")`
 *    surfaces while a below-level `ctx.log("debug")` is filtered when
 *    level=info; default level emits everything; opt-out suppresses the
 *    capability + the wire notifications.
 *
 * ADR 64 re-sourcing: `ctx.log` is now a UNIVERSAL slot that emits ONE
 * bus event; `installLogProjection` (a bus subscriber) forwards it to
 * `notifications/message`. These assertions are unchanged on the wire —
 * they now prove the emit→bus→projection→wire path end-to-end rather
 * than the retired direct `sendLoggingMessage` sink.
 *  - lifecycle bug: `capabilities.tasks:false` suppresses tasks and does
 *    NOT depend on `resources`.
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { ContentBlock, ToolDeclaration } from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { buildCapabilities } from "../protocol/lifecycle.js";
import {
  completeFromList,
  inMemoryServerTransport,
  McpServerHarness,
  type McpServerOptions,
  type ToolHandlerResolver,
} from "../index.js";

// ────────────────────────── helpers ──────────────────────────

async function makeConnectedClient(options: Omit<McpServerOptions, "transports">): Promise<{
  readonly harness: McpServerHarness;
  readonly client: McpClient;
  readonly cleanup: () => Promise<void>;
}> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { transports: [transport], serverInfo: { name: "test", version: "0.0.0" }, ...options },
  );
  await harness.ready;
  await harness.start();
  const clientTransport = await transport.connect();
  const client = new McpClient({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    harness,
    client,
    cleanup: async () => {
      await client.close();
      await harness.close();
    },
  };
}

const logToolSchema = jsonSchema({
  type: "object",
  properties: {},
  additionalProperties: false,
});

function logToolDeclaration(): ToolDeclaration {
  return {
    id: "emit_logs",
    name: "emit_logs",
    description: "emits an info + a debug log line",
    inputSchema: logToolSchema,
    exposure: ["model"],
    handlerRef: "handler:emit_logs",
  };
}

/**
 * Handler resolver whose `emit_logs` tool fires one info-level and one
 * debug-level `ctx.log` before returning. The MCP request context
 * (with `ctx.log`) is the second arg the tools projection passes in.
 */
const logHandlerResolver: ToolHandlerResolver = (ref) => {
  if (ref !== "handler:emit_logs") return null;
  return async (_input, ctx) => {
    // ADR 64 — `ctx.log` is a universal always-present slot; it emits a
    // bus event the log projection forwards to `notifications/message`.
    ctx.log("info", { msg: "info-line" }, "test-logger");
    ctx.log("debug", { msg: "debug-line" });
    const content: ContentBlock[] = [{ type: "text", text: "done" }];
    return { kind: "inline", content };
  };
};

function allLevelsToolDeclaration(): ToolDeclaration {
  return {
    id: "emit_all",
    name: "emit_all",
    description: "emits one log per RFC-5424 severity via the level methods",
    inputSchema: logToolSchema,
    exposure: ["model"],
    handlerRef: "handler:emit_all",
  };
}

/**
 * Fires one log per RFC-5424 severity using the callable {@link Log} LEVEL
 * METHODS (`ctx.log.debug` … `ctx.log.critical`). Proves two things end to end:
 * the level-method sugar reaches the wire, and the MCP projection forwards each
 * level VERBATIM — the framework's `LogLevel` vocabulary IS the MCP wire enum,
 * so the mapping is identity (no translation table to drift).
 */
const allLevelsHandlerResolver: ToolHandlerResolver = (ref) => {
  if (ref !== "handler:emit_all") return null;
  return async (_input, ctx) => {
    ctx.log.debug({ lvl: "debug" });
    ctx.log.info({ lvl: "info" });
    ctx.log.notice({ lvl: "notice" });
    ctx.log.warning({ lvl: "warning" });
    ctx.log.error({ lvl: "error" });
    ctx.log.critical({ lvl: "critical" });
    const content: ContentBlock[] = [{ type: "text", text: "done" }];
    return { kind: "inline", content };
  };
};

// ════════════════════════ completion ════════════════════════

describe("completion projection — capability", () => {
  it("advertises completions when a handler is wired", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "cmp",
      completions: { prompts: { greet: { name: completeFromList(["Ada", "Alan"]) } } },
    });
    expect(client.getServerCapabilities()?.completions).toBeDefined();
    await cleanup();
  });

  it("does NOT advertise completions without a handler", async () => {
    const { client, cleanup } = await makeConnectedClient({ name: "cmp-none" });
    expect(client.getServerCapabilities()?.completions).toBeUndefined();
    await cleanup();
  });

  it("does NOT advertise completions when the slot has empty arg maps", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "cmp-empty",
      completions: { prompts: { greet: {} } },
    });
    expect(client.getServerCapabilities()?.completions).toBeUndefined();
    await cleanup();
  });

  it("capabilities.completions:false suppresses the capability", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "cmp-optout",
      completions: { prompts: { greet: { name: completeFromList(["Ada"]) } } },
      capabilities: { completions: false },
    });
    expect(client.getServerCapabilities()?.completions).toBeUndefined();
    await cleanup();
  });
});

describe("completion projection — round-trip", () => {
  it("routes ref/prompt to the configured handler with prefix filter", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "cmp-rt",
      completions: {
        prompts: { greet: { name: completeFromList(["Ada", "Alan", "Bob"]) } },
      },
    });
    const res = await client.complete({
      ref: { type: "ref/prompt", name: "greet" },
      argument: { name: "name", value: "A" },
    });
    expect(res.completion.values).toEqual(["Ada", "Alan"]);
    await cleanup();
  });

  it("passes context.arguments through to the handler", async () => {
    const seen: Array<Record<string, string>> = [];
    const { client, cleanup } = await makeConnectedClient({
      name: "cmp-ctx",
      completions: {
        prompts: {
          greet: {
            city: (typed, ctx) => {
              seen.push({ ...ctx.resolvedArguments });
              return [`${typed}-from-${ctx.resolvedArguments["country"] ?? "?"}`];
            },
          },
        },
      },
    });
    const res = await client.complete({
      ref: { type: "ref/prompt", name: "greet" },
      argument: { name: "city", value: "Par" },
      context: { arguments: { country: "FR" } },
    });
    expect(res.completion.values).toEqual(["Par-from-FR"]);
    expect(seen).toEqual([{ country: "FR" }]);
    await cleanup();
  });

  it("unknown prompt / argument resolves to an empty value list", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "cmp-unknown",
      completions: { prompts: { greet: { name: completeFromList(["Ada"]) } } },
    });
    const unknownPrompt = await client.complete({
      ref: { type: "ref/prompt", name: "nope" },
      argument: { name: "name", value: "" },
    });
    expect(unknownPrompt.completion.values).toEqual([]);
    const unknownArg = await client.complete({
      ref: { type: "ref/prompt", name: "greet" },
      argument: { name: "unknown_arg", value: "" },
    });
    expect(unknownArg.completion.values).toEqual([]);
    await cleanup();
  });

  it("ref/resource resolves to empty (resource-template completion is Wave 4)", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "cmp-resource",
      completions: { prompts: { greet: { name: completeFromList(["Ada"]) } } },
    });
    const res = await client.complete({
      ref: { type: "ref/resource", uri: "file:///{path}" },
      argument: { name: "path", value: "" },
    });
    expect(res.completion.values).toEqual([]);
    await cleanup();
  });
});

// ════════════════════════ logging ════════════════════════

describe("logging projection — capability", () => {
  it("advertises logging by default", async () => {
    const { client, cleanup } = await makeConnectedClient({ name: "log-default" });
    expect(client.getServerCapabilities()?.logging).toBeDefined();
    await cleanup();
  });

  it("capabilities.logging:false suppresses the capability", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "log-optout",
      capabilities: { logging: false },
    });
    expect(client.getServerCapabilities()?.logging).toBeUndefined();
    await cleanup();
  });
});

describe("logging projection — ctx.log round-trip + level filter", () => {
  it("default level (no setLevel) emits both info and debug", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "log-nolevel",
      tools: { registry: [logToolDeclaration()], resolveHandler: logHandlerResolver },
    });
    const received: Array<{ level: string; data: unknown }> = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      received.push({ level: n.params.level, data: n.params.data });
    });

    await client.callTool({ name: "emit_logs", arguments: {} });
    await new Promise((r) => setTimeout(r, 10));

    const levels = received.map((r) => r.level).sort();
    expect(levels).toEqual(["debug", "info"]);
    await cleanup();
  });

  it("setLoggingLevel('info') reaches the handler → info surfaces, debug is filtered", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "log-info",
      tools: { registry: [logToolDeclaration()], resolveHandler: logHandlerResolver },
    });
    const received: Array<{ level: string; logger?: string; data: unknown }> = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      received.push({ level: n.params.level, logger: n.params.logger, data: n.params.data });
    });

    // setLevel round-trips to the server's SetLevelRequestSchema handler.
    await client.setLoggingLevel("info");
    await client.callTool({ name: "emit_logs", arguments: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toEqual([
      { level: "info", logger: "test-logger", data: { msg: "info-line" } },
    ]);
    await cleanup();
  });

  it("setLoggingLevel('warning') filters notice/info/debug, passes warning+ (RFC-5424 identity)", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "log-warning",
      tools: { registry: [allLevelsToolDeclaration()], resolveHandler: allLevelsHandlerResolver },
    });
    const received: string[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      received.push(n.params.level);
    });

    await client.setLoggingLevel("warning");
    await client.callTool({ name: "emit_all", arguments: {} });
    await new Promise((r) => setTimeout(r, 10));

    // Only warning and MORE severe pass; the level methods' RFC-5424 severities
    // reach the wire unmapped.
    expect(received.sort()).toEqual(["critical", "error", "warning"]);
    await cleanup();
  });

  it("log level is per-connection: one client's setLevel('warning') does not affect another", async () => {
    // Two connections into ONE server harness — the isolation unit.
    const transportA = inMemoryServerTransport();
    const transportB = inMemoryServerTransport();
    const harness = new McpServerHarness(
      `srv:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        name: "log-iso",
        transports: [transportA, transportB],
        serverInfo: { name: "test", version: "0.0.0" },
        tools: { registry: [allLevelsToolDeclaration()], resolveHandler: allLevelsHandlerResolver },
      },
    );
    await harness.ready;
    await harness.start();
    const clientA = new McpClient({ name: "A", version: "0.0.0" }, { capabilities: {} });
    const clientB = new McpClient({ name: "B", version: "0.0.0" }, { capabilities: {} });
    await clientA.connect(await transportA.connect());
    await clientB.connect(await transportB.connect());
    const recvA: string[] = [];
    const recvB: string[] = [];
    clientA.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      recvA.push(n.params.level);
    });
    clientB.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      recvB.push(n.params.level);
    });

    // A restricts to warning; B stays at the server default (debug — everything).
    await clientA.setLoggingLevel("warning");
    await clientA.callTool({ name: "emit_all", arguments: {} });
    await clientB.callTool({ name: "emit_all", arguments: {} });
    await new Promise((r) => setTimeout(r, 20));

    // Each connection saw ONLY its own emit, filtered by ITS OWN level — no
    // cross-contamination of level state or of the scoped notifications.
    expect(recvA.sort()).toEqual(["critical", "error", "warning"]);
    expect(recvB.sort()).toEqual(["critical", "debug", "error", "info", "notice", "warning"]);
    await clientA.close();
    await clientB.close();
    await harness.close();
  });

  it("logging opt-out installs no projection — ctx.log still emits, but no notifications fire", async () => {
    const { client, cleanup } = await makeConnectedClient({
      name: "log-off",
      capabilities: { logging: false },
      tools: { registry: [logToolDeclaration()], resolveHandler: logHandlerResolver },
    });
    const received: unknown[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      received.push(n);
    });
    // ADR 64 — `ctx.log` is always present, so the handler still emits a
    // bus event. But `installLogProjection` is gated on `loggingEnabled`,
    // so with logging opted out there's no subscriber (the emit is a
    // cheap no-op probe) and nothing reaches the wire.
    const result = await client.callTool({ name: "emit_logs", arguments: {} });
    await new Promise((r) => setTimeout(r, 10));
    expect(result.isError ?? false).toBe(false);
    expect(received).toEqual([]);
    await cleanup();
  });
});

// ════════════════════ lifecycle bug regression ════════════════════

describe("buildCapabilities — tasks gating (lifecycle.ts:71 regression)", () => {
  const allWired = {
    tools: true,
    prompts: false,
    resources: false,
    elicitation: false,
    sampling: false,
    tasks: true,
    completions: false,
    logging: false,
  } as const;

  it("advertises tasks when wired and not opted out", () => {
    const caps = buildCapabilities(allWired, undefined);
    expect((caps as { tasks?: unknown }).tasks).toBeDefined();
  });

  it("capabilities.tasks:false suppresses tasks", () => {
    const caps = buildCapabilities(allWired, { tasks: false });
    expect((caps as { tasks?: unknown }).tasks).toBeUndefined();
  });

  it("tasks advertisement does NOT depend on the resources opt-out (the copy-paste bug)", () => {
    // Pre-fix code gated tasks on `override?.resources !== false`, so
    // `resources:false` wrongly suppressed tasks. Post-fix, resources
    // opt-out is orthogonal to tasks.
    const caps = buildCapabilities(allWired, { resources: false });
    expect((caps as { tasks?: unknown }).tasks).toBeDefined();
  });

  it("tasks stays advertised even when resources is opted out AND tasks is left default", () => {
    const wiredWithResources = { ...allWired, resources: true };
    const caps = buildCapabilities(wiredWithResources, { resources: false });
    expect((caps as { tasks?: unknown }).tasks).toBeDefined();
    expect(caps.resources).toBeUndefined();
  });
});

describe("buildCapabilities — completions + logging gating", () => {
  const base = {
    tools: false,
    prompts: false,
    resources: false,
    elicitation: false,
    sampling: false,
    tasks: false,
  } as const;

  it("completions appears only when wired", () => {
    expect(
      buildCapabilities({ ...base, completions: false, logging: false }, undefined).completions,
    ).toBeUndefined();
    expect(
      buildCapabilities({ ...base, completions: true, logging: false }, undefined).completions,
    ).toBeDefined();
  });

  it("logging appears when wired and honors opt-out", () => {
    expect(
      buildCapabilities({ ...base, completions: false, logging: true }, undefined).logging,
    ).toBeDefined();
    expect(
      buildCapabilities({ ...base, completions: false, logging: true }, { logging: false }).logging,
    ).toBeUndefined();
  });
});

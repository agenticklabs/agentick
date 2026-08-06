/**
 * `createClientTool` — the joined declaration/handler, and the dispatch rules
 * that give `accepts` and `notFound` their meaning.
 *
 * The load-bearing claim is the DISTINCTION between two silences: a tool that
 * declines is not a tool that is missing, and conflating them turns three
 * correctly-quiet tabs into three warnings about a working system.
 *
 * @verifiedBy this file
 */

import { describe, expect, it, vi } from "vitest";
import { NOOP_METRICS, OFF_TRACE, createLog, jsonSchema } from "@agentick/spec";
import type { ClientRuntimeContext, ToolResultInput } from "@agentick/spec";

import { createClientTool, toClientToolDeclaration } from "../client/create-client-tool.js";
import { dispatchClientToolCall } from "../client/use-client-tools.js";
import type { ClientToolCallHandle } from "../client/client-tool-calls.js";

const runtime: ClientRuntimeContext = {
  clientId: "c1",
  connectionId: "conn-A",
  log: createLog(() => {}),
  trace: OFF_TRACE,
  metrics: NOOP_METRICS,
  activeSpan: () => undefined,
};

const schema = jsonSchema({ type: "object", properties: { to: { type: "string" } } });

function call(name: string, input: unknown = {}, target?: string): ClientToolCallHandle {
  return {
    toolCallId: "tc-1",
    name,
    input,
    target,
    correlationId: "corr-1",
    receivedAt: 0,
    respond: async () => {},
  };
}

const run = (
  c: ClientToolCallHandle,
  tools: readonly never[] | readonly unknown[],
  self: string,
  opts?: Parameters<typeof dispatchClientToolCall>[5],
) =>
  dispatchClientToolCall(
    c,
    tools as never,
    () => self,
    runtime,
    new AbortController().signal,
    opts,
  );

describe("toClientToolDeclaration", () => {
  it("projects the declaration and drops the halves that cannot cross the wire", () => {
    const tool = createClientTool({
      name: "navigate_to",
      description: "Navigate this tab",
      inputSchema: schema,
      aliases: ["goto"],
      accepts: () => true,
      handler: async () => "ok",
    });

    const declaration = toClientToolDeclaration(tool as never);

    expect(declaration).toEqual({
      name: "navigate_to",
      description: "Navigate this tab",
      inputSchema: { type: "object", properties: { to: { type: "string" } } },
      aliases: ["goto"],
    });
    expect("handler" in declaration).toBe(false);
    expect("accepts" in declaration).toBe(false);
  });
});

describe("dispatch", () => {
  it("runs the handler and returns its result", async () => {
    const tool = createClientTool({
      name: "read_selection",
      description: "d",
      inputSchema: schema,
      handler: async () => "highlighted text",
    });
    await expect(run(call("read_selection"), [tool], "conn-A")).resolves.toBe("highlighted text");
  });

  it("resolves a call that arrived under an alias", async () => {
    const tool = createClientTool({
      name: "navigate_to",
      description: "d",
      inputSchema: schema,
      aliases: ["goto"],
      handler: async () => "navigated",
    });
    await expect(run(call("goto"), [tool], "conn-A")).resolves.toBe("navigated");
  });

  it("hands the handler a ctx carrying the call and the client's runtime", async () => {
    const seen: Record<string, unknown> = {};
    const tool = createClientTool({
      name: "t",
      description: "d",
      inputSchema: schema,
      handler: async (_input, ctx) => {
        seen["toolCallId"] = ctx.toolCallId;
        seen["name"] = ctx.name;
        seen["target"] = ctx.target;
        seen["clientId"] = ctx.clientId;
        seen["connectionId"] = ctx.connectionId;
        // Present and safe to call with no adapter wired.
        ctx.log.info({ msg: "hi" });
        await ctx.trace("child", () => {});
        return "ok";
      },
    });

    await run(call("t", {}, "conn-B"), [tool], "conn-A");

    expect(seen).toEqual({
      toolCallId: "tc-1",
      name: "t",
      target: "conn-B",
      clientId: "c1",
      connectionId: "conn-A",
    });
  });

  it("reads connectionId live, so a reconnect is not stale on a long-lived tool", async () => {
    let current: string | undefined = "conn-A";
    const live: ClientRuntimeContext = {
      ...runtime,
      get connectionId() {
        return current;
      },
    };
    let observed: string | undefined;
    const tool = createClientTool({
      name: "t",
      description: "d",
      inputSchema: schema,
      handler: async (_i, ctx) => {
        observed = ctx.connectionId;
        return "ok";
      },
    });

    current = "conn-RECONNECTED";
    await dispatchClientToolCall(
      call("t"),
      [tool] as never,
      () => "conn-A",
      live,
      new AbortController().signal,
    );
    expect(observed).toBe("conn-RECONNECTED");
  });

  it("answers a handler throw with an error result — a suspended call never hangs", async () => {
    const tool = createClientTool({
      name: "t",
      description: "d",
      inputSchema: schema,
      handler: async () => {
        throw new Error("boom");
      },
    });
    await expect(run(call("t"), [tool], "conn-A")).resolves.toEqual({
      content: "boom",
      isError: true,
    });
  });
});

describe("the two silences", () => {
  it("a DECLINED call returns nothing — this client must not answer", async () => {
    const handler = vi.fn();
    const tool = createClientTool({
      name: "navigate_to",
      description: "d",
      inputSchema: schema,
      accepts: ({ target, self }) => target === undefined || target === self,
      handler,
    });

    const result = await run(call("navigate_to", {}, "conn-B"), [tool], "conn-A");

    expect(result).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("an UNKNOWN call is answered — nobody has it, so someone must say so", async () => {
    await expect(run(call("mystery"), [], "conn-A")).resolves.toEqual({
      content: 'no client handler for "mystery"',
      isError: true,
    });
  });

  it("declining does NOT reach notFound — it is not the same as not knowing the tool", async () => {
    const notFound = vi.fn(async (): Promise<ToolResultInput> => "fallback");
    const tool = createClientTool({
      name: "navigate_to",
      description: "d",
      inputSchema: schema,
      accepts: () => false,
      handler: async () => "ran",
    });

    const result = await run(call("navigate_to"), [tool], "conn-A", { notFound });

    expect(result).toBeUndefined();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("four tabs, one addressed: exactly one answers and three stay silent", async () => {
    const ran: string[] = [];
    const toolFor = (self: string) =>
      createClientTool({
        name: "navigate_to",
        description: "d",
        inputSchema: schema,
        accepts: ({ target }) => target === undefined || target === self,
        handler: async () => {
          ran.push(self);
          return "navigated";
        },
      });

    const tabs = ["conn-A", "conn-B", "conn-C", "conn-D"];
    const results = await Promise.all(
      tabs.map((self) => run(call("navigate_to", {}, "conn-C"), [toolFor(self)], self)),
    );

    expect(ran).toEqual(["conn-C"]);
    expect(results.filter((r) => r !== undefined)).toEqual(["navigated"]);
  });

  it("an unaddressed call reaches every tab — the default is broadcast, not silence", async () => {
    const ran: string[] = [];
    const toolFor = (self: string) =>
      createClientTool({
        name: "show_toast",
        description: "d",
        inputSchema: schema,
        handler: async () => {
          ran.push(self);
          return "shown";
        },
      });

    await Promise.all(
      ["conn-A", "conn-B"].map((self) => run(call("show_toast"), [toolFor(self)], self)),
    );

    expect(ran).toEqual(["conn-A", "conn-B"]);
  });

  it("accepts sees the input, so acceptance can depend on the arguments", async () => {
    const tool = createClientTool({
      name: "navigate_to",
      description: "d",
      inputSchema: schema,
      accepts: ({ input }) => (input as { to?: string }).to === "/reports",
      handler: async () => "navigated",
    });

    await expect(run(call("navigate_to", { to: "/reports" }), [tool], "conn-A")).resolves.toBe(
      "navigated",
    );
    await expect(
      run(call("navigate_to", { to: "/other" }), [tool], "conn-A"),
    ).resolves.toBeUndefined();
  });

  it("a custom notFound answers the unknown call", async () => {
    const notFound = async (): Promise<ToolResultInput> => "handled elsewhere";
    await expect(run(call("mystery"), [], "conn-A", { notFound })).resolves.toBe(
      "handled elsewhere",
    );
  });
});

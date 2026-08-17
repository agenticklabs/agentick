/**
 * `createTool` — the joined declaration/handler, and the dispatch rules
 * that give `accepts` and `notFound` their meaning.
 *
 * The load-bearing claim is the DISTINCTION between two silences: a tool that
 * declines is not a tool that is missing, and conflating them turns three
 * correctly-quiet tabs into three warnings about a working system.
 *
 * @verifiedBy this file
 */

import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@agentick/utils/testing";
import { NOOP_METRICS, OFF_TRACE, createLog, jsonSchema } from "@agentick/spec";
import type { ClientRuntimeContext, ToolResultInput } from "@agentick/spec";

import { createTool, toDeclaration } from "../client/create-tool.js";
import { DECLINED, dispatchClientToolCall, routeClientTools } from "../client/use-client-tools.js";
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
    sessionId: "s1",
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

describe("toDeclaration", () => {
  it("projects the declaration and drops the half that cannot cross the wire", () => {
    const tool = createTool({
      name: "navigate_to",
      description: "Navigate this tab",
      inputSchema: schema,
      aliases: ["goto"],
      handler: async () => "ok",
    });

    const declaration = toDeclaration(tool);

    expect(declaration).toEqual({
      name: "navigate_to",
      description: "Navigate this tab",
      inputSchema: { type: "object", properties: { to: { type: "string" } } },
      aliases: ["goto"],
      // Defaulted on, so the handler's answer is what the model reads.
      annotations: { requiresResponse: true },
    });
    expect("handler" in declaration).toBe(false);
  });
});

describe("dispatch", () => {
  it("runs the handler and returns its result", async () => {
    const tool = createTool({
      name: "read_selection",
      description: "d",
      inputSchema: schema,
      handler: async () => "highlighted text",
    });
    await expect(run(call("read_selection"), [tool], "client-A")).resolves.toBe("highlighted text");
  });

  it("resolves a call that arrived under an alias", async () => {
    const tool = createTool({
      name: "navigate_to",
      description: "d",
      inputSchema: schema,
      aliases: ["goto"],
      handler: async () => "navigated",
    });
    await expect(run(call("goto"), [tool], "client-A")).resolves.toBe("navigated");
  });

  it("hands the handler a ctx carrying the call and the client's runtime", async () => {
    const seen: Record<string, unknown> = {};
    const tool = createTool({
      name: "t",
      description: "d",
      inputSchema: schema,
      handler: async (_input, ctx) => {
        seen["toolCallId"] = ctx.toolCallId;
        seen["name"] = ctx.name;
        seen["target"] = ctx.target;
        seen["clientId"] = ctx.clientId;
        // Present and safe to call with no adapter wired.
        ctx.log.info({ msg: "hi" });
        await ctx.trace("child", () => {});
        return "ok";
      },
    });

    await run(call("t", {}, "client-A"), [tool], "client-A");

    expect(seen).toEqual({
      toolCallId: "tc-1",
      name: "t",
      target: "client-A",
      clientId: "c1",
    });
  });

  it("answers a handler throw with an error result — a suspended call never hangs", async () => {
    const tool = createTool({
      name: "t",
      description: "d",
      inputSchema: schema,
      handler: async () => {
        throw new Error("boom");
      },
    });
    await expect(run(call("t"), [tool], "client-A")).resolves.toEqual({
      content: "`t` failed in the browser: boom",
      isError: true,
    });
  });
});

describe("addressing — every client receives every call", () => {
  it("runs a call addressed to THIS client", async () => {
    const tool = createTool({
      name: "navigate_to",
      description: "d",
      inputSchema: schema,
      handler: async () => "navigated",
    });
    await expect(run(call("navigate_to", {}, "client-A"), [tool], "client-A")).resolves.toBe(
      "navigated",
    );
  });

  it("stays SILENT on a call addressed to another client", async () => {
    const handler = vi.fn();
    const tool = createTool({
      name: "navigate_to",
      description: "d",
      inputSchema: schema,
      handler,
    });

    const result = await run(call("navigate_to", {}, "client-B"), [tool], "client-A");

    // No response at all — the addressed client is the one that answers.
    expect(result).toBe(DECLINED);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs an UNADDRESSED call — nobody in particular means everybody", async () => {
    const tool = createTool({
      name: "show_toast",
      description: "d",
      inputSchema: schema,
      handler: async () => "shown",
    });
    await expect(run(call("show_toast"), [tool], "client-A")).resolves.toBe("shown");
  });

  it("four clients, one addressed: exactly one answers and three stay silent", async () => {
    const ran: string[] = [];
    const toolFor = (self: string) =>
      createTool({
        name: "navigate_to",
        description: "d",
        inputSchema: schema,
        handler: async () => {
          ran.push(self);
          return "navigated";
        },
      });

    const clients = ["client-A", "client-B", "client-C", "client-D"];
    const results = await Promise.all(
      clients.map((self) => run(call("navigate_to", {}, "client-C"), [toolFor(self)], self)),
    );

    expect(ran).toEqual(["client-C"]);
    expect(results.filter((r) => r !== DECLINED)).toEqual(["navigated"]);
  });

  it("reads `self` at dispatch, so a rebound client id is not stale", async () => {
    // The server BINDS the id at handshake and may answer with one the client
    // did not claim; a captured `self` would compare against the wrong value.
    let bound = "client-CLAIMED";
    const tool = createTool({
      name: "t",
      description: "d",
      inputSchema: schema,
      handler: async () => "ran",
    });

    bound = "client-BOUND";
    await expect(
      dispatchClientToolCall(
        call("t", {}, "client-BOUND"),
        [tool],
        () => bound,
        runtime,
        new AbortController().signal,
      ),
    ).resolves.toBe("ran");
  });
});

describe("an unknown tool is still answered", () => {
  it("answers a call naming a tool this client never declared", async () => {
    // Distinct from an addressed-elsewhere call, which is silent: nobody has
    // this one, so silence would hang it until it timed out.
    await expect(run(call("mystery"), [], "client-A")).resolves.toEqual({
      content: 'no client handler for "mystery"',
      isError: true,
    });
  });

  it("a custom notFound answers it instead", async () => {
    const notFound = async (): Promise<ToolResultInput> => "handled elsewhere";
    await expect(run(call("mystery"), [], "client-A", { notFound })).resolves.toBe(
      "handled elsewhere",
    );
  });

  it("an addressed-elsewhere call does NOT reach notFound", async () => {
    const notFound = vi.fn(async (): Promise<ToolResultInput> => "fallback");
    const tool = createTool({
      name: "navigate_to",
      description: "d",
      inputSchema: schema,
      handler: async () => "ran",
    });

    const result = await run(call("navigate_to", {}, "client-B"), [tool], "client-A", { notFound });

    expect(result).toBe(DECLINED);
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe("a handler that answers with nothing", () => {
  it("is answered as UNKNOWN, not mistaken for an addressing decline", async () => {
    // Reachable from untyped JS, where the return type is not enforced.
    // Treating it as a decline would hang the call; treating it as success
    // would have the model announce an effect nobody observed.
    const tool = createTool({
      name: "t",
      description: "d",
      inputSchema: schema,
      handler: (() => undefined) as never,
    });

    const result = await run(call("t"), [tool], "client-A");

    expect(result).not.toBe(DECLINED);
    expect(String(result)).toContain("reported no outcome");
    expect(String(result)).toContain("Do not tell the user it succeeded");
  });
});

describe("the handler's answer reaches the model", () => {
  it("asks for a response by default — the handler's return value is the point", () => {
    // Without this the relay is one-way: the handler runs, its value is
    // discarded, and the model is told "executed successfully" before the
    // handler has even finished. The type forbids returning nothing, so
    // dropping what it forced you to return is the API disagreeing with itself.
    const tool = createTool({
      name: "read_table",
      description: "d",
      inputSchema: schema,
      handler: async () => "the table has 4 rows",
    });

    expect(toDeclaration(tool).annotations).toMatchObject({
      requiresResponse: true,
    });
  });

  it("takes `requiresResponse: false` as the opt-out", () => {
    const tool = createTool({
      name: "show_toast",
      description: "d",
      inputSchema: schema,
      annotations: { broadcast: true, requiresResponse: false },
      handler: async () => "shown",
    });

    expect(toDeclaration(tool).annotations).toMatchObject({
      broadcast: true,
      requiresResponse: false,
    });
  });

  it("keeps every other annotation the author set", () => {
    const tool = createTool({
      name: "navigate_to",
      description: "d",
      inputSchema: schema,
      annotations: { intent: "action", title: "Navigate", responseTimeoutMs: 5_000 },
      handler: async () => "navigated",
    });

    expect(toDeclaration(tool).annotations).toEqual({
      intent: "action",
      title: "Navigate",
      responseTimeoutMs: 5_000,
      requiresResponse: true,
    });
  });
});

describe("routeClientTools — a reply that never reaches the server", () => {
  // The handler ran and the browser rendered its result, but the respond did
  // not land. That used to vanish into a `void`ed async IIFE, which is how a
  // one-second transport hiccup became an execution suspended forever with
  // nothing anywhere saying why.
  function feedOf(call: ClientToolCallHandle) {
    return {
      onCall(listener: (c: ClientToolCallHandle) => void) {
        listener(call);
        return () => {};
      },
    };
  }

  const echo = createTool({
    name: "read_dom",
    description: "",
    inputSchema: schema,
    handler: () => "outline",
  });

  it("reports the failure instead of swallowing it", async () => {
    const logged: { level: string; data: unknown }[] = [];
    const rt: ClientRuntimeContext = {
      ...runtime,
      log: createLog((level, data) => logged.push({ level, data })),
    };

    const failing: ClientToolCallHandle = {
      ...call("read_dom"),
      respond: () => Promise.reject(new Error("socket closed")),
    };

    routeClientTools(feedOf(failing), [echo], () => "c1", rt, new AbortController().signal);
    await waitFor(() => logged.length > 0);

    const entry = logged[0]!;
    expect(entry.level).toBe("error");
    const data = entry.data as Record<string, unknown>;
    expect(data["tool"]).toBe("read_dom");
    expect(data["correlationId"]).toBe("corr-1");
    // The reason survives, so the log names the transport failure rather than
    // reporting a bare "something went wrong".
    expect(String(data["reason"])).toContain("socket closed");
  });

  it("does not reject the caller — routing one bad call keeps the feed alive", async () => {
    const rt: ClientRuntimeContext = { ...runtime, log: createLog(() => {}) };
    const failing: ClientToolCallHandle = {
      ...call("read_dom"),
      respond: () => Promise.reject(new Error("socket closed")),
    };

    expect(() =>
      routeClientTools(feedOf(failing), [echo], () => "c1", rt, new AbortController().signal),
    ).not.toThrow();
    // Settle the rejection so an unhandled-rejection guard cannot fire late.
    await waitFor(() => true);
  });
});

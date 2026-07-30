/**
 * The INWARD completion direction (completions.md §2.4), walked end to end: a remote
 * MCP server's prompt, folded into the native prompts harness, completes its argument
 * slots by forwarding to the origin server — and the siblings the user has already
 * filled ride along as MCP's `context.arguments`.
 *
 * Nothing below the seam is faked: a real SDK `Server`, a real {@link McpClientHarness}
 * over the linked in-memory transport, a real `PromptsHarness`. The claim is a
 * user-visible one — typing into `/change_order`'s `phase` slot offers the phases of the
 * job already chosen — and it holds only if EVERY hop carries the context, which is
 * exactly what a fake at any layer would fail to prove.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import { PromptsHarness } from "@agentick/prompts";

import { InMemoryMcpTransport } from "../../transport/in-memory.js";
import { McpClientHarness, NoneAuth } from "../../client/index.js";
import { inMemoryServerTransport, McpServerHarness } from "../../server/index.js";
import { surfaceRemotePrompts } from "../prompt-surface.js";

/** Which phases exist depends on the JOB — the whole reason `context` is threaded. */
const PHASES: Record<string, readonly string[]> = {
  "Miller Residence": ["framing", "finish carpentry"],
  "Plaza Remodel": ["demo", "drywall"],
};

interface ServerSpec {
  /** What the server advertises at `initialize`. Omit `completions` to test the gate. */
  readonly capabilities?: ServerCapabilities;
  /** Register no `completion/complete` handler — the SDK then answers method-not-found. */
  readonly noCompletionHandler?: boolean;
  /** Report the answer as truncated, to prove the judgment survives the fold. */
  readonly hasMore?: boolean;
}

function makeServer(spec: ServerSpec = {}): Server {
  const capabilities = spec.capabilities ?? { prompts: {}, completions: {} };
  const server = new Server({ name: "jobs-server", version: "0.0.0" }, { capabilities });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "change_order",
        description: "Draft a change order",
        arguments: [
          { name: "job", description: "Which job", required: true },
          { name: "phase", description: "Which phase of that job", required: true },
        ],
      },
    ],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async () => ({
    messages: [{ role: "user", content: { type: "text", text: "draft it" } }],
  }));

  // A server that did not advertise `completions` cannot register the handler at all —
  // the SDK refuses, which is the same fact the client-side gate reads off `initialize`.
  if (spec.noCompletionHandler !== true && capabilities.completions !== undefined) {
    server.setRequestHandler(CompleteRequestSchema, async (req) => {
      const { argument, context } = req.params;
      // A phase is only knowable once the job is: this is the conditional completion the
      // whole chain exists to serve.
      const pool =
        argument.name === "job"
          ? Object.keys(PHASES)
          : (PHASES[context?.arguments?.job ?? ""] ?? []);
      const values = pool.filter((v) => v.toLowerCase().startsWith(argument.value.toLowerCase()));
      return {
        completion: {
          values,
          total: values.length,
          ...(spec.hasMore !== undefined ? { hasMore: spec.hasMore } : {}),
        },
      };
    });
  }

  return server;
}

interface Wired {
  readonly prompts: PromptsHarness;
  readonly client: McpClientHarness;
  readonly server: Server;
}

const active: Wired[] = [];

/** Stand up server ↔ client ↔ prompts, and perform the fold. */
async function wire(spec: ServerSpec = {}): Promise<Wired> {
  const server = makeServer(spec);
  const [clientTransport, serverTransport] = InMemoryMcpTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new McpClientHarness(
    `mcp:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { serverId: "jobs", transport: clientTransport, auth: new NoneAuth() },
  );
  await client.connect();

  const prompts = new PromptsHarness(
    "prompts:fold",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await prompts.ready;
  await surfaceRemotePrompts(prompts, "jobs", "", client);

  const wired = { prompts, client, server };
  active.push(wired);
  return wired;
}

afterEach(async () => {
  while (active.length > 0) {
    const w = active.pop()!;
    await w.prompts.close();
    await w.client.close();
    await w.server.close();
  }
});

describe("a folded remote prompt completes its arguments", () => {
  it("answers from the origin server, filtered by what was typed", async () => {
    const { prompts } = await wire();
    const outcome = await prompts.complete({
      name: "change_order",
      argument: { name: "job", value: "mil" },
    });
    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" && outcome.result.values).toEqual(["Miller Residence"]);
  });

  it("scopes by the sibling already filled — the phases of THAT job", async () => {
    // The load-bearing hop: `complete({ context })` → resolver `ctx.resolvedArguments`
    // → the client verb's `context` → the wire's `params.context.arguments` → the
    // server's handler. Break any one and this reads as an empty slot.
    const { prompts } = await wire();
    const outcome = await prompts.complete({
      name: "change_order",
      argument: { name: "phase", value: "fra" },
      context: { arguments: { job: "Miller Residence" } },
    });
    expect(outcome.kind === "resolved" && outcome.result.values).toEqual(["framing"]);

    // A DIFFERENT job has no `framing`, which is what proves the scoping is real and
    // not an artifact of the prefix filter.
    const other = await prompts.complete({
      name: "change_order",
      argument: { name: "phase", value: "fra" },
      context: { arguments: { job: "Plaza Remodel" } },
    });
    expect(other.kind === "resolved" && other.result.values).toEqual([]);
  });

  it("without the sibling there is nothing to offer, rather than a wrong job's phases", async () => {
    const { prompts } = await wire();
    const outcome = await prompts.complete({
      name: "change_order",
      argument: { name: "phase", value: "" },
    });
    expect(outcome.kind === "resolved" && outcome.result.values).toEqual([]);
  });

  it("carries the origin's truncation judgment through the fold", async () => {
    // `hasMore` is the reason the client verb answers a `CompletionResult` and not a
    // bare `string[]`: a forwarded answer must not present a trimmed list as the whole.
    const { prompts } = await wire({ hasMore: true });
    const outcome = await prompts.complete({
      name: "change_order",
      argument: { name: "job", value: "" },
    });
    expect(outcome.kind === "resolved" && outcome.result.hasMore).toBe(true);
    expect(outcome.kind === "resolved" && outcome.result.total).toBe(2);
  });
});

describe("re-exposed over our own MCP server, the completion takes two hops", () => {
  it("an inbound completion/complete on a folded prompt reaches the origin server", async () => {
    // The outward projection's arm 2 runs the DECLARATION's resolver — which, for a
    // folded prompt, is the forwarding one. So a client of our server completes against
    // a server it never connected to, through one seam and two hops. Nothing about
    // completion is configured here: `prompts.use` is the whole wiring.
    const { prompts } = await wire();
    const transport = inMemoryServerTransport();
    const relay = new McpServerHarness(
      `srv:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {
        name: "relay",
        serverInfo: { name: "relay", version: "0.0.0" },
        transports: [transport],
        prompts: { use: prompts },
      },
    );
    await relay.ready;
    await relay.start();
    const downstream = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
    await downstream.connect((await transport.connect()) as unknown as Transport);

    const res = await downstream.complete({
      ref: { type: "ref/prompt", name: "change_order" },
      argument: { name: "phase", value: "" },
      context: { arguments: { job: "Plaza Remodel" } },
    });
    expect(res.completion.values).toEqual(["demo", "drywall"]);

    await downstream.close();
    await relay.close();
  });
});

describe("when the origin has nothing to say", () => {
  it("a server that advertised completions but answers method-not-found yields empty", async () => {
    // Per keystroke, a protocol error is a dismissal — not a `CompletionResolveFailed`
    // for the composer to render on every character.
    const { prompts } = await wire({ noCompletionHandler: true });
    const outcome = await prompts.complete({
      name: "change_order",
      argument: { name: "job", value: "mil" },
    });
    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" && outcome.result.values).toEqual([]);
  });

  it("a server that never advertised completions leaves the slot uncompletable", async () => {
    // `unavailable`, not empty values: the composer can tell "this slot does not
    // complete" from "nothing matched", and no request is spent finding out.
    const { prompts } = await wire({ capabilities: { prompts: {} } });
    const outcome = await prompts.complete({
      name: "change_order",
      argument: { name: "job", value: "mil" },
    });
    expect(outcome.kind).toBe("unavailable");
  });
});

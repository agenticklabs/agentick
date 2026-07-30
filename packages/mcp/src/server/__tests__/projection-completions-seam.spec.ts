/**
 * `completion/complete` resolves through the PROMPTS SEAM — one declaration
 * serving both wires.
 *
 * The claim this suite exists to prove: a prompt argument that declares how it
 * completes needs nothing restated in MCP server config. The declaration's own
 * resolver answers an inbound `completion/complete`, and it answers it with the
 * CONNECTION's identity in hand — because the projection composes
 * `prompts.fx.complete` inside the crossing rather than calling the Promise
 * facade, which would mint the resolver's ctx from the harness's own scope.
 *
 * Pins:
 *  - an INLINE declaration resolver answers `ref/prompt`, prefix-filtered, with
 *    `context.arguments` reaching it as `resolvedArguments`
 *  - a NAMED ref resolves the second hop against the wired completions registry;
 *    with no registry wired it answers empty rather than erroring
 *  - an EXPLICIT config handler outranks the declaration for the same argument
 *  - the resolver's ctx carries the caller's `mcp.user` (credential included) and
 *    the redacted `identity` — the fiber is intact, not a fresh root
 *  - silence over faults: unknown prompt, unknown argument, an argument declaring
 *    no completion, a ref nobody bound → `{ values: [] }`, no protocol error
 *  - a per-connection prompts `filter` hides a prompt from completion too
 *  - the `completions` capability follows a projected prompts surface
 *  - THE CAP IS THE WIRE'S: one 150-value resolver answers 100 + `hasMore` over
 *    MCP and all 150 through the harness's own door
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type {
  CompletionCtx,
  McpAuthenticatedUser,
  PromptDeclaration,
  PromptsCompleteInput,
} from "@agentick/spec";
import { CompletionsHarness } from "@agentick/completions";
import { PromptsHarness } from "@agentick/prompts";

import {
  COMPLETION_MAX_VALUES,
  completeFromList,
  inMemoryServerTransport,
  McpServerHarness,
  type CompletionContext,
  type McpServerOptions,
  type PromptsFilter,
} from "../index.js";

// ────────────────────────────── fixtures ──────────────────────────────

const BEARER = "SEAM_SECRET";

const ADA: McpAuthenticatedUser = {
  id: "user-42",
  displayName: "Ada",
  scopes: ["read:all"],
  token: BEARER,
};

const alwaysAda = {
  authenticator: async (): Promise<{ authenticated: true; user: McpAuthenticatedUser }> => ({
    authenticated: true,
    user: ADA,
  }),
};

function substrate(): [MemoryJournal, LocalEventBus, LocalInbox] {
  return [new MemoryJournal({ capacity: 1024 }), new LocalEventBus(), new LocalInbox()];
}

async function makePrompts(declarations: readonly PromptDeclaration[]): Promise<PromptsHarness> {
  const harness = new PromptsHarness(`prompts:${ulid()}`, ...substrate());
  await harness.ready;
  for (const declaration of declarations) await harness.register({ declaration });
  return harness;
}

async function makeCompletions(
  sources: Readonly<Record<string, (value: string, ctx: CompletionCtx) => readonly string[]>>,
): Promise<CompletionsHarness> {
  const harness = new CompletionsHarness(`completions:${ulid()}`, ...substrate());
  await harness.ready;
  for (const [name, resolver] of Object.entries(sources)) harness.register(name, resolver);
  return harness;
}

/**
 * One server projecting a prompts surface, one connected client. `prompts.use`
 * is the same slot the prompts projection consumes — nothing about completion is
 * configured unless a test opts into the override.
 */
async function connected(options: {
  readonly prompts?: PromptsHarness;
  readonly promptsFilter?: PromptsFilter;
  readonly completions?: McpServerOptions["completions"];
}): Promise<{ readonly client: McpClient; readonly cleanup: () => Promise<void> }> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(`srv:${ulid()}`, ...substrate(), {
    name: "seam",
    serverInfo: { name: "seam", version: "0.0.0" },
    transports: [transport],
    ...(options.prompts
      ? {
          prompts: {
            use: options.prompts,
            ...(options.promptsFilter ? { filter: options.promptsFilter } : {}),
          },
        }
      : {}),
    ...(options.completions ? { completions: options.completions } : {}),
    auth: alwaysAda,
  });
  await harness.ready;
  await harness.start();
  const client = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
  await client.connect((await transport.connect()) as unknown as Transport);
  return {
    client,
    cleanup: async () => {
      await client.close().catch(() => {});
      await harness.close();
    },
  };
}

const askGreet = (
  argument: string,
  value: string,
  args?: Readonly<Record<string, string>>,
): Parameters<McpClient["complete"]>[0] => ({
  ref: { type: "ref/prompt", name: "greet" },
  argument: { name: argument, value },
  ...(args ? { context: { arguments: args } } : {}),
});

// ══════════════════ the declaration answers the MCP wire ══════════════════

describe("completion/complete — through the prompts seam", () => {
  it("an inline declaration resolver answers ref/prompt, prefix-filtered", async () => {
    const prompts = await makePrompts([
      {
        name: "greet",
        description: "g",
        template: "hi",
        arguments: [{ name: "name", complete: completeFromList(["Ada", "Alan", "Bob"]) }],
      },
    ]);
    // NOTE: no `completions` config at all. The declaration is the whole wiring.
    const { client, cleanup } = await connected({ prompts });
    const res = await client.complete(askGreet("name", "A"));
    expect(res.completion.values).toEqual(["Ada", "Alan"]);
    await cleanup();
  });

  it("context.arguments reach the declaration's resolver as resolvedArguments", async () => {
    const seen: Array<Record<string, string>> = [];
    const prompts = await makePrompts([
      {
        name: "greet",
        description: "g",
        template: "hi",
        arguments: [
          {
            name: "phase",
            complete: (typed, ctx) => {
              seen.push({ ...ctx.resolvedArguments });
              return [`${typed}-of-${ctx.resolvedArguments["job"] ?? "?"}`];
            },
          },
        ],
      },
    ]);
    const { client, cleanup } = await connected({ prompts });
    const res = await client.complete(askGreet("phase", "fra", { job: "Miller" }));
    expect(res.completion.values).toEqual(["fra-of-Miller"]);
    expect(seen).toEqual([{ job: "Miller" }]);
    await cleanup();
  });

  it("the resolver's ctx carries the CALLER's identity — the crossing fiber is intact", async () => {
    let seen: CompletionCtx | undefined;
    const prompts = await makePrompts([
      {
        name: "greet",
        description: "g",
        template: "hi",
        arguments: [
          {
            name: "name",
            complete: (_typed, ctx) => {
              seen = ctx;
              return [];
            },
          },
        ],
      },
    ]);
    const { client, cleanup } = await connected({ prompts });
    await client.complete(askGreet("name", ""));

    // The full authenticated record — credential included — on the in-fiber
    // boundary facet the crossing published. Through the Promise facade this
    // would be a ctx minted from the prompts harness's own scope: no `mcp` at
    // all, and no caller identity.
    const facet = (seen as CompletionContext | undefined)?.mcp;
    expect(facet?.user).toEqual(ADA);
    expect(facet?.user?.token).toBe(BEARER);
    // The redacted twin — what the journal records — travels on the trunk.
    expect(seen?.identity?.principal).toBe("user-42");
    expect(seen?.identity?.user).not.toHaveProperty("token");
    await cleanup();
  });
});

// ══════════════════ the second hop: a NAMED registry ref ══════════════════

describe("completion/complete — named refs and the registry", () => {
  const declaringNamedRef: readonly PromptDeclaration[] = [
    {
      name: "greet",
      description: "g",
      template: "hi",
      arguments: [{ name: "job", complete: "knowify.jobs" }],
    },
  ];

  it("resolves a named ref against the wired completions registry", async () => {
    const prompts = await makePrompts(declaringNamedRef);
    const completions = await makeCompletions({
      "knowify.jobs": (typed) => ["Miller", "Mason", "Baker"].filter((j) => j.startsWith(typed)),
    });
    const { client, cleanup } = await connected({
      prompts,
      completions: { use: completions },
    });
    const res = await client.complete(askGreet("job", "M"));
    expect(res.completion.values).toEqual(["Miller", "Mason"]);
    await cleanup();
  });

  it("a named ref with NO registry wired completes empty, not an error", async () => {
    const prompts = await makePrompts(declaringNamedRef);
    const { client, cleanup } = await connected({ prompts });
    const res = await client.complete(askGreet("job", "M"));
    expect(res.completion.values).toEqual([]);
    await cleanup();
  });

  it("a ref no registry answers to completes empty", async () => {
    const prompts = await makePrompts(declaringNamedRef);
    const completions = await makeCompletions({ "other.source": () => ["x"] });
    const { client, cleanup } = await connected({
      prompts,
      completions: { use: completions },
    });
    const res = await client.complete(askGreet("job", ""));
    expect(res.completion.values).toEqual([]);
    await cleanup();
  });

  it("a registry resolver sees the caller's identity too — the second hop stays on the fiber", async () => {
    let seen: CompletionCtx | undefined;
    const prompts = await makePrompts(declaringNamedRef);
    const completions = await makeCompletions({
      "knowify.jobs": (_typed, ctx) => {
        seen = ctx;
        return [];
      },
    });
    const { client, cleanup } = await connected({
      prompts,
      completions: { use: completions },
    });
    await client.complete(askGreet("job", ""));
    expect((seen as CompletionContext | undefined)?.mcp?.user).toEqual(ADA);
    await cleanup();
  });
});

// ══════════════════ precedence and silence ══════════════════

describe("completion/complete — precedence", () => {
  it("an explicit config handler outranks the declaration for the same argument", async () => {
    const prompts = await makePrompts([
      {
        name: "greet",
        description: "g",
        template: "hi",
        arguments: [{ name: "name", complete: completeFromList(["from-declaration"]) }],
      },
    ]);
    const { client, cleanup } = await connected({
      prompts,
      completions: { prompts: { greet: { name: completeFromList(["from-config"]) } } },
    });
    const res = await client.complete(askGreet("name", ""));
    expect(res.completion.values).toEqual(["from-config"]);
    await cleanup();
  });

  it("a config handler for a DIFFERENT argument leaves the declaration's own intact", async () => {
    const prompts = await makePrompts([
      {
        name: "greet",
        description: "g",
        template: "hi",
        arguments: [
          { name: "name", complete: completeFromList(["declared"]) },
          { name: "city", description: "no completion declared" },
        ],
      },
    ]);
    const { client, cleanup } = await connected({
      prompts,
      completions: { prompts: { greet: { city: completeFromList(["configured"]) } } },
    });
    expect((await client.complete(askGreet("name", ""))).completion.values).toEqual(["declared"]);
    expect((await client.complete(askGreet("city", ""))).completion.values).toEqual(["configured"]);
    await cleanup();
  });
});

describe("completion/complete — silence over faults", () => {
  it("unknown prompt, unknown argument, and an argument declaring nothing all answer empty", async () => {
    const prompts = await makePrompts([
      {
        name: "greet",
        description: "g",
        template: "hi",
        arguments: [
          { name: "name", complete: completeFromList(["Ada"]) },
          { name: "plain", description: "declares no completion" },
        ],
      },
    ]);
    const { client, cleanup } = await connected({ prompts });

    const unknownPrompt = await client.complete({
      ref: { type: "ref/prompt", name: "nope" },
      argument: { name: "name", value: "" },
    });
    expect(unknownPrompt.completion.values).toEqual([]);
    expect((await client.complete(askGreet("nope_arg", ""))).completion.values).toEqual([]);
    expect((await client.complete(askGreet("plain", ""))).completion.values).toEqual([]);
    await cleanup();
  });

  it("a prompt hidden by the per-connection filter is not completable either", async () => {
    const prompts = await makePrompts([
      {
        name: "greet",
        description: "g",
        template: "hi",
        arguments: [{ name: "name", complete: completeFromList(["Ada"]) }],
      },
    ]);
    const { client, cleanup } = await connected({
      prompts,
      promptsFilter: (decl) => decl.name !== "greet",
    });
    // Visibility is symmetric across list / get / complete: completing an
    // argument runs a resolver over the caller's data, which is exactly what the
    // filter exists to withhold.
    const res = await client.complete(askGreet("name", ""));
    expect(res.completion.values).toEqual([]);
    await cleanup();
  });
});

// ══════════════════ capability ══════════════════

describe("completions capability — earned by the prompts surface", () => {
  it("is advertised for a prompts surface with no completions config", async () => {
    const prompts = await makePrompts([{ name: "greet", description: "g", template: "hi" }]);
    const { client, cleanup } = await connected({ prompts });
    expect(client.getServerCapabilities()?.completions).toBeDefined();
    await cleanup();
  });

  it("capabilities.completions:false still suppresses it", async () => {
    const prompts = await makePrompts([
      {
        name: "greet",
        description: "g",
        template: "hi",
        arguments: [{ name: "name", complete: completeFromList(["Ada"]) }],
      },
    ]);
    const transport = inMemoryServerTransport();
    const harness = new McpServerHarness(`srv:${ulid()}`, ...substrate(), {
      name: "seam-optout",
      serverInfo: { name: "seam-optout", version: "0.0.0" },
      transports: [transport],
      prompts: { use: prompts },
      capabilities: { completions: false },
    });
    await harness.ready;
    await harness.start();
    const client = new McpClient({ name: "c", version: "0.0.0" }, { capabilities: {} });
    await client.connect((await transport.connect()) as unknown as Transport);
    expect(client.getServerCapabilities()?.completions).toBeUndefined();
    await client.close();
    await harness.close();
  });
});

// ══════════════════ the cap belongs to the wire, not the resolver ══════════════════

describe("the 150-value declaration — capped on MCP, whole on the agentick door", () => {
  const huge = Array.from({ length: 150 }, (_, i) => `v${i}`);

  it("one resolver: 100 + hasMore over MCP, all 150 through the prompts door", async () => {
    const prompts = await makePrompts([
      {
        name: "greet",
        description: "g",
        template: "hi",
        arguments: [{ name: "name", complete: completeFromList(huge) }],
      },
    ]);
    const { client, cleanup } = await connected({ prompts });

    // Over MCP: the projection is the single cap site.
    const wire = await client.complete(askGreet("name", ""));
    expect(wire.completion.values).toHaveLength(COMPLETION_MAX_VALUES);
    expect(wire.completion.hasMore).toBe(true);

    // The SAME resolver, asked through the harness door the agentick wire route
    // uses — untruncated, because the cap is MCP's and lives at MCP's edge.
    const ask: PromptsCompleteInput = {
      name: "greet",
      argument: { name: "name", value: "" },
    };
    const outcome = await prompts.complete(ask);
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind === "resolved") {
      expect(outcome.result.values).toHaveLength(150);
      expect(outcome.result.hasMore).toBeUndefined();
    }
    await cleanup();
  });
});

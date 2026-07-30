/**
 * `surfaceRemotePrompts` — projecting a remote server's prompts into the session's
 * prompts namespace, so they surface wherever the app's own prompts do.
 *
 * Exercised against a REAL `PromptsHarness` with a fake client (no live transport),
 * mirroring `./resource-surface.spec.ts`. What matters here is what a *user* ends up
 * seeing in a palette: the right names, the right arguments, content that comes from the
 * remote on every invoke, and — on a `list_changed` — no stale entry left behind.
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { PromptsHarness } from "@agentick/prompts";

import { surfaceRemotePrompts, type RemotePromptClient } from "../prompt-surface.js";
import type {
  McpCompletionContext,
  McpGetPromptResult,
  McpPromptPage,
} from "../../client/types.js";

async function harness(): Promise<PromptsHarness> {
  const h = new PromptsHarness(
    "prompts:test",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await h.ready;
  return h;
}

interface FakeSpec {
  readonly prompts: McpPromptPage["prompts"];
  readonly pages?: Readonly<Record<string, McpPromptPage>>;
  readonly get?: (name: string, args?: Readonly<Record<string, string>>) => McpGetPromptResult;
}

/** One recorded `completion/complete` forward, as the resolver issued it. */
interface CompleteCall {
  readonly prompt: string;
  readonly argument: string;
  readonly value: string;
  readonly context: McpCompletionContext | undefined;
}

function fakeClient(
  spec: FakeSpec,
): RemotePromptClient & { gets: string[]; completes: CompleteCall[] } {
  const gets: string[] = [];
  const completes: CompleteCall[] = [];
  return {
    gets,
    completes,
    async listPrompts(cursor?: string): Promise<McpPromptPage> {
      if (cursor !== undefined && spec.pages?.[cursor]) return spec.pages[cursor]!;
      return { prompts: spec.prompts, ...(spec.pages ? { nextCursor: "p2" } : {}) };
    },
    async getPrompt(name, args): Promise<McpGetPromptResult> {
      gets.push(name);
      return (
        spec.get?.(name, args) ?? {
          messages: [{ role: "user", content: [{ type: "text", text: `rendered:${name}` }] }],
        }
      );
    },
    async completePromptArgument(prompt, argument, value, context) {
      completes.push({ prompt, argument, value, context });
      return { values: [`${argument}:${value}`] };
    },
  };
}

describe("what a user sees in the palette", () => {
  it("registers each remote prompt under the prefixed name", async () => {
    const prompts = await harness();
    await surfaceRemotePrompts(
      prompts,
      "knowify",
      "knowify__",
      fakeClient({ prompts: [{ name: "jobs_over_budget", description: "Jobs over budget" }] }),
    );
    expect(prompts.list().map((p) => p.name)).toEqual(["knowify__jobs_over_budget"]);
    expect(prompts.get("knowify__jobs_over_budget")?.description).toBe("Jobs over budget");
    await prompts.close();
  });

  it("an empty prefix gives bare names, for a palette with one server", async () => {
    // `/jobs_over_budget` reads better than `/knowify__jobs_over_budget`, and this is the
    // escape hatch for an adopter who knows there is no collision to guard against.
    const prompts = await harness();
    await surfaceRemotePrompts(
      prompts,
      "knowify",
      "",
      fakeClient({ prompts: [{ name: "jobs_over_budget" }] }),
    );
    expect(prompts.list().map((p) => p.name)).toEqual(["jobs_over_budget"]);
    await prompts.close();
  });

  it("keeps title and description DISTINCT — a palette wants a label and a subtitle", async () => {
    // The fold this replaces (`description ?? title ?? name`) lost the title of any
    // server supplying both, which is the common case for a well-documented prompt.
    const prompts = await harness();
    await surfaceRemotePrompts(
      prompts,
      "k",
      "",
      fakeClient({
        prompts: [{ name: "profit", title: "Job Profitability", description: "Margin by job" }],
      }),
    );
    expect(prompts.get("profit")?.title).toBe("Job Profitability");
    expect(prompts.get("profit")?.description).toBe("Margin by job");
    await prompts.close();
  });

  it("falls back title → name for description when the server gives none", async () => {
    // A palette row with an empty subtitle is worse than one echoing the label.
    const prompts = await harness();
    await surfaceRemotePrompts(
      prompts,
      "k",
      "",
      fakeClient({ prompts: [{ name: "a", title: "The A Report" }, { name: "b" }] }),
    );
    expect(prompts.get("a")?.title).toBe("The A Report");
    expect(prompts.get("a")?.description).toBe("The A Report");
    expect(prompts.get("b")?.title).toBeUndefined();
    expect(prompts.get("b")?.description).toBe("b");
    await prompts.close();
  });

  it("carries the arguments through, so a palette can prompt for them", async () => {
    const prompts = await harness();
    await surfaceRemotePrompts(
      prompts,
      "k",
      "",
      fakeClient({
        prompts: [
          {
            name: "profit",
            arguments: [
              { name: "jobId", description: "Which job", required: true },
              { name: "asOf" },
            ],
          },
        ],
      }),
    );
    expect(
      prompts.get("profit")?.arguments?.map((a) => ({
        name: a.name,
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(a.required !== undefined ? { required: a.required } : {}),
        completable: typeof a.complete === "function",
      })),
    ).toEqual([
      { name: "jobId", description: "Which job", required: true, completable: true },
      { name: "asOf", completable: true },
    ]);
    await prompts.close();
  });

  it("paginates, so a server with many prompts is not silently truncated", async () => {
    const prompts = await harness();
    await surfaceRemotePrompts(
      prompts,
      "k",
      "",
      fakeClient({
        prompts: [{ name: "one" }],
        pages: { p2: { prompts: [{ name: "two" }] } },
      }),
    );
    expect(
      prompts
        .list()
        .map((p) => p.name)
        .sort(),
    ).toEqual(["one", "two"]);
    await prompts.close();
  });
});

describe("content comes from the remote, on every invoke", () => {
  it("renders by calling prompts/get rather than caching at registration", async () => {
    // A server whose prompt text changes without emitting `list_changed` still serves the
    // current one — which is why registration captures a call, not a rendering.
    const prompts = await harness();
    const client = fakeClient({ prompts: [{ name: "p" }] });
    await surfaceRemotePrompts(prompts, "k", "", client);
    expect(client.gets).toEqual([]); // nothing fetched at registration

    const first = await prompts.invoke({ name: "p", args: {} });
    expect(client.gets).toEqual(["p"]);
    expect(first.messages[0]?.content).toEqual([{ type: "text", text: "rendered:p" }]);

    await prompts.invoke({ name: "p", args: {} });
    expect(client.gets).toEqual(["p", "p"]); // fetched again
    await prompts.close();
  });

  it("threads the invoke's arguments to the remote", async () => {
    const prompts = await harness();
    let seen: Readonly<Record<string, string>> | undefined;
    const client: RemotePromptClient = {
      listPrompts: async () => ({ prompts: [{ name: "p", arguments: [{ name: "jobId" }] }] }),
      getPrompt: async (_name, args) => {
        seen = args;
        return { messages: [{ role: "user", content: [{ type: "text", text: "ok" }] }] };
      },
      completePromptArgument: async () => ({ values: [] }),
    };
    await surfaceRemotePrompts(prompts, "k", "", client);
    await prompts.invoke({ name: "p", args: { jobId: "4471" } });
    expect(seen).toEqual({ jobId: "4471" });
    await prompts.close();
  });

  it("keeps the remote identity on metadata, so a consumer can route back", async () => {
    const prompts = await harness();
    await surfaceRemotePrompts(
      prompts,
      "knowify",
      "pre__",
      fakeClient({ prompts: [{ name: "p" }] }),
    );
    expect(prompts.get("pre__p")?.metadata).toEqual({
      mcp: { serverId: "knowify", remoteName: "p" },
    });
    await prompts.close();
  });
});

describe("argument completion forwards to the origin", () => {
  it("hands the composer's filled siblings to the origin as context.arguments", async () => {
    // The fold's half of the inward chain, pinned without a transport: the resolver is
    // called with the ORIGIN's prompt name (not the prefixed local one) and the ctx's
    // `resolvedArguments` re-nested under MCP's `context`. The full chain through a real
    // server lives in ./prompt-surface-completion.spec.ts.
    const prompts = await harness();
    const client = fakeClient({
      prompts: [{ name: "co", arguments: [{ name: "job" }, { name: "phase" }] }],
    });
    await surfaceRemotePrompts(prompts, "k", "pre__", client);

    const outcome = await prompts.complete({
      name: "pre__co",
      argument: { name: "phase", value: "fra" },
      context: { arguments: { job: "Miller" } },
    });

    expect(outcome).toEqual({ kind: "resolved", result: { values: ["phase:fra"] } });
    expect(client.completes).toEqual([
      { prompt: "co", argument: "phase", value: "fra", context: { arguments: { job: "Miller" } } },
    ]);
    await prompts.close();
  });
});

describe("teardown, which is what makes list_changed correct", () => {
  it("each returned unsubscribe removes exactly its own prompt", async () => {
    const prompts = await harness();
    const unsubs = await surfaceRemotePrompts(
      prompts,
      "k",
      "",
      fakeClient({ prompts: [{ name: "a" }, { name: "b" }] }),
    );
    expect(unsubs).toHaveLength(2);
    unsubs[0]!();
    await new Promise((r) => setTimeout(r, 5));
    expect(prompts.list().map((p) => p.name)).toEqual(["b"]);
    await prompts.close();
  });

  it("leaves no stale entry across a re-discovery that DROPPED a prompt", async () => {
    // The `list_changed` path is teardown-then-rediscover. If teardown missed anything, a
    // prompt the server has deleted would linger in the palette forever — invocable, and
    // failing on the remote.
    const prompts = await harness();
    const before = await surfaceRemotePrompts(
      prompts,
      "k",
      "",
      fakeClient({ prompts: [{ name: "kept" }, { name: "removed_upstream" }] }),
    );
    for (const u of before) u();
    await new Promise((r) => setTimeout(r, 5));
    await surfaceRemotePrompts(prompts, "k", "", fakeClient({ prompts: [{ name: "kept" }] }));
    expect(prompts.list().map((p) => p.name)).toEqual(["kept"]);
    await prompts.close();
  });
});

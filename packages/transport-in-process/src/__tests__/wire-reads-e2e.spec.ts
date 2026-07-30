/**
 * Full-stack wire-READS round-trip — the reads three-audiences-plan G-prep
 * authored so the skills / prompts / state client handles become buildable.
 *
 * Before G-prep the dynamic lane routed skills/prompts MUTATIONS only and state
 * had no read command at all — enumeration was wire-unreachable. This drives the
 * new reads end-to-end through the REAL `GatewayHarness` + `inProcessTransport`
 * via the generic dynamic-command lane (no client handles in this PR — the calls
 * go straight through `client.transport.request`):
 *
 *   - `skills/list` · `skills/get`      (skills had NO wire read)
 *   - `prompts/list`                    (prompts lacked `prompts/list`)
 *   - `state/get` · `state/list` · `state/set` round-trip (state had no read
 *     command AND its mutations were exposure-less → not wire-reachable)
 *   - `commands/list` enumerates them; an undeclared verb stays MethodNotFound
 *     (deny-by-default preserved).
 *
 * Side-effect imports register the server-side surfaces + WireMethods rows.
 */

import "@agentick/state";

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { hydrateFrom as hydrateSkillsFrom, withSkills } from "@agentick/skills";
import { hydrateFrom as hydratePromptsFrom, withPrompts } from "@agentick/prompts";
import { ErrorCode, type ContentBlock, type Skill, type WireMethod } from "@agentick/spec";

import { inProcessTransport } from "../index.js";

/** `n` filler skills / prompts — enough to push a wire read past one page. */
function fillerSkills(n: number): ReadonlyArray<{
  name: string;
  description: string;
  content: string;
}> {
  return Array.from({ length: n }, (_, i) => ({
    name: `filler-${String(i).padStart(3, "0")}`,
    description: "filler",
    content: "…",
  }));
}

async function makeStack(bulk = 0) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("e2e-reads-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "reads-app",
    rootElement: null,
    options: {
      modelExecutor: executor,
      compiler: fakeCompiler(),
      // skills + prompts are OPTIONAL harnesses — install them so their command
      // surfaces mount at the dynamic-lane inbox address. state is built-in.
      extensions: [
        withSkills({
          hydrate: hydrateSkillsFrom([
            { name: "review", description: "Review changes", content: "# Review\nCheck it." },
            ...fillerSkills(bulk),
          ]),
        }),
        withPrompts({
          hydrate: hydratePromptsFrom([
            {
              declaration: { name: "greet", description: "Greet the user", template: "Hi {name}" },
            },
            ...fillerSkills(bulk).map((f) => ({
              declaration: { name: f.name, description: f.description, template: "x" },
            })),
          ]),
        }),
      ],
    },
  });
  const session = await app.createSession({ sessionId: "reads-session" });

  // Seed a state key on the built-in state harness.
  await session.state.set({ key: "theme", value: "dark" });

  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();

  const request = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    client.transport.request(method as WireMethod, params as never);

  return {
    request,
    session,
    sessionId: session.id,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("wire reads end-to-end — client ↔ gateway (dynamic lane) ↔ session", () => {
  it("skills/list enumerates the seeded skill (content included)", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    const { skills } = (await request("skills/list", { sessionId })) as {
      skills: readonly Skill[];
      nextCursor?: string;
    };
    const review = skills.find((s) => s.name === "review");
    expect(review).toMatchObject({ name: "review", description: "Review changes" });
    expect(review?.content).toContain("Check it.");

    await cleanup();
  });

  it("skills/get returns one skill by name (null on miss)", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    const hit = (await request("skills/get", { sessionId, name: "review" })) as Skill | null;
    expect(hit).toMatchObject({ name: "review" });

    const miss = await request("skills/get", { sessionId, name: "nope" });
    expect(miss).toBeNull();

    await cleanup();
  });

  it("prompts/list enumerates the seeded prompt as a wire-safe record", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    const { prompts } = (await request("prompts/list", { sessionId })) as {
      prompts: ReadonlyArray<{
        name: string;
        description: string;
        template?: unknown;
        render?: unknown;
      }>;
      nextCursor?: string;
    };
    const greet = prompts.find((p) => p.name === "greet");
    expect(greet).toMatchObject({ name: "greet", description: "Greet the user" });
    // The wire projection is the record slice — no non-serializable fields.
    expect(greet).not.toHaveProperty("template");
    expect(greet).not.toHaveProperty("render");

    await cleanup();
  });

  it("skills/list + prompts/list page with an opaque cursor; a walk sees each row once", async () => {
    // 150 filler rows + the fixture — past the shared DEFAULT_PAGE_SIZE of 100,
    // so page one carries a cursor and page two closes the walk.
    const { request, sessionId, cleanup } = await makeStack(150);

    for (const [method, key] of [
      ["skills/list", "skills"],
      ["prompts/list", "prompts"],
    ] as const) {
      const first = (await request(method, { sessionId })) as {
        readonly [k: string]: readonly { name: string }[] | string | undefined;
      };
      const firstRows = first[key] as readonly { name: string }[];
      expect(firstRows).toHaveLength(100);
      expect(first.nextCursor).toBe("100");

      const second = (await request(method, { sessionId, cursor: "100" })) as typeof first;
      const secondRows = second[key] as readonly { name: string }[];
      expect(secondRows).toHaveLength(51);
      expect(second.nextCursor).toBeUndefined();

      const names = new Set([...firstRows, ...secondRows].map((r) => r.name));
      expect(names.size).toBe(151);
    }

    await cleanup();
  });

  it("a small catalog carries no cursor (wire-stable for the common case)", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    expect(await request("skills/list", { sessionId })).not.toHaveProperty("nextCursor");
    expect(await request("prompts/list", { sessionId })).not.toHaveProperty("nextCursor");

    await cleanup();
  });

  it("state/get + state/list read the seeded key", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    expect(await request("state/get", { sessionId, key: "theme" })).toBe("dark");

    const entries = (await request("state/list", { sessionId })) as ReadonlyArray<{
      key: string;
      value: unknown;
    }>;
    expect(entries.find((e) => e.key === "theme")).toEqual({ key: "theme", value: "dark" });

    await cleanup();
  });

  it("state/set round-trips over the wire and re-reads on the server", async () => {
    const { request, session, sessionId, cleanup } = await makeStack();

    await request("state/set", { sessionId, key: "count", value: 7 });

    expect(session.state.get("count")).toBe(7);
    expect(await request("state/get", { sessionId, key: "count" })).toBe(7);

    await cleanup();
  });

  it("commands/list enumerates the new wire-exposed read verbs", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    const reply = (await request("commands/list", { sessionId })) as {
      commands: Array<{ method: string }>;
    };
    const methods = reply.commands.map((c) => c.method);
    for (const m of [
      "skills/list",
      "skills/get",
      "skills/search",
      "prompts/list",
      "prompts/get",
      "state/get",
      "state/list",
      "state/set",
    ]) {
      expect(methods).toContain(m);
    }

    await cleanup();
  });

  it("an undeclared read verb is MethodNotFound (deny-by-default)", async () => {
    const { request, sessionId, cleanup } = await makeStack();

    const err = await request("skills/frobnicate", { sessionId }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    const e = err as { code?: number; error?: { code?: number } };
    expect(e.error?.code ?? e.code).toBe(ErrorCode.MethodNotFound);

    await cleanup();
  });
});

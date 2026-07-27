/**
 * Full-stack CLIENT-HANDLE round-trip — the three-audiences-plan §G parity
 * handles driven through the REAL `GatewayHarness` + `inProcessTransport`.
 *
 * The `wire-reads-e2e` sibling drives the raw `client.transport.request(...)`
 * calls; THIS test drives the typed client handles the §G packages ship
 * (`session.skills` / `.prompts` / `.state` / `.resources`), proving the ADR 87
 * `/client` self-assembly + the fire-and-refetch read/mutate loop over the
 * generic dynamic-command lane end-to-end. (`session.tools` — the §F handle — is
 * covered by the tool-executor server suite + the client bundle self-assembly
 * test; its wire read rides the dedicated `session/list_tools` method.)
 *
 * Side-effect imports register BOTH the server-side command surfaces (+
 * `WireMethods` rows) AND the client `/client` sub-handles.
 */

import "@agentick/state";
import "@agentick/state/client";
import "@agentick/skills/client";
import "@agentick/prompts/client";
import "@agentick/resources/client";

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { createGateway } from "@agentick/gateway";
import { fakeCompiler } from "@agentick/compiler/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { hydrateFrom as hydrateSkillsFrom, withSkills } from "@agentick/skills";
import { hydrateFrom as hydratePromptsFrom, withPrompts } from "@agentick/prompts";
import type { ContentBlock } from "@agentick/spec";

import { inProcessTransport } from "../index.js";

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("e2e-handles-exec", journal, bus, inbox, {
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
    appId: "handles-app",
    rootElement: null,
    options: {
      modelExecutor: executor,
      compiler: fakeCompiler(),
      extensions: [
        withSkills({
          hydrate: hydrateSkillsFrom([
            { name: "review", description: "Review changes", content: "# Review" },
          ]),
        }),
        withPrompts({
          hydrate: hydratePromptsFrom([
            { declaration: { name: "greet", description: "Greet the user", template: "Hi {who}" } },
          ]),
        }),
      ],
    },
  });
  const session = await app.createSession({ sessionId: "handles-session" });

  // Seed server-side state + a resource.
  await session.state.set({ key: "theme", value: "dark" });
  session.resources.register("test://doc", (uri) => [
    { uri, text: "hello world", mimeType: "text/plain" },
  ]);

  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();

  return {
    client,
    session,
    sessionId: session.id,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("client handles end-to-end — client ↔ gateway (dynamic lane) ↔ session", () => {
  it("session.skills — refresh reads the library; register round-trips", async () => {
    const { client, session, sessionId, cleanup } = await makeStack();
    const skills = client.session(sessionId).skills;

    const rows = await skills.refresh();
    expect(rows.find((s) => s.name === "review")).toMatchObject({ description: "Review changes" });
    // Enumerable sync read reflects the poll.
    expect(skills.get("review")?.name).toBe("review");

    await skills.register({ name: "summarize", description: "Summarize", content: "# Sum" });
    expect(session.skills?.get("summarize")).toMatchObject({ name: "summarize" });

    await cleanup();
  });

  it("session.prompts — refresh reads declarations; render round-trips", async () => {
    const { client, sessionId, cleanup } = await makeStack();
    const prompts = client.session(sessionId).prompts;

    const rows = await prompts.refresh();
    expect(rows.find((p) => p.name === "greet")).toMatchObject({ description: "Greet the user" });

    const rendered = await prompts.render({ name: "greet", args: { who: "world" } });
    expect(rendered.messages.length).toBeGreaterThan(0);

    await cleanup();
  });

  it("session.state — refresh reads entries; set round-trips to the server", async () => {
    const { client, session, sessionId, cleanup } = await makeStack();
    const state = client.session(sessionId).state;

    const rows = await state.refresh();
    expect(rows.find((e) => e.key === "theme")).toEqual({ key: "theme", value: "dark" });

    await state.set("count", 7);
    expect(session.state.get("count")).toBe(7);
    // The fire-and-refetch re-poll folded the new entry into the client snapshot.
    expect(state.get("count")).toEqual({ key: "count", value: 7 });

    await cleanup();
  });

  it("session.resources — refresh lists fixed resources; read round-trips content", async () => {
    const { client, sessionId, cleanup } = await makeStack();
    const resources = client.session(sessionId).resources;

    const rows = await resources.refresh();
    expect(rows.find((r) => r.uri === "test://doc")).toBeDefined();

    const contents = await resources.read("test://doc");
    expect(contents[0]).toMatchObject({ uri: "test://doc", text: "hello world" });

    await cleanup();
  });
});

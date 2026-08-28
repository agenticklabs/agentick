/**
 * The session-principal completion (ADR 48) — inheritance + the adopter seams,
 * end-to-end through `createApp` (the app is the `SpawnContext` that constructs
 * children and the host that runs `onSessionCreate` + session extensions).
 *
 * Pins the parts the wire-tier `session-principal.spec.ts` can't reach:
 *   - **spawn + fork** children carry the PARENT's principal (harness + record).
 *   - **fork** inherits the parent's adopter `metadata` bag when `ForkInput.metadata`
 *     is absent; an explicit bag wins; **spawn** does NOT auto-inherit metadata.
 *   - **onSessionCreate reshape** — a hook injects a metadata key into a spawned
 *     child's input (selective spawn inheritance); veto still refuses the session.
 *   - **SessionInstaller** exposes the session's `principal` + `metadata` at install.
 *
 * @verifiedBy this file
 * @see packages/session/src/harness.ts — `spawn()` principal thread, `fork()` metadata inherit
 * @see packages/app/src/harness.ts — `createSessionBody` reshape loop, `makeSessionInstaller`
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type {
  CreateSessionInput,
  ExecutionTarget,
  LanguageModelExecutionResult,
  SessionExtension,
  SessionHarnessProtocol,
  SessionInstaller,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import { createApp } from "../react.js";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const result: LanguageModelExecutionResult = {
  specVersion: SPEC_VERSION,
  output: [{ type: "text", text: "ok" }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function fakeExecutor(): FakeLanguageModelExecutor {
  return new FakeLanguageModelExecutor(
    `fake-${generateId()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { scripted: Array.from({ length: 6 }, () => ({ result })), target },
  );
}

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "You are an agent.");

/** ADR 100 law 3 — a conversation (a fork included) has no row until it speaks. */
async function recordEarnedBySpeaking(session: SessionHarnessProtocol): Promise<void> {
  await (
    await session.send({ messages: [{ role: "user", content: "hi" }] })
  ).result;
}

describe("session-principal — inheritance + adopter seams (ADR 48)", () => {
  it("(part 2) spawn + fork children carry the parent's principal (harness + record)", async () => {
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: fakeExecutor(),
      target,
    });
    const parent = await app.createSession({ sessionId: "parent", principal: "owner-1" });
    expect(parent.principal).toBe("owner-1");

    const spawned = (await parent.spawn({})) as SessionHarnessProtocol;
    expect(spawned.principal).toBe("owner-1");
    expect((await app.getSessionRecord(spawned.id))?.principal).toBe("owner-1");

    // A fork is a conversation, so its record is earned by speaking (ADR 100
    // law 3) — the descent is on the harness from birth, and on the row it writes.
    const forked = await parent.fork();
    expect(forked.principal).toBe("owner-1");
    await recordEarnedBySpeaking(forked);
    expect((await app.getSessionRecord(forked.id))?.principal).toBe("owner-1");

    await app.closeApp();
  });

  it("(part 3) fork inherits the parent metadata bag; explicit wins; spawn does NOT inherit", async () => {
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: fakeExecutor(),
      target,
    });
    const parent = await app.createSession({
      sessionId: "p",
      principal: "o",
      metadata: { tenant: "acme" },
    });

    // fork, no metadata → inherits the parent's bag (a same-image copy).
    const forkInherit = await parent.fork();
    await recordEarnedBySpeaking(forkInherit);
    expect((await app.getSessionRecord(forkInherit.id))?.metadata?.tenant).toBe("acme");

    // fork with explicit metadata → the explicit bag wins.
    const forkExplicit = await parent.fork({ metadata: { tenant: "beta" } });
    await recordEarnedBySpeaking(forkExplicit);
    expect((await app.getSessionRecord(forkExplicit.id))?.metadata?.tenant).toBe("beta");

    // spawn → a NEW session; metadata is NOT auto-inherited.
    const spawned = (await parent.spawn({})) as SessionHarnessProtocol;
    expect((await app.getSessionRecord(spawned.id))?.metadata?.tenant).toBeUndefined();

    await app.closeApp();
  });

  it("(part 4) onSessionCreate reshape injects a metadata key into a spawned child", async () => {
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: fakeExecutor(),
      target,
    });
    // Selective spawn inheritance: reshape ONLY branched sessions.
    app.onSessionCreate((input: CreateSessionInput) => {
      if (input.from === undefined) return Promise.resolve();
      return Promise.resolve({ ...input, metadata: { ...input.metadata, injected: "yes" } });
    });

    const parent = await app.createSession({ sessionId: "root", principal: "o" });
    // Parent (no parent) was NOT reshaped.
    expect((await app.getSessionRecord("root"))?.metadata?.injected).toBeUndefined();

    const child = (await parent.spawn({})) as SessionHarnessProtocol;
    expect((await app.getSessionRecord(child.id))?.metadata?.injected).toBe("yes");

    await app.closeApp();
  });

  it("(part 4) onSessionCreate veto still refuses the session", async () => {
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: fakeExecutor(),
      target,
    });
    app.onSessionCreate(() => Promise.resolve({ kind: "veto", reason: "no new sessions" }));

    await expect(app.createSession({ sessionId: "denied" })).rejects.toThrow(/no new sessions/);

    await app.closeApp();
  });

  it("(part 5) SessionInstaller exposes the session's principal + metadata at install", async () => {
    let captured: { principal?: string; metadata?: Readonly<Record<string, unknown>> } | undefined;
    const ext: SessionExtension = {
      name: "read-identity-at-install",
      target: "session",
      install: (installer: SessionInstaller) => {
        captured = { principal: installer.principal, metadata: installer.metadata };
      },
    };

    const app = await createApp(React.createElement(Agent), {
      modelExecutor: fakeExecutor(),
      target,
      extensions: [ext],
    });

    await app.createSession({ sessionId: "s", principal: "inst-p", metadata: { region: "us" } });

    expect(captured).toBeDefined();
    expect(captured!.principal).toBe("inst-p");
    expect(captured!.metadata?.region).toBe("us");

    await app.closeApp();
  });
});

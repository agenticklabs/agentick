/**
 * `CreateSessionInput.initialProps` — one app-level root element,
 * per-session variation.
 *
 * The chain under test: app maps `initialProps` onto the session's opaque
 * `rootInput`, the session forwards it to `compiler.mount`, and the React
 * compiler cloneElement-merges it over the root element's own props
 * (initialProps win per key, baked props survive). Observed at the
 * adopter's entry point via `dryRun()` — the claim is about what the model
 * would be sent.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ExecutionTarget } from "@agentick/spec";

import { createApp, type CreateAppOptions } from "../react.js";

interface AgentProps {
  readonly persona?: string;
  readonly medium?: string;
}

function Agent({ persona = "unset-persona", medium = "unset-medium" }: AgentProps) {
  return React.createElement(
    "section" as never,
    { id: "system", audience: "model" },
    `persona=${persona} medium=${medium}`,
  );
}

const mkTarget = (): ExecutionTarget =>
  ({ kind: "language-model", provider: "fake", modelId: "m", capabilities: {} }) as ExecutionTarget;

async function mkApp(id: string, options: Partial<CreateAppOptions<AgentProps>> = {}) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor(id, journal, bus, inbox, {
    scripted: [{ kind: "text", text: "ok" }] as never,
  });
  await executor.ready;
  const app = await createApp(
    React.createElement(Agent, { persona: "baked-persona", medium: "web" }),
    { modelExecutor: executor, target: mkTarget(), journal, bus, inbox, ...options },
  );
  return app;
}

const systemText = async (session: { dryRun(): Promise<{ input?: unknown }> }): Promise<string> =>
  JSON.stringify((await session.dryRun()).input);

describe("createSession initialProps", () => {
  it("without initialProps the root renders its baked props", async () => {
    const app = await mkApp("props-baked");
    try {
      const session = await app.createSession({ sessionId: "props-baked" });
      const input = await systemText(session);
      expect(input).toContain("persona=baked-persona");
      expect(input).toContain("medium=web");
    } finally {
      await app.close();
    }
  });

  it("initialProps merge over baked props — supplied keys win, others survive", async () => {
    const app = await mkApp("props-merge");
    try {
      const session = await app.createSession({
        sessionId: "props-merge",
        initialProps: { medium: "sms" },
      });
      const input = await systemText(session);
      expect(input).toContain("medium=sms");
      expect(input).toContain("persona=baked-persona");
    } finally {
      await app.close();
    }
  });

  it("app-level initialProps default applies when the session supplies none", async () => {
    const app = await mkApp("props-default", { initialProps: { medium: "voice" } });
    try {
      const defaulted = await app.createSession({ sessionId: "props-default-a" });
      expect(await systemText(defaulted)).toContain("medium=voice");

      // Per-session wins over the app default.
      const overridden = await app.createSession({
        sessionId: "props-default-b",
        initialProps: { medium: "sms" },
      });
      expect(await systemText(overridden)).toContain("medium=sms");
    } finally {
      await app.close();
    }
  });

  it("sibling sessions with different initialProps do not bleed", async () => {
    const app = await mkApp("props-iso");
    try {
      const sms = await app.createSession({
        sessionId: "props-iso-sms",
        initialProps: { medium: "sms" },
      });
      const web = await app.createSession({ sessionId: "props-iso-web" });
      expect(await systemText(sms)).toContain("medium=sms");
      expect(await systemText(web)).toContain("medium=web");
    } finally {
      await app.close();
    }
  });
});

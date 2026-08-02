/**
 * ADR 94's headline consequence, at the altitude an adopter experiences it:
 * a `<Section>` written BELOW `<Timeline />` is the LAST message the model
 * receives.
 *
 * That sentence used to be false. `buildMessages` filtered every section
 * entry — wherever it sat — into one leading `role: "system"` message, so a
 * section placed after the conversation was silently hoisted to the top of
 * the system prompt. Rendered JSX did not equal compiled model input, in the
 * one framework whose pitch is that the tree IS the context surface.
 *
 * `@agentick/app` is the only home where the real React compiler, the real
 * timeline, the canonical projection and a real loop run all coexist (the
 * ADR-27 rule: cross-harness tests live where their dependencies live), so
 * this asserts against what the EXECUTOR was handed, not against an IR.
 *
 * @see docs/proposals/v2/blueprint/94-positional-sections.md
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { Grounding, Section, System } from "@agentick/compiler-react";
import { Timeline } from "@agentick/timeline/react";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import type {
  ExecutionTarget,
  ExecutorFx,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelMessage,
  ProjectInput,
  RunInput,
} from "@agentick/spec";

import { createApp } from "../react.js";

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

/** Records the canonical `LanguageModelInput` the loop projected each tick. */
class RecordingExecutor extends FakeLanguageModelExecutor {
  readonly inputs: LanguageModelInput[] = [];

  override get fx(): ExecutorFx<LanguageModelInput, unknown, LanguageModelExecutionResult> {
    const base = super.fx;
    const inputs = this.inputs;
    const grab = (input: ProjectInput | RunInput): void => {
      inputs.push(
        this.project({
          compiled: input.compiled,
          target: input.target,
          tools: input.tools,
        }) as unknown as LanguageModelInput,
      );
    };
    return {
      ...base,
      project: (input) => {
        grab(input);
        return base.project(input);
      },
      run: (input) => {
        grab(input);
        return base.run(input);
      },
    };
  }
}

const textOf = (m: LanguageModelMessage): string =>
  m.content.map((p) => (p.type === "text" ? p.text : "")).join("");

async function runOnce(element: React.ReactElement): Promise<LanguageModelInput> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new RecordingExecutor("pos-exec", journal, bus, inbox);
  await executor.ready;

  const app = await createApp(element, {
    modelExecutor: executor,
    target: mkTarget(),
    journal,
    bus,
    inbox,
  });
  const session = await app.createSession({ sessionId: "pos" });
  const handle = await session.send({ messages: [{ role: "user", content: "hello" }] });
  await handle.result;
  const input = executor.inputs[0];
  if (input === undefined) throw new Error("executor was never handed an input");
  return input;
}

describe("a section below <Timeline /> is the last message the model receives", () => {
  it("arrives after the conversation, not hoisted into the system prompt", async () => {
    const input = await runOnce(
      <>
        <System>You are a helpful assistant.</System>
        <Timeline />
        <Section title="Current User">Ryan, on the billing page.</Section>
      </>,
    );

    const last = input.messages[input.messages.length - 1]!;
    expect(textOf(last)).toBe("# Current User\nRyan, on the billing page.");
    // The role the anonymous box gets: not `user` (it is not something the
    // human typed) and not `system` (it is not an instruction).
    expect(last.role).toBe("grounding");

    // The user's own turn is still IN the conversation, before it.
    const roles = input.messages.map((m) => m.role);
    expect(roles.indexOf("user")).toBeLessThan(roles.length - 1);

    // And the system prompt is exactly what `<System>` contained — the
    // section is nowhere in it. This is the assertion that would have failed
    // before ADR 94.
    const system = input.messages.find((m) => m.role === "system");
    expect(textOf(system!)).toBe("You are a helpful assistant.");
    expect(textOf(system!)).not.toContain("Current User");
  });

  it("puts a section ABOVE <Timeline /> before the conversation", async () => {
    // The other half of "position decides order" — the same construct, moved.
    const input = await runOnce(
      <>
        <System>You are a helpful assistant.</System>
        <Section title="Current User">Ryan</Section>
        <Timeline />
      </>,
    );
    const roles = input.messages.map((m) => m.role);
    expect(roles.indexOf("grounding")).toBeLessThan(roles.indexOf("user"));
  });

  it("puts a section INSIDE <System> into the system prompt", async () => {
    // The migration path the compiler diagnostic names, end to end.
    const input = await runOnce(
      <>
        <System>
          You are a helpful assistant.
          <Section title="House rules">Be concise.</Section>
        </System>
        <Timeline />
      </>,
    );
    const system = input.messages.find((m) => m.role === "system");
    expect(textOf(system!)).toContain("# House rules\nBe concise.");
    expect(input.messages.some((m) => m.role === "grounding")).toBe(false);
  });

  it("treats <Grounding> below the timeline the same way", async () => {
    const input = await runOnce(
      <>
        <System>You are a helpful assistant.</System>
        <Timeline />
        <Grounding title="Current User">Ryan</Grounding>
      </>,
    );
    const last = input.messages[input.messages.length - 1]!;
    expect(last.role).toBe("grounding");
    expect(textOf(last)).toBe("# Current User\nRyan");
  });
});

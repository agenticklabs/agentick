/**
 * `reactCompiler` — the `CompilerFactory` form of the React reference compiler.
 *
 * `CompilerFactory` declares `(deps?: CompilerFactoryDeps)`: a parent harness
 * passes its substrate so the compiler's events flow on the shared bus/journal,
 * and a STANDALONE caller (a test, a REPL, an adopter probing a tree before
 * wiring an app) calls it bare and gets a private local substrate. Both halves
 * are pinned here — the optional parameter is only real if the shipped
 * reference factory honors it.
 */

import { describe, expect, it } from "vitest";
import React from "react";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { fakeBridges } from "@agentick/compiler";
import { isCompilerFactory, type ProtocolEvent } from "@agentick/spec";

import { reactCompiler } from "../factory.js";

const Agent = () =>
  React.createElement(
    React.Fragment,
    null,
    React.createElement("message", { role: "system" }, "hi"),
  );

async function mount(compiler: ReturnType<ReturnType<typeof reactCompiler>>, mountId: string) {
  await compiler.mount({
    mountId,
    sessionId: "s",
    element: React.createElement(Agent),
    bridges: fakeBridges({ sessionId: "s" }),
    defaultFormatter: { id: "markdown", format: "markdown" },
  });
}

describe("reactCompiler", () => {
  it("carries the factory marker", () => {
    expect(isCompilerFactory(reactCompiler())).toBe(true);
  });

  it("uses the SUPPLIED substrate when a parent harness passes deps", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const compiler = reactCompiler()({
      scopeId: "shared-1",
      journal,
      bus,
      inbox: new LocalInbox(),
    });
    const events: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(bus.subscribe({ surface: "compiler" }), (e) =>
        Effect.sync(() => {
          events.push(e);
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));

    await mount(compiler, "m_shared");
    await new Promise((r) => setTimeout(r, 20));
    await Effect.runPromise(Fiber.interrupt(fiber));

    // The point of the deps form: the compiler's envelopes land on the
    // PARENT's bus, not a private one.
    expect(events.some((e) => e.name === "compiler:command:mount")).toBe(true);
  });

  it("constructs with NO deps — the local-substrate fallback works end to end", async () => {
    const compiler = reactCompiler()();
    await mount(compiler, "m_bare");
    const rendered = await compiler.renderTree({ mountId: "m_bare", sessionId: "s" });
    expect(rendered.tree).toBeDefined();
    await compiler.unmount({ mountId: "m_bare" });
  });

  it("mints a distinct scope per dep-less call (no cross-instance collision)", async () => {
    const factory = reactCompiler();
    const a = factory();
    const b = factory();
    expect(a).not.toBe(b);
    // Same mountId in both is fine precisely because the substrates are private.
    await mount(a, "m_same");
    await mount(b, "m_same");
    await expect(a.renderTree({ mountId: "m_same", sessionId: "s" })).resolves.toBeDefined();
    await expect(b.renderTree({ mountId: "m_same", sessionId: "s" })).resolves.toBeDefined();
  });
});

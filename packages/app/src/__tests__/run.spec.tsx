/**
 * `run()` one-shot execution (#171) — temporary app + session, single
 * send, auto-teardown, v1 handle ergonomics (await / .result /
 * for-await).
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { scriptedAdapter } from "@agentick/model/testing";

import { run } from "../react.js";

function MinimalAgent() {
  return React.createElement("message" as never, { role: "user" }, "ping");
}

describe("run() — one-shot execution", () => {
  it("`await run(...).result` resolves the SendResult (v1 unwrap ergonomic)", async () => {
    const result = await run(React.createElement(MinimalAgent), {
      model: scriptedAdapter("pong from run"),
      messages: [{ role: "user", content: "hi" }],
    }).result;
    expect(result.response).toContain("pong from run");
  });

  it("awaiting the handle then iterating streams events before result", async () => {
    const handle = await run(React.createElement(MinimalAgent), {
      model: scriptedAdapter("streamed pong"),
      messages: [{ role: "user", content: "hi" }],
    });
    const types: string[] = [];
    for await (const event of handle.events()) types.push(event.type);
    expect(types.length).toBeGreaterThan(0);
    const result = await handle.result;
    expect(result.response).toContain("streamed pong");
  });

  it("`.events()` directly on the run handle works (no intermediate await)", async () => {
    const handle = run(React.createElement(MinimalAgent), {
      model: scriptedAdapter("direct iteration"),
      messages: [{ role: "user", content: "hi" }],
    });
    const types: string[] = [];
    for await (const event of handle.events()) types.push(event.type);
    expect(types.length).toBeGreaterThan(0);
    expect((await handle.result).response).toContain("direct iteration");
  });

  it("construction failure rejects the handle without leaking an unhandled rejection", async () => {
    // A bare adapter on the `modelExecutor` slot trips the app slot guard at
    // construction. (A model-less app is now LEGAL — the removed "model is
    // required" guard no longer fires; see the model-less send test below.)
    await expect(
      run(React.createElement(MinimalAgent), {
        modelExecutor: scriptedAdapter("wrong slot") as never,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/goes on the `model` slot/);
  });

  it("a model-less run() constructs, but the send fails with NoModelForExecutionError", async () => {
    // The model requirement is enforced at execution time. A model-less
    // one-shot run constructs its temporary app + session fine; the single
    // send resolves no effective model (no default, no per-send override, no
    // per-tick <Model>) and fails with the typed error naming how to supply one.
    await expect(
      run(React.createElement(MinimalAgent), {
        messages: [{ role: "user", content: "hi" }],
      }).result,
    ).rejects.toMatchObject({ _tag: "NoModelForExecutionError" });
  });

  it("runs back-to-back — each invocation owns and tears down its app", async () => {
    const first = await run(React.createElement(MinimalAgent), {
      model: scriptedAdapter("first"),
      messages: [{ role: "user", content: "1" }],
    }).result;
    const second = await run(React.createElement(MinimalAgent), {
      model: scriptedAdapter("second"),
      messages: [{ role: "user", content: "2" }],
    }).result;
    expect(first.response).toContain("first");
    expect(second.response).toContain("second");
  });
});

describe("run({ history }) — timeline seeding (#187)", () => {
  const history = [
    {
      kind: "message",
      message: {
        id: "h1",
        role: "user",
        content: [{ type: "text", text: "REMEMBER: heliotrope" }],
        ts: 0,
      },
    },
  ] as never[];

  it("run({ history }) executes cleanly over a seeded timeline", async () => {
    const result = await run(React.createElement(MinimalAgent), {
      model: scriptedAdapter("ok"),
      history,
      messages: [{ role: "user", content: "hi" }],
    }).result;
    expect(result.response).toContain("ok");
  });

  it("the seeding mechanism: a pre-populated store + sessionId hydrates the persisted timeline", async () => {
    // The exact wiring run() performs, asserted at the session surface
    // (run() itself tears the app down before the session is reachable).
    const { MemoryTimelineStore } = await import("@agentick/timeline");
    const { createApp } = await import("../react.js");
    const store = new MemoryTimelineStore();
    await store.append("seeded-session:timeline", history, { sessionId: "seeded-session" });
    const app = await createApp(React.createElement(MinimalAgent), {
      model: scriptedAdapter("ok"),
      timeline: { store },
    });
    const session = await app.createSession({ sessionId: "seeded-session" });
    await (session as unknown as { mountReady?: Promise<void> }).mountReady;
    const persisted = session.timeline.read().entries as readonly {
      message?: { id?: string };
    }[];
    expect(persisted.map((e) => e.message?.id)).toEqual(["h1"]);
    await app.closeApp();
  });
});

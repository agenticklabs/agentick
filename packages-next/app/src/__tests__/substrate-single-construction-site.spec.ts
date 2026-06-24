/**
 * Substrate-primitive harness single-construction-site (#159).
 *
 * The AppHarness is the SINGLE construction site for the per-session
 * `ElicitationHarness` and `TasksHarness`. `withTasks()` and
 * `withElicitation()` must NOT construct their own — doing so collides
 * on the inbox address (`tasks:${sessionId}:tasks`,
 * `elicitation:${sessionId}:elicitation`) and forks the registry that
 * `bridges.*` vs `ctx.*` vs `session.*` resolve to.
 *
 * This spec pins the contract from three angles:
 *
 *   1. Installing both extensions does NOT throw — addresses are
 *      registered exactly once on the substrate inbox.
 *   2. `installer.tasks` / `installer.elicitation` are the SAME
 *      instances `session.tasks` / `session.elicitation` expose. The
 *      `SessionInstaller` surface and the `SessionHarnessProtocol`
 *      surface agree on identity.
 *   3. The `session_tasks_*` model-facing tools `withTasks()`
 *      auto-registers reach the SAME tasks instance via `ctx.tasks`
 *      at dispatch time — proving `bridges.tasks` (overlaid via
 *      buildSessionBridges) and `ctx.tasks` (threaded through
 *      `ToolExecutor`) point at one harness.
 *
 * Background: before this fix, `withTasks()` and `withElicitation()`
 * both ran `new TasksHarness(...)` / `new ElicitationHarness(...)`
 * against the substrate, AND the AppHarness ALSO constructed both
 * per session. The first construction won the inbox address; the
 * second silently failed to register (or threw, depending on inbox
 * impl). `bridges.*` then pointed at the extension's instance via
 * `installer.registerNamespace(...)` while `ctx.*` and `session.*`
 * pointed at the AppHarness's instance. Disaster waiting to happen
 * for adopters running the documented `extensions: [withTasks(),
 * withElicitation()]` usage.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { withElicitation } from "@agentick/elicitation-next";
import { withTasks } from "@agentick/tasks-next";
import type { ContentBlock, SessionExtension, SessionInstaller } from "@agentick/spec-next";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    "single-site-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: Array.from({ length: 10 }, () => ({
        result: {
          specVersion: "2026-05-08" as const,
          output: [{ type: "text" as const, text: "ok" } satisfies ContentBlock],
          stopReason: "end" as const,
        },
      })),
    },
  );
  await exec.ready;
  return exec;
}

describe("#159 substrate primitives — single construction site", () => {
  it("installing both withTasks() and withElicitation() does NOT throw on the inbox address", async () => {
    // Before #159 this combination would either throw at the second
    // inbox.register() or silently fork the registry.
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      extensions: [withTasks(), withElicitation()],
    });

    const session = await app.createSession({ sessionId: "s-no-collision" });

    // Both harnesses ready and reachable from the session's documented
    // accessors.
    expect(typeof session.tasks.submit).toBe("function");
    expect(typeof session.elicitation.elicit).toBe("function");

    await session.close();
    await app.close();
  });

  it("installer.tasks / installer.elicitation are the SAME instances session.tasks / session.elicitation expose", async () => {
    // Capture what the installer sees mid-install, then check that
    // `session.*` and `installer.*` are reference-equal — the
    // single-construction-site invariant.
    let captured: { tasks: unknown; elicitation: unknown; sessionId: string } | undefined;
    const capture: SessionExtension = {
      name: "capture-installer",
      target: "session",
      install: (installer: SessionInstaller) => {
        captured = {
          tasks: installer.tasks,
          elicitation: installer.elicitation,
          sessionId: installer.sessionId,
        };
      },
    };

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      // Order matters: withTasks/withElicitation MUST NOT register a
      // different namespace before `capture` runs. Place `capture`
      // first so we see installer.* in pristine form, then let
      // withTasks/withElicitation run after.
      extensions: [capture, withTasks(), withElicitation()],
    });
    const session = await app.createSession({ sessionId: "s-identity" });

    expect(captured).toBeDefined();
    expect(captured!.sessionId).toBe("s-identity");
    // Identity invariant: the installer slot and the session-facing
    // accessor return the EXACT same JS reference.
    expect(session.tasks).toBe(captured!.tasks);
    expect(session.elicitation).toBe(captured!.elicitation);

    await session.close();
    await app.close();
  });

  it("session_tasks_* model tools reach the same harness via ctx.tasks (dispatch round-trip)", async () => {
    // `withTasks()` auto-registers four model-facing tools whose
    // handlers read `ctx.tasks` at call time. If `bridges.tasks` and
    // `ctx.tasks` ever pointed at different instances, this dispatch
    // would either fail or return data from a phantom registry.
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      extensions: [withTasks(), withElicitation()],
    });
    const session = await app.createSession({ sessionId: "s-dispatch" });

    // Submit a task directly on the session's tasks harness (the one
    // bridges.tasks exposes per #159). The work intentionally blocks
    // on a pending promise so the task stays `working` until we cancel
    // — list() must include the in-flight id.
    const blockForever = new Promise<readonly ContentBlock[]>(() => {
      // never resolves; we cancel it below
    });
    const handle = session.tasks.submit<readonly ContentBlock[]>(() => blockForever);
    // Drain the typed rejection that fires when we cancel below —
    // otherwise vitest reports it as an unhandled rejection. The
    // handle's `.result` is documented to reject with `TaskRejection`
    // on cancel.
    handle.result.catch(() => undefined);

    // Dispatch `session_tasks_list` — the handler reads ctx.tasks
    // (which the ToolExecutor was wired with). If ctx.tasks !==
    // session.tasks, the submitted task would be invisible.
    const result = await session.dispatch("session_tasks_list", {});
    const text = result.map((b: ContentBlock) => (b.type === "text" ? b.text : "")).join("");
    // The handler returns a JSON payload listing tasks. The exact
    // shape lives in `@agentick/tasks-next/tools`; we only assert
    // that the submitted taskId is reachable through it.
    expect(text).toContain(handle.taskId);

    // Clean up the in-flight task before closing the session.
    await session.tasks.cancel(handle.taskId, "test cleanup");

    await session.close();
    await app.close();
  });
});

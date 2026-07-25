/**
 * The client half — the star of this example.
 *
 * Everything a frontend needs comes from ONE import: `@agentick/client`,
 * the batteries-included bundle. Importing it lights up every built-in session
 * sub-handle (`session.knobs` / `session.tasks` / `session.elicitations`)
 * with no per-harness imports — that's the ADR 87 seam + the core/bundle split.
 *
 * This module wires an in-process transport to the gateway, then drives one
 * coding session while exercising the full client surface:
 *
 *   - `onLog`               — the agent's `ctx.log(...)` diagnostics
 *   - `session.knobs`       — live read + a CLIENT-driven write (CQRS)
 *   - `session.tasks`       — live task-status view (run_shell submits tasks)
 *   - `session.elicitations`— human-in-the-loop approvals for write_file
 *   - `handle.events()`     — the streamed token/tool output of the run
 */

import { createClient, type Client } from "@agentick/client";
import { inProcessTransport } from "@agentick/transport-in-process";
import type { GatewayHarnessProtocol, SendResult } from "@agentick/spec";

/**
 * Connect a client to an in-process gateway. `inProcessTransport({ gateway })`
 * builds the dispatch wiring internally. Swap it for `webSocketTransport(url)`
 * and this is a remote client, unchanged.
 */
export async function connectClient(gateway: GatewayHarnessProtocol): Promise<Client> {
  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();
  return client;
}

/**
 * Run one coding request end-to-end, wiring up every ergonomic. Returns the
 * final `SendResult`.
 */
export async function runCodingSession(
  client: Client,
  appId: string,
  prompt: string,
): Promise<SendResult> {
  // Create the session server-side, over the wire.
  const sessionId = "coding-session";
  await client.app(appId).createSession({ sessionId });
  const session = client.session(sessionId);

  // ── 1. onLog — the agent's ctx.log(...) diagnostics stream here ──────────
  const offLog = session.onLog((e) => {
    console.log(`   · log[${e.level}] ${JSON.stringify(e.data)}`);
  });

  // ── 2. session.knobs — the store contract (subscribe) + a client write ───
  // The ClientHandle contract: `subscribe(cb)` fires on change (cb takes NO
  // args); read the current descriptors+values via `list()`. Then FLIP a knob —
  // fire-and-observe: the write returns as a channel delta that re-folds the
  // view (CQRS) and the agent re-renders.
  session.knobs.subscribe(() =>
    console.log(`   · knobs ${JSON.stringify(session.knobs.list().map((k) => [k.id, k.value]))}`),
  );
  await session.knobs.set("explainSteps", true);

  // ── 3. session.tasks — the store contract: re-read list() on change ──────
  // `subscribe(cb)` fires on every transition; `list()` is the current task set
  // (Enumerable — includes tasks pending before we connected).
  session.tasks.subscribe(() => {
    for (const t of session.tasks.list()) {
      console.log(`   · task[${t.status}] ${t.statusMessage ?? t.taskId}`);
    }
  });

  // ── 4. session.elicitations — approve write_file, human-in-the-loop ───────
  // write_file calls ctx.elicit.confirm(...) server-side; the request lands in
  // `list()` (snapshot-first — a mid-ask connect sees it). `subscribe` fires on
  // change; we approve each pending ask once. Answering drops it from list().
  const approved = new Set<string>();
  const stopElicit = session.elicitations.subscribe(() => {
    for (const e of session.elicitations.list()) {
      if (approved.has(e.correlationId)) continue;
      approved.add(e.correlationId);
      console.log(`   · elicit "${e.message}" → approve`);
      void e.accept(true);
    }
  });

  // ── 5. Send the coding request and STREAM the run ────────────────────────
  console.log(`\n→ user: ${prompt}\n`);
  const handle = session.send({ messages: [{ role: "user", content: prompt }] });

  process.stdout.write("← agent: ");
  for await (const ev of handle.events()) {
    if (ev.type === "content-delta") {
      process.stdout.write(ev.delta);
    } else if (ev.type === "tool-dispatch-start") {
      process.stdout.write(`\n   ⚙ ${ev.name}(…)\n           `);
    }
  }

  const result = (await handle.result) as SendResult;
  console.log(
    `\n\n[${result.ticks} tick(s), ${result.usage.totalTokens} tokens, stop=${result.stopReason}]`,
  );

  // ── Cleanup ──────────────────────────────────────────────────────────────
  offLog();
  stopElicit();
  session.knobs.close();
  session.tasks.close();

  return result;
}

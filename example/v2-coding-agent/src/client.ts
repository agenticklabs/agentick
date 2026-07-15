/**
 * The client half — the star of this example.
 *
 * Everything a frontend needs comes from ONE import: `@agentick/client-next`,
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

import { createClient, type Client } from "@agentick/client-next";
import { inProcessTransport } from "@agentick/transport-in-process-next";
import type { GatewayHarnessProtocol, SendResult } from "@agentick/spec-next";

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

  // ── 2. session.knobs — STATE feed (subscribe) + a client-driven write ────
  // We want the whole knob store to display → `subscribe` hands you the folded
  // STATE. Then FLIP a knob — fire-and-observe: the write returns as a channel
  // delta that re-folds the view (CQRS) and the agent re-renders.
  session.knobs.subscribe((knobs) => console.log(`   · knobs ${JSON.stringify(knobs)}`));
  await session.knobs.set("explainSteps", true);

  // ── 3. session.tasks — CHANGE feed (onChange): the task that transitioned ─
  // `onChange` hands you the FRAME — the one task that changed — not the whole
  // map, so no dedup bookkeeping. (For the full list, use `.subscribe(map =>…)`.)
  session.tasks.onChange((frame) => {
    if ("kind" in frame) return; // skip the opening snapshot; deltas are TaskInfo
    console.log(`   · task[${frame.status}] ${frame.statusMessage ?? frame.taskId}`);
  });

  // ── 4. session.elicitations.onChange — approve write_file, human-in-the-loop ──────────
  // write_file calls ctx.elicit.confirm(...) server-side; the request arrives
  // here. `.onChange` runs the callback per request (stream handled under the
  // hood) — mirrors onLog/onProgress. We auto-approve; a real UI would prompt.
  const stopElicit = session.elicitations.onChange((e) => {
    console.log(`   · elicit "${e.message}" → approve`);
    void e.accept(true);
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

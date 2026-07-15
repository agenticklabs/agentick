/**
 * The client half — the star of this example.
 *
 * Everything a frontend needs comes from ONE import: `@agentick/client-next`,
 * the batteries-included bundle. Importing it lights up every built-in session
 * sub-handle (`session.knobs` / `session.tasks` / `session.elicitations()`)
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
import { dispatchRequest, type DispatchSink } from "@agentick/transport-next";
import type { GatewayHarnessProtocol, JsonRpcRequest, SendResult } from "@agentick/spec-next";

/**
 * Connect a client to an in-process gateway. Each RPC gets a FRESH
 * `DispatchSink` whose `sendNotification` is that frame's notification route —
 * a shared forwarder would drop subscription events. Swap `inProcessTransport`
 * for `webSocketTransport(url)` and this is a remote client, unchanged.
 */
export async function connectClient(gateway: GatewayHarnessProtocol): Promise<Client> {
  const transport = inProcessTransport({
    handler: async (req: JsonRpcRequest, sendNotification) => {
      const sink: DispatchSink = {
        sendNotification,
        registerSubscription: () => {},
        unregisterSubscription: () => {},
        registerInFlight: () => {},
        unregisterInFlight: () => {},
      };
      return dispatchRequest(gateway, req, sink);
    },
  });

  const client = await createClient({ transport });
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

  // ── 2. session.knobs — live view + a client-driven write ─────────────────
  // The bundle attached `.knobs` (a KnobsHandleView). Subscribe to the live
  // fold, then FLIP a knob from the client. The write is fire-and-observe: it
  // returns as a channel delta that re-folds the view (CQRS), and the server
  // agent re-renders with the new prompt.
  session.knobs.subscribe(() => {
    console.log(`   · knobs ${JSON.stringify(session.knobs.get())}`);
  });
  await session.knobs.set("explainSteps", true);

  // ── 3. session.tasks — live task-status view (run_shell submits tasks) ───
  const seenTasks = new Set<string>();
  session.tasks.subscribe(() => {
    for (const t of Object.values(session.tasks.get())) {
      const key = `${t.taskId}:${t.status}`;
      if (seenTasks.has(key)) continue;
      seenTasks.add(key);
      console.log(`   · task[${t.status}] ${t.statusMessage ?? t.taskId}`);
    }
  });

  // ── 4. session.elicitations() — approve write_file, human-in-the-loop ────
  // write_file calls ctx.elicit.confirm(...) server-side; the request arrives
  // here. We auto-approve; a real UI would prompt the user. Runs in the
  // background for the life of the session.
  const elicitations = session.elicitations();
  const approver = (async () => {
    for await (const e of elicitations) {
      console.log(`   · elicit "${e.message}" → approve`);
      await e.accept(true);
    }
  })();

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
  await elicitations.close();
  await approver.catch(() => undefined);
  session.knobs.close();
  session.tasks.close();

  return result;
}

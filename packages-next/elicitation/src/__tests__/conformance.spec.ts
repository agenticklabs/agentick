/**
 * Run the published `ElicitationHarnessProtocol` conformance suite
 * against the in-package `ElicitationHarness` implementation.
 *
 * The shell factory wires the harness to a `MemoryJournal +
 * LocalEventBus + LocalInbox` substrate and exposes
 * `nextCorrelationId()` via a `Stream.take` subscription on the bus.
 *
 * `close()` is idempotent — the suite's `close()` may run after a
 * specific test (e.g., the "close() cancels pending" case) has
 * already closed the harness.
 */

import { Chunk, Effect, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ProtocolEvent } from "@agentick/spec-next";

import { ELICITATION_CHANNEL_FQN } from "../channel.js";
import { ElicitationHarness } from "../harness.js";
import {
  runElicitationHarnessConformance,
  type ElicitationConformanceShell,
} from "../conformance.js";

type EnvelopeWithMetadata = ProtocolEvent & {
  readonly metadata?: Readonly<Record<string, unknown>>;
};

runElicitationHarnessConformance(async ({ harnessId }) => {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new ElicitationHarness(harnessId, journal, bus, inbox);
  await harness.ready;

  const nextEnv = (): Promise<EnvelopeWithMetadata> =>
    Effect.runPromise(
      Stream.runCollect(
        Stream.take(
          bus.subscribe({
            surface: "session",
            name: { exact: ELICITATION_CHANNEL_FQN },
          }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
          1,
        ),
      ),
    ).then((chunk) => Array.from(Chunk.toReadonlyArray(chunk))[0]!);

  let closed = false;
  const shell: ElicitationConformanceShell = {
    harness,
    nextCorrelationId: () =>
      nextEnv().then((env) => {
        const id = env.metadata?.correlationId;
        if (typeof id !== "string") {
          throw new Error("expected correlationId on elicitation request envelope");
        }
        return id;
      }),
    nextEnvelope: () => nextEnv(),
    close: async () => {
      if (closed) return;
      closed = true;
      await harness.close();
    },
  };
  return shell;
});

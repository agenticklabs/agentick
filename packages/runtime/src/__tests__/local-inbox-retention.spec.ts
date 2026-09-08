/**
 * The idempotency cache remembers OUTCOMES, not fibers.
 *
 * A settled handler's FiberRuntime retains its context and span, and through
 * Effect's span stack trace the frames that built the message — for a
 * `compiler:mount` that is the whole session. With a 10,000-entry cache that
 * was the production heap leak. Entries keep the Exit and drop the fiber the
 * moment it settles; expired entries are swept on insert rather than waiting
 * for a lookup of their own id that never comes.
 */

import { describe, expect, it } from "vitest";
import { Deferred, Effect } from "effect";

import { LocalInbox } from "../substrate/local-inbox.js";

const msg = (type: string, messageId: string, payload?: unknown) => ({ type, messageId, payload });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("LocalInbox — idempotency retention", () => {
  it("drops the handler fiber once it settles and still replays the result", async () => {
    const inbox = new LocalInbox();
    let runs = 0;
    await Effect.runPromise(
      inbox.register("echo:1", (m) =>
        Effect.sync(() => {
          runs += 1;
          return `ran:${String((m.payload as { n: number }).n)}`;
        }),
      ),
    );

    const first = await Effect.runPromise(inbox.ask("echo:1", msg("echo", "m_1", { n: 7 })));
    await tick();
    expect(inbox.idempotencyStats()).toEqual({ entries: 1, inFlight: 0 });

    const replayed = await Effect.runPromise(inbox.ask("echo:1", msg("echo", "m_1", { n: 99 })));
    expect(first).toBe("ran:7");
    expect(replayed).toBe("ran:7");
    expect(runs).toBe(1);
    inbox.close();
  });

  it("keeps the fiber only while the handler is still running", async () => {
    const inbox = new LocalInbox();
    const gate = await Effect.runPromise(Deferred.make<void>());
    await Effect.runPromise(inbox.register("slow:1", () => Deferred.await(gate)));

    await Effect.runPromise(inbox.send("slow:1", msg("go", "m_slow")));
    expect(inbox.idempotencyStats()).toEqual({ entries: 1, inFlight: 1 });

    await Effect.runPromise(Deferred.succeed(gate, undefined));
    await tick();
    expect(inbox.idempotencyStats()).toEqual({ entries: 1, inFlight: 0 });
    inbox.close();
  });

  it("replays a failure as the same failure after the fiber is gone", async () => {
    const inbox = new LocalInbox();
    await Effect.runPromise(
      inbox.register("boom:1", () =>
        Effect.fail({ _tag: "HandlerError", message: "nope" } as never),
      ),
    );
    const a = await Effect.runPromiseExit(inbox.ask("boom:1", msg("x", "m_boom")));
    await tick();
    const b = await Effect.runPromiseExit(inbox.ask("boom:1", msg("x", "m_boom")));
    expect(a._tag).toBe("Failure");
    expect(b).toEqual(a);
    inbox.close();
  });

  it("sweeps expired entries on insert, not only on their own lookup", async () => {
    const inbox = new LocalInbox({ idempotencyTtlMs: 1 });
    await Effect.runPromise(inbox.register("echo:1", () => Effect.succeed("ok")));
    for (let i = 0; i < 5; i++) await Effect.runPromise(inbox.send("echo:1", msg("e", `m_${i}`)));
    await new Promise<void>((r) => setTimeout(r, 5));
    await Effect.runPromise(inbox.send("echo:1", msg("e", "m_fresh")));
    expect(inbox.idempotencyStats().entries).toBe(1);
    inbox.close();
  });
});

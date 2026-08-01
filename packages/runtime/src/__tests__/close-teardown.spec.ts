/**
 * `BaseHarness.close` — the teardown contract.
 *
 * Detaching from the inbox is what releases `address` for the next harness to
 * claim it. Every concrete harness used to reach that detach only at the END of
 * its own failable work (`await super.close()` as the last line of an
 * overridden `close()`), so a single rejection anywhere in that prelude skipped
 * it and the address stayed claimed for the life of the process. The next
 * harness at the same address then failed to register with `RoutingFailed:
 * address already registered: …` — an error about the wrong thing, and
 * permanent, because nothing retried into a clean slot.
 *
 * `close()` now owns the ordering: run the subclass's {@link teardown}, then
 * detach, then unwind `onClose` LIFO — every step isolated from the ones after
 * it, and the teardown failure re-thrown at the end rather than swallowed.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { MessageEnvelope, MessageHandlerError, MessageInbox } from "@agentick/spec";

import { BaseHarness } from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";

class TeardownHarness extends BaseHarness<"tool"> {
  teardownRuns = 0;

  constructor(
    scopeId: string,
    inbox: MessageInbox,
    private readonly onTeardown?: () => void | Promise<void>,
  ) {
    super("tool", scopeId, new MemoryJournal(), new LocalEventBus(), inbox);
  }

  protected override async teardown(): Promise<void> {
    this.teardownRuns += 1;
    await this.onTeardown?.();
  }

  protected handleMessage(
    _msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.succeed(undefined);
  }
}

/** True when `address` is FREE — nothing is registered on it. */
async function addressFree(inbox: MessageInbox, address: string): Promise<boolean> {
  const probe = await Effect.runPromise(
    Effect.either(inbox.register(address, () => Effect.succeed(undefined))),
  );
  if (probe._tag === "Right") {
    probe.right();
    return true;
  }
  return false;
}

const boom = () => {
  throw new Error("teardown blew up");
};

describe("BaseHarness.close — a failing teardown does not skip the unwind", () => {
  it("detaches from the inbox anyway", async () => {
    const inbox = new LocalInbox();
    const harness = new TeardownHarness("s1", inbox, boom);
    await harness.ready;
    expect(await addressFree(inbox, "tool:s1")).toBe(false);

    await expect(harness.close()).rejects.toThrow(/teardown blew up/);

    expect(await addressFree(inbox, "tool:s1")).toBe(true);
  });

  it("still fires every onClose handler, LIFO", async () => {
    const order: string[] = [];
    const harness = new TeardownHarness("s2", new LocalInbox(), boom);
    await harness.ready;
    harness.onClose(() => void order.push("first"));
    harness.onClose(() => void order.push("second"));

    await expect(harness.close()).rejects.toThrow(/teardown blew up/);

    expect(order).toEqual(["second", "first"]);
  });

  it("re-throws the teardown failure rather than swallowing it", async () => {
    const harness = new TeardownHarness("s3", new LocalInbox(), () =>
      Promise.reject(new Error("async teardown blew up")),
    );
    await harness.ready;

    await expect(harness.close()).rejects.toThrow(/async teardown blew up/);
  });

  it("one throwing onClose handler does not block the rest", async () => {
    const ran: string[] = [];
    const harness = new TeardownHarness("s4", new LocalInbox());
    await harness.ready;
    harness.onClose(() => void ran.push("outer"));
    harness.onClose(() => {
      throw new Error("handler blew up");
    });

    await harness.close();

    expect(ran).toEqual(["outer"]);
  });
});

describe("BaseHarness.close — idempotence and the construction race", () => {
  it("runs teardown exactly once across repeated closes", async () => {
    const harness = new TeardownHarness("s5", new LocalInbox());
    await harness.ready;

    await harness.close();
    await harness.close();

    expect(harness.teardownRuns).toBe(1);
  });

  it("releases the address when close races the registration", async () => {
    // `inboxUnsubscribe` is assigned in a `.then()` off the registration
    // Effect. A close that lands before that microtask must not lose the
    // handle — the harness would otherwise hold the address forever with
    // nothing left alive to release it.
    const inbox = new LocalInbox();
    const harness = new TeardownHarness("s6", inbox);
    // Deliberately NOT awaiting `ready`.
    await harness.close();

    expect(await addressFree(inbox, "tool:s6")).toBe(true);
  });
});

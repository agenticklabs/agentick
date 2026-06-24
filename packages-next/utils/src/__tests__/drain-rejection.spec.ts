import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { drainRejection } from "../testing/drain-rejection.js";

describe("drainRejection", () => {
  describe("return value — table-driven", () => {
    interface Case {
      readonly make: () => Promise<unknown>;
      readonly expected: unknown;
      readonly match: "equal" | "instanceof-error-with-message";
    }

    const cases: Record<string, Case> = {
      "resolving Promise → resolved value flows through": {
        make: () => Promise.resolve(42),
        expected: 42,
        match: "equal",
      },
      "resolving Promise → undefined flows through": {
        make: () => Promise.resolve(undefined),
        expected: undefined,
        match: "equal",
      },
      "resolving Promise → object identity preserved": {
        make: () => Promise.resolve({ k: "v" }),
        expected: { k: "v" },
        match: "equal",
      },
      "rejecting Promise (Error) → reason returned": {
        make: () => Promise.reject(new Error("boom")),
        expected: "boom",
        match: "instanceof-error-with-message",
      },
      "rejecting Promise (string) → reason returned verbatim": {
        make: () => Promise.reject("nope"),
        expected: "nope",
        match: "equal",
      },
      "rejecting Promise (undefined reason) → undefined returned": {
        make: () => Promise.reject(undefined),
        expected: undefined,
        match: "equal",
      },
      "rejecting Promise (number reason) → reason returned verbatim": {
        make: () => Promise.reject(0),
        expected: 0,
        match: "equal",
      },
    };

    it.each(Object.entries(cases))("%s", async (_name, c) => {
      const drained = await drainRejection(c.make());
      if (c.match === "instanceof-error-with-message") {
        expect(drained).toBeInstanceOf(Error);
        expect((drained as Error).message).toBe(c.expected);
      } else {
        expect(drained).toEqual(c.expected);
      }
    });
  });

  describe("unhandled-rejection observability", () => {
    let unhandled: unknown[];
    let listener: (reason: unknown) => void;

    beforeEach(() => {
      unhandled = [];
      listener = (reason) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", listener);
    });

    afterEach(() => {
      process.off("unhandledRejection", listener);
    });

    it("eagerly observes the rejection — no unhandled-rejection event fires when another await races", async () => {
      // A long-tail rejection: another await runs first, so without
      // an eager drain the rejection would surface as unhandled in
      // the interim. drainRejection attaches the handler in the same
      // synchronous turn the Promise is constructed.
      const rejecting = Promise.reject(new Error("late"));
      const drained = drainRejection(rejecting);

      // Race in unrelated tasks — give the microtask queue several
      // turns to flush a would-be unhandled rejection.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const reason = await drained;
      expect((reason as Error).message).toBe("late");
      expect(unhandled).toHaveLength(0);
    });

    it("a typical session-lifecycle pattern stays warning-free", async () => {
      // Simulates the canonical pre-drain pattern: kick off a long
      // operation that will reject, attach drainRejection eagerly,
      // run other awaits, then read the reason.
      const work = (async (): Promise<never> => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throw new Error("session-failed");
      })();
      const drained = drainRejection(work);

      // Unrelated lifecycle steps run before we read the reason.
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      const reason = await drained;
      expect((reason as Error).message).toBe("session-failed");
      expect(unhandled).toHaveLength(0);
    });
  });

  describe("microtask + identity", () => {
    it("returns a Promise — never a synchronous value", () => {
      const result = drainRejection(Promise.resolve(1));
      expect(result).toBeInstanceOf(Promise);
    });

    it("can be awaited multiple times — same Promise yields the same resolution", async () => {
      const drained = drainRejection(Promise.reject(new Error("x")));
      const first = await drained;
      const second = await drained;
      expect(first).toBe(second);
    });

    it("does not absorb rejections of *other* Promises in the same tick", async () => {
      // Guards against an accidentally-global drain. drainRejection
      // operates on a single Promise instance only.
      const guarded = Promise.reject(new Error("guarded"));
      const unguarded = Promise.reject(new Error("unguarded"));

      const guardedDrained = drainRejection(guarded);
      const unguardedDrained = drainRejection(unguarded); // separate drain

      const guardedReason = await guardedDrained;
      const unguardedReason = await unguardedDrained;
      expect((guardedReason as Error).message).toBe("guarded");
      expect((unguardedReason as Error).message).toBe("unguarded");
    });
  });
});

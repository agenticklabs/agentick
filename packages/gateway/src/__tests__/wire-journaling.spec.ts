/**
 * Per-method wire journaling — `WireExtension.journal` folded into the gateway's
 * policy.
 *
 * The fact under test is easy to miss and expensive to get wrong. Every wire
 * dispatch mints a `wire:<method>` boundary op, and `requested` + `terminal` are
 * `alwaysJournal` phases — so by DEFAULT a JSON-RPC call appends two envelopes to
 * the gateway journal. That is right for `knobs/set` (a write; someone will want
 * the audit trail) and wrong for a typeahead verb that fires per keystroke: it
 * would move the journal flood that `CompletionsHarness.resolve` was made a plain
 * method to avoid up one layer, to the gateway, where nobody is looking for it.
 *
 * So a method declares its own disposition and the gateway translates it to the
 * op name it alone knows how to derive. Both halves are asserted here: the
 * default still journals, the declaration still suppresses, and an adopter's
 * explicit policy outranks the declaration (it is a default, not a lock).
 *
 * @see packages/spec/src/wire/extension.ts — `WireExtension.journal`
 * @see packages/completions/src/wire.ts — the declaring verb
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_JOURNALING_POLICY, defineWireExtension } from "@agentick/spec";
import type { WireMethod } from "@agentick/spec";
import { MemoryJournal } from "@agentick/runtime";

import { GatewayHarness } from "../harness.js";
import { fakeWireCtx } from "./fake-wire-ctx.js";

/**
 * Two rows with identical shapes and opposite dispositions, so the only variable
 * between them is the declaration. Registered through the adopter
 * `wireExtensions` tier — the same fold the built-in tier goes through.
 */
declare module "@agentick/spec" {
  interface WireMethods {
    "journaltest/loud": { params: { sessionId: string }; result: null };
    "journaltest/quiet": { params: { sessionId: string }; result: null };
  }
}

const probeExtension = defineWireExtension({
  name: "test:journaling-probe",
  namespace: "journaltest",
  methods: {
    "journaltest/loud": async () => null,
    "journaltest/quiet": async () => null,
  },
  journal: { "journaltest/quiet": "bus-only" },
});

/** Dispatch `method` through the real boundary op and report journal growth. */
async function appendsFor(gw: GatewayHarness, journal: MemoryJournal, method: WireMethod) {
  const before = journal.totalAppended();
  await gw.runWireDispatch(method, { sessionId: "sess-1" }, fakeWireCtx(gw), async () => null);
  return journal.totalAppended() - before;
}

describe("wire journaling — the per-method disposition", () => {
  it("journals an undeclared method and suppresses a `bus-only` one", async () => {
    const journal = new MemoryJournal();
    const gw = new GatewayHarness({ journal, wireExtensions: [probeExtension] });
    await gw.ready;

    // The default: `requested` + `terminal` reach the journal.
    expect(await appendsFor(gw, journal, "journaltest/loud")).toBe(2);
    // The declaration: bus only, nothing durable.
    expect(await appendsFor(gw, journal, "journaltest/quiet")).toBe(0);

    await gw.close();
  });

  it("keeps `completions/complete` out of the journal while `knobs/set` stays in it", async () => {
    // The claim that motivated the seam, asserted on the real verbs. Both rows
    // ride `builtinWireExtensions`, so this needs no completions/knobs import —
    // the dispatch is driven by method name and the handler is stubbed (routing
    // is covered in each package's own wire spec).
    const journal = new MemoryJournal();
    const gw = new GatewayHarness({ journal });
    await gw.ready;

    expect(await appendsFor(gw, journal, "completions/complete")).toBe(0);
    expect(await appendsFor(gw, journal, "knobs/set")).toBe(2);

    await gw.close();
  });

  it("lets an adopter's explicit policy override outrank the declaration", async () => {
    // The declaration is a framework DEFAULT. A deployment that genuinely wants
    // completion traffic durable (a compliance audit of what was offered to whom)
    // says so and wins.
    const journal = new MemoryJournal();
    const gw = new GatewayHarness({
      journal,
      policy: {
        ...DEFAULT_JOURNALING_POLICY,
        override: { "wire:completions/complete": "always" },
      },
    });
    await gw.ready;

    // THREE, not two: `"always"` journals every phase regardless of the phase
    // rules, so the `before` envelope lands alongside `requested` + `terminal`.
    // That the count exceeds even the undeclared default is the point — the
    // adopter's value won this KEY outright. The override MAPS still deep-merge,
    // so a declaration for some other verb survives an adopter's policy.
    expect(await appendsFor(gw, journal, "completions/complete")).toBe(3);

    await gw.close();
  });
});

/**
 * ADR 91 §2 — a prompt `render(args, ctx)` receives the invoking op's ctx.
 *
 * `PromptDeclaration.render` gained an optional `(args, ctx?)` second param;
 * the harness's `render` / `invoke` paths derive the invoking op's branded
 * `OperationCtx` in-fiber (`currentOperationCtx`) and thread it in, so a
 * dynamic prompt can render per-principal content.
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { OperationCtx } from "@agentick/spec";

import { PromptsHarness } from "../harness.js";

describe("ADR 91 §2 — prompt render ctx", () => {
  it("threads the invoking op's branded ctx (trunk + facets) into render(args, ctx)", async () => {
    const h = new PromptsHarness(
      "prompt-sess-91",
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {},
    );
    await h.ready;

    let receivedArgs: unknown;
    let received: OperationCtx | undefined;
    await h.register({
      declaration: {
        name: "who",
        description: "identity-scoped prompt",
        render: (args, ctx) => {
          receivedArgs = args;
          received = ctx;
          return "hi";
        },
      },
    });

    await h.render({ name: "who", args: { n: 1 } });

    expect(receivedArgs).toEqual({ n: 1 });
    expect(received).toBeDefined();
    // Trunk — the render command scopes to `{ sessionId: scopeId }`.
    expect(received?.sessionId).toBe("prompt-sess-91");
    // Facets present.
    expect(typeof received?.log).toBe("function");
    expect(typeof received?.run).toBe("function");

    await h.close();
  });
});

/**
 * ADR 91 §2 — a prompt `render(args, ctx)` receives the invoking op's ctx.
 *
 * `PromptDeclaration.render` gained an optional `(args, ctx?)` second param;
 * the harness's `render` / `invoke` paths derive the invoking op's branded
 * `OperationCtx` in-fiber (`currentOperationCtx`) and thread it in, so a
 * dynamic prompt can render per-principal content.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { LocalEventBus, LocalInbox, MemoryJournal, withContext } from "@agentick/runtime";
import type { OperationCtx } from "@agentick/spec";

import { PromptsHarness } from "../harness.js";

describe("ADR 91 §2 — prompt render ctx", () => {
  it("threads the invoking op's branded ctx (trunk + facets) into render(args, ctx)", async () => {
    const h = new PromptsHarness(
      "prompt-sess-91",
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      // The ctx's `sessionId` is the harness's construction-bound `parentScope`
      // now, not its own id self-stamped per command. `session-bridges` always
      // supplies it; a standalone harness that does not is honestly "inside
      // nothing" rather than claiming its own scope key as a session.
      { parentScope: { sessionId: "prompt-sess-91" } },
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

// ============================================================================
// ADR 92 §Slice A — the Effect-canonical render face (`fx`)
// ============================================================================

/**
 * The trunk a `render(args, ctx)` sees is only as good as the FIBER the render
 * runs on. `render(input)` is the edge facade: a ROOT fiber, so an enclosing
 * operation's trunk is not there to inherit. `fx.render(input)` is the same
 * command un-run — composed by an in-fiber caller (the MCP server's
 * `get-prompt` crossing) it inherits the ambient trunk, which is what carries
 * wire identity into a dynamic prompt.
 */
describe("ADR 92 §Slice A — fx.render composes in-fiber", () => {
  const harnessWith = async (
    id: string,
    onRender: (ctx?: OperationCtx) => void,
  ): Promise<PromptsHarness> => {
    const h = new PromptsHarness(
      id,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      // The ctx's `sessionId` is the harness's construction-bound `parentScope`
      // now, not its own id self-stamped per command. `session-bridges` always
      // supplies it; a standalone harness that does not is honestly "inside
      // nothing" rather than claiming its own scope key as a session.
      { parentScope: { sessionId: id } },
    );
    await h.ready;
    await h.register({
      declaration: {
        name: "who",
        description: "identity-scoped prompt",
        render: (_args, ctx) => {
          onRender(ctx);
          return "hi";
        },
      },
    });
    return h;
  };

  it("inherits the ambient trunk — identity + the enclosing opId as parent", async () => {
    let received: OperationCtx | undefined;
    const h = await harnessWith("prompt-fx", (ctx) => {
      received = ctx;
    });

    const result = await Effect.runPromise(
      withContext(
        { opId: "op:outer", identity: { principal: "user-42", scopes: ["read:all"] } },
        h.fx.render({ name: "who" }),
      ),
    );

    expect(result.messages).toHaveLength(1);
    expect(received?.identity?.principal).toBe("user-42");
    expect(received?.parentOpId).toBe("op:outer");

    await h.close();
  });

  it("the Promise facade does NOT — a root fiber has no trunk to inherit", async () => {
    let received: OperationCtx | undefined;
    const h = await harnessWith("prompt-facade", (ctx) => {
      received = ctx;
    });

    await Effect.runPromise(
      withContext(
        { opId: "op:outer", identity: { principal: "user-42" } },
        Effect.promise(() => h.render({ name: "who" })),
      ),
    );

    expect(received?.identity).toBeUndefined();
    expect(received?.parentOpId).toBeUndefined();

    await h.close();
  });
});

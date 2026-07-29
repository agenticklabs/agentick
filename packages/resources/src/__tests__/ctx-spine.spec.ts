/**
 * ADR 91 §2 — a resource resolver receives the invoking op's ctx.
 *
 * `ResourceResolver` gained an optional `(uri, ctx?)` second param; the
 * harness's `read` command derives the invoking op's branded `OperationCtx`
 * in-fiber (`currentOperationCtx`) and threads it in. The read command scopes
 * to `{ sessionId: this.scopeId }`, so the resolver sees that as its trunk —
 * the seam an identity-scoped resolver (`knowify://me`) reads to resolve
 * per-principal content.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { LocalEventBus, LocalInbox, MemoryJournal, withContext } from "@agentick/runtime";
import type { OperationCtx, ResourceContents } from "@agentick/spec";

import { ResourcesHarness } from "../harness.js";

describe("ADR 91 §2 — resource resolver ctx", () => {
  it("threads the read op's branded ctx (trunk + facets) into the resolver", async () => {
    const harness = new ResourcesHarness(
      "res-sess-91",
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      // The ctx's `sessionId` is the harness's construction-bound `parentScope`
      // now, not its own id self-stamped per command. `session-bridges` always
      // supplies it; a standalone harness that does not is honestly "inside
      // nothing" rather than claiming its own scope key as a session.
      { parentScope: { sessionId: "res-sess-91" } },
    );
    await harness.ready;

    let received: OperationCtx | undefined;
    let receivedUri: string | undefined;
    harness.register("knowify://me", (uri, ctx) => {
      receivedUri = uri;
      received = ctx;
      return [{ uri, mimeType: "text/plain", text: "me" }] as ResourceContents[];
    });

    await harness.read("knowify://me");

    expect(receivedUri).toBe("knowify://me");
    expect(received).toBeDefined();
    // Trunk — the read command scopes to `{ sessionId: scopeId }`.
    expect(received?.sessionId).toBe("res-sess-91");
    // Facets — a resolver can log / open spans / run ops off its ctx.
    expect(typeof received?.log).toBe("function");
    expect(typeof received?.run).toBe("function");
    expect(received?.trace).toBeDefined();

    await harness.close();
  });

  it("threads ctx into a template resolver too", async () => {
    const harness = new ResourcesHarness(
      "res-tmpl-91",
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      // The ctx's `sessionId` is the harness's construction-bound `parentScope`
      // now, not its own id self-stamped per command. `session-bridges` always
      // supplies it; a standalone harness that does not is honestly "inside
      // nothing" rather than claiming its own scope key as a session.
      { parentScope: { sessionId: "res-tmpl-91" } },
    );
    await harness.ready;

    let received: OperationCtx | undefined;
    harness.registerTemplate("knowify://user/{id}", (uri, ctx) => {
      received = ctx;
      return [{ uri, mimeType: "text/plain", text: "u" }] as ResourceContents[];
    });

    await harness.read("knowify://user/42");

    expect(received?.sessionId).toBe("res-tmpl-91");
    expect(typeof received?.log).toBe("function");

    await harness.close();
  });
});

// ============================================================================
// ADR 92 §Slice A — the Effect-canonical read face (`fx`)
// ============================================================================

/**
 * The trunk a resolver sees is only as good as the FIBER the read runs on.
 * `read(uri)` is the edge facade: it starts a ROOT fiber, so an enclosing
 * operation's trunk (a caller's identity, its opId) is NOT there to inherit.
 * `fx.read(input)` is the same command un-run — composed by an in-fiber caller
 * (the MCP server's crossing) it inherits the ambient trunk, which is what
 * carries wire identity into a resolver.
 */
describe("ADR 92 §Slice A — fx.read composes in-fiber", () => {
  const harnessWith = async (
    id: string,
    onRead: (uri: string, ctx?: OperationCtx) => void,
  ): Promise<ResourcesHarness> => {
    const harness = new ResourcesHarness(
      id,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {},
    );
    await harness.ready;
    harness.register("mem://who", (uri, ctx) => {
      onRead(uri, ctx);
      return [{ uri, mimeType: "text/plain", text: "me" }] as ResourceContents[];
    });
    return harness;
  };

  it("inherits the ambient trunk — identity + the enclosing opId as parent", async () => {
    let received: OperationCtx | undefined;
    const harness = await harnessWith("res-fx", (_uri, ctx) => {
      received = ctx;
    });

    const contents = await Effect.runPromise(
      withContext(
        { opId: "op:outer", identity: { principal: "user-42", scopes: ["read:all"] } },
        harness.fx.read({ uri: "mem://who" }),
      ),
    );

    expect(contents[0]).toMatchObject({ uri: "mem://who", text: "me" });
    expect(received?.identity?.principal).toBe("user-42");
    expect(received?.parentOpId).toBe("op:outer");

    await harness.close();
  });

  it("the Promise facade does NOT — a root fiber has no trunk to inherit", async () => {
    let received: OperationCtx | undefined;
    const harness = await harnessWith("res-facade", (_uri, ctx) => {
      received = ctx;
    });

    // Same ambient scope; the facade's `Effect.runPromiseExit` severs it.
    await Effect.runPromise(
      withContext(
        { opId: "op:outer", identity: { principal: "user-42" } },
        Effect.promise(() => harness.read("mem://who")),
      ),
    );

    expect(received?.identity).toBeUndefined();
    expect(received?.parentOpId).toBeUndefined();

    await harness.close();
  });

  it("fx.list / fx.listTemplates serve the same pages as their positional twins", async () => {
    const harness = await harnessWith("res-fx-list", () => {});
    harness.registerTemplate("mem://u/{id}", (uri) => [{ uri, text: "u" }] as ResourceContents[]);

    const [fxList, fxTemplates] = await Effect.runPromise(
      Effect.all([harness.fx.list({}), harness.fx.listTemplates({})]),
    );
    expect(fxList).toEqual(await harness.list());
    expect(fxTemplates).toEqual(await harness.listTemplates());

    await harness.close();
  });
});

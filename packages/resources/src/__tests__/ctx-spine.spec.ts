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

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { OperationCtx, ResourceContents } from "@agentick/spec";

import { ResourcesHarness } from "../harness.js";

describe("ADR 91 §2 — resource resolver ctx", () => {
  it("threads the read op's branded ctx (trunk + facets) into the resolver", async () => {
    const harness = new ResourcesHarness(
      "res-sess-91",
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {},
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
      {},
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

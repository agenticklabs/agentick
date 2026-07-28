/**
 * ADR 87 — the FORGOTTEN `/client` IMPORT. A sub-handle slot is registered as a
 * side effect of importing a harness's `/client` subpath; an adopter on the lean
 * `@agentick/client-core` who forgets that import used to fall through to
 * wire-namespace synthesis, so `session.tools` silently returned a proxy that
 * failed much later with a confusing `tools/list` method-not-found.
 *
 * Accessing a KNOWN-but-unregistered slot now throws
 * {@link SessionSubHandleNotRegistered} at ACCESS time, naming the import to add.
 * Names the diagnostics dictionary does NOT know keep synthesizing — the
 * gateway-porcelain (`session.billing.approve`) path is untouched.
 *
 * Registry note: the module-level registry has no `unregister` (registration is
 * an import-time side effect). Vitest isolates the module graph per FILE, so the
 * one slot this file registers (`knobs`) cannot leak into a sibling suite — and
 * within this file the throwing cases deliberately use OTHER slots.
 */

import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { AgentickError } from "@agentick/spec";

import { makeSessionHandle } from "../handles.js";
import {
  knownSessionHandleExtensionImports,
  registerSessionHandleExtension,
  SessionSubHandleNotRegistered,
} from "../session-handle-extensions.js";

type InternalClientArg = Parameters<typeof makeSessionHandle>[0];

/** Minimal client — `request` records; `transport` is never touched here. */
function fakeClient() {
  const request = vi.fn(async () => null);
  const client = { id: "c1", request, transport: {} } as unknown as InternalClientArg;
  return { client, request };
}

/** The runtime is a superset of the mapped type; probe slots by name. */
function slot(session: object, name: string): unknown {
  return (session as unknown as Record<string, unknown>)[name];
}

describe("known-slot diagnostics (forgotten /client import)", () => {
  it("accessing a known-but-unregistered slot throws, naming the bundle then the import", () => {
    const session = makeSessionHandle(fakeClient().client, "s1");

    let caught: unknown;
    try {
      slot(session, "tools");
    } catch (e: unknown) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SessionSubHandleNotRegistered);
    expect(caught).toBeInstanceOf(AgentickError);
    expect(caught).toBeInstanceOf(Error);
    const err = caught as SessionSubHandleNotRegistered;
    expect(err._tag).toBe("SessionSubHandleNotRegistered");
    expect(err.name).toBe("SessionSubHandleNotRegistered");
    expect(err.slot).toBe("tools");
    expect(err.importSpecifier).toBe("@agentick/tool-executor/client");
    // The message leads with the zero-config fix, then the lean-core one.
    expect(err.message).toContain("session.tools is not registered");
    expect(err.message).toContain("Install @agentick/client");
    expect(err.message).toContain('import "@agentick/tool-executor/client"');
    expect(err.message.indexOf("@agentick/client —")).toBeLessThan(
      err.message.indexOf("@agentick/tool-executor/client"),
    );
  });

  it.each([
    ["timeline", "@agentick/timeline/client"],
    ["elicitations", "@agentick/elicitation/client"],
    ["clientToolCalls", "@agentick/tool-executor/client"],
    ["live", "@agentick/live/client"],
  ])("%s names its own import specifier (%s)", (name, specifier) => {
    const session = makeSessionHandle(fakeClient().client, "s1");
    expect(() => slot(session, name)).toThrow(`import "${specifier}"`);
  });

  it("every dictionary entry maps a slot name to a `/client` subpath", () => {
    const dictionary = knownSessionHandleExtensionImports();
    expect(Object.keys(dictionary).length).toBeGreaterThan(0);
    for (const [name, specifier] of Object.entries(dictionary)) {
      expect(name).not.toBe("");
      expect(specifier).toMatch(/^@agentick\/[a-z-]+\/client$/);
    }
  });

  it("a REGISTERED slot is served from the handle (diagnostics never consulted)", () => {
    // The dictionary knows `knobs`; registering it is exactly what
    // `import "@agentick/knobs/client"` does.
    registerSessionHandleExtension("knobs", (_client, id) => ({ marker: "real", id }));
    const session = makeSessionHandle(fakeClient().client, "s1");

    const sub = slot(session, "knobs") as { marker: string; id: string };
    expect(sub.marker).toBe("real");
    expect(sub.id).toBe("s1");
  });
});

describe("unknown namespaces keep synthesizing (gateway porcelain)", () => {
  it("session.billing.approve issues `billing/approve` with { sessionId }", async () => {
    const { client, request } = fakeClient();
    const session = makeSessionHandle(client, "s1");

    const billing = slot(session, "billing") as {
      approve(params: { orderId: string }): Promise<unknown>;
    };
    await billing.approve({ orderId: "o-9" });

    expect(request).toHaveBeenCalledWith("billing/approve", { sessionId: "s1", orderId: "o-9" });
    // Memoized, as before.
    expect(slot(session, "billing")).toBe(billing);
  });
});

describe("probes and inspection never throw", () => {
  it("`in`, Object.keys and util.inspect do not route through the diagnostics path", () => {
    const session = makeSessionHandle(fakeClient().client, "s1");

    // `in` hits the `has` trap, not `get` — absence is reported, not thrown.
    expect("tools" in session).toBe(false);
    expect("send" in session).toBe(true);

    expect(() => Object.keys(session)).not.toThrow();
    expect(Object.keys(session)).not.toContain("tools");
    expect(() => inspect(session)).not.toThrow();
  });

  it("the handle is still not a thenable (await resolves to the handle)", async () => {
    const session = makeSessionHandle(fakeClient().client, "s1");
    const awaited = await session;
    expect(awaited.id).toBe("s1");
  });
});

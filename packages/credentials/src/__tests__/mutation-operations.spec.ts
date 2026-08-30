/**
 * ADR 92 §Family 2 item 7 — credential writes ARE operations, and the secret
 * never enters the envelope.
 *
 * The claim under test: `set` / `delete` are no longer plain CRUD. They run as
 * `credentials:command:{set,delete}` — guardable, hookable, journaled — while
 * reads stay data-plane. And the sharpest clause: the credential VALUE has no
 * representation anywhere in the operation envelope, because it is not an
 * operation input at all (structural redaction, not a post-hoc scrub).
 *
 * Pins, one describe per contract clause:
 *
 *   1. A write emits the op with the `{ credentialNamespace, credentialKey }`
 *      scope and journals both `requested` and `terminal`.
 *   2. THE REDACTION LAW — the serialized journal + bus records contain neither
 *      the value nor any substring of it.
 *   3. A guard veto blocks the write: the store is never touched.
 *   4. Reads stay data-plane — `get` / `has` / `keys` emit no operation.
 *
 * @see docs/proposals/v2/blueprint/92-operation-grammar-completion.md
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ProtocolEvent } from "@agentick/spec";

import { stubStoreCtx } from "@agentick/store";

import { CredentialsHarness } from "../harness.js";
import { inMemoryCredentialProvider } from "../providers/in-memory.js";
import type { CredentialProvider } from "../provider.js";

// ============================================================================
// Fixtures
// ============================================================================

const SET_OP = "credentials:command:set";
const DELETE_OP = "credentials:command:delete";

/**
 * A distinctive secret with no substring shared with the namespace, the key, or
 * any op name — so a leak anywhere in the envelope is unambiguous.
 */
const SECRET = "sk-live-Zq7Wx4TbNv2Ph8Rk";
/** The shortest fragment whose presence would still prove a leak. */
const SECRET_FRAGMENT = "Zq7Wx4TbNv";

interface Rig {
  readonly harness: CredentialsHarness;
  readonly providers: ReadonlyMap<string, CredentialProvider>;
  readonly journal: MemoryJournal;
  readonly events: ProtocolEvent[];
  readonly stop: () => Promise<void>;
}

/**
 * Namespaces this spec exercises. Under ADR 107 a provider serves exactly one,
 * so the rig registers one per namespace instead of a single store demuxing
 * them — which is also what makes the sibling-namespace veto case meaningful.
 */
const NAMESPACES = ["oauth", "locked", "open", "api", "stripe"] as const;

async function rig(overrides: readonly CredentialProvider[] = []): Promise<Rig> {
  const overridden = new Set(overrides.map((p) => p.namespace));
  const providerList = [
    ...overrides,
    ...NAMESPACES.filter((ns) => !overridden.has(ns)).map((ns) =>
      inMemoryCredentialProvider({ namespace: ns }),
    ),
  ];
  const providers = new Map(providerList.map((p) => [p.namespace, p] as const));
  const bus = new LocalEventBus();
  const journal = new MemoryJournal({ capacity: 4096 });
  const harness = new CredentialsHarness("app-1:credentials", journal, bus, new LocalInbox(), {
    providers: providerList,
  });
  await harness.ready;

  const events: ProtocolEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe({ surface: "credentials" }), (e) =>
      Effect.sync(() => {
        events.push(e);
      }),
    ),
  );

  return {
    harness,
    providers,
    journal,
    events,
    stop: async () => {
      await harness.close();
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
}

/** Settle the microtask + bus fan-out queue. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/**
 * Decorate a store's `set` while keeping every other method live. The adapters
 * are class instances, so a spread would drop the prototype methods — delegate
 * through a `Proxy` that forwards everything except the one overridden member,
 * with `this` still bound to the real instance.
 */
function withSet(
  base: CredentialProvider,
  set: NonNullable<CredentialProvider["set"]>,
): CredentialProvider {
  // A wrapper, not a Proxy: `defineCredentialProvider` freezes its result, and
  // a proxy cannot report a different value for a frozen own property.
  return { ...base, set };
}

/** Read a credential directly off the store, bypassing the harness surface. */
function read<T>(
  providers: ReadonlyMap<string, CredentialProvider>,
  ns: string,
  key: string,
): Promise<T | undefined> {
  return providers.get(ns)!.get<T>(key, stubStoreCtx());
}

function opsNamed(events: readonly ProtocolEvent[], name: string): readonly ProtocolEvent[] {
  return events.filter((e) => e.name === name);
}

async function journaled(journal: MemoryJournal, name?: string): Promise<readonly ProtocolEvent[]> {
  const out = await Effect.runPromise(
    Stream.runCollect(
      journal.readByQuery(name === undefined ? {} : { name: { exact: name } }, "beginning"),
    ),
  );
  return Array.from(out);
}

let active: Rig | undefined;
afterEach(async () => {
  await active?.stop();
  active = undefined;
});

// ============================================================================
// 1 — the op, its scope, and its journal policy
// ============================================================================

describe("a credential write runs as credentials:command:set", () => {
  it("emits the op with the credential address as scope", async () => {
    const r = (active = await rig());

    await r.harness.set("oauth", "github", SECRET);
    await settle();

    const ops = opsNamed(r.events, SET_OP);
    expect(ops.length).toBeGreaterThan(0);
    for (const e of ops) {
      expect(e.surface).toBe("credentials");
      expect(e.scope.credentialNamespace).toBe("oauth");
      expect(e.scope.credentialKey).toBe("github");
    }
    expect(ops.find((e) => e.phase === "terminal")?.outcome).toBe("succeeded");
    expect(await read(r.providers, "oauth", "github")).toBe(SECRET);
  });

  it("journals BOTH requested and terminal (the fact of the write is audited)", async () => {
    const r = (active = await rig());

    await r.harness.set("oauth", "github", SECRET);
    await settle();

    const rows = await journaled(r.journal, SET_OP);
    expect(rows.map((e) => e.phase)).toEqual(expect.arrayContaining(["requested", "terminal"]));
  });

  it("delete runs as credentials:command:delete and journals its boolean outcome", async () => {
    const r = (active = await rig());
    await r.harness.set("oauth", "github", SECRET);

    await expect(r.harness.delete("oauth", "github")).resolves.toBe(true);
    await expect(r.harness.delete("oauth", "github")).resolves.toBe(false);
    await settle();

    const terminals = opsNamed(r.events, DELETE_OP).filter((e) => e.phase === "terminal");
    expect(terminals).toHaveLength(2);
    expect(terminals.every((e) => e.outcome === "succeeded")).toBe(true);
    expect(terminals.every((e) => e.scope.credentialKey === "github")).toBe(true);
  });

  it("the op input is the ADDRESS — { namespace, key } and nothing else", async () => {
    const r = (active = await rig());

    await r.harness.set("oauth", "github", SECRET);
    await settle();

    const requested = opsNamed(r.events, SET_OP).find((e) => e.phase === "requested")!;
    expect(requested.payload).toEqual({ namespace: "oauth", key: "github" });
  });

  it("threads the ENRICHED store ctx — the write's own opId reaches the adapter", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const base = inMemoryCredentialProvider({ namespace: "oauth" });
    const r = (active = await rig([
      withSet(base, async (key, value, ctx) => {
        seen.push({ ...(ctx as Record<string, unknown>) });
        return base.set!(key, value, ctx);
      }),
    ]));

    await r.harness.set("oauth", "github", SECRET);

    expect(seen).toHaveLength(1);
    expect(String(seen[0]!.opId)).toMatch(/^credentials:set:/);
  });
});

// ============================================================================
// 2 — THE REDACTION LAW
// ============================================================================

describe("the redaction law — the secret never enters the audit trail", () => {
  it("no journal record, serialized, contains the value or any fragment of it", async () => {
    const r = (active = await rig());

    await r.harness.set("oauth", "github", SECRET);
    await r.harness.set("api", "stripe", { token: SECRET, refresh: `${SECRET}-r` });
    await r.harness.delete("oauth", "github");
    await settle();

    // EVERY record in the journal — not just the credentials ops — so a leak
    // via some other surface's envelope would fail this too.
    const serialized = JSON.stringify(await journaled(r.journal));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(SECRET_FRAGMENT);
    // Sanity: the journal is not empty and DOES carry the address, so the
    // assertions above are not vacuously true.
    expect(serialized).toContain("credentials:command:set");
    expect(serialized).toContain("github");
  });

  it("no bus envelope, serialized, contains the value or any fragment of it", async () => {
    const r = (active = await rig());

    await r.harness.set("oauth", "github", SECRET);
    await settle();

    const serialized = JSON.stringify(r.events);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(SECRET_FRAGMENT);
    expect(serialized).toContain("credentials:command:set");
  });

  it("a guard observing the input sees the address, never the material", async () => {
    const r = (active = await rig());
    const observed: unknown[] = [];
    r.harness.guard((input) => {
      observed.push(input);
      return undefined;
    });

    await r.harness.set("oauth", "github", SECRET);

    expect(observed).toEqual([{ namespace: "oauth", key: "github" }]);
    expect(JSON.stringify(observed)).not.toContain(SECRET_FRAGMENT);
  });
});

// ============================================================================
// 3 — the guard seam
// ============================================================================

describe("a guard veto blocks a credential write", () => {
  it("a vetoed set never reaches the store", async () => {
    const base = inMemoryCredentialProvider({ namespace: "oauth" });
    const setSpy = vi.fn(base.set!.bind(base));
    const r = (active = await rig([withSet(base, setSpy)]));
    r.harness.guard(() => ({ kind: "veto", reason: "read-only-deployment" }));

    await expect(r.harness.set("oauth", "github", SECRET)).rejects.toBeTruthy();
    await settle();

    expect(setSpy).not.toHaveBeenCalled();
    expect(await read(r.providers, "oauth", "github")).toBeUndefined();
    const terminal = opsNamed(r.events, SET_OP).find((e) => e.phase === "terminal");
    expect(terminal?.outcome).toBe("vetoed");
  });

  it("a vetoed delete leaves the entry in place", async () => {
    const r = (active = await rig());
    await r.harness.set("oauth", "github", SECRET);
    r.harness.guard(() => ({ kind: "veto", reason: "retention-policy" }));

    await expect(r.harness.delete("oauth", "github")).rejects.toBeTruthy();
    await settle();

    expect(await read(r.providers, "oauth", "github")).toBe(SECRET);
    const terminal = opsNamed(r.events, DELETE_OP).find((e) => e.phase === "terminal");
    expect(terminal?.outcome).toBe("vetoed");
  });

  it("a guard reading the input can veto ONE namespace and let a sibling through", async () => {
    const r = (active = await rig());
    r.harness.guard<{ readonly namespace: string }>((input) =>
      input.namespace === "locked" ? { kind: "veto", reason: "policy" } : undefined,
    );

    await expect(r.harness.set("locked", "k", SECRET)).rejects.toBeTruthy();
    await r.harness.set("open", "k", SECRET);

    expect(await read(r.providers, "locked", "k")).toBeUndefined();
    expect(await read(r.providers, "open", "k")).toBe(SECRET);
  });

  it("a vetoed write publishes no change notification", async () => {
    const r = (active = await rig());
    const listener = vi.fn();
    r.harness.subscribe(listener);
    r.harness.guard(() => ({ kind: "veto", reason: "policy" }));

    await expect(r.harness.set("oauth", "github", SECRET)).rejects.toBeTruthy();

    expect(listener).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 4 — reads stay data-plane
// ============================================================================

describe("reads are NOT operations (the ADR's data-plane exclusion)", () => {
  it("get / has / keys emit nothing on the bus", async () => {
    const r = (active = await rig());
    await r.harness.set("oauth", "github", SECRET);
    await settle();
    const before = r.events.length;

    await r.harness.get("oauth", "github");
    await r.harness.has("oauth", "github");
    await r.harness.keys("oauth");
    await settle();

    expect(r.events.length).toBe(before);
  });

  it("a blanket guard veto does not block reads", async () => {
    const r = (active = await rig());
    await r.harness.set("oauth", "github", SECRET);
    r.harness.guard(() => ({ kind: "veto", reason: "writes-frozen" }));

    await expect(r.harness.get("oauth", "github")).resolves.toBe(SECRET);
    await expect(r.harness.has("oauth", "github")).resolves.toBe(true);
    await expect(r.harness.keys("oauth")).resolves.toEqual(["github"]);
  });
});

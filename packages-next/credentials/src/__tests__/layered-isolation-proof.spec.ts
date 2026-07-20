/**
 * ADR 48 proof — "per-scope harness instance over a shared backing
 * resource, isolated by namespace."
 *
 * Validates the load-bearing claim of the layered-isolation model
 * using pieces that already exist (a pluggable `CredentialsStore` +
 * `CredentialsHarness`), and pins the ONE gap the model predicted:
 * isolation is currently caller-supplied per call, not bound to the
 * harness at construction.
 *
 * Proven here:
 *   1. RESOURCE SHARING — N per-scope harnesses share ONE store
 *      instance (the "one Pg pool, many scoped views" shape). No
 *      per-scope connection.
 *   2. NAMESPACE ISOLATION — distinct namespaces do not read each
 *      other's values, over the shared store.
 *
 * Gap surfaced (see the final test): `get/set(namespace, key)` takes
 * the namespace as a per-CALL argument. So today isolation is
 * "remember to pass the right namespace" — caller discipline, the same
 * runtime-supplied shape ADR 47 rejected for `notify`. To be
 * STRUCTURALLY per-scope (ADR 48), the harness must bind its scope
 * (namespace prefix) at construction so a scoped view cannot address
 * another scope's namespace. That binding does not exist yet — it is
 * the concrete next step the model calls for.
 *
 * @see docs/proposals/v2/blueprint/48-layered-isolation.md
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { stubStoreCtx } from "@agentick/store-next";
import { CredentialsHarness } from "../harness.js";
import { inMemoryCredentialsStore } from "../stores/in-memory.js";

/** Construct a per-scope harness bound to a shared store instance. */
function scopedHarness(scopeId: string, store: ReturnType<typeof inMemoryCredentialsStore>) {
  return new CredentialsHarness(
    scopeId,
    store,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
}

describe("ADR 48 — per-scope harness over shared resource", () => {
  it("resource sharing: N scoped harnesses over ONE store; writes land in the shared backing", async () => {
    // The shared, expensive resource — one instance (imagine a Pg pool).
    const store = inMemoryCredentialsStore();

    // Two cheap per-scope harness instances over it.
    const userA = scopedHarness("cred:user-a", store);
    const userB = scopedHarness("cred:user-b", store);

    await userA.set("user-a", "linear.token", "tok-A");
    await userB.set("user-b", "linear.token", "tok-B");

    // Both writes are in the SAME backing store (shared resource) —
    // readable directly off the store, no second connection.
    expect(await store.get("user-a", "linear.token", stubStoreCtx())).toBe("tok-A");
    expect(await store.get("user-b", "linear.token", stubStoreCtx())).toBe("tok-B");

    await userA.close();
    await userB.close();
  });

  it("namespace isolation: distinct namespaces don't observe each other over the shared store", async () => {
    const store = inMemoryCredentialsStore();
    const userA = scopedHarness("cred:user-a", store);
    const userB = scopedHarness("cred:user-b", store);

    await userA.set("user-a", "linear.token", "tok-A");

    // User B, reading its OWN namespace, does not see user A's secret.
    expect(await userB.get("user-b", "linear.token")).toBeUndefined();
    // The mechanism (namespace = isolation) holds over one shared store.
    expect(await userA.get("user-a", "linear.token")).toBe("tok-A");

    await userA.close();
    await userB.close();
  });

  it("GAP (ADR 48): isolation is caller-supplied per-call, not construction-bound", async () => {
    // This test documents the chafe, not a desired property. Today a
    // harness will happily read ANY namespace it's asked for — the
    // scope is not bound to the instance. userB can read userA's
    // secret simply by passing userA's namespace.
    const store = inMemoryCredentialsStore();
    const userA = scopedHarness("cred:user-a", store);
    const userB = scopedHarness("cred:user-b", store);

    await userA.set("user-a", "linear.token", "tok-A");

    // userB reaches into userA's namespace — nothing structural stops
    // it, because the namespace is a per-call argument.
    expect(await userB.get("user-a", "linear.token")).toBe("tok-A");

    // ADR 48 target (NOT yet implemented): a scoped harness binds its
    // namespace prefix at construction, so `userB.get("linear.token")`
    // can only ever resolve within userB's scope — cross-scope reads
    // become unrepresentable, not merely discouraged. That construction
    // binding is the next concrete step.

    await userA.close();
    await userB.close();
  });
});

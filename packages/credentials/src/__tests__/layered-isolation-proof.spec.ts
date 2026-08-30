/**
 * ADR 48 / ADR 107 — "per-scope harness instance over a shared backing
 * resource, isolated by namespace", re-proven against the provider registry.
 *
 * Proven here:
 *
 *   1. RESOURCE SHARING — N per-scope harnesses share ONE provider instance
 *      (the "one Pg pool, many scoped views" shape). No per-scope connection.
 *   2. ROUTING — a namespace has exactly one provider, an unregistered one is a
 *      loud error rather than an empty read, and a second claim on a namespace
 *      is refused instead of silently shadowing the first.
 *   3. POLICY ON READ — the gap the previous version of this file documented as
 *      unfixed is now closed. A harness still routes any namespace it is asked
 *      for, but the PROVIDER receives `StoreCtx` (which extends
 *      `RuntimeContext`), so it sees the acting principal and can refuse. A
 *      namespace is a naming scheme; the principal check is the boundary.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { stubStoreCtx } from "@agentick/store";
import type { StoreCtx } from "@agentick/spec";

import { CredentialsHarness } from "../harness.js";
import { defineCredentialProvider } from "../define-provider.js";
import { inMemoryCredentialProvider } from "../providers/in-memory.js";
import { DuplicateCredentialNamespace, UnknownCredentialNamespace } from "../errors.js";
import type { CredentialProvider } from "../provider.js";

/** A per-scope harness over caller-supplied providers. */
function scopedHarness(scopeId: string, ...providers: CredentialProvider[]): CredentialsHarness {
  return new CredentialsHarness(
    scopeId,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { providers },
  );
}

describe("layered isolation over a shared backing resource", () => {
  it("N per-scope harnesses share ONE provider instance", async () => {
    // The shared, expensive resource — one instance (imagine a Pg pool).
    const shared = inMemoryCredentialProvider({ namespace: "tokens" });

    const userA = scopedHarness("cred:user-a", shared);
    const userB = scopedHarness("cred:user-b", shared);

    await userA.set("tokens", "user-a.linear", "tok-A");
    await userB.set("tokens", "user-b.linear", "tok-B");

    // Both writes landed in the same backing instance — readable through either
    // harness, and directly off the provider, with no second connection.
    expect(await userB.get("tokens", "user-a.linear")).toBe("tok-A");
    expect(await shared.get("user-b.linear", stubStoreCtx())).toBe("tok-B");

    await userA.close();
    await userB.close();
  });

  it("routing is exact: an unregistered namespace is an error, not an empty read", async () => {
    const harness = scopedHarness("cred:routing", inMemoryCredentialProvider({ namespace: "a" }));

    await expect(harness.get("nope", "k")).rejects.toBeInstanceOf(UnknownCredentialNamespace);
    expect(await harness.get("a", "k")).toBeUndefined();

    await harness.close();
  });

  it("a namespace has one owner — a second claim is refused, never shadowed", async () => {
    const harness = scopedHarness("cred:dup", inMemoryCredentialProvider({ namespace: "a" }));

    await expect(harness.register(inMemoryCredentialProvider({ namespace: "a" }))).rejects.toThrow(
      DuplicateCredentialNamespace,
    );

    await harness.close();
  });
});

describe("policy on read — the provider sees who is asking", () => {
  it("a provider can serve one principal and refuse another over the same namespace", async () => {
    // What the previous version of this file recorded as an unfixed gap: a
    // harness routes any namespace it is handed. It still does — but the
    // provider is handed the acting principal, so the refusal has a home.
    const owned = defineCredentialProvider({
      namespace: "tokens",
      backend: "principal-scoped",
      get: <T>(key: string, ctx: StoreCtx): Promise<T | undefined> => {
        const [owner] = key.split(":");
        if (owner !== ctx.principal) return Promise.resolve(undefined);
        return Promise.resolve(`secret-for-${owner}` as unknown as T);
      },
    });

    const asA = new CredentialsHarness(
      "cred:a",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      { providers: [owned], principal: "user-a" },
    );

    expect(await asA.get("tokens", "user-a:linear")).toBe("secret-for-user-a");
    // Reaching for another principal's key over the same namespace resolves
    // nothing — the provider, not the namespace, is the boundary.
    expect(await asA.get("tokens", "user-b:linear")).toBeUndefined();

    await asA.close();
  });
});

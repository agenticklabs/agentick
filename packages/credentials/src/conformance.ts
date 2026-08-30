/**
 * Conformance suite for {@link CredentialProvider} implementations (ADR 107).
 *
 * Every bundled provider and every adopter-written one (1Password, Vault, AWS
 * Secrets Manager, a token minter) should pass this.
 *
 * Runs per PROVIDER rather than per store, because a namespace now has exactly
 * one owner and a provider never sees another's keys. Namespace isolation is a
 * property of the harness's routing, tested there — not of a provider that only
 * ever serves one.
 *
 * Capabilities are declared rather than sniffed: a minter legitimately has no
 * `set` and no `keys`, and asserting round-trips against one would fail a
 * correct implementation. Declare what the provider supports, and the suite
 * checks the OMISSIONS are honest too — an absent verb must be genuinely absent,
 * because the harness reports one as unsupported and a present one as success.
 */

import { expect, it } from "vitest";
import { stubStoreCtx } from "@agentick/store";

import type { CredentialProvider } from "./provider.js";

const ctx = stubStoreCtx();

export interface CredentialProviderConformanceOptions {
  /** Display label, prefixed onto each case. */
  readonly label: string;
  /** Builds a FRESH provider per case. */
  readonly factory: () => CredentialProvider | Promise<CredentialProvider>;
  readonly capabilities?: {
    /** `set` / `delete` supported. Defaults to true. */
    readonly writable?: boolean;
    /** `keys` supported. Defaults to `writable`. */
    readonly enumerable?: boolean;
    /** `onChange` supported. Defaults to true. */
    readonly reactivity?: boolean;
  };
}

export function runCredentialProviderConformance(opts: CredentialProviderConformanceOptions): void {
  const writable = opts.capabilities?.writable ?? true;
  const enumerable = opts.capabilities?.enumerable ?? writable;
  const reactivity = opts.capabilities?.reactivity ?? true;
  const setup = async (): Promise<CredentialProvider> => opts.factory();

  it(`${opts.label}: declares a namespace and a backend`, async () => {
    const provider = await setup();
    expect(provider.namespace.length).toBeGreaterThan(0);
    expect(provider.backend.length).toBeGreaterThan(0);
  });

  it(`${opts.label}: an absent key resolves undefined, never throws`, async () => {
    const provider = await setup();
    expect(await provider.get("no-such-key", ctx)).toBeUndefined();
  });

  it(`${opts.label}: declared capabilities match the implemented verbs`, async () => {
    const provider = await setup();
    expect(typeof provider.set === "function").toBe(writable);
    expect(typeof provider.delete === "function").toBe(writable);
    expect(typeof provider.keys === "function").toBe(enumerable);
  });

  it.skipIf(!writable)(`${opts.label}: round-trips a value through set/get`, async () => {
    const provider = await setup();
    await provider.set!("k", { token: "abc", expires: 1000 }, ctx);
    expect(await provider.get<{ token: string; expires: number }>("k", ctx)).toEqual({
      token: "abc",
      expires: 1000,
    });
  });

  it.skipIf(!writable)(`${opts.label}: overwrites prior values on repeat set`, async () => {
    const provider = await setup();
    await provider.set!("k", "first", ctx);
    await provider.set!("k", "second", ctx);
    expect(await provider.get<string>("k", ctx)).toBe("second");
  });

  it.skipIf(!writable)(`${opts.label}: delete removes, and is idempotent`, async () => {
    const provider = await setup();
    await provider.set!("k", "v", ctx);
    expect(await provider.delete!("k", ctx)).toBe(true);
    expect(await provider.get("k", ctx)).toBeUndefined();
    expect(await provider.delete!("k", ctx)).toBe(false);
  });

  it.skipIf(!writable)(`${opts.label}: has() tracks set and delete`, async () => {
    const provider = await setup();
    const present = async (key: string): Promise<boolean> =>
      provider.has ? provider.has(key, ctx) : (await provider.get(key, ctx)) !== undefined;
    expect(await present("k")).toBe(false);
    await provider.set!("k", "v", ctx);
    expect(await present("k")).toBe(true);
    await provider.delete!("k", ctx);
    expect(await present("k")).toBe(false);
  });

  it.skipIf(!enumerable || !writable)(`${opts.label}: keys() lists what was set`, async () => {
    const provider = await setup();
    expect(await provider.keys!(ctx)).toEqual([]);
    await provider.set!("a", 1, ctx);
    await provider.set!("b", 2, ctx);
    expect([...(await provider.keys!(ctx))].sort()).toEqual(["a", "b"]);
  });

  it.skipIf(!writable || !reactivity)(
    `${opts.label}: notifies subscribers with the KEY only`,
    async () => {
      const provider = await setup();
      if (!provider.onChange) return;
      const keys: string[] = [];
      const unsubscribe = provider.onChange((key) => keys.push(key));
      await provider.set!("k", "v", ctx);
      await provider.delete!("k", ctx);
      expect(keys).toEqual(["k", "k"]);
      unsubscribe();
      await provider.set!("k2", "v2", ctx);
      expect(keys).toHaveLength(2);
    },
  );
}

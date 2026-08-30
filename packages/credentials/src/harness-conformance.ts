/**
 * Conformance suite for `CredentialsHarness` implementations.
 *
 * Separate from `runCredentialsStoreConformance` (which pins the
 * adapter contract): this suite pins the **harness** contract on top
 * of the store — fan-out semantics, listener isolation, close
 * idempotency, close drops subscriptions.
 *
 * Adopter alternatives to `CredentialsHarness` (e.g., cluster-aware
 * wrappers, audit-log decorators) run this same suite to guarantee
 * substrate compliance.
 */

import { describe, expect, it } from "vitest";

import type { CredentialsHarnessProtocol } from "@agentick/spec";
import { stubStoreCtx } from "@agentick/store";

import type { CredentialProvider } from "./provider.js";

export interface CredentialsHarnessConformanceOptions {
  readonly label: string;
  /**
   * Factory for a fresh `CredentialsHarness` (or compatible impl). The
   * returned store reference is given back so the suite can drive
   * external-change scenarios against the adapter directly while
   * observing harness fan-out.
   */
  readonly factory: () => Promise<{
    readonly harness: CredentialsHarnessProtocol;
    readonly provider: CredentialProvider;
  }>;
}

export function runCredentialsHarnessConformance(opts: CredentialsHarnessConformanceOptions): void {
  describe(`CredentialsHarness conformance — ${opts.label}`, () => {
    it("fans out internal set/delete to subscribers", async () => {
      const { harness, provider } = await opts.factory();
      const ns = provider.namespace;
      const events: Array<{ namespace: string; key: string }> = [];
      const off = harness.subscribe((ev) => {
        events.push({ namespace: ev.namespace, key: ev.key });
      });
      await harness.set(ns, "srv-a", { access_token: "t" });
      await harness.delete(ns, "srv-a");
      off();
      expect(events).toEqual([
        { namespace: ns, key: "srv-a" },
        { namespace: ns, key: "srv-a" },
      ]);
      await harness.close();
    });

    it("forwards external store changes to subscribers (when adapter supports onChange)", async () => {
      const { harness, provider } = await opts.factory();
      const ns = provider.namespace;
      if (!provider.onChange) {
        // Stores without native reactivity can't surface external
        // changes — the harness only sees writes routed through itself.
        // Skip rather than fail.
        await harness.close();
        return;
      }
      const events: Array<{ namespace: string; key: string }> = [];
      const off = harness.subscribe((ev) => {
        events.push({ namespace: ev.namespace, key: ev.key });
      });
      // Write through the adapter directly — simulates a sibling
      // process editing the keychain.
      await provider.set!("srv-b", { access_token: "external" }, stubStoreCtx());
      off();
      expect(events).toEqual([{ namespace: ns, key: "srv-b" }]);
      await harness.close();
    });

    it("does NOT double-publish when adapter has native onChange", async () => {
      const { harness, provider } = await opts.factory();
      const ns = provider.namespace;
      if (!provider.onChange) {
        await harness.close();
        return;
      }
      const events: Array<{ namespace: string; key: string }> = [];
      const off = harness.subscribe((ev) => {
        events.push({ namespace: ev.namespace, key: ev.key });
      });
      // Internal write routes through both the harness's set AND the
      // adapter's onChange — but should produce exactly one event.
      await harness.set(ns, "srv-c", "v");
      off();
      expect(events).toHaveLength(1);
      await harness.close();
    });

    it("publishes nothing on a no-op delete (key was absent)", async () => {
      const { harness, provider } = await opts.factory();
      const ns = provider.namespace;
      const events: Array<unknown> = [];
      const off = harness.subscribe((ev) => events.push(ev));
      const removed = await harness.delete(ns, "never-set");
      off();
      expect(removed).toBe(false);
      expect(events).toEqual([]);
      await harness.close();
    });

    it("isolates listener errors — one buggy listener doesn't break siblings", async () => {
      const { harness, provider } = await opts.factory();
      const ns = provider.namespace;
      const good: Array<{ namespace: string; key: string }> = [];
      harness.subscribe(() => {
        throw new Error("intentional");
      });
      harness.subscribe((ev) => good.push({ namespace: ev.namespace, key: ev.key }));
      await harness.set(ns, "k", "v");
      expect(good).toEqual([{ namespace: ns, key: "k" }]);
      await harness.close();
    });

    it("subscribe() returns Unsubscribe that stops future events", async () => {
      const { harness, provider } = await opts.factory();
      const ns = provider.namespace;
      const events: Array<unknown> = [];
      const off = harness.subscribe((ev) => events.push(ev));
      await harness.set(ns, "k1", "v");
      off();
      await harness.set(ns, "k2", "v");
      expect(events).toHaveLength(1);
      await harness.close();
    });

    it("close() drops subscribers and stops fan-out", async () => {
      const { harness, provider } = await opts.factory();
      const ns = provider.namespace;
      const events: Array<unknown> = [];
      harness.subscribe((ev) => events.push(ev));
      await harness.close();
      // Drive a post-close write directly against the adapter — if
      // the harness failed to unsubscribe its forwarder OR failed to
      // clear its notifier, the listener would fire here.
      if (provider.onChange) {
        await provider.set!("post-close", "v", stubStoreCtx());
      }
      // ...and through the harness itself, for impls whose set/delete
      // path publishes independently of the adapter's onChange.
      try {
        await harness.set(ns, "post-close-harness", "v");
      } catch {
        // Adopter impls that throw on post-close writes (#281b.2 candidate)
        // are conformant — what matters is that NO event surfaced.
      }
      expect(events).toEqual([]);
    });

    it("close() is idempotent", async () => {
      const { harness } = await opts.factory();
      await harness.close();
      await harness.close();
    });

    it("exposes id + address with the BaseHarness convention", async () => {
      const { harness } = await opts.factory();
      expect(typeof harness.id).toBe("string");
      expect(harness.id.length).toBeGreaterThan(0);
      expect(harness.address).toBe(`credentials:${harness.id}`);
      await harness.close();
    });
  });
}

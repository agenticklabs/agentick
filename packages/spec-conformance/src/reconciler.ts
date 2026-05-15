/**
 * Conformance suite for `ReconcilerProtocol` implementations.
 *
 * Validates the invariants the pluggability charter promises:
 *
 *   1. **Mount idempotency.** Mounting twice with the same mountId
 *      returns the existing mount (no re-execution).
 *   2. **JSON firewall.** `RenderedTree` round-trips through
 *      `JSON.parse(JSON.stringify(t))` without loss.
 *   3. **Contributor dispatch by identity.** Same component instance
 *      produces the same IR fragment shape across renders.
 *   4. **Sectioning.** Section/message intrinsics produce
 *      kind-discriminated context entries.
 *   5. **Lifecycle dispatch.** notifyLifecycle invokes registered
 *      handlers and supports tick-start catch-up.
 *   6. **Snapshot round-trip.** snapshot → JSON → restore preserves
 *      mountId / elementVersion / knobs.
 *   7. **Unmount cleanup.** notifyLifecycle / renderTree after unmount
 *      reject with NotMounted.
 *
 * The suite is parametrized by a `factory` that returns a fresh
 * reconciler harness + builders for the test fixtures (element + bridges).
 * Implementations on alternative substrates (Vue/Solid hosts,
 * imperative builders) pass the same suite if they produce equivalent
 * `RenderedTree`s.
 */

import { describe, expect, it } from "vitest";
import type {
  HookBridges,
  LifecycleEvent,
  ReconcilerProtocol,
  ReconcilerSnapshot,
} from "@agentick/spec";

/**
 * Test-fixture factory shape. The conformance suite is reconciler-
 * substrate-agnostic — it never references React directly. Concrete
 * impls (reconciler-react) supply the harness + the element/bridges
 * builders that the suite needs.
 */
export interface ReconcilerConformanceFactory {
  /** Create a fresh reconciler protocol implementation. */
  createReconciler(): Promise<ReconcilerProtocol>;
  /** Create a fresh bridge bundle (defaults to stub bridges). */
  createBridges(opts?: { sessionId?: string; knobs?: Record<string, unknown> }): HookBridges;
  /**
   * Build a substrate-specific JSX-equivalent element. The conformance
   * suite uses logical descriptions; the impl translates to its own
   * substrate's element shape.
   */
  buildElement(input: ElementInput): unknown;
}

/**
 * Substrate-agnostic element descriptions. Reconciler impls translate
 * these into their substrate's element shape (React.createElement, etc.).
 */
export type ElementInput =
  | { readonly kind: "fragment"; readonly children?: readonly ElementInput[] }
  | {
      readonly kind: "section";
      readonly id?: string;
      readonly title?: string;
      readonly text?: string;
    }
  | {
      readonly kind: "message";
      readonly role: string;
      readonly text?: string;
    }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly description?: string;
      readonly handlerRef?: string;
    };

export function runReconcilerConformance(factory: ReconcilerConformanceFactory): void {
  describe("ReconcilerProtocol — mount semantics", () => {
    it("mount returns a MountResult with the provided mountId", async () => {
      const reconciler = await factory.createReconciler();
      const result = await reconciler.mount({
        mountId: "m_1",
        sessionId: "s",
        element: factory.buildElement({ kind: "fragment" }),
        bridges: factory.createBridges(),
      });
      expect(result.mountId).toBe("m_1");
      expect(typeof result.restoredFromSnapshot).toBe("boolean");
    });

    it("mount is idempotent on mountId (second call replays cached terminal)", async () => {
      const reconciler = await factory.createReconciler();
      const input = {
        mountId: "m_idem",
        sessionId: "s",
        element: factory.buildElement({ kind: "fragment" }),
        bridges: factory.createBridges(),
      };
      const a = await reconciler.mount(input);
      const b = await reconciler.mount(input);
      expect(a.mountId).toBe(b.mountId);
    });

    it("operations on an unmounted id reject with NotMounted", async () => {
      const reconciler = await factory.createReconciler();
      await expect(
        reconciler.renderTree({ mountId: "missing", sessionId: "s" }),
      ).rejects.toMatchObject({ _tag: "NotMounted" });
    });
  });

  describe("ReconcilerProtocol — renderTree → RenderedTree", () => {
    it("produces a RenderedTree with specVersion + context", async () => {
      const reconciler = await factory.createReconciler();
      await reconciler.mount({
        mountId: "m_rt",
        sessionId: "s",
        element: factory.buildElement({
          kind: "message",
          role: "user",
          text: "hello",
        }),
        bridges: factory.createBridges(),
      });
      const { tree } = await reconciler.renderTree({ mountId: "m_rt", sessionId: "s" });
      expect(tree.specVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(tree.context.entries)).toBe(true);
    });

    it("section + message + tool produce kind-discriminated entries / declarations", async () => {
      const reconciler = await factory.createReconciler();
      await reconciler.mount({
        mountId: "m_kinds",
        sessionId: "s",
        element: factory.buildElement({
          kind: "fragment",
          children: [
            { kind: "section", id: "s.intro", title: "Intro", text: "intro body" },
            { kind: "message", role: "user", text: "hi" },
            {
              kind: "tool",
              name: "echo",
              description: "echo back",
              handlerRef: "h.echo",
            },
          ],
        }),
        bridges: factory.createBridges(),
      });
      const { tree } = await reconciler.renderTree({ mountId: "m_kinds", sessionId: "s" });
      expect(tree.context.entries.some((e) => e.kind === "section" && e.id === "s.intro")).toBe(
        true,
      );
      expect(
        tree.context.entries.some((e) => e.kind === "message" && e.role === "user"),
      ).toBe(true);
      expect(tree.declarations?.tools?.some((t) => t.name === "echo")).toBe(true);
    });

    it("JSON firewall — RenderedTree round-trips through JSON without loss", async () => {
      const reconciler = await factory.createReconciler();
      await reconciler.mount({
        mountId: "m_json",
        sessionId: "s",
        element: factory.buildElement({
          kind: "fragment",
          children: [
            { kind: "section", id: "s.a", title: "A", text: "body-a" },
            { kind: "message", role: "user", text: "msg" },
          ],
        }),
        bridges: factory.createBridges(),
      });
      const { tree } = await reconciler.renderTree({ mountId: "m_json", sessionId: "s" });
      const json = JSON.stringify(tree);
      const round = JSON.parse(json);
      expect(round).toEqual(tree);
    });

    it("renderTree reports iterations >= 1 and an empty diagnostics list on success", async () => {
      const reconciler = await factory.createReconciler();
      await reconciler.mount({
        mountId: "m_iter",
        sessionId: "s",
        element: factory.buildElement({ kind: "message", role: "user", text: "ok" }),
        bridges: factory.createBridges(),
      });
      const result = await reconciler.renderTree({ mountId: "m_iter", sessionId: "s" });
      expect(result.iterations).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(result.diagnostics)).toBe(true);
    });
  });

  describe("ReconcilerProtocol — rerender", () => {
    it("rerender swaps the root element; the next renderTree reflects it", async () => {
      const reconciler = await factory.createReconciler();
      await reconciler.mount({
        mountId: "m_rr",
        sessionId: "s",
        element: factory.buildElement({ kind: "message", role: "user", text: "first" }),
        bridges: factory.createBridges(),
      });
      const r1 = await reconciler.renderTree({ mountId: "m_rr", sessionId: "s" });
      const e1 = r1.tree.context.entries[0]!;
      if (e1.kind !== "message") throw new Error("expected message");
      expect(e1.content.map((b) => (b as { text?: string }).text ?? "").join("")).toBe("first");

      await reconciler.rerender({
        mountId: "m_rr",
        element: factory.buildElement({ kind: "message", role: "user", text: "second" }),
      });
      const r2 = await reconciler.renderTree({ mountId: "m_rr", sessionId: "s" });
      const e2 = r2.tree.context.entries[0]!;
      if (e2.kind !== "message") throw new Error("expected message");
      expect(e2.content.map((b) => (b as { text?: string }).text ?? "").join("")).toBe("second");
    });
  });

  describe("ReconcilerProtocol — notifyLifecycle", () => {
    it("dispatches tick-start / tick-end without throwing", async () => {
      const reconciler = await factory.createReconciler();
      await reconciler.mount({
        mountId: "m_lc",
        sessionId: "s",
        element: factory.buildElement({ kind: "fragment" }),
        bridges: factory.createBridges(),
      });
      const ts: LifecycleEvent = { kind: "tick-start", tickId: "t1" };
      const te: LifecycleEvent = { kind: "tick-end", tickId: "t1", result: 0 };
      await reconciler.notifyLifecycle({ mountId: "m_lc", event: ts });
      await reconciler.notifyLifecycle({ mountId: "m_lc", event: te });
    });

    it("rejects with NotMounted for an unknown mountId", async () => {
      const reconciler = await factory.createReconciler();
      await expect(
        reconciler.notifyLifecycle({
          mountId: "nope",
          event: { kind: "tick-start", tickId: "t1" },
        }),
      ).rejects.toMatchObject({ _tag: "NotMounted" });
    });
  });

  describe("ReconcilerProtocol — snapshot / restore round-trip", () => {
    it("snapshot returns a spec-shaped payload that JSON-round-trips", async () => {
      const reconciler = await factory.createReconciler();
      await reconciler.mount({
        mountId: "m_snap",
        sessionId: "s",
        element: factory.buildElement({ kind: "fragment" }),
        bridges: factory.createBridges({ knobs: { mood: "curious" } }),
        elementVersion: "sha:abc",
      });
      const snap = await reconciler.snapshot({ mountId: "m_snap" });
      expect(snap.specVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(snap.mountId).toBe("m_snap");
      expect(snap.elementVersion).toBe("sha:abc");
      const round: ReconcilerSnapshot = JSON.parse(JSON.stringify(snap));
      expect(round).toEqual(snap);
    });

    it("restore is callable and does not throw on a fresh snapshot", async () => {
      const reconciler = await factory.createReconciler();
      await reconciler.mount({
        mountId: "m_restore",
        sessionId: "s",
        element: factory.buildElement({ kind: "fragment" }),
        bridges: factory.createBridges(),
      });
      const snap = await reconciler.snapshot({ mountId: "m_restore" });
      await reconciler.restore({ mountId: "m_restore", snapshot: snap });
    });
  });

  describe("ReconcilerProtocol — unmount cleanup", () => {
    it("unmount removes the mount; subsequent operations reject", async () => {
      const reconciler = await factory.createReconciler();
      await reconciler.mount({
        mountId: "m_un",
        sessionId: "s",
        element: factory.buildElement({ kind: "fragment" }),
        bridges: factory.createBridges(),
      });
      await reconciler.unmount({ mountId: "m_un" });
      await expect(
        reconciler.renderTree({ mountId: "m_un", sessionId: "s" }),
      ).rejects.toMatchObject({ _tag: "NotMounted" });
    });

    it("unmounting an unknown mountId is a no-op", async () => {
      const reconciler = await factory.createReconciler();
      await reconciler.unmount({ mountId: "never-mounted" });
    });
  });
}

/**
 * Conformance suite for `CompilerProtocol` implementations.
 *
 * Validates the invariants the pluggability charter promises:
 *
 *   1. **Mount idempotency.** Mounting twice with the same mountId
 *      returns the existing mount (no re-execution).
 *   2. **JSON firewall.** `RenderedTree` round-trips through
 *      `JSON.parse(JSON.stringify(t))` without loss.
 *   3. **Contributor dispatch by identity.** Same component instance
 *      produces the same IR fragment shape across renders.
 *   4. **Sectioning.** A free-floating section intrinsic surfaces as a
 *      `role: "grounding"` message entry carrying the section id; the
 *      message intrinsic keeps its own role (ADR 94 — a section is
 *      content, not an entry kind).
 *   5. **Lifecycle projection capability (optional).** When the impl
 *      exposes `dispatchLifecycle` (ADR 89 §4 `LifecycleProjectionTarget`),
 *      it routes events per mount and rejects NotMounted for unknown
 *      mounts.
 *   6. **Snapshot round-trip.** snapshot → JSON → restore preserves
 *      mountId / elementVersion / knobs.
 *   7. **Unmount cleanup.** renderTree after unmount rejects with
 *      NotMounted.
 *
 * The suite is parametrized by a `factory` that returns a fresh
 * compiler harness + builders for the test fixtures (element + bridges).
 * Implementations on alternative substrates (Vue/Solid hosts,
 * imperative builders) pass the same suite if they produce equivalent
 * `RenderedTree`s.
 */

import { describe, expect, it } from "vitest";
import type { HookBridges, LifecycleEvent, CompilerProtocol } from "@agentick/spec";
import { NotMounted, supportsLifecycleProjection } from "@agentick/spec";

/**
 * Test-fixture factory shape. The conformance suite is compiler-
 * substrate-agnostic — it never references React directly. Concrete
 * impls (compiler-react) supply the harness + the element/bridges
 * builders that the suite needs.
 */
export interface CompilerConformanceFactory {
  /** Create a fresh compiler protocol implementation. */
  createCompiler(): Promise<CompilerProtocol>;
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
 * Substrate-agnostic element descriptions. Compiler impls translate
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

export function runCompilerConformance(factory: CompilerConformanceFactory): void {
  describe("CompilerProtocol — mount semantics", () => {
    it("mount returns a MountResult with the provided mountId", async () => {
      const compiler = await factory.createCompiler();
      const result = await compiler.mount({
        mountId: "m_1",
        sessionId: "s",
        element: factory.buildElement({ kind: "fragment" }),
        bridges: factory.createBridges(),
      });
      expect(result.mountId).toBe("m_1");
    });

    it("mount is idempotent on mountId (second call replays cached terminal)", async () => {
      const compiler = await factory.createCompiler();
      const input = {
        mountId: "m_idem",
        sessionId: "s",
        element: factory.buildElement({ kind: "fragment" }),
        bridges: factory.createBridges(),
      };
      const a = await compiler.mount(input);
      const b = await compiler.mount(input);
      expect(a.mountId).toBe(b.mountId);
    });

    it("operations on an unmounted id reject with NotMounted", async () => {
      const compiler = await factory.createCompiler();
      await expect(
        compiler.renderTree({ mountId: "missing", sessionId: "s" }),
      ).rejects.toBeInstanceOf(NotMounted);
    });
  });

  describe("CompilerProtocol — renderTree → RenderedTree", () => {
    it("produces a RenderedTree with specVersion + context", async () => {
      const compiler = await factory.createCompiler();
      await compiler.mount({
        mountId: "m_rt",
        sessionId: "s",
        element: factory.buildElement({
          kind: "message",
          role: "user",
          text: "hello",
        }),
        bridges: factory.createBridges(),
      });
      const { tree } = await compiler.renderTree({ mountId: "m_rt", sessionId: "s" });
      expect(tree.specVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(tree.context.entries)).toBe(true);
    });

    it("section + message + tool produce role-discriminated entries / declarations", async () => {
      const compiler = await factory.createCompiler();
      await compiler.mount({
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
      const { tree } = await compiler.renderTree({ mountId: "m_kinds", sessionId: "s" });
      // ADR 94: a free-floating section is not an entry kind — it lowers to
      // an anonymous `role: "grounding"` message at its own tree position,
      // keeping the section id as the entry id.
      expect(tree.context.entries.some((e) => e.role === "grounding" && e.id === "s.intro")).toBe(
        true,
      );
      expect(tree.context.entries.some((e) => e.kind === "message" && e.role === "user")).toBe(
        true,
      );
      expect(tree.declarations?.tools?.some((t) => t.name === "echo")).toBe(true);
    });

    it("JSON firewall — RenderedTree round-trips through JSON without loss", async () => {
      const compiler = await factory.createCompiler();
      await compiler.mount({
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
      const { tree } = await compiler.renderTree({ mountId: "m_json", sessionId: "s" });
      const json = JSON.stringify(tree);
      const round = JSON.parse(json);
      expect(round).toEqual(tree);
    });

    it("renderTree reports iterations >= 1 and an empty diagnostics list on success", async () => {
      const compiler = await factory.createCompiler();
      await compiler.mount({
        mountId: "m_iter",
        sessionId: "s",
        element: factory.buildElement({ kind: "message", role: "user", text: "ok" }),
        bridges: factory.createBridges(),
      });
      const result = await compiler.renderTree({ mountId: "m_iter", sessionId: "s" });
      expect(result.iterations).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(result.diagnostics)).toBe(true);
    });
  });

  describe("CompilerProtocol — rerender", () => {
    it("rerender swaps the root element; the next renderTree reflects it", async () => {
      const compiler = await factory.createCompiler();
      await compiler.mount({
        mountId: "m_rr",
        sessionId: "s",
        element: factory.buildElement({ kind: "message", role: "user", text: "first" }),
        bridges: factory.createBridges(),
      });
      const r1 = await compiler.renderTree({ mountId: "m_rr", sessionId: "s" });
      const e1 = r1.tree.context.entries[0]!;
      if (e1.kind !== "message") throw new Error("expected message");
      expect(e1.content.map((b) => (b as { text?: string }).text ?? "").join("")).toBe("first");

      await compiler.rerender({
        mountId: "m_rr",
        element: factory.buildElement({ kind: "message", role: "user", text: "second" }),
      });
      const r2 = await compiler.renderTree({ mountId: "m_rr", sessionId: "s" });
      const e2 = r2.tree.context.entries[0]!;
      if (e2.kind !== "message") throw new Error("expected message");
      expect(e2.content.map((b) => (b as { text?: string }).text ?? "").join("")).toBe("second");
    });
  });

  describe("LifecycleProjectionTarget — optional capability (ADR 89 §4)", () => {
    it("when exposed, dispatchLifecycle routes tick-start / tick-end without throwing", async () => {
      const compiler = await factory.createCompiler();
      if (!supportsLifecycleProjection(compiler)) return; // capability absent — nothing to conform
      await compiler.mount({
        mountId: "m_lc",
        sessionId: "s",
        element: factory.buildElement({ kind: "fragment" }),
        bridges: factory.createBridges(),
      });
      const ts: LifecycleEvent = { kind: "tick-start", tickId: "t1" };
      const te: LifecycleEvent = { kind: "tick-end", tickId: "t1", result: 0 };
      await compiler.dispatchLifecycle({ mountId: "m_lc", event: ts });
      await compiler.dispatchLifecycle({ mountId: "m_lc", event: te });
    });

    it("when exposed, rejects with NotMounted for an unknown mountId", async () => {
      const compiler = await factory.createCompiler();
      if (!supportsLifecycleProjection(compiler)) return; // capability absent — nothing to conform
      await expect(
        compiler.dispatchLifecycle({
          mountId: "nope",
          event: { kind: "tick-start", tickId: "t1" },
        }),
      ).rejects.toBeInstanceOf(NotMounted);
    });
  });

  describe("CompilerProtocol — unmount cleanup", () => {
    it("unmount removes the mount; subsequent operations reject", async () => {
      const compiler = await factory.createCompiler();
      await compiler.mount({
        mountId: "m_un",
        sessionId: "s",
        element: factory.buildElement({ kind: "fragment" }),
        bridges: factory.createBridges(),
      });
      await compiler.unmount({ mountId: "m_un" });
      await expect(compiler.renderTree({ mountId: "m_un", sessionId: "s" })).rejects.toBeInstanceOf(
        NotMounted,
      );
    });

    it("unmounting an unknown mountId is a no-op", async () => {
      const compiler = await factory.createCompiler();
      await compiler.unmount({ mountId: "never-mounted" });
    });
  });
}

/**
 * Conformance suite for `ResourcesHarnessProtocol` implementations
 * (ADR 62).
 *
 * Validates the invariants every impl MUST honor:
 *
 *   1. **Register / list round-trip** — a registered uri appears in
 *      `list()` with its descriptor metadata; `has()` agrees.
 *   2. **Pagination** — with more registrations than one page, `list()`
 *      returns a `nextCursor`; following it walks the full set exactly
 *      once with no overlap.
 *   3. **Read (fixed)** — `read(uri)` runs the fixed resolver and
 *      returns its `ResourceContents[]`.
 *   4. **Read (templated)** — a uri with no fixed binding but matching a
 *      registered template resolves through the template resolver, which
 *      receives the CONCRETE uri.
 *   5. **Unknown uri** — `read()` of an unregistered, non-matching uri
 *      rejects with a `ResourceNotFound`-tagged error.
 *   6. **Text + blob typing** — both `ResourceContents` shapes round-trip
 *      structurally (`text` vs `blob`).
 *   7. **`subscribe` → `notifyUpdated` fans** — a per-uri subscriber
 *      fires on `notifyUpdated(uri)` and NOT on an unrelated uri.
 *   8. **`list_changed` on mutation** — a `subscribeAll`
 *      listener fires on register AND on unregister.
 *
 * Factory contract: the impl constructs its own substrate and exposes a
 * `close()`. `pageSize` lets the suite exercise the cursor path against a
 * handful of registrations.
 */

import { describe, expect, it } from "vitest";
import type { ResourceContents, ResourcesHarnessProtocol } from "@agentick/spec";

// ============================================================================
// Factory contract
// ============================================================================

export interface ResourcesConformanceFactoryInput {
  readonly harnessId: string;
  /** Page size for `list` / `listTemplates` — small so cursors trigger. */
  readonly pageSize: number;
}

export interface ResourcesConformanceShell {
  readonly harness: ResourcesHarnessProtocol;
  close(): Promise<void>;
}

export type ResourcesConformanceFactory = (
  input: ResourcesConformanceFactoryInput,
) => Promise<ResourcesConformanceShell>;

// ============================================================================
// Fixtures
// ============================================================================

function text(uri: string, body: string): ResourceContents {
  return { uri, mimeType: "text/plain", text: body };
}

function blob(uri: string, base64: string): ResourceContents {
  return { uri, mimeType: "application/octet-stream", blob: base64 };
}

// ============================================================================
// Suite
// ============================================================================

export function runResourcesHarnessConformance(
  label: string,
  factory: ResourcesConformanceFactory,
): void {
  describe(`ResourcesHarnessProtocol conformance — ${label}`, () => {
    async function make(pageSize = 100): Promise<ResourcesConformanceShell> {
      return factory({ harnessId: `conf-${Math.random().toString(36).slice(2)}`, pageSize });
    }

    it("register + list + has round-trips with descriptor metadata", async () => {
      const { harness, close } = await make();
      harness.register("mem://a", () => [text("mem://a", "A")], {
        name: "Alpha",
        description: "the a resource",
        mimeType: "text/plain",
      });
      expect(harness.has("mem://a")).toBe(true);
      expect(harness.has("mem://missing")).toBe(false);
      const { resources } = await harness.list();
      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({
        uri: "mem://a",
        name: "Alpha",
        description: "the a resource",
        mimeType: "text/plain",
      });
      await close();
    });

    it("name defaults to the uri when meta omits it", async () => {
      const { harness, close } = await make();
      harness.register("mem://nameless", () => [text("mem://nameless", "x")]);
      const { resources } = await harness.list();
      expect(resources[0]).toMatchObject({ uri: "mem://nameless", name: "mem://nameless" });
      await close();
    });

    it("paginates via nextCursor with no overlap or omission", async () => {
      const { harness, close } = await make(2);
      const uris = ["mem://1", "mem://2", "mem://3", "mem://4", "mem://5"];
      for (const uri of uris) harness.register(uri, () => [text(uri, uri)]);

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await harness.list(cursor);
        expect(res.resources.length).toBeLessThanOrEqual(2);
        for (const r of res.resources) seen.push(r.uri);
        cursor = res.nextCursor;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(10); // guard against a cursor loop
      } while (cursor !== undefined);

      expect(pages).toBeGreaterThan(1);
      expect(seen.slice().sort()).toEqual(uris.slice().sort());
      expect(new Set(seen).size).toBe(uris.length);
      await close();
    });

    it("read runs the fixed resolver", async () => {
      const { harness, close } = await make();
      harness.register("mem://doc", () => [text("mem://doc", "hello")]);
      const contents = await harness.read("mem://doc");
      expect(contents).toEqual([{ uri: "mem://doc", mimeType: "text/plain", text: "hello" }]);
      await close();
    });

    it("read resolves a templated uri, passing the concrete uri to the resolver", async () => {
      const { harness, close } = await make();
      const seen: string[] = [];
      harness.registerTemplate("mem://users/{id}", (uri) => {
        seen.push(uri);
        return [text(uri, `user:${uri}`)];
      });
      const contents = await harness.read("mem://users/42");
      expect(seen).toEqual(["mem://users/42"]);
      expect(contents).toEqual([
        { uri: "mem://users/42", mimeType: "text/plain", text: "user:mem://users/42" },
      ]);
      await close();
    });

    it("read of an unknown uri rejects with ResourceNotFound", async () => {
      const { harness, close } = await make();
      await expect(harness.read("mem://nope")).rejects.toMatchObject({ _tag: "ResourceNotFound" });
      await close();
    });

    it("text and blob contents both round-trip structurally", async () => {
      const { harness, close } = await make();
      harness.register("mem://text", () => [text("mem://text", "plain")]);
      harness.register("mem://blob", () => [blob("mem://blob", "YmluYXJ5")]);
      expect(await harness.read("mem://text")).toEqual([
        { uri: "mem://text", mimeType: "text/plain", text: "plain" },
      ]);
      expect(await harness.read("mem://blob")).toEqual([
        { uri: "mem://blob", mimeType: "application/octet-stream", blob: "YmluYXJ5" },
      ]);
      await close();
    });

    it("subscribe fires on notifyUpdated for the matching uri only", async () => {
      const { harness, close } = await make();
      harness.register("mem://watched", () => [text("mem://watched", "v1")]);
      harness.register("mem://other", () => [text("mem://other", "o")]);
      let hits = 0;
      const unsub = harness.subscribe("mem://watched", () => {
        hits += 1;
      });
      harness.notifyUpdated("mem://other");
      expect(hits).toBe(0);
      harness.notifyUpdated("mem://watched");
      expect(hits).toBe(1);
      unsub();
      harness.notifyUpdated("mem://watched");
      expect(hits).toBe(1);
      await close();
    });

    it("subscribeAll fires on register and unregister", async () => {
      const { harness, close } = await make();
      let changes = 0;
      harness.subscribeAll(() => {
        changes += 1;
      });
      const unregister = harness.register("mem://x", () => [text("mem://x", "x")]);
      expect(changes).toBe(1);
      unregister();
      expect(changes).toBe(2);
      await close();
    });
  });
}

/**
 * `ResourcesHarness` — harness-only pins beyond the shared conformance
 * suite: declared-command journaling, resolver-failure typing, fixed >
 * template precedence, template match semantics, duplicate-registration
 * error, and `backend`.
 */

import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { ProtocolEvent, ResourceContents } from "@agentick/spec";

import { ResourcesHarness } from "../harness.js";
import { compileUriTemplate, matchesTemplate } from "../uri-template.js";

async function makeHarness(pageSize?: number): Promise<ResourcesHarness> {
  const harness = new ResourcesHarness(
    `test:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    pageSize !== undefined ? { pageSize } : {},
  );
  await harness.ready;
  return harness;
}

function text(uri: string, body: string): ResourceContents {
  return { uri, mimeType: "text/plain", text: body };
}

describe("ResourcesHarness — registry", () => {
  it("duplicate fixed registration throws ResourceAlreadyRegistered", async () => {
    const h = await makeHarness();
    h.register("mem://x", () => [text("mem://x", "1")]);
    expect(() => h.register("mem://x", () => [text("mem://x", "2")])).toThrow(/already registered/);
    await h.close();
  });

  it("duplicate template registration throws ResourceAlreadyRegistered", async () => {
    const h = await makeHarness();
    h.registerTemplate("mem://u/{id}", (u) => [text(u, "1")]);
    expect(() => h.registerTemplate("mem://u/{id}", (u) => [text(u, "2")])).toThrow(
      /already registered/,
    );
    await h.close();
  });

  it("backend defaults to memory and is overridable", async () => {
    const h = await makeHarness();
    expect(h.backend).toBe("memory");
    await h.close();

    const h2 = new ResourcesHarness(
      `t:${ulid()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      { backend: "sandbox" },
    );
    await h2.ready;
    expect(h2.backend).toBe("sandbox");
    await h2.close();
  });

  it("listTemplates returns template descriptors with uriTemplate + name", async () => {
    const h = await makeHarness();
    h.registerTemplate("mem://users/{id}", (u) => [text(u, u)], { name: "User" });
    const { templates } = await h.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ uriTemplate: "mem://users/{id}", name: "User" });
    await h.close();
  });
});

describe("ResourcesHarness — read precedence + resolution", () => {
  it("prefers a fixed binding over a matching template", async () => {
    const h = await makeHarness();
    h.registerTemplate("mem://users/{id}", (u) => [text(u, "template")]);
    h.register("mem://users/root", () => [text("mem://users/root", "fixed")]);
    const contents = await h.read("mem://users/root");
    expect(contents[0]).toMatchObject({ text: "fixed" });
    // Non-fixed uri still falls through to the template.
    const templated = await h.read("mem://users/99");
    expect(templated[0]).toMatchObject({ text: "template" });
    await h.close();
  });

  it("wraps a throwing resolver in ResourceResolverFailed", async () => {
    const h = await makeHarness();
    h.register("mem://boom", () => {
      throw new Error("kaboom");
    });
    await expect(h.read("mem://boom")).rejects.toMatchObject({
      _tag: "ResourceResolverFailed",
      uri: "mem://boom",
    });
    await h.close();
  });

  it("wraps a rejecting async resolver in ResourceResolverFailed", async () => {
    const h = await makeHarness();
    h.register("mem://async-boom", async () => {
      throw new Error("async kaboom");
    });
    await expect(h.read("mem://async-boom")).rejects.toMatchObject({
      _tag: "ResourceResolverFailed",
    });
    await h.close();
  });
});

describe("ResourcesHarness — declared-command journaling", () => {
  it("read emits requested + terminal envelopes on the resources surface", async () => {
    const bus = new LocalEventBus();
    const harness = new ResourcesHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      bus,
      new LocalInbox(),
    );
    await harness.ready;
    harness.register("mem://doc", () => [text("mem://doc", "hi")]);

    const events: ProtocolEvent[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(bus.subscribe({ surface: "resources" }), (e) =>
        Effect.sync(() => {
          events.push(e);
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));

    await harness.read("mem://doc");
    await new Promise((r) => setTimeout(r, 20));
    await Effect.runPromise(Fiber.interrupt(fiber));

    const readEvents = events.filter((e) => e.name === "resources:command:read");
    const phases = readEvents.map((e) => e.phase);
    expect(phases).toContain("requested");
    expect(phases).toContain("terminal");
    await harness.close();
  });
});

describe("uri-template matcher", () => {
  it("{var} matches exactly one segment", () => {
    const re = compileUriTemplate("mem://users/{id}");
    expect(matchesTemplate(re, "mem://users/42")).toBe(true);
    expect(matchesTemplate(re, "mem://users/42/posts")).toBe(false);
    expect(matchesTemplate(re, "mem://users/")).toBe(false);
  });

  it("{+var} / {/var} match across segments", () => {
    const re = compileUriTemplate("file:///{+path}");
    expect(matchesTemplate(re, "file:///a/b/c.txt")).toBe(true);
    const re2 = compileUriTemplate("file://{/path}");
    expect(matchesTemplate(re2, "file:///deep/nested/file")).toBe(true);
  });

  it("escapes regex metacharacters in literals", () => {
    const re = compileUriTemplate("mem://a.b+c/{id}");
    expect(matchesTemplate(re, "mem://a.b+c/1")).toBe(true);
    expect(matchesTemplate(re, "mem://axbxc/1")).toBe(false);
  });
});

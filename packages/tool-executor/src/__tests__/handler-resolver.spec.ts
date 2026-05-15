import { describe, expect, it } from "vitest";
import { InMemoryHandlerResolver } from "../handler-resolver.js";
import { permissiveValidator } from "../validator.js";
import type { Validator } from "../types.js";

describe("InMemoryHandlerResolver", () => {
  it("register + resolve round-trip", () => {
    const r = new InMemoryHandlerResolver();
    const handler = async () => [{ type: "text" as const, text: "ok" }];
    r.register("h.echo", handler);
    const entry = r.resolve("h.echo");
    expect(entry?.handler).toBe(handler);
    expect(entry?.validator).toBe(permissiveValidator);
  });

  it("explicit validator is preserved", () => {
    const r = new InMemoryHandlerResolver();
    const validator: Validator = { validate: () => ({ value: 42 }) };
    r.register("h.strict", async () => [], validator);
    expect(r.resolve("h.strict")?.validator).toBe(validator);
  });

  it("unknown ref resolves to undefined", () => {
    const r = new InMemoryHandlerResolver();
    expect(r.resolve("h.missing")).toBeUndefined();
  });

  it("re-registering overwrites (last-writer-wins)", () => {
    const r = new InMemoryHandlerResolver();
    const first = async () => [];
    const second = async () => [{ type: "text" as const, text: "v2" }];
    r.register("h.same", first);
    r.register("h.same", second);
    expect(r.resolve("h.same")?.handler).toBe(second);
  });

  it("unregister removes the binding", () => {
    const r = new InMemoryHandlerResolver();
    r.register("h.gone", async () => []);
    r.unregister("h.gone");
    expect(r.resolve("h.gone")).toBeUndefined();
  });

  it("size and clear behave as expected", () => {
    const r = new InMemoryHandlerResolver();
    r.register("a", async () => []);
    r.register("b", async () => []);
    expect(r.size()).toBe(2);
    r.clear();
    expect(r.size()).toBe(0);
  });
});

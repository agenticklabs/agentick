/**
 * `AgentickError` base-class semantics.
 *
 * Pins:
 *   - Concrete subclass `name` is set to the class's own name (the
 *     `this.constructor.name` trick — no per-class boilerplate).
 *   - `instanceof AgentickError` AND `instanceof Error` both narrow.
 *   - `instanceof <SpecificSubclass>` narrows to the concrete class.
 *   - Two-level hierarchy: `instanceof <abstract-intermediate>` works.
 *   - `cause` flows through to `Error.cause` (ES2022).
 *   - `_tag` is an own property on the instance (Effect.catchTag relies
 *     on this; field initializers + `useDefineForClassFields:true` give
 *     us own-property semantics).
 *   - `toJSON()` carries `_tag`, `message`, and own enumerable domain
 *     fields; skips `name`/`stack`/`message`-duplication.
 */

import { describe, expect, it } from "vitest";

import { AgentickError, isAgentickError } from "../base.js";

abstract class DomainErrorFixture extends AgentickError {}

class LeafErrorFixture extends DomainErrorFixture {
  readonly _tag = "LeafErrorFixture" as const;
  readonly resourceId: string;
  readonly attempt: number;

  constructor(args: {
    readonly resourceId: string;
    readonly attempt: number;
    readonly cause?: unknown;
  }) {
    super(`leaf failure on ${args.resourceId} (attempt ${args.attempt})`, { cause: args.cause });
    this.resourceId = args.resourceId;
    this.attempt = args.attempt;
  }
}

describe("AgentickError", () => {
  it("sets name to the concrete subclass name via this.constructor.name", () => {
    const err = new LeafErrorFixture({ resourceId: "r-1", attempt: 2 });
    expect(err.name).toBe("LeafErrorFixture");
  });

  it("is catchable as Error and as AgentickError", () => {
    const err = new LeafErrorFixture({ resourceId: "r-1", attempt: 2 });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentickError);
  });

  it("narrows to the abstract intermediate via instanceof (two-level chain)", () => {
    const err = new LeafErrorFixture({ resourceId: "r-1", attempt: 2 });
    expect(err).toBeInstanceOf(DomainErrorFixture);
    expect(err).toBeInstanceOf(LeafErrorFixture);
  });

  it("isAgentickError predicate matches AgentickError instances", () => {
    expect(isAgentickError(new LeafErrorFixture({ resourceId: "r", attempt: 0 }))).toBe(true);
    expect(isAgentickError(new Error("plain"))).toBe(false);
    expect(isAgentickError({ _tag: "Foo" })).toBe(false);
    expect(isAgentickError(null)).toBe(false);
    expect(isAgentickError(undefined)).toBe(false);
    expect(isAgentickError("string")).toBe(false);
  });

  it("threads cause through to ES2022 Error.cause", () => {
    const inner = new Error("inner");
    const err = new LeafErrorFixture({ resourceId: "r", attempt: 1, cause: inner });
    expect(err.cause).toBe(inner);
  });

  it("exposes _tag as an own enumerable property (required for Effect.catchTag)", () => {
    const err = new LeafErrorFixture({ resourceId: "r", attempt: 1 });
    expect(err._tag).toBe("LeafErrorFixture");
    expect(Object.prototype.hasOwnProperty.call(err, "_tag")).toBe(true);
  });

  it("constructs the message from args (no per-class duplication of message string in toJSON)", () => {
    const err = new LeafErrorFixture({ resourceId: "r-7", attempt: 3 });
    expect(err.message).toBe("leaf failure on r-7 (attempt 3)");
  });
});

describe("AgentickError.toJSON()", () => {
  it("emits _tag, message, and all own enumerable domain fields", () => {
    const err = new LeafErrorFixture({ resourceId: "r-9", attempt: 5 });
    const j = err.toJSON();
    expect(j).toMatchObject({
      _tag: "LeafErrorFixture",
      message: "leaf failure on r-9 (attempt 5)",
      resourceId: "r-9",
      attempt: 5,
    });
  });

  it("does NOT include name or stack in the JSON projection", () => {
    const err = new LeafErrorFixture({ resourceId: "r", attempt: 1 });
    const j = err.toJSON();
    expect(j).not.toHaveProperty("name");
    expect(j).not.toHaveProperty("stack");
  });

  it("does NOT double up the _tag key in the output", () => {
    const err = new LeafErrorFixture({ resourceId: "r", attempt: 1 });
    const j = err.toJSON() as Record<string, unknown>;
    const tagKeys = Object.keys(j).filter((k) => k === "_tag");
    expect(tagKeys).toHaveLength(1);
  });

  it("integrates with JSON.stringify (called as the toJSON conversion hook)", () => {
    const err = new LeafErrorFixture({ resourceId: "r-2", attempt: 4 });
    const parsed: unknown = JSON.parse(JSON.stringify(err));
    expect(parsed).toMatchObject({
      _tag: "LeafErrorFixture",
      message: "leaf failure on r-2 (attempt 4)",
      resourceId: "r-2",
      attempt: 4,
    });
  });
});

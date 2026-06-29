/**
 * JSON codec round-trip semantics.
 *
 * Pins:
 *   - serialize → deserialize reconstructs an instance of the original
 *     class (instanceof + _tag preserved).
 *   - Domain fields survive intact.
 *   - Unknown tags resolve to UnknownAgentickError with the payload
 *     preserved verbatim.
 *   - UnknownAgentickError re-serializes under the ORIGINAL tag (wire
 *     stays lossless across intermediate forwarders that don't know
 *     the type).
 *   - Non-object input / missing _tag throws.
 *   - JSON.stringify + JSON.parse + deserialize is a stable composition.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { AgentickError } from "../base.js";
import { deserializeAgentickError, serializeAgentickError } from "../codec.js";
import { registerAgentickError } from "../registry.js";
import { UnknownAgentickError } from "../unknown.js";

class CodecRoundTripFixture extends AgentickError {
  readonly _tag = "CodecRoundTripFixture" as const;
  readonly resourceId: string;
  readonly attempt: number;
  constructor(args: {
    readonly resourceId: string;
    readonly attempt: number;
    readonly cause?: unknown;
  }) {
    super(`codec fixture ${args.resourceId}#${args.attempt}`, { cause: args.cause });
    this.resourceId = args.resourceId;
    this.attempt = args.attempt;
  }
}

beforeAll(() => {
  registerAgentickError("CodecRoundTripFixture", CodecRoundTripFixture);
});

describe("AgentickError codec — known tag", () => {
  it("round-trips through serialize → deserialize preserving class identity", () => {
    const original = new CodecRoundTripFixture({ resourceId: "r-1", attempt: 7 });
    const wire = serializeAgentickError(original);
    const restored = deserializeAgentickError(wire);
    expect(restored).toBeInstanceOf(CodecRoundTripFixture);
    expect(restored).toBeInstanceOf(AgentickError);
    expect((restored as CodecRoundTripFixture)._tag).toBe("CodecRoundTripFixture");
    expect((restored as CodecRoundTripFixture).resourceId).toBe("r-1");
    expect((restored as CodecRoundTripFixture).attempt).toBe(7);
    expect(restored.message).toBe("codec fixture r-1#7");
  });

  it("survives JSON.stringify → JSON.parse → deserialize", () => {
    const original = new CodecRoundTripFixture({ resourceId: "r-2", attempt: 1 });
    const wire = JSON.stringify(original);
    const restored = deserializeAgentickError(JSON.parse(wire));
    expect(restored).toBeInstanceOf(CodecRoundTripFixture);
    expect((restored as CodecRoundTripFixture).resourceId).toBe("r-2");
  });

  it("restores a wire-supplied message that differs from the constructor's default", () => {
    // Simulate a producer with a localized / re-formatted message.
    const wire = {
      _tag: "CodecRoundTripFixture",
      message: "[localized] codec failure",
      resourceId: "r-3",
      attempt: 1,
    };
    const restored = deserializeAgentickError(wire);
    expect(restored.message).toBe("[localized] codec failure");
  });
});

describe("AgentickError codec — unknown tag", () => {
  it("resolves to UnknownAgentickError when the tag isn't registered", () => {
    const wire = {
      _tag: "NotRegisteredAnywhere",
      message: "some failure",
      foo: 1,
      bar: "two",
    };
    const restored = deserializeAgentickError(wire);
    expect(restored).toBeInstanceOf(UnknownAgentickError);
    expect((restored as UnknownAgentickError).originalTag).toBe("NotRegisteredAnywhere");
    expect((restored as UnknownAgentickError).payload).toEqual(wire);
  });

  it("UnknownAgentickError re-serializes under the ORIGINAL tag (lossless forwarding)", () => {
    const wire = {
      _tag: "NotRegisteredAnywhere",
      message: "some failure",
      foo: 1,
      bar: "two",
    };
    const intermediate = deserializeAgentickError(wire);
    const reserialized = serializeAgentickError(intermediate);
    expect(reserialized._tag).toBe("NotRegisteredAnywhere");
    expect(reserialized.foo).toBe(1);
    expect(reserialized.bar).toBe("two");
  });

  it("UnknownAgentickError remains instanceof AgentickError (cross-cutting predicate stable)", () => {
    const restored = deserializeAgentickError({ _tag: "Mystery", message: "?" });
    expect(restored).toBeInstanceOf(AgentickError);
  });
});

describe("AgentickError codec — input validation", () => {
  it("throws TypeError on non-object input", () => {
    expect(() => deserializeAgentickError("string")).toThrow(TypeError);
    expect(() => deserializeAgentickError(42)).toThrow(TypeError);
    expect(() => deserializeAgentickError(null)).toThrow(TypeError);
    expect(() => deserializeAgentickError(undefined)).toThrow(TypeError);
  });

  it("throws TypeError when _tag is missing or non-string", () => {
    expect(() => deserializeAgentickError({})).toThrow(TypeError);
    expect(() => deserializeAgentickError({ _tag: 5 })).toThrow(TypeError);
    expect(() => deserializeAgentickError({ _tag: "" })).toThrow(TypeError);
  });
});

/**
 * Registry semantics: register / lookup / dupe-detection.
 *
 * Pins:
 *   - register stores by string tag, lookup retrieves the same class.
 *   - re-registering the SAME class+tag is idempotent (test reload safe).
 *   - registering a DIFFERENT class under an existing tag throws.
 *   - empty / non-string tag throws at registration time.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { AgentickError } from "../base.js";
import {
  _clearAgentickErrorRegistry,
  _registeredAgentickErrorTags,
  lookupAgentickError,
  registerAgentickError,
} from "../registry.js";

class FixtureA extends AgentickError {
  readonly _tag = "FixtureA" as const;
  constructor() {
    super("a");
  }
}
class FixtureB extends AgentickError {
  readonly _tag = "FixtureB" as const;
  constructor() {
    super("b");
  }
}

describe("AgentickError registry", () => {
  // beforeEach so each test starts with an empty registry regardless
  // of what other specs (e.g. codec.spec) registered at module load.
  beforeEach(() => {
    _clearAgentickErrorRegistry();
  });

  it("register + lookup round-trips a concrete class", () => {
    registerAgentickError("FixtureA", FixtureA);
    expect(lookupAgentickError("FixtureA")).toBe(FixtureA);
  });

  it("lookup returns undefined for unknown tags", () => {
    expect(lookupAgentickError("NeverRegistered")).toBeUndefined();
  });

  it("registering the same class+tag again is idempotent", () => {
    registerAgentickError("FixtureA", FixtureA);
    expect(() => registerAgentickError("FixtureA", FixtureA)).not.toThrow();
    expect(lookupAgentickError("FixtureA")).toBe(FixtureA);
  });

  it("registering a different class under an existing tag throws", () => {
    registerAgentickError("FixtureA", FixtureA);
    expect(() => registerAgentickError("FixtureA", FixtureB)).toThrow(/already registered/i);
  });

  it("rejects empty / non-string tags", () => {
    expect(() => registerAgentickError("", FixtureA)).toThrow(/non-empty string/i);
    // @ts-expect-error — exercising the runtime guard
    expect(() => registerAgentickError(undefined, FixtureA)).toThrow(/non-empty string/i);
    // @ts-expect-error — exercising the runtime guard
    expect(() => registerAgentickError(123, FixtureA)).toThrow(/non-empty string/i);
  });

  it("_registeredAgentickErrorTags lists everything currently registered", () => {
    registerAgentickError("FixtureA", FixtureA);
    registerAgentickError("FixtureB", FixtureB);
    const tags = _registeredAgentickErrorTags();
    expect(tags).toContain("FixtureA");
    expect(tags).toContain("FixtureB");
    expect(tags).toHaveLength(2);
  });
});

/**
 * Creating a compiler must not leave a trace in React's shared internals.
 *
 * `react-reconciler`'s factory chains `ReactSharedInternals.S` on every
 * instantiation and never unchains. With one reconciler per mount, that global
 * kept every mount's reconciler — and its last tree, and the session behind
 * it — reachable forever. React names these fields with single letters in
 * every build; the restore is field-agnostic, and so is this spec, so a
 * renamed slot in a future React fails here instead of leaking quietly.
 */

import { describe, expect, it } from "vitest";
import React from "react";
import { createContainer } from "@agentick/compiler";

import { createCompiler } from "../react/compiler.js";

const internals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: Record<string, unknown>;
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

const mount = (i: number) =>
  createCompiler({ container: createContainer({ mountId: `m-${i}` }), idPrefix: `m-${i}` });

describe("createCompiler — React shared internals", () => {
  it("instantiating many compilers leaves every field exactly as it found it", () => {
    const before = { ...internals };
    for (let i = 0; i < 25; i++) mount(i);
    expect(Object.keys(internals).sort()).toEqual(Object.keys(before).sort());
    for (const key of Object.keys(before)) expect(internals[key]).toBe(before[key]);
  });

  it("rendering with many compilers never regrows the transition-finish chain", () => {
    const transitionFinish = internals.S;
    for (let i = 0; i < 25; i++) {
      const compiler = mount(100 + i);
      const root = compiler.createRoot();
      compiler.render(React.createElement("system", null, "hi"), root);
      compiler.render(null, root);
    }
    expect(internals.S).toBe(transitionFinish);
  });
});

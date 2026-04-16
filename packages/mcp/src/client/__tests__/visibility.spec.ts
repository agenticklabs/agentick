/**
 * Tool Visibility Helpers
 *
 * Tests for the MCP Apps visibility filtering helpers per the spec:
 *   visibility: ["model"]         → only model can call
 *   visibility: ["app"]           → only apps can call (hidden from model)
 *   visibility: ["model", "app"]  → both can call (default)
 *   visibility: undefined          → both can call (default)
 */

import { describe, it, expect } from "vitest";
import { isToolVisibleToModel, isToolVisibleToApps, isToolVisibilityModelOnly } from "../apps.js";

describe("isToolVisibleToModel", () => {
  it("returns true when visibility is undefined (default)", () => {
    expect(isToolVisibleToModel({ name: "t", inputSchema: { type: "object" } as any })).toBe(true);
  });

  it("returns true when _meta is undefined", () => {
    expect(
      isToolVisibleToModel({ name: "t", inputSchema: { type: "object" } as any, _meta: undefined }),
    ).toBe(true);
  });

  it("returns true when _meta.ui is undefined", () => {
    expect(
      isToolVisibleToModel({
        name: "t",
        inputSchema: { type: "object" } as any,
        _meta: { other: "data" },
      }),
    ).toBe(true);
  });

  it("returns true when visibility is undefined", () => {
    expect(
      isToolVisibleToModel({
        name: "t",
        inputSchema: { type: "object" } as any,
        _meta: { ui: { resourceUri: "ui://x" } },
      }),
    ).toBe(true);
  });

  it("returns true when visibility is empty array", () => {
    // Defensive — treat empty array as default (visible to model)
    expect(
      isToolVisibleToModel({
        name: "t",
        inputSchema: { type: "object" } as any,
        _meta: { ui: { visibility: [] } },
      }),
    ).toBe(true);
  });

  it('returns true when visibility is ["model"]', () => {
    expect(
      isToolVisibleToModel({
        name: "t",
        inputSchema: { type: "object" } as any,
        _meta: { ui: { visibility: ["model"] } },
      }),
    ).toBe(true);
  });

  it('returns true when visibility is ["model", "app"]', () => {
    expect(
      isToolVisibleToModel({
        name: "t",
        inputSchema: { type: "object" } as any,
        _meta: { ui: { visibility: ["model", "app"] } },
      }),
    ).toBe(true);
  });

  it('returns false when visibility is ["app"] (app-only)', () => {
    expect(
      isToolVisibleToModel({
        name: "t",
        inputSchema: { type: "object" } as any,
        _meta: { ui: { visibility: ["app"] } },
      }),
    ).toBe(false);
  });
});

describe("Visibility helpers — symmetry between model and app", () => {
  it("a model-only tool: visible to model, NOT visible to app", () => {
    const tool = {
      name: "t",
      inputSchema: { type: "object" } as any,
      _meta: { ui: { visibility: ["model"] as Array<"model" | "app"> } },
    };
    expect(isToolVisibleToModel(tool)).toBe(true);
    expect(isToolVisibleToApps(tool as any)).toBe(false);
  });

  it("an app-only tool: NOT visible to model, visible to app", () => {
    const tool = {
      name: "t",
      inputSchema: { type: "object" } as any,
      _meta: { ui: { visibility: ["app"] as Array<"model" | "app"> } },
    };
    expect(isToolVisibleToModel(tool)).toBe(false);
    expect(isToolVisibleToApps(tool as any)).toBe(true);
  });

  it("a both-visibility tool: visible to model AND visible to app", () => {
    const tool = {
      name: "t",
      inputSchema: { type: "object" } as any,
      _meta: { ui: { visibility: ["model", "app"] as Array<"model" | "app"> } },
    };
    expect(isToolVisibleToModel(tool)).toBe(true);
    expect(isToolVisibleToApps(tool as any)).toBe(true);
  });

  it("a tool with no visibility: visible to both (default)", () => {
    const tool = { name: "t", inputSchema: { type: "object" } as any };
    expect(isToolVisibleToModel(tool)).toBe(true);
    expect(isToolVisibleToApps(tool as any)).toBe(true);
  });
});

describe("isToolVisibilityModelOnly — alignment with ext-apps semantics", () => {
  it('returns true ONLY when visibility is exactly ["model"]', () => {
    // From ext-apps spec: model-only means ONLY the model, not apps
    expect(
      isToolVisibilityModelOnly({
        name: "t",
        inputSchema: { type: "object" } as any,
        _meta: { ui: { visibility: ["model"] } },
      } as any),
    ).toBe(true);
  });

  it("returns false when visibility includes 'app'", () => {
    expect(
      isToolVisibilityModelOnly({
        name: "t",
        inputSchema: { type: "object" } as any,
        _meta: { ui: { visibility: ["model", "app"] } },
      } as any),
    ).toBe(false);
  });

  it("returns false when visibility is unset (default)", () => {
    // Per ext-apps: default is treated as visible to all, not "model-only"
    expect(
      isToolVisibilityModelOnly({
        name: "t",
        inputSchema: { type: "object" } as any,
      } as any),
    ).toBe(false);
  });
});

/**
 * Filter transforms: drop tools based on a predicate.
 *
 * `filter` is the primitive; `allow` / `deny` are ergonomic
 * specializations for the common allowlist/denylist case.
 *
 * **First-null short-circuits the chain.** When composed with other
 * transforms, a filter rejection stops processing — later transforms
 * never see the dropped tool. Compose-order matters.
 */

import type { ToolDeclaration } from "@agentick/spec-next";

import type { ToolTransform } from "./transform.js";

/**
 * Drop tools where the predicate returns `false`. Tools where it
 * returns `true` flow through unchanged.
 *
 * The predicate sees the live context — use it for per-connection
 * authz, per-session capability checks, transport-aware visibility,
 * or any other dynamic gate.
 *
 *   filter((tool, ctx) => ctx.user.role === "admin" || !tool.metadata?.adminOnly)
 */
export function filter<C = unknown>(
  predicate: (tool: ToolDeclaration, ctx: C) => boolean,
): ToolTransform<C> {
  return {
    name: "filter",
    apply: (tool, ctx) => (predicate(tool, ctx) ? tool : null),
  };
}

/**
 * Allow only tools whose name is in the list (or matches one of the
 * supplied RegExps). Everything else is dropped.
 *
 *   allow(["search", "get", /^read_/])
 *
 * Strings match by exact equality; RegExps test against `tool.name`.
 */
export function allow<C = unknown>(matchers: readonly (string | RegExp)[]): ToolTransform<C> {
  const names = new Set<string>();
  const patterns: RegExp[] = [];
  for (const m of matchers) {
    if (typeof m === "string") names.add(m);
    else patterns.push(m);
  }
  return {
    name: "allow",
    apply: (tool) => {
      if (names.has(tool.name)) return tool;
      for (const p of patterns) {
        if (p.test(tool.name)) return tool;
      }
      return null;
    },
  };
}

/**
 * Drop tools whose name is in the list (or matches one of the
 * supplied RegExps). Everything else flows through unchanged.
 *
 *   deny(["dangerous_delete", /^admin_/])
 */
export function deny<C = unknown>(matchers: readonly (string | RegExp)[]): ToolTransform<C> {
  const names = new Set<string>();
  const patterns: RegExp[] = [];
  for (const m of matchers) {
    if (typeof m === "string") names.add(m);
    else patterns.push(m);
  }
  return {
    name: "deny",
    apply: (tool) => {
      if (names.has(tool.name)) return null;
      for (const p of patterns) {
        if (p.test(tool.name)) return null;
      }
      return tool;
    },
  };
}

/**
 * Drop tools that don't expose the given audience. `exposure` is the
 * v2 surface where each tool declares which seams can reach it
 * (`"model"` / `"dispatch"` / `"runtime"`); the MCP server projection
 * cares mainly about `"model"`.
 *
 *   onlyExposingTo("model")
 *
 * Useful as a default-deny floor in projection pipelines.
 */
export function onlyExposingTo<C = unknown>(
  audience: ToolDeclaration["exposure"][number],
): ToolTransform<C> {
  return {
    name: `onlyExposingTo(${audience})`,
    apply: (tool) => (tool.exposure.includes(audience) ? tool : null),
  };
}

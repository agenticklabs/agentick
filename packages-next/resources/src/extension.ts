/**
 * `withResources()` — `SessionExtension` factory.
 *
 * Wave 4a ships the harness + MCP server projection. Session surfacing
 * (constructing a per-session `ResourcesHarness`, exposing it on
 * `bridges.resources` / `ctx.resource`, and the React `<Resource>`
 * front-end) is Wave 4b — see `TODO(#237-4b)` below. Until then this is
 * a documented no-op that preserves the `extensions: [...]` mental model
 * ("opt into the bundled primitives explicitly"), mirroring
 * `withElicitation()`'s no-op survival post-#159.
 *
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 * @see docs/proposals/v2/blueprint/26-harness-api-shape.md
 */

import type { SessionExtension } from "@agentick/spec-next";

export function withResources(): SessionExtension {
  return {
    name: "@agentick/resources-next",
    target: "session",
    install: (): void => {
      // TODO(#237-4b): construct the per-session ResourcesHarness, wire
      // `bridges.resources` + `ctx.resource`, and register the React
      // `<Resource>` front-end. Wave 4a is the harness + MCP server
      // projection only; session surfacing is out of scope here.
    },
  };
}

/**
 * Applies {@link runObservabilityCtxConformance} to the canonical
 * {@link fakeToolHandlerCtx} — proving the shared fixture carries the
 * facet flat in BOTH transports (in-process + MCP), so every downstream
 * test that builds a ctx via the fake inherits a conformant surface.
 *
 * Surface-integration proofs (span parenting, metric fan-out, MCP
 * no-wire-leak) live in the owning packages' tests against a real runtime
 * + spy provider (see `@agentick/runtime` observability.spec.ts).
 */

import { fakeToolHandlerCtx } from "../fake-tool-handler-ctx.js";
import { runObservabilityCtxConformance } from "../observability.js";
import { runOpsCtxConformance } from "../ops.js";

runObservabilityCtxConformance("ToolHandlerCtx (in-process)", () => fakeToolHandlerCtx());
runObservabilityCtxConformance("ToolHandlerCtx (mcp)", () =>
  fakeToolHandlerCtx({ transport: "mcp" }),
);

runOpsCtxConformance("ToolHandlerCtx (in-process)", () => fakeToolHandlerCtx());
runOpsCtxConformance("ToolHandlerCtx (mcp)", () => fakeToolHandlerCtx({ transport: "mcp" }));

/**
 * `@agentick/gateway/v2` — runtime-root GatewayHarness.
 *
 * Phase 4 of the v2 build. See `docs/proposals/v2/blueprint/12-gateway.md`
 * for the full Gateway shape across deployment tiers.
 */

export {
  GatewayHarness,
  type CreateGatewayAppInput,
  type GatewayHarnessOptions,
} from "./harness.js";
export { createGateway } from "./create-gateway.js";

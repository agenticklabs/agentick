/**
 * `createGateway(options)` — top-level factory function. Mirrors
 * `createApp(rootElement, options)` shape — adopters get a ready
 * GatewayHarness without manual `await harness.ready` boilerplate.
 */

import { GatewayHarness, type GatewayHarnessOptions } from "./harness.js";

export async function createGateway(options: GatewayHarnessOptions = {}): Promise<GatewayHarness> {
  const gateway = new GatewayHarness(options);
  await gateway.ready;
  return gateway;
}

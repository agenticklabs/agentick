/**
 * `@agentick/connector-next/testing` — test doubles for connectors.
 *
 * `fakeConnectorPlatform` is a working in-memory `ConnectorPlatform`
 * that records deliveries + confirmations and lets tests drive inbound
 * messages and confirmation replies. Meszaros naming (`fake*`).
 */

export {
  fakeConnectorPlatform,
  type FakeConnectorPlatform,
  type FakeConnectorPlatformOptions,
} from "./fake-connector-platform.js";

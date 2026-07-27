/**
 * `@agentick/cluster-broker/testing` — in-memory fixtures for
 * focused base-class tests. Concrete wire packages (@agentick/cluster-net,
 * @agentick/cluster-ws) use real listeners; these fixtures are for the
 * base-class internal-mechanics tests.
 */

export { createInMemoryConnectionPair } from "./in-memory-pair.js";

export { createInMemoryClusterPair, type InMemoryClusterPair } from "./in-memory-pair-fixture.js";

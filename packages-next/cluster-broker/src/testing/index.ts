/**
 * `@agentick/cluster-broker-next/testing` — in-memory fixtures for
 * focused base-class tests. Concrete wire packages (cluster-net-next,
 * cluster-ws-next) use real listeners; these fixtures are for the
 * base-class internal-mechanics tests.
 */

export { createInMemoryConnectionPair } from "./in-memory-pair.js";

export { createInMemoryClusterPair, type InMemoryClusterPair } from "./in-memory-pair-fixture.js";

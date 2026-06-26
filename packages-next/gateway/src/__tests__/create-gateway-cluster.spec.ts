/**
 * Phase 5c — createGateway cluster wiring. Verifies that:
 *
 *   1. `createGateway({ cluster })` resolves the factory at
 *      construction. The gateway's substrate IS the cluster-wrapped
 *      one — proven by the cluster registering the gateway-as-node
 *      in the local registry.
 *   2. `gateway.closeGateway()` fires the cluster's parent.onClose
 *      chain — proven by registry removal.
 *   3. Substrate factories alongside `cluster` are rejected with a
 *      clear error.
 *
 * The "apps inherit gateway's cluster" behavior is structural — apps
 * default their substrate to the gateway's instances, and after
 * cluster wrap those ARE the cluster-wrapped versions. No special
 * code path; covered transitively by the membership self-join assertion.
 */

import { createLocalClusterRegistry, defineLocalCluster } from "@agentick/cluster-next/testing";
import { LocalEventBus } from "@agentick/runtime-next";
import { describe, expect, it } from "vitest";

import { createGateway } from "../create-gateway.js";

describe("createGateway({ cluster }) — Phase 5c gateway-level wiring", () => {
  it("the gateway's substrate IS cluster-wrapped — membership shows the gateway as a member, close removes it", async () => {
    const registry = createLocalClusterRegistry();
    const gateway = await createGateway({
      cluster: defineLocalCluster({ nodeId: "gw-A", registry }),
    });

    expect(registry.nodes()).toContain("gw-A");
    await gateway.closeGateway();
    expect(registry.nodes()).not.toContain("gw-A");
  });

  it("rejects createGateway({ cluster, bus: factory }) — substrate factories incompatible with cluster opt", async () => {
    await expect(
      createGateway({
        cluster: defineLocalCluster({ nodeId: "gw-B" }),
        bus: LocalEventBus.factory(),
      }),
    ).rejects.toThrow(/substrate instances \(not factories\)/);
  });

  it("accepts createGateway({ cluster, bus: instance })", async () => {
    const registry = createLocalClusterRegistry();
    const gateway = await createGateway({
      cluster: defineLocalCluster({ nodeId: "gw-C", registry }),
      bus: new LocalEventBus(),
    });

    expect(registry.nodes()).toContain("gw-C");
    await gateway.closeGateway();
  });
});

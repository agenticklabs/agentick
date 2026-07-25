/**
 * Phase 4f.3 — internal re-election on broker death. Single-host
 * multi-worker failover: when the broker process dies, a surviving
 * worker should race to bind the vacated socket and take over.
 *
 * In-process scenario (mirrors real multi-worker layout but inside
 * one Node process for testability):
 *
 *   1. Process A: `unixBroker(...)` on path P.
 *   2. Process B: `electableUnixClusterNode({ path: P, reElectAfterFailures: 2 })`.
 *      B handshakes with A.
 *   3. Kill A's broker (await unixBroker.close).
 *   4. B's client sees connect-failed diagnostics on next reconnect attempts.
 *      After 2 consecutive failures, the wrapper races for the bind
 *      via `tryBindOrConnectUnix({ mode: "auto" })`.
 *   5. B wins (it's the only contender), spins up a local broker,
 *      emits `cluster:broker:re-election:promoted`.
 *   6. Test asserts `B.getLocalBroker() !== null` and that the
 *      diagnostic name landed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClusterCodec } from "@agentick/cluster";
import { waitFor } from "@agentick/utils/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unixBroker } from "../unix-cluster.js";
import { electableUnixClusterNode } from "../unix-re-election.js";

function makeJsonCodec(): ClusterCodec {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    encode: (v) => enc.encode(JSON.stringify(v)),
    decode: (raw) => JSON.parse(dec.decode(raw)),
  };
}

describe("Unix re-election — broker promotion on broker-gone", () => {
  let tmp: string;
  let socketPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentick-reelect-"));
    socketPath = join(tmp, "cluster.sock");
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("a surviving worker wins the bind race after broker dies and becomes the new broker", async () => {
    const codec = makeJsonCodec();
    // Initial broker — process A.
    const brokerA = await unixBroker({ socketPath, codec });

    // Spy on diagnostics from electable node B.
    const diags: Array<{ name: string; payload?: unknown }> = [];
    const onDiagnostic = (name: string, payload?: unknown): void => {
      diags.push({ name, payload });
    };

    const nodeB = electableUnixClusterNode({
      nodeId: "node-B",
      socketPath,
      codec,
      reElectAfterFailures: 2,
      // Tight reconnect schedule so the test runs quickly.
      reconnect: { initialMs: 5, maxMs: 20, maxAttempts: 100 },
      heartbeatMs: 0,
      onDiagnostic,
    });

    // Create a fake parent so we can invoke transport(parent) — it
    // lazy-constructs the BaseClusterClient and connects.
    const closeHandlers: Array<() => void | Promise<void>> = [];
    const parent = {
      onClose: (h: () => void | Promise<void>) => {
        closeHandlers.push(h);
      },
      // The rest of the ClusterParent surface isn't exercised by
      // unixClusterNode's transport factory.
    } as unknown as import("@agentick/cluster").ClusterParent;

    try {
      // Materialize the client.
      nodeB.transport(parent);

      // Wait until B is connected to A.
      await waitFor(() => diags.some((d) => d.name === "cluster:broker:client:connected"), {
        timeoutMs: 2000,
        pollMs: 20,
      });

      // Kill A.
      await brokerA.close();

      // Wait until B is promoted via re-election.
      await waitFor(() => diags.some((d) => d.name === "cluster:broker:re-election:promoted"), {
        timeoutMs: 3000,
        pollMs: 20,
      });

      // Sanity: local broker is now running.
      expect(nodeB.getLocalBroker()).not.toBeNull();

      // Sanity: we emitted the attempt diagnostic before the promotion.
      const attemptIdx = diags.findIndex((d) => d.name === "cluster:broker:re-election:attempt");
      const promotedIdx = diags.findIndex((d) => d.name === "cluster:broker:re-election:promoted");
      expect(attemptIdx).toBeGreaterThan(-1);
      expect(promotedIdx).toBeGreaterThan(attemptIdx);
    } finally {
      // Teardown — run client teardown via parent.onClose chain, then
      // close the local broker.
      for (const h of closeHandlers) await h();
      await nodeB.closeLocalBroker();
    }
  });

  it("if some OTHER process wins the bind race, this node stays a client (lost-race diagnostic)", async () => {
    // Scenario: B sees broker A die, but BEFORE B finishes its bind
    // race a 3rd process (synthesized here as a direct
    // tryBindOrConnectUnix call) wins. B should emit the lost-race
    // diagnostic and NOT spin up a local broker.
    const codec = makeJsonCodec();
    const brokerA = await unixBroker({ socketPath, codec });

    const diags: Array<{ name: string; payload?: unknown }> = [];
    const nodeB = electableUnixClusterNode({
      nodeId: "node-B",
      socketPath,
      codec,
      reElectAfterFailures: 2,
      reconnect: { initialMs: 5, maxMs: 20, maxAttempts: 100 },
      heartbeatMs: 0,
      onDiagnostic: (name, payload) => diags.push({ name, payload }),
    });

    const closeHandlers: Array<() => void | Promise<void>> = [];
    const parent = {
      onClose: (h: () => void | Promise<void>) => {
        closeHandlers.push(h);
      },
    } as unknown as import("@agentick/cluster").ClusterParent;

    try {
      nodeB.transport(parent);

      await waitFor(() => diags.some((d) => d.name === "cluster:broker:client:connected"), {
        timeoutMs: 2000,
        pollMs: 20,
      });

      // Close A. Immediately spin up a NEW external broker on the
      // same socket — this races B's internal re-election.
      await brokerA.close();
      const brokerC = await unixBroker({ socketPath, codec });

      // B should now either: see lost-race (if its re-election kicks
      // off after C bound) OR get reconnected to C (no re-election
      // needed). Either is a valid "stays a client" outcome — but
      // it MUST NOT have a local broker.
      await waitFor(
        () =>
          diags.some(
            (d) =>
              d.name === "cluster:broker:re-election:lost-race" ||
              d.name === "cluster:broker:client:connected",
          ),
        { timeoutMs: 3000, pollMs: 20 },
      );

      expect(nodeB.getLocalBroker()).toBeNull();
      await brokerC.close();
    } finally {
      for (const h of closeHandlers) await h();
      await nodeB.closeLocalBroker();
    }
  });
});

import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type { ProtocolEvent } from "@agentick/spec";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { ScopeNodeRegistry } from "../substrate/scope-node-registry.js";
import { forkBusSubscription } from "../substrate/fork-bus-subscription.js";

describe("ScopeNodeRegistry", () => {
  it("resolves the host's own bus at the empty path", () => {
    const root = new LocalEventBus({ batch: {} });
    const registry = new ScopeNodeRegistry({ root });
    expect(registry.node([]).bus).toBe(root);
  });

  it("creates a node lazily and returns the same bus for the same path", () => {
    const root = new LocalEventBus({ batch: {} });
    const created: string[][] = [];
    const registry = new ScopeNodeRegistry({
      root,
      createBus: ({ path, parent }) => {
        created.push([...path]);
        return new LocalEventBus({ batch: {}, parent });
      },
    });

    expect(created).toEqual([]);
    const first = registry.node(["t", "u"]);
    // Creating a node creates its missing ancestors, parent-first.
    expect(created).toEqual([["t"], ["t", "u"]]);
    expect(registry.node(["t", "u"]).bus).toBe(first.bus);
    expect(created).toHaveLength(2);
  });

  it("fans a node's events in to its ancestors and never to a sibling", async () => {
    const root = new LocalEventBus({ batch: {} });
    const registry = new ScopeNodeRegistry({
      root,
      createBus: ({ parent }) => new LocalEventBus({ batch: {}, parent }),
    });

    const tenant = registry.node(["t"]);
    const user = registry.node(["t", "u"]);
    const sibling = registry.node(["t2"]);

    const seen = { root: [] as string[], tenant: [] as string[], sibling: [] as string[] };
    const unsubs = [
      forkBusSubscription(root, {}, (e) => void seen.root.push(e.id)),
      forkBusSubscription(tenant.bus, {}, (e) => void seen.tenant.push(e.id)),
      forkBusSubscription(sibling.bus, {}, (e) => void seen.sibling.push(e.id)),
    ];
    await settle();

    await Effect.runPromise(user.bus.append(ev("from-user")));
    await settle();

    expect(seen.tenant).toEqual(["from-user"]);
    expect(seen.root).toEqual(["from-user"]);
    expect(seen.sibling).toEqual([]);

    for (const u of unsubs) u();
  });

  it("publish(path, event) reaches the node's subscribers and its ancestors", async () => {
    const root = new LocalEventBus({ batch: {} });
    const registry = new ScopeNodeRegistry({
      root,
      createBus: ({ parent }) => new LocalEventBus({ batch: {}, parent }),
    });
    const room = registry.node(["t", "room"]);

    const atRoom: string[] = [];
    const atRoot: string[] = [];
    const unsubs = [
      forkBusSubscription(room.bus, {}, (e) => void atRoom.push(e.id)),
      forkBusSubscription(root, {}, (e) => void atRoot.push(e.id)),
    ];
    await settle();

    await Effect.runPromise(registry.publish(["t", "room"], ev("broadcast")));
    await settle();

    expect(atRoom).toEqual(["broadcast"]);
    expect(atRoot).toEqual(["broadcast"]);

    for (const u of unsubs) u();
  });

  it("publish at an unheld path still fans in to the nearest live ancestor", async () => {
    const root = new LocalEventBus({ batch: {} });
    const registry = new ScopeNodeRegistry({
      root,
      createBus: ({ parent }) => new LocalEventBus({ batch: {}, parent }),
    });

    const atRoot: string[] = [];
    const unsub = forkBusSubscription(root, {}, (e) => void atRoot.push(e.id));
    await settle();

    await Effect.runPromise(registry.publish(["t", "ephemeral"], ev("transient")));
    await settle();

    expect(atRoot).toEqual(["transient"]);
    unsub();
  });

  it("closes a node when its last lease releases, and rebuilds it fresh on re-request", async () => {
    const root = new LocalEventBus({ batch: {} });
    const registry = new ScopeNodeRegistry({
      root,
      createBus: ({ parent }) => new LocalEventBus({ batch: {}, parent }),
    });

    const a = registry.node(["t", "u"]);
    const b = registry.node(["t", "u"]);
    const bus = a.bus as LocalEventBus;

    a.release();
    // Second lease still holds it open.
    const probe = registry.node(["t", "u"]);
    expect(probe.bus).toBe(bus);

    probe.release();
    b.release();

    const rebuilt = registry.node(["t", "u"]);
    expect(rebuilt.bus).not.toBe(bus);
    // The discarded node's ring is gone with it — a subscriber on it ends.
    const drained = await Effect.runPromise(Stream.runCollect(bus.subscribe({})));
    expect(Array.from(drained)).toEqual([]);
  });

  it("releases the ancestor lease when the last descendant closes", () => {
    const root = new LocalEventBus({ batch: {} });
    const created: string[][] = [];
    const registry = new ScopeNodeRegistry({
      root,
      createBus: ({ path, parent }) => {
        created.push([...path]);
        return new LocalEventBus({ batch: {}, parent });
      },
    });

    const leaf = registry.node(["t", "u"]);
    leaf.release();
    // Both the leaf and its now-unreferenced ancestor are gone: re-requesting
    // the ancestor constructs it again.
    registry.node(["t"]);
    expect(created).toEqual([["t"], ["t", "u"], ["t"]]);
  });

  it("keeps an ancestor alive while a descendant holds it", () => {
    const root = new LocalEventBus({ batch: {} });
    const created: string[][] = [];
    const registry = new ScopeNodeRegistry({
      root,
      createBus: ({ path, parent }) => {
        created.push([...path]);
        return new LocalEventBus({ batch: {}, parent });
      },
    });

    const tenantBus = registry.node(["t"]).bus;
    const leaf = registry.node(["t", "u"]);
    registry.node(["t"]).release();
    expect(registry.node(["t"]).bus).toBe(tenantBus);
    leaf.release();
    expect(created).toEqual([["t"], ["t", "u"]]);
  });

  it("ignores a repeated release", () => {
    const root = new LocalEventBus({ batch: {} });
    const registry = new ScopeNodeRegistry({
      root,
      createBus: ({ parent }) => new LocalEventBus({ batch: {}, parent }),
    });
    const held = registry.node(["t"]);
    const alsoHeld = registry.node(["t"]);
    held.release();
    held.release();
    expect(registry.node(["t"]).bus).toBe(alsoHeld.bus);
  });
});

function settle(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function ev(id: string, partial: Partial<ProtocolEvent> = {}): ProtocolEvent {
  return {
    id,
    surface: "session",
    name: "session:test",
    phase: "delta",
    timestamp: Date.now(),
    scope: {},
    ...partial,
  } as ProtocolEvent;
}

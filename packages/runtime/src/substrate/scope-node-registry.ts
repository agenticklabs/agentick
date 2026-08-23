/**
 * Scope-node registry — a tree of buses addressed by a path of scope
 * keys (ADR 102).
 *
 * A node's bus parents to the node one segment shorter, so writes fan
 * IN toward the root and reads stay inside the node's subtree. Grouping,
 * isolation, and broadcast are then the same fact: what fans into a
 * node, who may attach to it, what is published at it.
 *
 * @see docs/proposals/v2/blueprint/102-subscription-bus-topology.md
 */

import { Effect } from "effect";
import type { EventBus, ProtocolEvent, ScopeNodeLease } from "@agentick/spec";
import { LocalEventBus } from "./local-event-bus.js";

export interface ScopeNodeBusInput {
  readonly path: readonly string[];
  readonly parent: EventBus;
}

export interface ScopeNodeRegistryOptions {
  /** The bus at path `[]`. Owned by the host — the registry never closes it. */
  readonly root: EventBus;
  /** Bus construction for a non-root node. Defaults to a `LocalEventBus` fanning in to `parent`. */
  readonly createBus?: (input: ScopeNodeBusInput) => EventBus;
}

interface ScopeNodeEntry {
  readonly bus: EventBus;
  readonly releaseParent: () => void;
  refs: number;
}

export class ScopeNodeRegistry {
  private readonly root: EventBus;
  private readonly createBus: (input: ScopeNodeBusInput) => EventBus;
  private readonly nodes = new Map<string, ScopeNodeEntry>();

  constructor(options: ScopeNodeRegistryOptions) {
    this.root = options.root;
    this.createBus = options.createBus ?? (({ parent }) => new LocalEventBus({ parent }));
  }

  /**
   * Resolve the node at `path`, creating it (and any missing ancestor)
   * on first use, and hold it open until the returned lease is
   * released. A node holds a lease on its parent, so an ancestor
   * outlives every descendant. Releasing twice is a no-op.
   */
  node(path: readonly string[]): ScopeNodeLease {
    if (path.length === 0) return { path, bus: this.root, release: noop };

    const key = JSON.stringify(path);
    let entry = this.nodes.get(key);
    if (entry === undefined) {
      const parent = this.node(path.slice(0, -1));
      entry = {
        bus: this.createBus({ path, parent: parent.bus }),
        releaseParent: () => parent.release(),
        refs: 0,
      };
      this.nodes.set(key, entry);
    }
    entry.refs++;

    const held = entry;
    let released = false;
    return {
      path,
      bus: held.bus,
      release: () => {
        if (released) return;
        released = true;
        held.refs--;
        if (held.refs > 0) return;
        if (this.nodes.get(key) === held) this.nodes.delete(key);
        closeBus(held.bus);
        held.releaseParent();
      },
    };
  }

  /**
   * Publish an event AT `path` — room broadcast, the same verb as
   * everything else. `appendBatch` rather than `append` so an event
   * published at a node nobody holds still fans in before the
   * transient lease closes it (a batch accumulator would not flush).
   */
  publish(path: readonly string[], event: ProtocolEvent): Effect.Effect<void, never, never> {
    return Effect.suspend(() => {
      const lease = this.node(path);
      return Effect.ensuring(
        lease.bus.appendBatch([event]),
        Effect.sync(() => lease.release()),
      );
    });
  }

  /** Close every node this registry created. The root belongs to the host. */
  close(): void {
    for (const entry of this.nodes.values()) closeBus(entry.bus);
    this.nodes.clear();
  }
}

function noop(): void {}

function closeBus(bus: EventBus): void {
  (bus as { close?: () => void }).close?.();
}

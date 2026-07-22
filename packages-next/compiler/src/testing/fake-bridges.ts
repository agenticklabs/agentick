/**
 * Mock `HookBridges` for tests across the workspace.
 *
 * Per ADR 27, `@agentick/compiler-next` (and `@agentick/compiler-react-next`)
 * does NOT depend on any harness package. Tests that need bridges to
 * drive the compiler use these protocol-conforming mocks
 * (lightweight, deps-free).
 *
 * **What these are NOT:** they do not exercise the real harness
 * behavior (no journal envelopes, no inbox routing, no operation
 * lifecycle). Tests of "does the real harness work correctly with the
 * compiler" — knobs validation pipeline, timeline reads,
 * state K/V semantics — live in their respective harness packages
 * (`@agentick/<harness>/__tests__/integration-with-compiler.spec.tsx`)
 * and use the real stub factories from `@agentick/<harness>/testing`.
 *
 * Adopters writing tests should NOT import from here — they should use
 * `agentick/testing` (which composes real harness stubs from each
 * package's `/testing` subpath).
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import type {
  HookBridges,
  KnobDescriptor,
  KnobPrimitive,
  KnobsDispatchInput,
  KnobsHarnessProtocol,
  KnobsRegisterInput,
  KnobsSetInput,
  LoopBridge,
  SessionBridge,
  StateDeleteInput,
  StateHarnessProtocol,
  StateSetInput,
  TimelineEntry,
  TimelineHarnessProtocol,
  TimelineReplaceProjectionInput,
  TimelineSnapshot,
  TimelineHarnessSnapshot,
  CompactStrategy,
  CompactResult,
} from "@agentick/spec-next";
import { createKeyedNotifier, createNotifier } from "@agentick/pubsub-next";
import { InMemoryDataBridge } from "../bridges/in-memory-data-bridge.js";
import { InMemoryModelBridge } from "../bridges/in-memory-model-bridge.js";
import { omitUndefined } from "@agentick/utils-next";

/**
 * Mock timeline harness — Map + Promise resolvers; satisfies
 * `TimelineHarnessProtocol`. NOT a real `TimelineHarness`. Use
 * `@agentick/timeline-next/testing` `stubTimelineHarness` for tests that
 * exercise harness behavior.
 */
export function fakeTimelineHarness(
  initial: readonly TimelineEntry[] = [],
): TimelineHarnessProtocol {
  const persisted: TimelineEntry[] = [...initial];
  let projection: TimelineEntry[] = [...initial];
  let version = 0;
  const listeners = createNotifier();
  const notify = () => listeners.notify();

  let snapshot: TimelineSnapshot = { entries: [...projection], version };
  const refresh = () => {
    version += 1;
    snapshot = { entries: [...projection], version };
  };
  if (initial.length > 0) refresh();

  return {
    id: "mock:timeline",
    ready: Promise.resolve(),
    read: () => snapshot,
    subscribe: (l) => listeners.subscribe(l),
    trailingInput: () => {
      let lastAssistant = -1;
      for (let i = persisted.length - 1; i >= 0; i--) {
        const e = persisted[i]!;
        if (e.kind === "message" && e.message.role === "assistant") {
          lastAssistant = i;
          break;
        }
      }
      return persisted
        .slice(lastAssistant + 1)
        .filter(
          (e): e is Extract<TimelineEntry, { kind: "message" }> =>
            e.kind === "message" && e.message.role === "user",
        );
    },
    inputEntryCount: () =>
      persisted.filter((e) => e.kind === "message" && e.message.role === "user").length,
    endTurn: async () => {},
    readPersisted: () => persisted,
    append: async (...entries: TimelineEntry[]) => {
      if (entries.length === 0) return;
      for (const entry of entries) {
        persisted.push(entry);
        projection.push(entry);
      }
      refresh();
      notify();
    },
    // No durable store behind the fake — memory is the only tier, so the
    // flush barrier is already satisfied.
    flush: async () => {},
    compact: async (strategy: CompactStrategy): Promise<CompactResult> => {
      const source = strategy.source ?? "persisted";
      const entries = source === "persisted" ? persisted : projection;
      const before = entries.length;
      const next = await strategy.run({
        entries,
        ...omitUndefined({ instructions: strategy.instructions }),
      });
      projection = [...next];
      refresh();
      notify();
      return { entriesBefore: before, entriesAfter: projection.length, source };
    },
    replaceProjection: async (input: TimelineReplaceProjectionInput) => {
      projection = [...input.entries];
      refresh();
      notify();
    },
    resetProjection: async () => {
      projection = [...persisted];
      refresh();
      notify();
    },
    exportSnapshot: (): TimelineHarnessSnapshot => ({
      persisted: [...persisted],
      projection: [...projection],
      persistedVersion: persisted.length,
      projectionVersion: version,
    }),
    importSnapshot: async (snap: TimelineHarnessSnapshot): Promise<void> => {
      // Mock: rewrite from snapshot.
      persisted.length = 0;
      persisted.push(...snap.persisted);
      projection = [...snap.projection];
      version = snap.projectionVersion;
      snapshot = { entries: [...projection], version };
      notify();
    },
    close: async () => {},
  };
}

/**
 * Mock knobs harness — minimal Map + listener set; satisfies
 * `KnobsHarnessProtocol`. No validation pipeline, no envelopes, no
 * inbox. Use `@agentick/knobs-next/testing` for tests that exercise harness
 * behavior.
 */
export function fakeKnobsHarness(
  initial: Readonly<Record<string, KnobPrimitive>> = {},
): KnobsHarnessProtocol {
  const values = new Map<string, KnobPrimitive>(Object.entries(initial));
  const descriptors = new Map<string, KnobDescriptor>();
  for (const [id, value] of values) {
    descriptors.set(id, { id, value, valueType: typeof value as "string" | "number" | "boolean" });
  }
  const notifier = createKeyedNotifier();
  // Cached snapshot ref — invalidated on every mutation. Without this
  // `useSyncExternalStore` sees a fresh array on every list() call and
  // loops infinitely. Mirrors the real KnobsHarness's `listCache`.
  let listCache: readonly KnobDescriptor[] | null = null;
  const fire = (id: string) => {
    listCache = null;
    notifier.notify(id);
  };

  return {
    id: "mock:knobs",
    ready: Promise.resolve(),
    get: (id) => values.get(id),
    has: (id) => values.has(id),
    list: () => {
      if (listCache !== null) return listCache;
      listCache = [...descriptors.values()];
      return listCache;
    },
    subscribe: (id, l) => notifier.subscribe(id, l),
    subscribeAll: (l) => notifier.subscribeAll(l),
    set: async ({ id, value }: KnobsSetInput) => {
      values.set(id, value);
      const prev = descriptors.get(id);
      descriptors.set(id, { ...(prev ?? {}), id, value });
      fire(id);
    },
    register: async ({ id, descriptor }: KnobsRegisterInput) => {
      const current = values.has(id) ? values.get(id) : descriptor.defaultValue;
      if (current !== undefined && !values.has(id)) values.set(id, current);
      descriptors.set(id, { ...descriptor, id, value: current });
      fire(id);
    },
    dispatch: async (_input: KnobsDispatchInput) => {
      // Mock — accept without validation. Returns minimal content.
      return [{ type: "text", text: "(mock) set_knob applied" }];
    },
    exportSnapshot: () => {
      const out: Record<string, KnobPrimitive> = {};
      for (const [k, v] of values) out[k] = v;
      return out;
    },
    importSnapshot: (snap: Readonly<Record<string, KnobPrimitive>>) => {
      values.clear();
      descriptors.clear();
      for (const [k, v] of Object.entries(snap)) {
        values.set(k, v);
        descriptors.set(k, {
          id: k,
          value: v,
          valueType: typeof v as "string" | "number" | "boolean",
        });
        fire(k);
      }
    },
    close: async () => {},
  };
}

/**
 * Mock state harness — Map + listeners; satisfies
 * `StateHarnessProtocol`. Use `@agentick/state-next/testing` for tests that
 * exercise harness behavior.
 */
export function mockStateHarness(
  initial: Readonly<Record<string, unknown>> = {},
): StateHarnessProtocol {
  const values = new Map<string, unknown>(Object.entries(initial));
  const notifier = createKeyedNotifier();
  const fire = (key: string) => {
    notifier.notify(key);
  };

  return {
    id: "mock:state",
    ready: Promise.resolve(),
    get: (key) => values.get(key),
    has: (key) => values.has(key),
    list: () => [...values.keys()],
    subscribe: (key, l) => notifier.subscribe(key, l),
    subscribeAll: (l) => notifier.subscribeAll(l),
    set: async ({ key, value }: StateSetInput) => {
      values.set(key, value);
      fire(key);
    },
    delete: async ({ key }: StateDeleteInput) => {
      if (!values.has(key)) return;
      values.delete(key);
      fire(key);
    },
    exportSnapshot: () => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of values) out[k] = v;
      return out;
    },
    importSnapshot: (snap: Readonly<Record<string, unknown>>) => {
      const before = new Set(values.keys());
      values.clear();
      for (const [k, v] of Object.entries(snap)) values.set(k, v);
      const after = new Set(values.keys());
      for (const k of new Set([...before, ...after])) fire(k);
    },
    close: async () => {},
  };
}

export function stubLoopBridge(): LoopBridge {
  return {
    continueAfterTick: () => {},
    stopAfterTick: () => {},
  };
}

export function stubSessionBridge(id = "s_stub"): SessionBridge {
  return { id, status: "idle" };
}

export interface FakeBridgesOptions {
  readonly sessionId?: string;
  readonly knobs?: Readonly<Record<string, KnobPrimitive>>;
  readonly state?: Record<string, unknown>;
  readonly timeline?: readonly TimelineEntry[];
  readonly onDataSettled?: (key: string) => void;
}

/**
 * Convenience: produce a `HookBridges` bundle with mock protocol
 * implementations. Suitable for testing the COMPILER itself —
 * mount, render, lifecycle, snapshot mechanics.
 *
 * Tests that exercise specific harness behavior (knobs validation
 * pipeline, timeline pending/drain semantics, state K/V routing
 * through real Operations) should NOT use this — they belong in the
 * relevant harness package's `__tests__/integration-with-compiler.spec.tsx`
 * and use real harness stubs from `@agentick/<harness>/testing`.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */
export function fakeBridges(options: FakeBridgesOptions = {}): HookBridges {
  // `timeline`, `knobs`, `state` are typed onto HookBridges only when
  // their respective packages' `augment.ts` is loaded. This package
  // doesn't depend on those harness packages, so the slots aren't
  // visible here at typecheck — we still construct them at runtime
  // (consumers who imported `@agentick/{timeline,knobs,state}` see
  // them typed). Cast through `unknown` to acknowledge the type gap.
  return {
    data: new InMemoryDataBridge({ onSettled: options.onDataSettled }),
    loop: stubLoopBridge(),
    session: stubSessionBridge(options.sessionId),
    // ADR 56: a fresh `ModelBridge` so `fakeBridges()` callers exercising
    // `useModelRegistration` get a real registry. Undeclared mounts never
    // touch it (the loop falls back to its send/session executor).
    models: new InMemoryModelBridge(),
    timeline: fakeTimelineHarness(options.timeline),
    knobs: fakeKnobsHarness(options.knobs),
    state: mockStateHarness(options.state),
  } as unknown as HookBridges;
}

// Note: `stubKnobsHarness`, `stubTimelineHarness`, `stubStateHarness`
// (the REAL harness factories) live in their respective packages'
// `/testing` subpaths now (`@agentick/timeline-next/testing`, etc.).
// This package does not ship them — tests that need real
// harness behavior import directly from those packages.

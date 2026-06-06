---
name: create-harness
description: Build a new v2 harness — a `BaseHarness` subclass with substrate, protocol, augmentation, optional /react and /testing subpaths, and conformance suite. Use when an adopter or contributor needs to add a session-scoped or app-scoped capability that owns its own bus/inbox/journal participation, OR when implementing a custom backend for an existing harness protocol (e.g., a Postgres-backed TimelineHarness). Referenced by `create-extension` (the adopter-facing entry) and by the future `customize-[harness]` family.
---

# Create a v2 Harness

This skill produces the canonical v2 harness shape: a `BaseHarness<"surface">` subclass with a typed protocol, inbox catalog, augmentation onto `HookBridges`, an extension factory (`withX()`), optional `/react` and `/testing` subpaths, and a shared conformance suite.

Every built-in harness in v2 — knobs, state, timeline, gates, sandbox, MCP, subscriptions — follows this shape. New extensions follow it. Custom backends for existing protocols (a Redis-backed knobs, a Postgres-backed timeline) implement the same protocol and satisfy the same conformance suite.

**Audience.** Adopters writing a published `@my-org/agentick-thing` package. Contributors adding a built-in harness to the workspace. The mechanical content is identical for both; packaging differs at the end (see `create-extension` for the lighter local-only path).

**Output.** A package (or local module) that:

- Extends `BaseHarness<"surface">` correctly, with substrate slot inheritance
- Defines a `*HarnessProtocol` interface that any impl can satisfy
- Routes inbox messages via a typed discriminated catalog
- Wraps async writes in `runOperation` (audit trail, idempotency, lifecycle handlers)
- Augments `HookBridges` (and optionally `SessionHarnessProtocol`) via `declare module`
- Ships `withX()` as a `SessionExtension` or `AppExtension`
- Passes its own conformance suite
- Optionally exposes `/react` (hook + components) and `/testing` (stub factory) subpaths

## Required reading

Read these end-to-end before writing code. They are the contract.

1. **`docs/proposals/v2/blueprint/26-harness-api-shape.md`** (ADR 26) — "Harness as the single shape." Defines what a harness IS, what it owns, and why bridges-vs-harnesses isn't a meaningful distinction.

2. **`docs/proposals/v2/blueprint/27-modular-built-ins.md`** (ADR 27, foundational) — Built-ins are not "built in," they are *bundled*. Every harness package follows the same architectural pattern. The module-augmentation discipline is non-negotiable. Read every section.

3. **`docs/proposals/v2/blueprint/31-harness-hierarchy.md`** (ADR 31) — Self-similar slottable harness hierarchy. Substrate slots (`bus | inbox | journal`) accept `instance | factory` at every level. This is inherited from `BaseHarness` — your harness gets it for free, but you must construct correctly.

4. **`docs/proposals/v2/blueprint/19-foundation.md`** — Substrate primitives (Journal, Bus, Inbox), the `Operation` shape, lifecycle handlers, idempotency, journaling policy. Your async surface composes Operations; you need to understand them.

5. **`packages/spec/src/protocol/app-extension.ts`** — `Extension`, `AppExtension`, `SessionExtension`, `AppInstaller`, `SessionInstaller`, `AppSubstrate`. The integration contract your `withX()` factory implements.

6. **`packages/spec/src/protocol/hook-bridges.ts`** — The empty seed interface every harness augments. Read the file even though it's nearly empty; the comments document the augmentation discipline.

7. **`packages/runtime/src/substrate/base-harness.ts`** — `BaseHarness` constructor signature, `HarnessShell`, `runOperation`, `runHarnessProtocol`, `handleMessage`, lifecycle hooks. You will extend this class.

8. **`packages/knobs/`** — The canonical reference impl. Read every file. This is the shape to copy:
   - `src/harness.ts` — `BaseHarness<"knobs">` subclass with sync + async surface
   - `src/augment.ts` — dual augmentation pattern (`HookBridges.knobs` + `SessionHarnessProtocol.knobs`)
   - `src/extension.ts` — `withKnobs()` `SessionExtension` factory
   - `src/handle.ts` — curated user-facing API exposed on the session
   - `src/conformance.ts` — `runKnobsHarnessConformance()` factory-deps suite
   - `src/react/use-knob.ts` — `useBridges()` + `useSyncExternalStore` pattern
   - `src/testing/index.ts` — `stubKnobsHarness()` factory
   - `src/__tests__/harness.spec.ts` — harness-only tests
   - `src/__tests__/integration-with-reconciler.spec.tsx` — real-`ReconcilerHarness` integration
   - `package.json` — `sideEffects`, dual subpaths, optional react peer dep

9. **`packages/state/`** — Second reference. Differs from knobs in: persistence layer (state survives `serialize`/`restore`), simpler async surface. Read for the snapshot/restore contract.

10. **`packages/timeline/`** — Third reference. Differs in: large async surface (append, projection, two-tier log), strategies file (`strategies.ts`) for pluggable behavior. Read if your harness has compositional internals.

11. **`packages/sandbox/`** — Per-session-factory variant. Read if your harness needs per-session instance lifecycle that the bundled installer pattern doesn't directly model.

If any of those don't make sense after reading, stop and ask. The skill assumes you've internalized them.

## Decision tree before writing

Answer these before opening an editor. They determine the shape.

### Q1. Is this really a harness?

A harness owns substrate participation. It publishes envelopes through a bus, appends to a journal, and routes inbox messages. If your "extension" doesn't do any of those — it's just a React hook, a reconciler contributor, a tool, or a formatter — **it is not a harness**. Reference `create-extension` for the right category.

You are writing a harness if **any** of these are true:

- The capability produces an audit trail (envelopes on the bus that future-you or an external observer will read)
- The capability has model-visible state that mutates via async commands (knobs pattern)
- The capability accepts inbox messages from other actors (remote dashboards, cluster peers, sibling harnesses)
- The capability owns a long-lived resource that needs close() lifecycle (sandbox provider, MCP connection)
- Adopters might want to swap the implementation (`withTimeline({ impl: PostgresTimeline })`)

You are **not** writing a harness if:

- It's purely render-time (a formatter, a semantic component, a content-block contributor) — `create-component` instead
- It's a single tool with a handler — `create-tool` instead
- It's a React hook that subscribes to an existing bridge — write the hook in the consumer
- It's a model adapter — `create-adapter` instead

### Q2. Session-scoped or app-scoped?

- **Session-scoped** (`target: "session"`): one instance per session. Per-session state. Most common. Matches knobs, state, timeline, gates, sandbox-session, MCP, subscriptions.
- **App-scoped** (`target: "app"`): one instance for the entire app. Shared across every session. Matches sandbox-provider, app-level registries, app-level connection pools.

Many extensions are session-scoped but read app-scoped resources. Sandbox uses the pair pattern (`withSandbox()` returns `readonly [AppExtension, SessionExtension]` — the App registers the provider, the Session reads it through `installer.app.metadata` / a closure-captured registry).

If unsure, default to session-scoped.

### Q3. Does it need a curated handle, or expose the full protocol?

Two augmentation patterns:

- **Handle pattern** (knobs, state, timeline). The harness implements the full protocol. The augmentation puts the full protocol on `HookBridges.x` (for internal bridge plumbing) AND a curated subset on `SessionHarnessProtocol.x` (for adopter ergonomics — hides `id`, `close`, `ready`, internal methods). Adopters reach the handle via `session.x`.
- **Full protocol exposed** (gates if it had a harness, simpler extensions). No handle file; the augmentation just puts the protocol on `HookBridges.x`. Adopters reach it via `useBridges().x` in React or through whatever surface you expose.

Default to the handle pattern unless the harness genuinely has nothing to hide. The handle gives you room to add internal lifecycle without breaking adopters.

### Q4. Does it need snapshot/restore?

If state must survive `app.serialize()` / `app.restore()` (i.e., session lives longer than the process), implement `SnapshotCapable`:

```ts
exportSnapshot(): unknown;
importSnapshot(snapshot: unknown): void;
```

Per ADR 27, the framework iterates `HookBridges` generically and feature-detects `SnapshotCapable` — no hardcoded slot names. If you implement it, your harness participates automatically.

Skip it for transient state (per-execution caches, in-flight connection tracking).

### Q5. Does it need a `/react` subpath?

Yes if adopters consume the harness from JSX. The `/react` subpath ships:

- `useX()` hook(s) that consume `useBridges()` and subscribe to the harness
- Optional component wrappers (`<X />`) that mount-time-register with the harness

Skip if the harness is pure server-side (no React consumer). Example: a background-scheduler harness with no UI.

If you ship `/react`, mark `react` as an optional peer dep in `package.json`. The base package must not import React.

### Q6. Does it need a `/testing` subpath?

Yes if downstream code unit-tests components that consume the hook. The `/testing` subpath ships:

- `stubX()` factory that returns a fresh harness with in-memory substrate and optional seed state

Skip only if there's genuinely no need (rare).

### Q7. Does it have peers it composes with?

Some harnesses look up other harnesses at install time:

```ts
// hypothetical
const knobs = installer.getNamespace<KnobsHarness>("knobs");
if (knobs) {
  // wire something up
}
```

If yes, document the soft dependency in your package README. The install order is last-writer-wins — sibling harnesses might not be present yet. Use `installer.getNamespace<T>(name)` defensively (it can return `undefined`).

## Package skeleton

Create `packages/my-thing/` (workspace package) or `@my-org/agentick-my-thing` (published package).

### `package.json`

The canonical shape — adapt names + scope.

```json
{
  "name": "@agentick/my-thing",
  "version": "0.0.0",
  "description": "MyThing harness — <one-line description>. Per ADR 26, this is a harness (extends BaseHarness).",
  "license": "MIT",
  "type": "module",
  "main": "src/index.ts",
  "sideEffects": [
    "./src/index.ts",
    "./src/augment.ts",
    "./dist/index.js",
    "./dist/augment.js"
  ],
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./src/index.ts"
    },
    "./react": {
      "types": "./src/react/index.ts",
      "import": "./src/react/index.ts",
      "default": "./src/react/index.ts"
    },
    "./testing": {
      "types": "./src/testing/index.ts",
      "import": "./src/testing/index.ts",
      "default": "./src/testing/index.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.build.json --noEmit"
  },
  "dependencies": {
    "@agentick/spec": "workspace:*",
    "@agentick/runtime": "workspace:*",
    "@agentick/reconciler": "workspace:*",
    "@agentick/reconciler-react": "workspace:*",
    "effect": "^3.21.2"
  },
  "devDependencies": {
    "@agentick/spec-conformance": "workspace:*",
    "@types/react": "^19.2.5"
  },
  "peerDependencies": {
    "react": "^19.0.0"
  },
  "peerDependenciesMeta": {
    "react": { "optional": true }
  }
}
```

**Non-negotiable details:**

- `sideEffects` lists `augment.js` and `augment.ts` — bundlers MUST NOT tree-shake the augmentation file. Without this, your `declare module` slot disappears in production builds and the framework can't find your bridge.
- `react` is an **optional** peer. The base package must never import React. Only files under `src/react/` import React.
- Workspace deps use `workspace:*`. Published packages outside the workspace use actual version ranges.

### `tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "compilerOptions": {
    "rootDir": "src",
    "jsx": "react-jsx"
  }
}
```

### `tsconfig.build.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist"
  }
}
```

### Directory layout

```
packages/my-thing/
  package.json
  tsconfig.json
  tsconfig.build.json
  README.md
  src/
    index.ts                              ← package entry; imports ./augment for side effects
    harness.ts                            ← BaseHarness<"my-thing"> subclass
    augment.ts                            ← declare module "@agentick/spec"
    extension.ts                          ← withMyThing() SessionExtension factory
    handle.ts                             ← curated user-facing API (optional but recommended)
    conformance.ts                        ← runMyThingHarnessConformance(deps)
    react/
      index.ts                            ← barrel
      use-my-thing.ts                     ← primary hook
      components.tsx                      ← optional component wrappers
    testing/
      index.ts                            ← stubMyThingHarness()
    __tests__/
      harness.spec.ts                     ← harness-only tests (uses in-memory substrate)
      integration-with-reconciler.spec.tsx ← integration with real ReconcilerHarness
      conformance.spec.ts                 ← runs the conformance suite against the default impl
```

## Step-by-step build

### Step 1. Protocol shape (`packages/spec/src/protocol/my-thing-harness.ts`)

The protocol lives in `@agentick/spec`. Bundled built-ins do this; published external extensions can either contribute via PR or keep their protocol local (see "Local protocol variant" at the end).

```ts
import type { ContentBlock } from "../data/content-block.js";
import type { Unsubscribe } from "./inbox.js";

// Input types — what `set` / `dispatch` / etc. accept.
export interface MyThingSetInput {
  readonly id: string;
  readonly value: string;
}

// Discriminated inbox catalog — typed messages this harness handles.
// Other actors (cluster peers, sibling harnesses, admin dashboards)
// address inbox messages here.
export type MyThingInboxMessage =
  | { readonly type: "my-thing:set"; readonly payload: MyThingSetInput }
  | { readonly type: "my-thing:reset"; readonly payload: { readonly id: string } };

// The full protocol — implementations satisfy this. Conformance tests
// against this interface, not against the concrete class.
export interface MyThingHarnessProtocol {
  readonly id: string;
  readonly ready: Promise<void>;
  close(): Promise<void>;

  // Sync surface — reads from local state, cheap, no envelopes.
  get(id: string): string | undefined;
  has(id: string): boolean;
  list(): readonly { readonly id: string; readonly value: string }[];
  subscribe(id: string, listener: () => void): Unsubscribe;
  subscribeAll(listener: () => void): Unsubscribe;

  // Async surface — full Operations with audit envelopes.
  set(input: MyThingSetInput): Promise<void>;
  reset(input: { readonly id: string }): Promise<readonly ContentBlock[]>;

  // Optional: snapshot/restore (SnapshotCapable feature detection).
  exportSnapshot(): Readonly<Record<string, string>>;
  importSnapshot(snapshot: Readonly<Record<string, string>>): void;
}
```

Add an export to `packages/spec/src/protocol/index.ts` and re-export from `packages/spec/src/index.ts`.

**Design notes:**

- **Sync reads, async writes.** Read methods (`get`, `list`, `has`, `subscribe`) are synchronous — they read from local Maps maintained by the harness. Write methods (`set`, `reset`) return Promises because they go through `runOperation` (lifecycle handlers → middleware → body → terminal envelope on bus + journal). This split is canonical. Do not make reads async; the React side depends on sync reads through `useSyncExternalStore`.
- **`Unsubscribe`** is imported from `@agentick/spec` — a `() => void` newtype. Always return it from `subscribe*`.
- **Inbox catalog** as a discriminated union. The `type` field is the discriminator. Cluster routing depends on this shape.

### Step 2. Harness impl (`src/harness.ts`)

```ts
import { Effect } from "effect";
import { BaseHarness, runHarnessProtocol, ulid, type Unsubscribe } from "@agentick/runtime";
import type {
  ContentBlock,
  EventBus,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  MyThingHarnessProtocol,
  MyThingInboxMessage,
  MyThingSetInput,
  Operation,
  OperationJournal,
} from "@agentick/spec";

export class MyThingHarness
  extends BaseHarness<"my-thing">
  implements MyThingHarnessProtocol
{
  private readonly values = new Map<string, string>();
  private readonly idListeners = new Map<string, Set<() => void>>();
  private readonly wildcards = new Set<() => void>();
  private listCache: readonly { readonly id: string; readonly value: string }[] | null = null;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
  ) {
    super("my-thing", scopeId, journal, bus, inbox);
  }

  // ─────────── Sync surface ───────────

  get(id: string): string | undefined {
    return this.values.get(id);
  }

  has(id: string): boolean {
    return this.values.has(id);
  }

  list(): readonly { readonly id: string; readonly value: string }[] {
    if (this.listCache !== null) return this.listCache;
    const out: { readonly id: string; readonly value: string }[] = [];
    for (const [id, value] of this.values) out.push({ id, value });
    this.listCache = out;
    return out;
  }

  subscribe(id: string, listener: () => void): Unsubscribe {
    let set = this.idListeners.get(id);
    if (!set) {
      set = new Set();
      this.idListeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  subscribeAll(listener: () => void): Unsubscribe {
    this.wildcards.add(listener);
    return () => {
      this.wildcards.delete(listener);
    };
  }

  // ─────────── Async surface — full Operations ───────────

  set(input: MyThingSetInput): Promise<void> {
    const op: Operation<MyThingSetInput, void, never> = {
      opId: `my-thing:set:${ulid()}`,
      surface: "my-thing",
      name: "my-thing:command:set",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.applySet(i);
        }),
      ),
    );
  }

  reset(input: { readonly id: string }): Promise<readonly ContentBlock[]> {
    const op: Operation<{ readonly id: string }, readonly ContentBlock[], never> = {
      opId: `my-thing:reset:${ulid()}`,
      surface: "my-thing",
      name: "my-thing:command:reset",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.values.delete(i.id);
          this.invalidateAndNotify(i.id);
          return [{ type: "text" as const, text: `reset ${i.id}` }];
        }),
      ),
    );
  }

  // ─────────── Snapshot / restore (optional — implements SnapshotCapable) ───────────

  exportSnapshot(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.values);
  }

  importSnapshot(snapshot: Readonly<Record<string, string>>): void {
    this.values.clear();
    for (const [k, v] of Object.entries(snapshot)) this.values.set(k, v);
    this.listCache = null;
    for (const l of this.wildcards) l();
  }

  // ─────────── Inbox handler — required by BaseHarness ───────────

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    const payload = msg.body as MyThingInboxMessage;
    switch (payload.type) {
      case "my-thing:set":
        return Effect.tryPromise({
          try: () => this.set(payload.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerFailed", cause }),
        });
      case "my-thing:reset":
        return Effect.tryPromise({
          try: () => this.reset(payload.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerFailed", cause }),
        });
      default:
        return Effect.fail({
          _tag: "UnknownMessageType",
          messageType: (payload as { type: string }).type,
        });
    }
  }

  // ─────────── Private mutation helpers ───────────

  private applySet(input: MyThingSetInput): void {
    this.values.set(input.id, input.value);
    this.invalidateAndNotify(input.id);
  }

  private invalidateAndNotify(id: string): void {
    this.listCache = null;
    const set = this.idListeners.get(id);
    if (set) for (const l of set) l();
    for (const l of this.wildcards) l();
  }
}
```

**Key mechanics — internalize these:**

1. **Constructor passes positional substrate to `super`.** The substrate slot pattern (instance | factory) is inherited from `BaseHarness`. Your constructor takes `(scopeId, journal, bus, inbox)` as defaults; callers who pass `options.bus = factory` to `super()` get the factory resolved into a real bus. Don't reinvent this.

2. **Sync surface reads from local Maps.** No Effect. No envelopes. Cheap.

3. **`listCache`.** Cache the array returned by `list()` until a mutation invalidates it. React's `useSyncExternalStore` checks reference equality — without caching, every read returns a fresh array and triggers infinite re-renders.

4. **Async surface wraps `runOperation`.** Build an `Operation<Input, Output, Error>` envelope, pass the body as an Effect, call `this.runOperation(op, body)`, wrap with `runHarnessProtocol` to convert the Effect into a Promise the protocol method signature requires.

5. **`opId`** includes a ULID. Always. Idempotency replay depends on it.

6. **`scope.sessionId`** is `this.scopeId`. Envelopes are scoped to the harness's scope id (which is the session id for session-scoped harnesses).

7. **`handleMessage` is the inbox catalog dispatcher.** Discriminate on the `type` field. Return `Effect.fail({ _tag: "UnknownMessageType", ... })` for unrecognized types — the framework logs + drops without crashing.

8. **Mutation helpers (`applySet`) are private.** Only the Operation body calls them. This ensures every mutation flows through the audit trail.

9. **Subscription fan-out runs synchronously inside the Operation body.** Listeners fire before the Operation's terminal envelope publishes. React state updates happen synchronously with the mutation.

### Step 3. Augmentation (`src/augment.ts`)

```ts
import type { MyThingHarnessProtocol } from "@agentick/spec";
import type { MyThingHandle } from "./handle.js";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly myThing: MyThingHarnessProtocol;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /** Curated handle exposed at `session.myThing`. */
    readonly myThing: MyThingHandle;
  }
}
```

**Two augmentations:**

- `HookBridges.myThing` — the full protocol. Internal plumbing; `useBridges().myThing` in React.
- `SessionHarnessProtocol.myThing` — the curated handle. Adopter ergonomics; `session.myThing` everywhere.

If you skipped the handle (Q3 = full protocol exposed), augment only `HookBridges`.

**Common pitfall:** forgetting to import this file as a side effect. `index.ts` must include `import "./augment.js";` at the top. Otherwise the slot doesn't register at runtime, even though TypeScript thinks it exists. The `sideEffects` array in `package.json` keeps bundlers from tree-shaking it.

### Step 4. Handle (`src/handle.ts`)

```ts
import type { ContentBlock, Unsubscribe } from "@agentick/spec";
import type { MyThingSetInput } from "@agentick/spec";

export interface MyThingHandle {
  list(): readonly { readonly id: string; readonly value: string }[];
  get(id: string): string | undefined;
  has(id: string): boolean;
  set(input: MyThingSetInput): Promise<void>;
  reset(input: { readonly id: string }): Promise<readonly ContentBlock[]>;
  subscribe(id: string, listener: () => void): Unsubscribe;
  subscribeAll(listener: () => void): Unsubscribe;
}
```

Structural subset of the protocol. Hides `id`, `ready`, `close`, `exportSnapshot`, `importSnapshot`. No runtime wrapping — the harness class IS a structural `MyThingHandle` because it satisfies the same method shape.

### Step 5. Extension factory (`src/extension.ts`)

```ts
import type { SessionExtension, SessionInstaller } from "@agentick/spec";
import { MyThingHarness } from "./harness.js";

export interface WithMyThingOptions {
  readonly initial?: Readonly<Record<string, string>>;
}

export function withMyThing(options: WithMyThingOptions = {}): SessionExtension {
  return {
    name: "@agentick/my-thing",
    target: "session",
    install: async (installer: SessionInstaller) => {
      const harness = new MyThingHarness(
        `${installer.hostId}:my-thing`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
      );
      await harness.ready;

      if (options.initial) {
        harness.importSnapshot(options.initial);
      }

      installer.registerNamespace("myThing", harness);
      installer.onClose(() => harness.close());
    },
  };
}
```

**Notes:**

- `name` is a stable identifier (used for diagnostics, slot routing). Last-writer-wins on collision.
- `target: "session"` routes to `SessionInstaller`. Change to `"app"` if app-scoped (and accept `AppInstaller`).
- `installer.substrate.{journal,bus,inbox}` are the host's substrate — your harness shares them. Events appear in `session.events()`.
- `installer.registerNamespace(slotName, harness)` — `slotName` matches your augmentation key (`myThing`).
- `installer.onClose` — clean teardown. Symmetric to your harness's `close()`.
- `harness.ready` — wait for the BaseHarness initialization (slot resolution, lifecycle replay) before continuing.

**App-scoped variant** (when `target: "app"`):

```ts
import type { AppExtension, AppInstaller } from "@agentick/spec";

export function withMyThingApp(...): AppExtension {
  return {
    name: "@agentick/my-thing",
    target: "app",
    install: async (installer: AppInstaller) => {
      // Same shape; AppInstaller has additional methods:
      // - registerContributor (reconciler-side)
      // - registerToolHandler (pre-mount tools)
      // - subscribeBus (telemetry observers)
    },
  };
}
```

**Multi-target variant** (sandbox pattern — pairs an AppExtension with a SessionExtension):

```ts
export function withMyThing(opts): readonly [AppExtension, SessionExtension] {
  const providerRegistry = new Map();
  return [
    { name: "@agentick/my-thing", target: "app", install: ... /* register app-level state */ },
    { name: "@agentick/my-thing", target: "session", install: ... /* per-session reads from providerRegistry */ },
  ] as const;
}
```

### Step 6. Conformance suite (`src/conformance.ts`)

```ts
import { describe, expect, it } from "vitest";
import type { MyThingHarnessProtocol } from "@agentick/spec";

export interface MyThingHarnessFactoryDeps {
  readonly make: () => Promise<MyThingHarnessProtocol>;
}

export function runMyThingHarnessConformance(deps: MyThingHarnessFactoryDeps): void {
  describe("MyThingHarness — sync surface", () => {
    it("get() returns undefined for unknown ids", async () => {
      const h = await deps.make();
      expect(h.get("missing")).toBeUndefined();
      await h.close();
    });

    it("list() returns the same reference between mutations", async () => {
      const h = await deps.make();
      await h.set({ id: "a", value: "1" });
      const a = h.list();
      const b = h.list();
      expect(a).toBe(b);
      await h.close();
    });

    it("list() returns a fresh reference after a mutation", async () => {
      const h = await deps.make();
      const before = h.list();
      await h.set({ id: "a", value: "1" });
      expect(h.list()).not.toBe(before);
      await h.close();
    });
  });

  describe("MyThingHarness — async surface", () => {
    it("set() + get() round-trip", async () => {
      const h = await deps.make();
      await h.set({ id: "k", value: "v" });
      expect(h.get("k")).toBe("v");
      await h.close();
    });

    it("subscribe() fires per-id", async () => {
      const h = await deps.make();
      let n = 0;
      const unsub = h.subscribe("k", () => { n++; });
      await h.set({ id: "k", value: "1" });
      await h.set({ id: "k", value: "2" });
      expect(n).toBe(2);
      unsub();
      await h.set({ id: "k", value: "3" });
      expect(n).toBe(2);
      await h.close();
    });

    it("subscribeAll() fires on any mutation", async () => {
      const h = await deps.make();
      let n = 0;
      h.subscribeAll(() => { n++; });
      await h.set({ id: "a", value: "1" });
      await h.set({ id: "b", value: "2" });
      expect(n).toBeGreaterThanOrEqual(2);
      await h.close();
    });
  });

  describe("MyThingHarness — snapshot/restore", () => {
    it("export → import round-trips", async () => {
      const h1 = await deps.make();
      await h1.set({ id: "a", value: "1" });
      await h1.set({ id: "b", value: "2" });
      const snap = h1.exportSnapshot();
      await h1.close();

      const h2 = await deps.make();
      h2.importSnapshot(snap);
      expect(h2.get("a")).toBe("1");
      expect(h2.get("b")).toBe("2");
      await h2.close();
    });
  });
}
```

**The factory-deps pattern is canonical.** Conformance tests against the protocol via `deps.make()`. Default impl runs it in `__tests__/conformance.spec.ts`. Alternative impls (Redis-backed, Postgres-backed, test stubs) opt in by calling `runMyThingHarnessConformance({ make: () => makeRedisMyThing() })`.

### Step 7. `/react` subpath

`src/react/index.ts`:

```ts
export { useMyThing } from "./use-my-thing.js";
```

`src/react/use-my-thing.ts`:

```ts
import { useCallback, useSyncExternalStore } from "react";
import { useBridges } from "@agentick/reconciler-react";

export function useMyThing(id: string): readonly [string | undefined, (value: string) => void] {
  const { myThing } = useBridges();

  const value = useSyncExternalStore(
    useCallback((onChange) => myThing.subscribe(id, onChange), [myThing, id]),
    useCallback(() => myThing.get(id), [myThing, id]),
    useCallback(() => myThing.get(id), [myThing, id]),
  );

  const setter = useCallback(
    (next: string) => {
      void myThing.set({ id, value: next });
    },
    [myThing, id],
  );

  return [value, setter] as const;
}
```

**Mechanics:**

- `useBridges()` returns the typed `HookBridges` bag. Your augmentation slot (`myThing`) is reachable here.
- `useSyncExternalStore` is mandatory for React 18+ concurrent-safe subscriptions. The three args are: subscribe (returns unsubscribe), getSnapshot (current value), getServerSnapshot (SSR fallback).
- Setter is `void`-prefixed because `set` is async but the React setter API is sync. The Operation completes in the background; the subscribe callback fires when the value lands.
- Memoize callbacks with `useCallback` — `useSyncExternalStore` re-subscribes on identity change.

**Optional component wrappers** (`src/react/components.tsx`) — common pattern is a `<MyThing />` JSX component that registers a default value or renders the harness's state.

### Step 8. `/testing` subpath

`src/testing/index.ts`:

```ts
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import { MyThingHarness } from "../harness.js";

export function stubMyThingHarness(
  initial: Readonly<Record<string, string>> = {},
): MyThingHarness {
  const harness = new MyThingHarness(
    `stub:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  if (Object.keys(initial).length > 0) {
    harness.importSnapshot(initial);
  }
  return harness;
}
```

Used by downstream tests of components that consume `useMyThing()`. Pair with `@agentick/reconciler-react`'s test bridges to render-test a component in isolation.

### Step 9. Package entry (`src/index.ts`)

```ts
// Side-effect import — registers HookBridges.myThing slot.
import "./augment.js";

export { MyThingHarness } from "./harness.js";
export type { MyThingHandle } from "./handle.js";
export { withMyThing, type WithMyThingOptions } from "./extension.js";
export { runMyThingHarnessConformance } from "./conformance.js";
```

**Order matters.** `import "./augment.js"` must come first so the module augmentation registers before any consumer imports.

### Step 10. Tests

`src/__tests__/harness.spec.ts` — harness-only tests using the in-memory substrate (NO ReconcilerHarness). Test internals, edge cases, error paths.

`src/__tests__/conformance.spec.ts`:

```ts
import { runMyThingHarnessConformance } from "../conformance.js";
import { stubMyThingHarness } from "../testing/index.js";

runMyThingHarnessConformance({
  make: async () => {
    const h = stubMyThingHarness();
    await h.ready;
    return h;
  },
});
```

`src/__tests__/integration-with-reconciler.spec.tsx` — uses `@testing-library/react` + a real `ReconcilerHarness` with the harness installed via `withMyThing()`. Test that the React hook actually re-renders when the harness mutates.

## Registration checklist (workspace package)

Skip if this is a local module inside an adopter's app — see `create-extension` for the local mode.

1. **`pnpm install`** to register the workspace package
2. **`.changeset/config.json`** — add `@agentick/my-thing` to `linked[0]` array (semver linkage across the workspace)
3. **`website/typedoc.json`** — add `packages/my-thing/src/index.ts` to `entryPoints`
4. **`website/.vitepress/config.mts`** — add to `PACKAGE_GROUPS` in the right group
5. **`packages/my-thing/README.md`** — Purpose, Quick Start, API reference, Patterns. Match existing package READMEs.
6. **Metapackage bundle** — if this is a bundled built-in, re-export from `agentick/index.ts`. Skip if it's an optional extension.

## Common pitfalls (read before debugging)

1. **`sideEffects` missing or wrong.** The augmentation file gets tree-shaken; the slot disappears at runtime; `useBridges().myThing` is undefined in production but works in dev. Always include `augment.ts` and `augment.js` in `sideEffects`.

2. **Forgetting `import "./augment.js"` in `index.ts`.** TypeScript sees the slot; runtime doesn't register it. Symptom: types compile, `useBridges().myThing` is `undefined` at runtime.

3. **Reads going async.** Tempting to make `get()` return a Promise to "be consistent." Don't. `useSyncExternalStore` requires sync getSnapshot. If you need async loading, gate behind a separate async surface and cache sync.

4. **`list()` returning a fresh array.** Symptom: React infinite re-renders. Always cache; invalidate on mutation.

5. **Hardcoding the slot name in snapshot/restore.** ADR 27 mandates generic iteration with `SnapshotCapable` feature detection. Implement `exportSnapshot`/`importSnapshot` on the harness; the framework finds them. Don't try to hook into snapshot/restore explicitly — the framework iterates `HookBridges` for you.

6. **React subpath depending on the harness package depending on `reconciler-react`.** Cycle. The harness package depends on `@agentick/reconciler-react` (for `useBridges`); `@agentick/reconciler-react` MUST NOT depend on the harness package. Per ADR 27, reconciler-react has no harness deps.

7. **Skipping `await harness.ready`.** Operations queued before `ready` resolves silently drop. Always `await ready` in your extension's `install`.

8. **Constructor not passing positional substrate to `super`.** Substrate slot pattern is inherited from BaseHarness; your constructor passes defaults, BaseHarness handles instance|factory resolution from options. If you do anything custom here you're probably wrong.

9. **`scope.sessionId` mismatch.** Every Operation envelope you build must carry `scope: { sessionId: this.scopeId }`. Downstream observers filter by session id. Missing or wrong scope means envelopes vanish from `session.events()`.

10. **Synchronous listeners + mutation reentry.** A `subscribe` callback that calls `harness.set()` recursively will deadlock or stack-blow. Subscribers should READ, not WRITE. If you must, schedule with `queueMicrotask`.

## Verification

Before declaring done:

1. **`pnpm --filter @agentick/my-thing typecheck`** — clean
2. **`pnpm --filter @agentick/my-thing test`** — all tests green; conformance passes
3. **`pnpm --filter @agentick/my-thing build`** — emits `dist/` with `augment.js`
4. **Integration test renders + mutates** — `useMyThing()` in a test component triggers re-renders when the harness mutates
5. **`session.myThing` works in a real session** — open `example/v2-real`, install `withMyThing()`, exercise from an agent

If you can't claim all five, the harness isn't done.

## Local protocol variant (for adopter packages outside the workspace)

If you're building `@my-org/agentick-my-thing` outside the agentick workspace, you can either (a) PR the protocol type into `@agentick/spec` (preferred — the protocol becomes canonical), or (b) keep the protocol local in your package and augment from there. Both work; (b) means your protocol type is `@my-org/agentick-my-thing`'s `MyThingHarnessProtocol`, and your `augment.ts` imports it locally:

```ts
import type { MyThingHarnessProtocol } from "./protocol.js";

declare module "@agentick/spec" {
  interface HookBridges {
    readonly myThing: MyThingHarnessProtocol;
  }
}
```

(b) is fine for adopter-local extensions. Submit to spec only if the extension is broadly useful and you want canonical placement.

## Customizing an existing harness instead

If you're replacing an existing harness's implementation (e.g., Postgres-backed Timeline), the work is:

1. Skip Step 1 (protocol exists already in `@agentick/spec`)
2. Skip Step 3 (augmentation exists already in the bundled package)
3. Skip Step 4 (handle exists)
4. Steps 2, 5, 6, 7 (harness, extension factory, conformance, react/testing) apply normally but you implement the **existing** protocol
5. Your `withMyThing()` registers under the same slot name (`"myThing"`) — last-writer-wins gives you the override

That's what `create-harness` shares with the future `customize-[harness]` family. The custom backend goes through the same mechanical pipeline.

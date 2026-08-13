---
name: add-wire-command
description: 'Add a namespaced harness surface whose exposure:"wire" commands route to wire clients through the generic dynamic-command lane — no gateway edits'
---

## When to use

You have a capability that a wire client (browser, remote) must call by an RPC
verb — `sitemap/declare`, `catalog/search`, `foo/bar` — and it is NOT one of the
built-in surfaces. You are adding a new namespace, or new `exposure: "wire"`
commands to an existing one.

You do **not** touch the gateway. Since #258 the dynamic-command lane addresses
**any mounted surface**: a method `<ns>/<verb>` is asked at
`<ns>:<sessionId>:<ns>`, and if a harness is mounted there it routes; if not, the
ask fails `AddressNotFound` and the client sees `MethodNotFound`. Mounting the
harness is the whole job.

## The mental model

```
client.transport.request("foo/bar", { sessionId, … })
        │  (no porcelain method "foo/bar" → dynamic resolver)
        ▼
   authorize scope "foo:bar" at the dispatch choke point   ← grant required
        ▼
   inbox.ask("foo:<sessionId>:foo", { type: "foo:bar", origin: "wire", payload })
        ▼
   FooHarness command "foo:bar"  → your handler
```

Two rules the lane enforces for free: an `exposure: "wire"` command is reachable;
an `addressable` one is invisible to the wire (deny-by-default). A surface that
is not mounted is indistinguishable from an absent method.

## Recipe

Follow the per-harness layout (see `docs/proposals/v2/blueprint/27-modular-built-ins.md`).
Canonical reference: `packages/gates/src/` (harness + wire-augment + client).

### 1. The harness — `harness.ts`

A `BaseHarness` subclass. Each verb is `this.command({ name: "<ns>:<verb>",
exposure: "wire", handler })`; the handler returns an `Effect`. `handleMessage`
is the fallthrough for unknown types.

```ts
import { Effect } from "effect";
import { BaseHarness, type BaseHarnessOptions } from "@agentick/runtime";
import {
  HandlerError,
  type EventBus,
  type MessageEnvelope,
  type MessageHandlerError,
  type MessageInbox,
  type OperationJournal,
} from "@agentick/spec";

const SURFACE = "foo" as const;

export interface FooBarInput {
  readonly q: string;
}

export class FooHarness extends BaseHarness<"foo"> {
  readonly bar: (input: FooBarInput) => Promise<unknown>;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options?: BaseHarnessOptions<unknown, "foo">,
  ) {
    super(SURFACE, scopeId, journal, bus, inbox, options);

    this.bar = this.command({
      name: "foo:bar",
      exposure: "wire",
      handler: (input: FooBarInput) =>
        Effect.tryPromise({
          try: () => doTheWork(input),
          catch: (cause) => new HandlerError({ cause }),
        }),
    });
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown foo message type: ${msg.type}` }));
  }
}
```

- **Commands carry no input schema.** The wire payload is trusted pass-through;
  the handler types its own input. The wire SHAPE is documented by `WireMethods`
  (step 2), not by a runtime schema — matches every sibling (`knobs:set`,
  `gates:clear`).
- **Declare no scope key for a session-scoped command.** `BaseHarness` gap-fills
  the owning session from the construction-bound `parentScope`. A command that
  adds `() => ({ sessionId: this.scopeId })` mints the COMPOSED key
  `<sessionId>:<surface>`, which no session-scoped subscription can match. Add a
  scope factory ONLY for a dimension the command itself introduces.

### 2. The wire shape — `wire-augment.ts` (type-only)

Augment the `WireMethods` seed so `client.transport.request("foo/bar", …)` is
typed, and add the `foo/commands` discovery meta-verb.

```ts
import type { CommandInfo } from "@agentick/spec";

declare module "@agentick/spec" {
  interface WireMethods {
    "foo/bar": { params: { sessionId: string; q: string }; result: unknown };
    "foo/commands": { params: { sessionId: string }; result: { commands: readonly CommandInfo[] } };
  }
}
```

> [!WARNING]
> This file MUST carry a top-level `import`/`export` (the `import type` above
> suffices). A `declare module` file with no top-level import/export is a SCRIPT
> that SHADOWS `@agentick/spec` instead of a MODULE that AUGMENTS it — your rows
> silently replace the whole interface. Keep it separate from server-side
> `augment.ts` so the client subpath types `foo/*` without loading server code.

### 3. Mount it — `extension.ts`

A `withFoo()` session extension constructs the harness on the session substrate,
registers the namespace, and closes it. Reference: `packages/code/src/extension.ts`.

```ts
import { inheritedFrom } from "@agentick/runtime";
import type { SessionExtension, SessionInstaller } from "@agentick/spec";

export function withFoo(): SessionExtension {
  return {
    name: "foo",
    target: "session",
    install: async (installer: SessionInstaller) => {
      const harness = new FooHarness(
        `${installer.hostId}:foo`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        { parentScope: { sessionId: installer.sessionId }, ...inheritedFrom(installer) },
      );
      await harness.ready;
      installer.registerNamespace("foo", harness);
      installer.onClose(() => harness.close());
    },
  };
}
```

- **`inheritedFrom(installer)`** wraps the commands in `app.guard`/`app.hooks`, so
  the interceptor fold reaches them. Omit it and your commands run un-guarded.
- **`await harness.ready`** before `registerNamespace` — the harness registers its
  inbox address in its constructor, asynchronously via `ready`.
- The scopeId is `<hostId>:foo`; the harness derives its inbox address
  `foo:<sessionId>:foo` from it. This MUST match what `resolveAddress` mints, so
  keep the surface segment identical on both sides.

### 4. Routing — nothing to do

No gateway edit. The dynamic lane addresses `foo` the moment the harness mounts
(#258). The surface is addressable-but-not-enumerated — it will NOT appear in
`commands/list` (the enumeration set is still a known list; that half of #258 is
open). Clients that call `foo/bar` by name are unaffected; a client that relies
on `commands/list` discovery is not.

### 5. Authorization

The verb needs a grant. The authorizer gates scope `foo:bar` at the dispatch
choke point BEFORE your handler runs. Discovery (`foo/commands`) needs scope
`foo:commands`. Wire the grants where the app configures its authorizer
(`staticAuthorizer({ grants: { alice: ["foo:bar"] } })`, or a surface glob
`foo:*`). Deny-by-default: no grant → `Forbidden`.

### 6. Call it from the client

Typed by the `WireMethods` augmentation (import the `wire-augment` as a side
effect from your `/client` subpath):

```ts
const result = await client.transport.request("foo/bar", { sessionId, q: "hello" });
```

For an ergonomic handle, register a client namespace (`packages/gates/src/client`
is the reference: `registerNamespace("gates", …)` + a `session.gates` handle that
wraps `transport.request`).

### 7. Test

- **Harness spec** (`__tests__/harness.spec.ts`): the command declares
  `exposure: "wire"` and the handler round-trips. Use the real `stubInbox` from
  `@agentick/runtime/testing` and drive `harness.bar(input)`.
- **Dynamic-lane / e2e**: drive `foo/bar` through the REAL `GatewayHarness` +
  `inProcessTransport` (reference: `packages/transport-in-process/src/__tests__/gates-e2e.spec.ts`).
  Assert it dispatches with `origin: "wire"`, and that an UNMOUNTED surface →
  `MethodNotFound`. When stubbing the inbox for a unit test, an unmounted address
  must throw `AddressNotFound` (not a plain `Error`) — that is what the real
  `LocalInbox` throws and what the resolver keys on.

## Gotchas checklist

- [ ] `wire-augment.ts` has a top-level `import`/`export` (shadow trap).
- [ ] Surface segment identical everywhere: `SURFACE`, scopeId `<hostId>:foo`,
      inbox address `foo:<sessionId>:foo`, wire method `foo/bar`, grant `foo:bar`.
- [ ] No composed scope key on session-scoped commands (let `parentScope`
      gap-fill).
- [ ] `inheritedFrom(installer)` passed, so guards/hooks wrap the commands.
- [ ] Grants include `foo:commands` if the client uses discovery.
- [ ] Command is `exposure: "wire"` (not `addressable`) or the wire can't see it.

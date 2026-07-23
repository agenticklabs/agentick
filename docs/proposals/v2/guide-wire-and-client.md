# Extending the wire & how the client works (user-facing guide — DRAFT)

> Destination: website docs after the docs sweep. Source of truth for the model
> Ryan + architect converged 2026-07-22. Code-first.

## The whole mental model in one sentence

**The wire table gives you methods; a registered view gives you state.**

## 1. Your own wire methods — zero client code

Declare the row (types) and the handler (behavior). The client method *falls out*.

```ts
// 1. spec row — the ONLY type definition anywhere:
declare module "@agentick/spec-next" {
  interface WireMethods {
    "billing/approve": { params: { sessionId: string; orderId: string };
                         result: { ok: boolean } };
  }
}

// 2. gateway handler (your server logic):
defineWireExtension("billing/approve", async ({ sessionId, orderId }, ctx) => {
  return { ok: await myBilling.approve(orderId) };
});

// 3. client — NOTHING. It already exists, fully typed:
await session.billing.approve({ orderId: "o_1" });   // ✓ typed from the row
await session.billing.aprove({ orderId: "o_1" });    // ✗ compile error
```

> Verified by `packages-next/client/src/__tests__/wire-proxy-middleware-e2e.spec.ts`
> (zero-client-code round-trip) and
> `packages-next/spec/src/__tests__/wire-proxy.type.spec.ts` (the typed-from-the-row
> + typo-is-a-compile-error IntelliSense contract).

- Method names map `session.<ns>.<method>` ⇔ `"<ns>/<method>"`.
- `sessionId` is bound for you (the handle carries addressing).
- Params are **params-objects** everywhere — one shape, autocomplete does the
  work, optional params never break signatures.
- A typo can't ship: only server-typed rows exist on the client type. Unknown
  methods at runtime are rejected by the server anyway.

## 2. State — views

If your namespace has live state, register a **view** (a fold over a channel
topic). Then the handle carries the store contract:

```ts
session.knobs.list();                 // current state incl. pre-connection truth
session.knobs.get("depth");
session.knobs.subscribe(cb);          // cb(), no args — read via list()
// React (or Svelte/Vue — same two functions):
useSyncExternalStore(session.knobs.subscribe, session.knobs.list);
```

**The handle IS the default view** — no ceremony for the 90% case. Mint more:

```ts
const modelOnly = session.timeline.view({ filter: (e) => e.visibility === "model" });
modelOnly.subscribe(cb);
modelOnly.close();
// One wire subscription per topic — all views fold off the same fan-out.
```

> Verified by `packages-next/timeline/src/client/__tests__/timeline-fanout.spec.ts`
> (two views, ONE wire subscription; independent close; handle-close closes all) and
> the primitive `packages-next/client-core/src/__tests__/view-source.spec.ts`.

Local view operations (not wire) live on views — and thus on the handle too:

```ts
session.timeline.seed(await fetch("/my/api/history").then(r => r.json()));
session.timeline.prepend(olderPage);
session.timeline.clear();
```

## 3. Items carry their next action

Request-shaped state (`elicitations`, `clientToolCalls`) lists **item handles**
— data plus bound verbs, identical whether the item arrived before or after you
connected:

```ts
const ask = session.elicitations.list()[0];
await ask?.accept({ approved: true });     // = the derived respond method, partially applied
```

## 4. Your data everywhere (floors, not ceilings)

- Seed views from **your** endpoints; the framework owns live truth only.
- `metadata` bags ride untouched (your join keys, your correlation ids).
- Feed **your** store instead of using ours:
  `session.timeline.subscribe(() => myStore.ingest(session.timeline.list().map(toMine)))`.
- Extra fields/methods anywhere are yours; conformance never polices ceilings.

## 5. What falls out of this design (the compounding)

1. **Devtools for free** — the wire table is introspectable: an API panel
   (methods, params, try-it) can be *generated* from `WireMethods` + `commands()`.
2. **One mock seam** — a spy/fake client fakes every vertical uniformly (all
   methods funnel one `request`); testing your `billing` = testing our `knobs`.
3. **Client middleware applies universally** — `client.use(...)` (slice 4)
   wraps every derived method: auth headers, logging, retry, optimistic
   brackets — written once, covering verticals that don't exist yet.
   (Verified by the middleware-universality cases in
   `packages-next/client/src/__tests__/wire-proxy-middleware-e2e.spec.ts` —
   one `client.use` observed on `knobs/set` AND the zero-code `testns/doThing`,
   plus namespace-scoped `session.knobs.use`.)
4. **The table is an IDL** — a Python/Swift/Go client can be *generated* from
   the same rows; the wire table is the protocol schema, not just TS types.
5. **Docs generation** — the API reference renders from the table; it cannot
   drift from reality.
6. **Authz alignment** — ADR 51 already makes the method name the authz scope
   label, so permission scopes map 1:1 onto the client surface a user sees.
7. **Capability negotiation** — a client can enumerate the server's actual
   methods (`commands()`) and feature-detect per deployment.

## Open (tracked, not blocking)

- `.view(opts)` scope: `filter` + window options ship first; bring-your-own
  `{ initial, reduce }` waits for a third real consumer (two-ways-to-do-posture-B
  smell).
- Q#8: connection status lives at `client.status` (lean) — handles stay
  liveness-dumb.

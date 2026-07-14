# Hook Lifecycle & Taxonomy — the canonical reference

**The one place** documenting every hookable operation in agentick v2, its hooks,
and the surfaces you register them through. Kept in lockstep with the code by a
completeness test (see §Keeping this current). Mechanism: [ADR 83](./blueprint/83-one-interceptor-primitive.md).

## The one seam

Every harness verb — `<surface>:<action>` — routes through `BaseHarness.runOperation`,
which composes ONE interceptor list around the op. Every interceptor is a
`Middleware` `(input, next, ctx) => output`, tagged with a **kind**:

- **`guard`** — admission control: `proceed | veto | replace | defer`. Composes outermost.
- **`transform`** — reshapes input/output. Hooks are keyed sugar over this.
- **`observe`** — pure side-effect (metrics, logging).

There is no separate "lifecycle" subsystem: the framework's built-in lifecycle
(execution → compile → model → tool) IS this command set. A lifecycle hook is
just a command hook on a built-in verb.

## The naming rule

A hook name is a **total function of the command id**:
`hook = on(+ Before|After) + PascalCase(<surface>:<action>)`. The id splits on
`:` `/` `-` (kebab) and `_` (snake) — all four word boundaries — so
`session:apply-executor-result` → `onBeforeSessionApplyExecutorResult` and the
snake_case wire id `app/run_once` → `onBeforeWireAppRunOnce`. Type-level
`Pascal<K>` === runtime `deriveHookNames` (lockstep-tested).

## The four surfaces (all typed off `CommandRegistry`)

```ts
// 1. declarative config (folds down the construction tree)
createApp({ hooks: { onBeforeToolDispatch, onAfterToolDispatch, onToolDispatch } });

// 2. imperative batch                                  → Unsubscribe
const off = harness.hook({ onBeforeToolDispatch: fn });

// 3. per-verb proxy (before / after / full middleware) → Unsubscribe
harness.hooks.onBeforeToolDispatch(fn);       // input transform
harness.hooks.onAfterToolDispatch(fn);        // output transform
harness.hooks.onToolDispatch(mw);             // FULL typed middleware (on<Command>)

// 4. guard — admission (proceed/veto/replace/defer), UNCHANGED, its own concept
harness.guard(decide);
```

`on<Command>` is the ultimate low-level *typed* registrar (the whole
`(input,next,ctx)=>output`); `onBefore/onAfter` are one-sided sugar over it; raw
`harness.use(mw)` is the untyped, global floor. Removal is always the returned
`Unsubscribe`. Registration affects the harness's own future ops AND propagates
**live** down the construction tree: a hook registered on a parent reaches every
live descendant, and a new descendant pulls the parent's current set at
construction (ADR 83 §4, amended 2026-07-14 — was a frozen construction-fold, now
live inheritance). So a hook declared on the **gateway** reaches all apps —
created before AND after it — and cascades to their sessions and sub-harnesses
(ADR 84). Unsubscribe cascades to descendants.

## The complete lifecycle

Status legend: **✅ typed** = augmented into `CommandRegistry`, so all three
hooks below are type-safe AND fire at runtime. **⛔ deferred** = NOT augmented,
with a recorded reason — the names are reserved (the derivation is total) but no
hook fires, so typing them would mislead.

Every **✅ typed** command exposes exactly THREE hooks, all keyed off the same
`Pascal<command-id>`:

- **`on<X>`** — the full typed middleware `(input, next, ctx) => output` (the
  low-level registrar; `onBefore`/`onAfter` are one-sided sugar over it).
- **`onBefore<X>`** — input transform (or throw to veto).
- **`onAfter<X>`** — output transform.

Registered through any of the four surfaces (declarative `hooks`, `harness.hook({…})`,
the `harness.hooks.on…` proxy, or — full middleware — `harness.on<X>`).

| Phase | Command | Status | `on<X>` | `onBefore<X>` | `onAfter<X>` | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| App | `app:create-session` | ✅ typed | `onAppCreateSession` | `onBeforeAppCreateSession` | `onAfterAppCreateSession` | |
| App | `app:run-once` | ✅ typed | `onAppRunOnce` | `onBeforeAppRunOnce` | `onAfterAppRunOnce` | |
| App | `app:close-app` | ✅ typed | `onAppCloseApp` | `onBeforeAppCloseApp` | `onAfterAppCloseApp` | nullary op (`void`→`void`) |
| **Execution** | `loop:run-execution` | ✅ typed | `onLoopRunExecution` | `onBeforeLoopRunExecution` | `onAfterLoopRunExecution` | the whole send/execution; before = the execution input, after = `ExecutionTerminal` |
| **Compile** | `reconciler:render-tree` | ✅ typed | `onReconcilerRenderTree` | `onBeforeReconcilerRenderTree` | `onAfterReconcilerRenderTree` | the compile; before = render input, after = `RenderTreeResult` |
| Compile | `reconciler:mount` | ✅ typed | `onReconcilerMount` | `onBeforeReconcilerMount` | `onAfterReconcilerMount` | |
| Compile | `reconciler:rerender` | ✅ typed | `onReconcilerRerender` | `onBeforeReconcilerRerender` | `onAfterReconcilerRerender` | |
| Compile | `reconciler:render-to-string` | ✅ typed | `onReconcilerRenderToString` | `onBeforeReconcilerRenderToString` | `onAfterReconcilerRenderToString` | |
| Compile | `reconciler:unmount` | ⛔ deferred | `onReconcilerUnmount` | `onBeforeReconcilerUnmount` | `onAfterReconcilerUnmount` | teardown is a plain sync method — does NOT route through `runOperation`, so a typed hook would never fire. Wrap the teardown first. |
| **Model** | `executor:project` | ✅ typed | `onExecutorProject` | `onBeforeExecutorProject` | `onAfterExecutorProject` | compile → `LanguageModelInput` — **the media-reconciliation seam**. Fires on the direct facade; the loop inlines it under `executor:run`. |
| **Model** | `executor:execute` | ✅ typed | `onExecutorExecute` | `onBeforeExecutorExecute` | `onAfterExecutorExecute` | the provider call. `output` is raw `TRaw` (erased → `unknown`). Direct-facade fire; inlined under `executor:run` in the loop. |
| Model | `executor:run` | ✅ typed | `onExecutorRun` | `onBeforeExecutorRun` | `onAfterExecutorRun` | the per-tick run wrapper — the ONE executor seam a loop tick fires |
| Model | `executor:normalize` | ✅ typed | `onExecutorNormalize` | `onBeforeExecutorNormalize` | `onAfterExecutorNormalize` | output normalization |
| **Tool** | `tool:dispatch` | ✅ typed | `onToolDispatch` | `onBeforeToolDispatch` | `onAfterToolDispatch` | also `guardDispatch` (admission) |
| Tool | `tool:abort` | ✅ typed | `onToolAbort` | `onBeforeToolAbort` | `onAfterToolAbort` | |
| Tool | `tool:register` | ✅ typed | `onToolRegister` | `onBeforeToolRegister` | `onAfterToolRegister` | registry mutation |
| Tool | `tool:unregister` | ✅ typed | `onToolUnregister` | `onBeforeToolUnregister` | `onAfterToolUnregister` | registry mutation |
| Tool | `tool:remove-bound-tools` | ✅ typed | `onToolRemoveBoundTools` | `onBeforeToolRemoveBoundTools` | `onAfterToolRemoveBoundTools` | registry mutation |
| Tool | `tool:replace-reconciler-tools` | ✅ typed | `onToolReplaceReconcilerTools` | `onBeforeToolReplaceReconcilerTools` | `onAfterToolReplaceReconcilerTools` | registry mutation |
| **Elicitation** | `elicitation:elicit` | ✅ typed | `onElicitationElicit` | `onBeforeElicitationElicit` | `onAfterElicitationElicit` | one op for the round-trip: before=request, after=response |
| **Session** | `session:send` | ✅ typed | `onSessionSend` | `onBeforeSessionSend` | `onAfterSessionSend` | public door; NON-ADDRESSABLE (SendInput non-serializable) |
| Session | `session:append` | ✅ typed | `onSessionAppend` | `onBeforeSessionAppend` | `onAfterSessionAppend` | |
| Session | `session:apply-executor-result` | ✅ typed | `onSessionApplyExecutorResult` | `onBeforeSessionApplyExecutorResult` | `onAfterSessionApplyExecutorResult` | fires on the public facade, not the loop's in-fiber `*Fx` path |
| Session | `session:apply-tool-results` | ✅ typed | `onSessionApplyToolResults` | `onBeforeSessionApplyToolResults` | `onAfterSessionApplyToolResults` | fires on the public facade, not the loop's in-fiber `*Fx` path |
| Timeline | `timeline:compact` | ✅ typed | `onTimelineCompact` | `onBeforeTimelineCompact` | `onAfterTimelineCompact` | before = wire-safe compact SIGNAL; the explicit-arg form shares the op name, so it fires too |
| Sandbox | `sandbox:exec` | ✅ typed | `onSandboxExec` | `onBeforeSandboxExec` | `onAfterSandboxExec` | sibling file verbs (`read-file`/…) stay untyped until asked for |
| Gateway | `gateway:start` | ✅ typed | `onGatewayStart` | `onBeforeGatewayStart` | `onAfterGatewayStart` | `gateway.listen()` — fan out to `transport.listen()`; nullary op (`void`→`void`) |
| Gateway | `gateway:close` | ✅ typed | `onGatewayClose` | `onBeforeGatewayClose` | `onAfterGatewayClose` | `gateway.close({ drain })` — terminal teardown; nullary op (`void`→`void`) |
| Gateway | `gateway:create-app` | ✅ typed | `onGatewayCreateApp` | `onBeforeGatewayCreateApp` | `onAfterGatewayCreateApp` | `gateway.createApp(...)` — multi-tenant app-mount gating; before = normalized `CreateGatewayAppInput` (veto/transform), after = mounted `AppHarnessProtocol` |
| Gateway | `gateway:accept` | ✅ typed | `onGatewayAccept` | `onBeforeGatewayAccept` | `onAfterGatewayAccept` | `gateway.accept(info)` — per-CONNECTION admission (ADR 84 §4). Fires ONCE per newly-accepted persistent connection on connection-oriented transports (WebSocket / Unix socket), after ingress-authn, before frames flow; before = `ConnectionInfo` (throw to REJECT the connection / rate-limit / observe), after = observe. NOT fired by request-oriented HTTP — its admission is per-request `authorize` |
| **Auth** | `authorizer:authorize` | ✅ typed | `onAuthorizerAuthorize` | `onBeforeAuthorizerAuthorize` | `onAfterAuthorizerAuthorize` | `gateway.authorize(input)` — the FINE contextual auth layer (ADR 84 §5). before = `AuthorizeInput` (add contextual scope / deny), after = `AuthorizeResult`. The structural `requiredScopes` ceiling stays un-waivable and OUTSIDE this seam — checked before the op fires |
| **Tasks** | `tasks:submit` | ⛔ deferred | `onTasksSubmit` | `onBeforeTasksSubmit` | `onAfterTasksSubmit` | async-seam boundary — the seam is async (`asBefore`/`asAfter` await) but `submit` returns `TaskHandle` synchronously; see [ADR 83 §hookability](./blueprint/83-one-interceptor-primitive.md) |
| Tasks | `tasks:settle` | ⛔ deferred | `onTasksSettle` | `onBeforeTasksSettle` | `onAfterTasksSettle` | same async-seam boundary as `tasks:submit` |

**Wire methods** (JSON-RPC over `transport`) route through the **gateway's**
`runOperation` (`GatewayHarness.runWireDispatch`) under a **`wire:`-prefixed op
name**, distinct from the op they delegate to. A `session/send` dispatch fires
`gateway.hooks.onBeforeWireSessionSend` (op `wire:session/send` → `WireSessionSend`)
— the **wire boundary**. It does NOT collide with `onBeforeSessionSend`
(op `session:send` → `SessionSend`), which fires once at the **session op** and,
when declared on the gateway, folds down there via live inheritance (ADR 83 §4).
`authorizeDispatch` stays the un-waivable pre-gate. Same logical operation, three
layers — client request · gateway wire · session op — **distinct names, one fire
each** (the `wire:` prefix; ADR 83 §"Wire dispatch", amended 2026-07-14). Wire
hooks fire (mechanism); the typed client/server wire surface derives off
`WireMethods` with the `wire:` prefix (`HooksOf<WireMethods, …>`) — the
client-alignment follow-on.

The ADR 84 gateway op surface (`gateway:start`, `gateway:close`,
`gateway:create-app`, `authorizer:authorize`, `gateway:accept`) is now fully
landed and typed — every row is in the table above.

## The async-only property (deliberate)

Every hookable op crosses the async seam. A *synchronous* operation (a sync
handle return like `tasks.submit`, a sync FSM transition) cannot be hooked
without making it async. This is correct: the things worth intercepting (model
calls, dispatch, elicits, sends) are inherently async.

## Keeping this current

The `CommandRegistry` augmentations ARE the source of truth for the **✅ typed**
column. A name-derivation lock
(`packages-next/runtime/src/__tests__/hook-lifecycle-names.spec.ts`) pins
`deriveHookNames(<op>)` for every command in this table — typed and deferred
alike — so the names above and the generated hook keys cannot drift. When you
augment a new verb:
1. Add its `CommandRegistry` entry (in the owning harness package).
2. Add its row to the name-lock (and a firing test where practical).
3. Flip its row here from ⛔ deferred → ✅ typed (or add it) and spell out all
   three hook names.

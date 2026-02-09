# Patches

## ink@5.2.1 — react-reconciler@0.31 compatibility

**Why:** Ink 5.2.1 bundles react-reconciler@0.29 host config. We override the
reconciler to 0.31 via `pnpm.overrides` (for React 19 compatibility). Reconciler
0.31 requires host config methods that Ink doesn't provide, causing silent empty
renders.

**What changed:**

### `build/reconciler.js` — Host Config

Removed (0.29 API):

- `getCurrentEventPriority` — replaced by three methods below
- `prepareUpdate` — diff logic merged into `commitUpdate`

Added (0.31 API):

- `resolveUpdatePriority`, `getCurrentUpdatePriority`, `setCurrentUpdatePriority` — priority system refactor
- `supportsMicrotasks: true`, `scheduleMicrotask` — enables microtask-based scheduling (renders via `queueMicrotask` instead of `MessageChannel`)
- `maySuspendCommit`, `preloadInstance`, `startSuspendingCommit`, `suspendInstance`, `waitForCommitToBeReady` — suspense commit lifecycle (all no-op for terminal)
- `shouldAttemptEagerTransition` — transition API (returns false)
- `NotPendingTransition`, `HostTransitionContext` — React transitions support (null/empty context)
- `resetFormInstance` — form actions support (no-op)

Changed:

- `commitUpdate(node, _type, oldProps, newProps, _fiber)` — now receives raw props instead of `prepareUpdate`'s return value. Diff logic moved inline. **Critical:** The 5th arg is now the Fiber (frozen/sealed), NOT the root container. Setting properties on it throws "Cannot add property, object is not extensible".

Added (static dirty flag bridge):

- Module-level `_staticDirtyFlag` variable bridges `isStaticDirty` from `commitUpdate` (can't access root) to `resetAfterCommit` (receives root container). `commitUpdate` sets the flag; `resetAfterCommit` picks it up and sets `rootNode.isStaticDirty`.

### `build/ink.js` — Container Creation

- `createContainer` gains 2 new positional params: `onUncaughtError` and `onCaughtError` (positions 8-9, both `() => {}`)

**How to regenerate:**

```bash
pnpm patch ink@5.2.1           # extracts to temp dir
# apply changes to build/reconciler.js and build/ink.js
pnpm patch-commit <temp-dir>   # writes patches/ink@5.2.1.patch
```

**When to remove:** When Ink releases a version with native react-reconciler@0.31+ support. Track https://github.com/vadimdemedes/ink/issues for updates.

**Test coverage:** `packages/tui/src/testing.ts` documents the flush pattern needed for reconciler 0.31's microtask scheduling. All TUI component tests validate the patch works correctly.

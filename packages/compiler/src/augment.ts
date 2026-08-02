/**
 * The `CommandRegistry` rows for the compile verbs (ADR 80/83).
 *
 * These live in `@agentick/compiler` — the package that owns the
 * `CompilerProtocol` contract — and NOT in an implementation. The verbs are part
 * of the protocol: `defineCompiler` and `reactCompiler` both route them through
 * `runOperation`, so both mint the same ops, and a hook key that exists only
 * when you happen to have imported the React implementation is a key that lies
 * about what it covers.
 *
 * It used to live in `compiler-react`'s harness, which had two consequences:
 * a `defineCompiler`-built compiler minted `compiler:command:render-tree` while
 * `onAfterCompilerRenderTree` did not exist as a typed key unless something else
 * dragged compiler-react in; and any package wanting to NAME that key had to
 * depend on the React implementation to do it — which is how `@agentick/session`
 * ended up with a compiler-react dependency it has no business having.
 *
 * Typing a row mints `onBefore<Verb>` / `onAfter<Verb>` on the derived
 * `CommandHooks` surface, with the input/output generics of the declaration
 * site's Operation.
 *
 * `compiler:unmount` is DELIBERATELY absent: its method is a plain synchronous
 * teardown that does NOT route through `runOperation`, so a typed hook would
 * never fire. It stays deferred until the teardown is wrapped.
 */

import type {
  MountInput,
  MountResult,
  RenderToStringInput,
  RenderToStringResult,
  RenderTreeInput,
  RenderTreeResult,
  RerenderInput,
} from "@agentick/spec";

declare module "@agentick/runtime" {
  interface CommandRegistry {
    "compiler:render-tree": { input: RenderTreeInput; output: RenderTreeResult };
    "compiler:mount": { input: MountInput; output: MountResult };
    "compiler:rerender": { input: RerenderInput; output: void };
    "compiler:render-to-string": { input: RenderToStringInput; output: RenderToStringResult };
  }
}

// A `declare module` file with no top-level import/export is a SCRIPT, and a
// script SHADOWS the module it names instead of augmenting it — every export of
// the target vanishes. The type imports above already make this a module; this
// makes that non-accidental.
export {};

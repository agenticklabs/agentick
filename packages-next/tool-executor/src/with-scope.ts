/**
 * `withScope` — scoped tool-binding lifecycle.
 *
 * Composes `register-each` + `removeBoundTools` atomically around a
 * caller-supplied async body. Replaces the hand-rolled pattern:
 *
 *   for (const decl of decls) await executor.register(...);
 *   try { return await fn(); }
 *   finally { await executor.removeBoundTools({ binding }); }
 *
 * The cleanest layered-tools call site at every scope boundary:
 *
 *   const result = await withScope(
 *     toolExecutor,
 *     { scope: "execution", executionId },
 *     input.tools ?? [],
 *     () => loop.runExecution(...),
 *   );
 *
 * On any path out of `fn` — return, throw, abort — the scope's
 * binding is cleaned up before the call returns. A failure during
 * registration short-circuits before `fn` runs; the `finally`
 * still removes any registrations that landed (the `removeBoundTools`
 * primitive is a no-op for unknown bindings).
 */

import type { ToolBinding, ToolDeclaration, ToolExecutorProtocol } from "@agentick/spec-next";
import { toRegistration } from "@agentick/spec-next";

/**
 * Bind `declarations` to `binding` on `executor` for the duration of
 * `fn`. Removes the bound slice in `finally` regardless of how `fn`
 * resolves.
 *
 * Returns whatever `fn` resolves to. Re-throws whatever `fn` throws —
 * cleanup runs first, then the throw propagates.
 */
export async function withScope<T>(
  executor: ToolExecutorProtocol,
  binding: ToolBinding,
  declarations: readonly ToolDeclaration[],
  fn: () => Promise<T>,
): Promise<T> {
  for (const decl of declarations) {
    await executor.register({ registration: toRegistration(decl, binding) });
  }
  try {
    return await fn();
  } finally {
    await executor.removeBoundTools({ binding });
  }
}

/**
 * `commandForMethod` — resolve a wire method (`"session/send"`) to the Pascal
 * command suffix (`"SessionSend"`) the client hook seam keys on. Runs the SAME
 * {@link deriveHookNames} the type-level `ClientHooks` derivation uses, so a
 * method and its `onBefore…`/`onAfter…` hooks always meet on ONE key — one
 * derivation, both call sites.
 *
 * Client hooks register as method-scoped around middleware on the single
 * `client.use(...)` seam (`AgentickClient`) — there is no second interception
 * path, and no hook store: this module holds only the shared method→command
 * derivation both the hook adapter and the type layer need.
 *
 * @see docs/proposals/v2/blueprint/83-one-interceptor-primitive.md
 */

import { deriveHookNames } from "@agentick/spec-next";

/**
 * Resolve a wire method (`"session/send"`) to the Pascal command suffix
 * (`"SessionSend"`). No `wire:` prefix — the client hook mirrors the session op
 * it initiates (`onBeforeSessionSend`), so the key matches the plain derived
 * name; the `Wire*` qualifier is the gateway boundary's concern.
 */
export function commandForMethod(method: string): string {
  const [beforeName] = deriveHookNames(method);
  return beforeName.slice("onBefore".length);
}

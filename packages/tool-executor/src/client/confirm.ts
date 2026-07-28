/**
 * Client-side tool-confirmation POLICY (stage 3).
 *
 * The executor's confirmation gate publishes tool confirmations as ordinary
 * ELICITATIONS with `hints.kind === "tool_confirmation"` (see the gate in
 * `../harness.ts`). `confirmClientTools` consumes the client elicitation stream,
 * FILTERS to those, and applies a {@link ConfirmPolicy} — a truthy verdict
 * accepts (`{ approved: true }`, the shape the gate's
 * `TOOL_CONFIRMATION_REPLY_SCHEMA` requires), a falsy verdict declines.
 *
 * It reads the confirmation fields the gate stamps onto the elicitation
 * `metadata` — `toolName`, `toolUseId`, `arguments`, and (when the tool sets a
 * `confirmationPreview`) `preview` — plus the top-level `message`. That mapping
 * is {@link toolConfirmation}, exported so a client drawing its OWN dialog reads
 * a confirmation the same way the policy does instead of re-deriving it.
 *
 * **Coordination caveat.** If you use `confirmClientTools`, do NOT also answer
 * `tool_confirmation` elicitations in your own `session.elicitations` loop —
 * both would respond to the same correlationId (last responder wins /
 * double-respond). It subscribes via `onChange` on its OWN elicitation
 * subscription and IGNORES non-confirmation elicitations, so it never steals an
 * app's other prompts.
 *
 * @verifiedBy packages/tool-executor/src/__tests__/client-tool-confirm.spec.ts
 */

import type { Unsubscribe } from "@agentick/spec";
import { elicitationsHandle, type ElicitationClient } from "@agentick/elicitation/client";

import { TOOL_CONFIRMATION_KIND } from "../confirmation-schema.js";

/** The confirmation request a predicate policy inspects. */
export interface ConfirmRequest {
  /** The tool being confirmed (gate metadata `toolName`). */
  readonly toolName?: string;
  /** The originating tool-call id (gate metadata `toolUseId`). */
  readonly toolUseId?: string;
  /** The validated arguments (gate metadata `arguments`). */
  readonly arguments?: unknown;
  /** The confirmation prompt (elicitation `message`). */
  readonly message?: string;
  /** Optional preview the tool's `confirmationPreview` produced (gate metadata `preview`). */
  readonly preview?: unknown;
}

/**
 * A confirmation policy: the literal `"approve"` / `"deny"`, or a predicate on
 * the {@link ConfirmRequest} returning a boolean (sync or async). Truthy →
 * approve; falsy → deny.
 */
export type ConfirmPolicy =
  | "approve"
  | "deny"
  | ((req: ConfirmRequest) => boolean | Promise<boolean>);

/**
 * Apply `policy` to every inbound tool-confirmation elicitation. A truthy
 * verdict sends `accept({ approved: true })`; a falsy verdict sends `decline()`.
 * Non-confirmation elicitations are left untouched. Returns an
 * {@link Unsubscribe} that stops the policy AND closes its subscription.
 */
export function confirmClientTools(
  client: ElicitationClient,
  sessionId: string,
  policy: ConfirmPolicy,
): Unsubscribe {
  const elicitations = elicitationsHandle(client, sessionId);
  // `subscribe` fires on every pending-set change and we re-scan `list()`; a
  // seen-set makes each confirmation act exactly once (the store contract has no
  // per-item delta feed — read via list()).
  const acted = new Set<string>();
  const unsub = elicitations.subscribe(() => {
    for (const elic of elicitations.list()) {
      // The reader IS the filter: `undefined` means "not a tool confirmation".
      const req = toolConfirmation(elic);
      if (!req) continue;
      if (acted.has(elic.correlationId)) continue;
      acted.add(elic.correlationId);
      void (async () => {
        const approved = await evaluate(policy, req);
        if (approved) await elic.accept({ approved: true });
        else await elic.decline();
      })();
    }
  });
  return () => {
    unsub();
    elicitations.close();
  };
}

function evaluate(policy: ConfirmPolicy, req: ConfirmRequest): boolean | Promise<boolean> {
  if (policy === "approve") return true;
  if (policy === "deny") return false;
  return policy(req);
}

/**
 * Read a client elicitation as a {@link ConfirmRequest} — the narrowing reader
 * for the tool-confirmation contract. Returns `undefined` when `elic` is NOT a
 * tool confirmation (`hints.kind !== "tool_confirmation"`), so it doubles as the
 * discriminator; otherwise the fully-populated request, `preview` included.
 *
 * This is the reader for a client that draws its OWN confirmation dialog instead
 * of handing the decision to `.confirm(policy)`: pass anything
 * `session.elicitations.list()` yields (a `ClientElicitationHandle` satisfies the
 * parameter — the fields read are `message` / `hints` / `metadata`) and render
 * what comes back, then answer with `elic.accept({ approved: true })`.
 * `confirmClientTools` uses this same reader — one mapping, not two.
 */
export function toolConfirmation(elic: {
  readonly message?: string;
  readonly hints?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): ConfirmRequest | undefined {
  if (elic.hints?.kind !== TOOL_CONFIRMATION_KIND) return undefined;
  const meta = elic.metadata ?? {};
  return {
    ...(typeof meta.toolName === "string" ? { toolName: meta.toolName } : {}),
    ...(typeof meta.toolUseId === "string" ? { toolUseId: meta.toolUseId } : {}),
    ...(meta.arguments !== undefined ? { arguments: meta.arguments } : {}),
    ...(typeof elic.message === "string" ? { message: elic.message } : {}),
    ...(meta.preview !== undefined ? { preview: meta.preview } : {}),
  };
}

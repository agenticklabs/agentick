import type { ToolDispatchPolicy, ToolDispatchVerdict } from "@agentick/spec";

/**
 * The executor's default admission policy: a turn acting as someone other
 * than the session's owner may speak and may not dispatch. An owner turn
 * carries no `actor`, so it proceeds exactly as before. Scaffolding by
 * design — once credentials follow the actor a non-owner call fails at the
 * server on its own, and an adopter can replace this with `proceed` or with
 * judgment of its own (see `docs/proposals/v2/identity-axes.md` §3.5 R2).
 */
export const speakOnlyForNonOwners: ToolDispatchPolicy = ({ ctx }) =>
  ctx.actor === undefined || ctx.actor === ctx.principal
    ? PROCEED
    : {
        kind: "veto",
        reason: "this turn was started by someone other than the conversation's owner",
      };

export const PROCEED: ToolDispatchVerdict = { kind: "proceed" };

/** A policy may only proceed or veto; anything else is a bug at the adopter's site, not a soft error. */
export function assertDispatchVerdict(value: unknown, tool: string): ToolDispatchVerdict {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === "proceed" || kind === "veto") return value as ToolDispatchVerdict;
  throw new Error(
    `dispatchPolicy for "${tool}" returned ${JSON.stringify(value)}; a dispatch policy answers { kind: "proceed" } or { kind: "veto", reason? }`,
  );
}

/**
 * `completionsWireExtension` — the `completions/*` `WireExtension` that carries
 * argument completion over the Agentick client↔gateway wire.
 *
 * One verb, `completions/complete`, and the client surface for it is FREE: the
 * row in {@link ./wire-augment.ts} is what mints `session.completions.complete(…)`
 * on the derived wire proxy, params-minus-sessionId, typed end to end. There is
 * no hand-written client handle and no `session.complete` base method.
 *
 * ## The two-hop resolution, and why the route owns the join
 *
 * A prompt argument completes in one of two ways, and the two halves live in
 * different packages by design (completions.md §2.1): an INLINE resolver rides
 * the prompts sidecar, and a NAMED ref addresses this package's registry.
 * Prompts holds the first and refuses to import the second (it holds resolvers,
 * it does not run them), so somebody has to compose the hop. This route is that
 * somebody — it asks prompts first, then resolves a returned `completeRef`
 * against the session's registry.
 *
 * A consequence worth stating: the sidecar path needs NO completions namespace.
 * An app that installs `withPrompts` with inline `complete:` resolvers and never
 * mentions `withCompletions` still completes over the wire.
 *
 * ## Silence, not faults
 *
 * Everything unanswerable answers `{ values: [] }`: no prompts surface, an
 * argument that declares no completion, a ref pointing at a name nobody bound, a
 * restored session whose sidecar is gone. That is MCP parity and it is also just
 * honest — an unanswered question is not a protocol fault, and a composer
 * showing zero candidates is the correct UI for every one of those cases. The one
 * real error is an unknown PROMPT (`PromptNotFound`): the client named something
 * that does not exist, which is a bug in the client, not an empty answer.
 *
 * ## A keystroke is not an event
 *
 * The method declares `journal: "bus-only"`. Every wire dispatch mints a
 * `wire:<method>` boundary op at the gateway whose `requested` + `terminal`
 * envelopes journal by default — which for a per-keystroke verb would move the
 * journal flood from the harness (where `resolve` was made a plain method to
 * avoid exactly this) up to the gateway, defeating the whole point. `bus-only`
 * keeps the traffic visible to live observers and out of the durable spine.
 *
 * @see docs/proposals/v2/completions.md §2.3, §7 P2
 * @see packages/knobs/src/wire.ts — the wire-route template
 * @verifiedBy packages/completions/src/__tests__/wire.spec.ts
 * @verifiedBy packages/transport-in-process/src/__tests__/completions-complete-e2e.spec.ts
 */

import {
  CompletionNotFound,
  defineWireExtension,
  findSession,
  type CompletionResult,
  type PromptsCompleteInput,
  type PromptsCompleteOutcome,
  type SessionHarnessProtocol,
  type WireExtension,
} from "@agentick/spec";

import "./wire-augment.js"; // types `completions/complete` on WireMethods

/** Nothing to offer. The single answer for every unanswerable shape — see the module doc. */
const NO_VALUES: CompletionResult = { values: [] };

/**
 * The one method this route needs off the session's prompts surface.
 *
 * `SessionHarnessProtocol.prompts` is typed by `@agentick/prompts`'s module
 * augmentation, and this package depends on that one in NEITHER direction —
 * deliberately, both ways: prompts holds completion resolvers without importing
 * the registry that runs them, and the registry routes to prompts without
 * pulling its harness. Spec owns the shapes both sides speak, so the narrowest
 * possible contract is the whole contract.
 */
interface PromptsCompleteDoor {
  complete(input: PromptsCompleteInput): Promise<PromptsCompleteOutcome>;
}

/**
 * Feature-detect the prompts completion door on a session — the same structural
 * detection `SnapshotCapable` gets, for the same reason: the slot is contributed
 * by a package this one cannot name, and an adopter's own `Prompts`
 * implementation predating the door is a legitimate runtime state.
 */
function promptsDoorOf(session: SessionHarnessProtocol): PromptsCompleteDoor | undefined {
  const candidate = (session as { readonly prompts?: unknown }).prompts as
    | PromptsCompleteDoor
    | undefined;
  return typeof candidate?.complete === "function" ? candidate : undefined;
}

export const completionsWireExtension: WireExtension = defineWireExtension({
  name: "@agentick/completions#wire",
  namespace: "completions",
  version: "1.0.0",
  // Per-keystroke traffic stays out of the journal. See the module doc-block.
  journal: { "completions/complete": "bus-only" },
  methods: {
    "completions/complete": async (params, ctx) => {
      const session = ctx.session ?? findSession(ctx, params.sessionId);

      // No prompts surface on this session — a question this deployment cannot
      // answer, which is silence rather than a protocol error.
      const prompts = promptsDoorOf(session);
      if (prompts === undefined) return NO_VALUES;

      // HOP 1 — ask the declaration's own side. An inline resolver runs there and
      // comes back `resolved`; a named ref comes back as a name to look up.
      // `PromptNotFound` propagates as the error it is.
      const outcome = await prompts.complete({
        name: params.ref.name,
        argument: params.argument,
        ...(params.context !== undefined ? { context: params.context } : {}),
      });
      if (outcome.kind === "resolved") return outcome.result;
      if (outcome.kind === "unavailable") return NO_VALUES;

      // HOP 2 — the argument names a registry source. An absent namespace or an
      // unbound name is an unanswered question, not a wire fault: a declaration
      // may name a source this deployment never mounted (one prompt library
      // across tenants), and no candidates is the composer's right answer.
      try {
        return (
          (await session.completions?.resolve(outcome.completeRef, {
            value: params.argument.value,
            ...(params.context !== undefined
              ? { resolvedArguments: params.context.arguments }
              : {}),
          })) ?? NO_VALUES
        );
      } catch (cause) {
        // Only "nobody bound this name" is silence. A resolver that THREW
        // (`CompletionResolveFailed`) is a real failure and surfaces to the client.
        if (cause instanceof CompletionNotFound) return NO_VALUES;
        throw cause;
      }
    },
  },
});

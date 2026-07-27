/**
 * Shared ingress-authentication helper (ADR 61 slice 1).
 *
 * Every transport edge (ws / http / unix) — and, in slice 2, connectors
 * — builds an {@link IngressContext} from its native credential and runs
 * it through this one helper. Slice 1 is the degenerate single-interceptor
 * form: call the configured {@link AuthSource} directly. Slice 3
 * (`GatewayInstaller.interceptIngress`) generalizes this into the
 * installed chain-of-responsibility; the edges keep calling one function.
 *
 * The rules (ADR 61 §"Default posture" + §"Security invariants"):
 *
 *   - **No `AuthSource` configured → the local/trusted pole.** The
 *     crossing carries NO principal (`identity` stays undefined); it is
 *     admitted. Pairs with the gateway's unconfigured/permissive
 *     Authorizer for dev / single-tenant hosts.
 *   - **`AuthSource` configured → run it, FAIL CLOSED.** A throw
 *     propagates to the edge (mapped to 401 / drop). The helper NEVER
 *     catches an auth failure and falls through to the local pole.
 *   - **Enrichment-only.** The helper stamps identity; it NEVER
 *     authorizes. Authorization is the Authorizer's job at dispatch.
 *
 * @see docs/proposals/v2/blueprint/61-ingress-authentication.md
 */

import type { AuthSource, IngressAdmissionFailure, IngressContext } from "@agentick/spec";

/**
 * Report a REFUSED crossing (ADR 92 §Family 1.3). The helper builds the
 * failure from what the crossing itself carries; the edge supplies this
 * callback, enriches with whatever else it knows (a peer address), and
 * publishes it on its host's bus via `DispatchHost.emitAdmissionFailure`.
 *
 * A callback rather than a host reference on purpose: the helper stays a pure
 * function of its inputs — testable with a recording callback, with no bus, no
 * gateway, and no knowledge of where the report lands.
 */
export type IngressRejectionReporter = (failure: IngressAdmissionFailure) => void;

/**
 * Wall-clock ceiling on one `AuthSource.authenticate` call, applied when the
 * caller configures none.
 *
 * An `AuthSource` is adopter code that reaches the network — a JWKS fetch, an
 * OAuth introspection call, a database lookup. Unbounded, a hung dependency
 * becomes a hung crossing: an HTTP request that never answers, a WebSocket
 * upgrade whose socket is never released. 10s is generous for every one of
 * those round trips and still bounded.
 */
export const DEFAULT_INGRESS_AUTHN_TIMEOUT_MS = 10_000;

/**
 * Refusal raised when an `AuthSource` outlives its wall-clock ceiling. A
 * refusal, not a pass-through: an authenticator that cannot answer in time has
 * not admitted the caller, and fail-closed is the only safe reading.
 *
 * TODO(trail-typed-ingress-errors): promote to an `AgentickError` subclass in
 * `@agentick/spec` (registered, `_tag`-discriminable) so adopters can catch it
 * by tag rather than by class identity across a package boundary.
 */
export class IngressAuthnTimeout extends Error {
  override readonly name = "IngressAuthnTimeout";
  constructor(readonly timeoutMs: number) {
    super(`ingress authentication exceeded its ${timeoutMs}ms ceiling`);
  }
}

/**
 * How one crossing is authenticated, beyond the `AuthSource` itself.
 *
 * Flat by convention (ADR 42 adopter APIs): no nested `config`, no duplicated
 * lists. Every edge forwards its own option of the same name.
 */
export interface IngressAuthnOptions {
  /**
   * Reporter for a REFUSED crossing — see {@link IngressRejectionReporter}.
   */
  readonly onRejected?: IngressRejectionReporter;
  /**
   * Wall-clock ceiling for the `AuthSource` call, in milliseconds. Defaults to
   * {@link DEFAULT_INGRESS_AUTHN_TIMEOUT_MS}; `Infinity` opts out for a
   * deliberately interactive authenticator (a human-in-the-loop approval).
   * Exceeding it REFUSES the crossing with {@link IngressAuthnTimeout}.
   */
  readonly timeoutMs?: number;
}

/**
 * Run ingress authentication for one crossing and return the enriched
 * context (with `identity` set when an AuthSource ran and admitted the
 * caller; left undefined for the local pole).
 *
 * Throws whatever the `AuthSource` throws — fail-closed — and throws
 * {@link IngressAuthnTimeout} when it throws nothing at all inside its
 * ceiling. The caller (transport edge) maps the throw to its native
 * rejection, and `onRejected` (when supplied) sees the refusal first so the
 * audit trail records the attempt — a timeout included; a hung authenticator
 * is exactly the condition an operator needs to see. The report is a
 * side-channel: it never alters admission, and a throwing reporter is nobody's
 * problem but its own (it propagates — a reporter that throws is a bug at the
 * edge, not a silent condition).
 */
export async function authenticateIngress(
  context: IngressContext,
  authSource?: AuthSource,
  options: IngressAuthnOptions = {},
): Promise<IngressContext> {
  // No AuthSource → local/trusted pole. No principal stamped, nothing to
  // bound: the ceiling exists to guard an `await` that never happens here.
  if (!authSource) return context;

  const { onRejected } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_INGRESS_AUTHN_TIMEOUT_MS;

  // Configured AuthSource → run it under the ceiling. A rejection propagates
  // (fail closed); we deliberately do NOT catch-and-continue.
  try {
    const identity = await withCeiling(authSource.authenticate(context.credential), timeoutMs);
    return { ...context, identity };
  } catch (cause) {
    if (onRejected) {
      const reason = admissionReason(cause);
      // NEVER `context.credential` — not the token, not the header bag.
      onRejected({
        failureClass: "authenticate",
        transportKind: context.transportKind,
        ...(context.connectionId !== undefined ? { connectionId: context.connectionId } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    }
    throw cause;
  }
}

/**
 * Settle `work` or reject with {@link IngressAuthnTimeout} at `timeoutMs`.
 *
 * The timer is always cleared — a leaked ceiling timer would hold the event
 * loop open for its full duration on every admitted crossing. `Infinity`
 * short-circuits with no timer at all.
 *
 * TODO(trail-utils-with-timeout): this is the third hand-rolled wall-clock
 * race in the tree (`compiler-react/template.ts`,
 * `compiler-react/harness/compiler-harness.ts`). It belongs in
 * `@agentick/utils` as a shared `withTimeout`; kept local here to stay inside
 * one package's blast radius.
 */
async function withCeiling<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new IngressAuthnTimeout(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Reduce a rejection to a short string for the audit event. An `Error`
 * contributes only its message; anything else is stringified.
 */
function admissionReason(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

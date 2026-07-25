/**
 * Built-in wire-extensions — the `WireExtension`s that every gateway registers
 * because their harnesses are ALWAYS present (constructed unconditionally in
 * `buildSessionBridges`, ADR 26). This is the composition seam between the
 * bundled built-ins and the gateway's wire: `app-next` depends on the built-in
 * harness packages, so it can name their wire-extensions; the gateway depends
 * on `app-next`, so it can register them — without the gateway ever importing a
 * built-in directly (it stays harness-agnostic).
 *
 * The handlers are stateless routers (they resolve the live session at dispatch
 * and call its bridge), so registering them once at gateway construction is
 * correct even though the bridges themselves are per-session.
 *
 * Add a built-in's wire-extension here as it gains a client-reachable command:
 *   - `knobs/set` (knobs) — landed.
 *   - `tasks/cancel` (tasks) — landed.
 *   - state / gates — when they add write commands.
 *
 * NOTE: these are WRITE surfaces (client → server mutations). They are
 * registered in the bundled tier (not the framework-privileged tier), so an
 * adopter may still override them. They are NOT ungated: the wire dispatch
 * choke point (`@agentick/transport` `authorizeDispatch`) authorizes every
 * resolved method by its verb-derived scope (`knobs:set`) + the target session's
 * structural `requiredScopes` ceiling, with a deny-by-default authorizer for
 * authenticated principals. A deployment restricts these by granting/withholding
 * the corresponding scope in its `Authorizer` policy.
 */

import type { WireExtension } from "@agentick/spec";
import { knobsWireExtension } from "@agentick/knobs";
import { tasksWireExtension } from "@agentick/tasks";

export const builtinWireExtensions: readonly WireExtension[] = [
  knobsWireExtension,
  tasksWireExtension,
];

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
 *   - tasks / state / gates — when they add write commands.
 *
 * NOTE: these are WRITE surfaces (client → server mutations). They are
 * registered in the bundled tier (not the framework-privileged tier), so an
 * adopter may still gate or override them. A deployment that must NOT expose a
 * mutation to clients should attach an `auth` policy (per-method `WireMethodAuth`)
 * on the extension — none is declared today (`TODO(auth): gate knobs/set`).
 */

import type { WireExtension } from "@agentick/spec-next";
import { knobsWireExtension } from "@agentick/knobs-next";

export const builtinWireExtensions: readonly WireExtension[] = [knobsWireExtension];

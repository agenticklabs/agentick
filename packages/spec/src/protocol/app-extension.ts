/**
 * App extension protocol — small-core, infinitely-extensible.
 *
 * The Agentick spec carries a fixed set of core bridges (timeline,
 * knobs, state, data, loop, session, tools). Everything else — sandbox,
 * MCP, subscriptions, telemetry, secrets, persistence — is an
 * *extension*. Extensions register their bridges, contributors, tool
 * handlers, bus subscriptions, and Layer fragments through a shared
 * {@link AppInstaller} surface the AppHarness owns.
 *
 * The pattern is the standard plugin model (Fastify, NestJS, ESLint).
 * Each extension implements one method: `install(installer)`. The
 * installer grows new registration methods as the framework adds new
 * extension surfaces; existing extensions stay binary-compatible.
 *
 * Reconciler-binding: `AppInstaller.registerContributor` uses the
 * `Contributor` type, which is reconciler-specific (it walks the
 * reconciler's host tree shape). Non-reconciler extensions
 * (telemetry, persistence) skip that method entirely; they only touch
 * bridges + bus + Layer fragments. React-bound extension factories
 * (`@agentick/sandbox/react`, etc.) call `registerContributor` with
 * react-reconciler-shaped contributors. A future Angular reconciler
 * ships its own contributor type + own extension factory subpath.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md
 */

import type { EventQuery, ProtocolEvent } from "../data/events.js";
import type { ToolHandler } from "../data/tool-handler.js";
import type { Validator } from "../data/validator.js";
import type { Unsubscribe } from "./inbox.js";

// ============================================================================
// Extension
// ============================================================================

/**
 * Plugin contract. Extension packages ship `withX()` factory functions
 * that return one of these.
 *
 * `install` is called once when the AppHarness constructs. The extension
 * uses the installer to register everything it needs (bridges,
 * contributors, tool handlers, bus subscriptions, …). Order matters:
 * extensions install in the order supplied to `AppHarnessOptions.extensions`.
 * Last-writer-wins on bridge name collisions.
 *
 * `uninstall` is optional; called when the AppHarness closes. The
 * installer object passed in is the same instance that was passed to
 * `install` — extensions may stash unsubscribe handles via closure.
 */
export interface AppExtension {
  readonly name: string;
  install(installer: AppInstaller): void | Promise<void>;
  uninstall?(installer: AppInstaller): void | Promise<void>;
}

// ============================================================================
// Installer
// ============================================================================

/**
 * Registration surface the AppHarness exposes to extensions. New
 * registration methods can be added over time; existing extensions
 * stay binary-compatible (extensions only call methods they need).
 *
 * The installer is reconciler-binding via `registerContributor` — that
 * one method's `Contributor` type is reconciler-specific. React-bound
 * extensions call it; agnostic extensions (telemetry, persistence,
 * pure-bridge ones) skip it.
 */
export interface AppInstaller {
  // ──────────────────────── Bridges ────────────────────────

  /**
   * Merge a bridge into every session's `HookBridges` by name. Adopters
   * augment `HookBridges` (via `declare module`) to type the slot
   * correctly.
   *
   * Returns an unsubscribe that removes the bridge — useful for
   * cleanup in `uninstall`.
   */
  registerBridge(name: string, bridge: unknown): Unsubscribe;

  // ──────────────────────── Reconciler ────────────────────────

  /**
   * Add a {@link Contributor} to the reconciler's registry. Reconciler-
   * specific: the type parameter is whatever shape the active
   * reconciler uses for host instances (`HostInstance` in
   * `@agentick/reconciler-react`).
   *
   * Non-reconciler extensions skip this method.
   */
  registerContributor<TContributor = unknown>(contributor: TContributor): Unsubscribe;

  // ──────────────────────── Tool executor ────────────────────────

  /**
   * Pre-register a tool handler with the shared HandlerResolver. Useful
   * for extensions that ship built-in tools (e.g., a `@agentick/secrets`
   * extension might register a `read_secret` tool here so it works
   * before any JSX tool components mount).
   */
  registerToolHandler(
    handlerRef: string,
    handler: ToolHandler,
    validator?: Validator,
  ): Unsubscribe;

  // ──────────────────────── Substrate ────────────────────────

  /**
   * Subscribe to the app's bus. Used by telemetry / observability /
   * external-driver extensions (e.g., a scheduler that listens for
   * subscription-intent events).
   */
  subscribeBus(
    filter: EventQuery,
    listener: (event: ProtocolEvent) => void | Promise<void>,
  ): Unsubscribe;

  // ──────────────────────── App ────────────────────────

  /**
   * Reference to the AppHarness for late-binding interactions
   * (start an external driver thread, register a Layer fragment).
   * Opaque to the spec; the runtime types it concretely.
   */
  readonly app: AppInstallerHost;
}

/**
 * Late-binding handle to the AppHarness the installer is operating on.
 * Concrete type lives in `@agentick/app`; spec keeps it opaque.
 */
export interface AppInstallerHost {
  readonly appId: string;
  /**
   * Free-form metadata bag shared between extensions and the host —
   * useful for cross-extension state ("the scheduler extension says
   * cron jobs are firing in this app").
   */
  readonly metadata: Readonly<Record<string, unknown>>;
}

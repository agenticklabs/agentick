/**
 * The gateway's built-in connectors harness (ADR 104) — the machinery that
 * runs {@link ConnectorSpec}s. One harness per gateway, constructed as the
 * gateway's own child (substrate + interceptor cascade flow in at
 * construction, ADR 31 / ADR 83 §4); individual connectors are ENTRIES, not
 * harnesses — exactly as tools are entries in the tool executor.
 *
 * `inbound` / `deliver` run as commands (`connectors:command:*` envelopes on
 * the gateway bus), so the ingress hop is journaled, spanned, and
 * guardable: `gateway.guard()` on `connectors:inbound` is the home for
 * allowlists / rate limits / dedupe — deliberately not spec surface.
 *
 * @see docs/proposals/v2/blueprint/104-connectors-as-builtin.md
 */

import type {
  ConnectorHandle,
  ConnectorSpec,
  ConnectorStatus,
  ConnectorsConfig,
} from "../data/connector.js";

export interface ConnectorsHarnessProtocol {
  /**
   * Register a connector at runtime (`connectors:register` — a journaled
   * operation, unlike construction-supplied specs, which are configuration).
   * If the gateway is already listening, the connector starts immediately.
   * Duplicate name ⇒ throws.
   */
  register(spec: ConnectorSpec): Promise<void>;
  /** Stop (source teardown included) and remove a connector. Unknown name is a no-op. */
  unregister(name: string): Promise<void>;
  /** Look up a registered connector. Plain read — not an operation. */
  get(name: string): ConnectorHandle | undefined;
  /** Enumerate registered connectors. Plain read — not an operation. */
  list(): readonly ConnectorHandle[];
  /** Last reported source health for a connector, `undefined` when unknown. */
  status(name: string): ConnectorStatus | undefined;
  /**
   * Start every registered, not-yet-started connector (`connectors:start`
   * per connector — failures journal individually and don't stop siblings).
   * The gateway calls this from `listen()`; ingress opens when the gateway
   * opens. Idempotent.
   */
  start(): Promise<void>;
  /**
   * Stop every started connector (source teardown, subscription release).
   * The gateway calls this FIRST in `close()`, so shutdown never races new
   * inbounds against draining sessions. Idempotent.
   */
  stop(): Promise<void>;
}

/** The adopter-facing noun alias (ADR 42 §3 — "Harness" is framework vocabulary). */
export type Connectors = ConnectorsHarnessProtocol;

/**
 * The `createGateway({ connectors })` slot — the ADR 42 trichotomy:
 * `Decl[]` shorthand (the advertised form) | Config | Instance.
 */
export type ConnectorsSlot = readonly ConnectorSpec[] | ConnectorsConfig | Connectors;

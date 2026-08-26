/**
 * `defineConnector` — validate one {@link ConnectorSpec} (ADR 104).
 *
 * A spec is DATA: a recipe the gateway's built-in connectors harness runs.
 * Registration is the gateway's job — `createGateway({ connectors: [spec] })`
 * or `gateway.connectors.register(spec)` — so this function only checks the
 * shape early (a typo'd spec fails at definition, with the author's stack)
 * and freezes it. Raw spec literals are accepted everywhere a defined
 * connector is; `defineConnector` buys the early error and the typed return.
 */

import type { ConnectorSpec } from "@agentick/spec";

export function defineConnector(spec: ConnectorSpec): ConnectorSpec {
  if (!spec || typeof spec.name !== "string" || spec.name.length === 0) {
    throw new Error("defineConnector: spec requires a non-empty `name`");
  }
  if (typeof spec.start !== "function") {
    throw new Error(`defineConnector: connector "${spec.name}" requires a \`start\` function`);
  }
  for (const key of ["deliver", "stream", "confirm"] as const) {
    if (spec[key] !== undefined && typeof spec[key] !== "function") {
      throw new Error(`defineConnector: connector "${spec.name}": \`${key}\` must be a function`);
    }
  }
  return Object.freeze({ ...spec });
}

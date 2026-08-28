/**
 * Framework-supplied wire extensions (ADR 46). Registered as defaults
 * on every `GatewayHarness` during construction — see `../harness.ts`.
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md §"The framework's own wire methods ARE wire extensions"
 */

export { gatewayWireExtension } from "./gateway-extension.js";
export { appWireExtension } from "./app-extension.js";
export { sessionWireExtension } from "./session-extension.js";
export { subscriptionsWireExtension } from "./subscriptions-extension.js";
export {
  mayBranchFrom,
  metadataMatches,
  needsSnapshotPath,
  toSessionEntry,
  toSessionStoreQuery,
  visibleTo,
} from "./session-list.js";

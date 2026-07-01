/**
 * `buildClientCapabilities` — freeze a
 * {@link ClientCapabilities} from raw handshake responses. Pure
 * function; no framework coupling.
 *
 * The `AgentickClient` calls this after `initialize` +
 * `_extensions/list` complete, swapping the result into its
 * `_capabilities` slot. Reset to
 * {@link EMPTY_CLIENT_CAPABILITIES} on disconnect.
 *
 * @see @agentick/spec-next/client/capabilities.ts
 */

import type {
  ClientCapabilities,
  ServerCapabilities,
  WireExtensionInfo,
} from "@agentick/spec-next";

export function buildClientCapabilities(
  framework: ServerCapabilities,
  extensions: readonly WireExtensionInfo[],
): ClientCapabilities {
  const methods = new Set<string>();
  const notifications = new Set<string>();
  const namespaces = new Set<string>();
  for (const ext of extensions) {
    namespaces.add(ext.namespace);
    for (const m of ext.methods) methods.add(m);
    for (const n of ext.notifications) notifications.add(n);
  }

  return {
    framework,
    extensions,
    methods,
    notifications,
    hasMethod: (name) => methods.has(name),
    hasNotification: (name) => notifications.has(name),
    hasNamespace: (namespace) => namespaces.has(namespace),
    // TODO(post-296): populate from per-extension metadata blobs once
    // `_extensions/list` responses carry them. For now the ext slot is
    // an empty object — declaration-merge slots read as `undefined`.
    ext: {},
  };
}

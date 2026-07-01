/**
 * `createWireExtensionRegistry` — concrete implementation of
 * {@link WireExtensionRegistry} owned by `@agentick/gateway-next`.
 *
 * The registry holds every {@link WireExtension} installed on a
 * gateway, indexed by full method name for O(1) dispatch lookup.
 * Populated during gateway construction; sealed once the gateway is
 * ready (`register` throws thereafter).
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 */

import {
  WireExtensionDefinitionError,
  type WireExtension,
  type WireExtensionInfo,
  type WireExtensionRegistry,
  type WireExtensionResolution,
} from "@agentick/spec-next";

interface RegistryEntry {
  readonly extension: WireExtension;
  /**
   * Flat method → handler map, extracted once at registration for O(1)
   * lookup. Handler function values narrowed away from the strongly-
   * typed {@link WireExtension.methods} bag; the dispatcher passes
   * validated params/ctx at dispatch time.
   */
  readonly methods: ReadonlyMap<string, (params: unknown, ctx: unknown) => Promise<unknown>>;
}

/**
 * Create a fresh wire-extension registry. Called once per gateway
 * construction.
 */
export function createWireExtensionRegistry(): WireExtensionRegistry {
  // ADR 46 §"Namespace conflicts" — one extension per namespace,
  // first-write-wins with a typed throw on conflict.
  const byNamespace = new Map<string, RegistryEntry>();
  // Flat method-name index rebuilt on each register. Kept alongside
  // byNamespace so resolve() is a single map lookup instead of a
  // namespace walk.
  const byMethod = new Map<string, RegistryEntry>();
  // Name-uniqueness index — diagnostic hygiene, prevents two
  // extensions from claiming the same `name` even under different
  // namespaces (would confuse `_extensions/list` consumers).
  const byName = new Set<string>();
  let sealed = false;

  return {
    register(extension: WireExtension): void {
      if (sealed) {
        throw new WireExtensionDefinitionError({
          extensionName: extension.name,
          reason: "registry is sealed — register calls only allowed during gateway construction.",
        });
      }
      if (byNamespace.has(extension.namespace)) {
        const existing = byNamespace.get(extension.namespace)!.extension;
        throw new WireExtensionDefinitionError({
          extensionName: extension.name,
          reason: `namespace "${extension.namespace}" already registered by extension "${existing.name}". Two extensions cannot share a namespace.`,
        });
      }
      if (byName.has(extension.name)) {
        throw new WireExtensionDefinitionError({
          extensionName: extension.name,
          reason: `extension name "${extension.name}" already registered. Extension names must be unique across a gateway.`,
        });
      }

      // Extract handlers into a plain map — the strongly-typed
      // `methods` bag is a Partial index across every WireMethod key;
      // the dispatcher just needs "method-name → callable".
      const methods = new Map<string, (params: unknown, ctx: unknown) => Promise<unknown>>();
      for (const [name, handler] of Object.entries(extension.methods)) {
        if (handler) {
          methods.set(name, handler as (params: unknown, ctx: unknown) => Promise<unknown>);
        }
      }

      const entry: RegistryEntry = { extension, methods };
      byNamespace.set(extension.namespace, entry);
      byName.add(extension.name);
      for (const methodName of methods.keys()) {
        // defineWireExtension already validates no cross-extension
        // method-name collisions can occur (every method starts with
        // `${namespace}/` and namespaces are unique post-Register).
        // Defense in depth — if somehow two entries reach this branch
        // with the same method name, prefer the later-registered
        // extension (they'd be from the same package after all).
        byMethod.set(methodName, entry);
      }
    },

    resolve(method: string): WireExtensionResolution | undefined {
      const entry = byMethod.get(method);
      if (!entry) return undefined;
      const handler = entry.methods.get(method);
      if (!handler) return undefined;
      return { extension: entry.extension, handler };
    },

    enumerate(): readonly WireExtensionInfo[] {
      const out: WireExtensionInfo[] = [];
      for (const { extension } of byNamespace.values()) {
        out.push({
          name: extension.name,
          namespace: extension.namespace,
          ...(extension.version !== undefined ? { version: extension.version } : {}),
          methods: Object.keys(extension.methods).filter(
            (m) => extension.methods[m as keyof typeof extension.methods] !== undefined,
          ),
          notifications: (extension.notifications ?? []).slice(),
        });
      }
      return out;
    },

    seal(): void {
      sealed = true;
    },
  };
}

/**
 * `fakeWireCaller()` — invoke a wire method against real harnesses, with no
 * transport and no client.
 *
 * A wire method is where a projection lives: `app/list_sessions` decides what a
 * client can actually see of a `SessionRecord`, and a field dropped there is
 * unreachable no matter how faithfully the rest of the stack behaves. Proving that
 * needs the REAL handler, but the handler's only collaborator is a
 * {@link WireExtensionContext} — so standing up a transport, a client and a
 * connection to reach it is ceremony that tests nothing extra.
 *
 * A **fake** by the Meszaros taxonomy: a working implementation of the context,
 * simplified (in-memory app lookup, no auth, no interceptors) rather than canned.
 * It resolves methods across every framework wire extension, so a test names a
 * method the way a client would rather than importing the extension that happens
 * to own it.
 *
 * ```ts
 * const wire = fakeWireCaller({ apps: [app] });
 * const entry = await wire.call("app/get_session", { appId: app.id, sessionId });
 * ```
 *
 * What it deliberately does NOT do: the wire op interceptor fold, guards, scope
 * checks, or principal resolution. A test about authorization wants a real gateway
 * over `@agentick/transport-in-process`; this is for projections.
 */

import type { AppHarnessProtocol, WireExtension } from "@agentick/spec";

import { appWireExtension } from "../wire/app-extension.js";
import { gatewayWireExtension } from "../wire/gateway-extension.js";
import { sessionWireExtension } from "../wire/session-extension.js";

/** The framework's own wire namespaces — what a client can reach out of the box. */
const FRAMEWORK_EXTENSIONS: readonly WireExtension[] = [
  gatewayWireExtension,
  appWireExtension,
  sessionWireExtension,
];

export interface FakeWireCallerOptions {
  /** Apps reachable as `ctx.gateway.app(id)` / `ctx.gateway.apps()`. */
  readonly apps?: readonly AppHarnessProtocol[];
  /** Extra namespaces to resolve alongside the framework's. */
  readonly extensions?: readonly WireExtension[];
}

export interface FakeWireCaller {
  /**
   * Invoke a wire method by name. Throws `Error` on an unknown method — loud,
   * because a typo'd method name silently returning `undefined` would make an
   * assertion pass for the wrong reason.
   */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

type MethodTable = Record<string, (params: unknown, ctx: unknown) => Promise<unknown>>;

export function fakeWireCaller(options: FakeWireCallerOptions = {}): FakeWireCaller {
  const apps = options.apps ?? [];
  const extensions = [...FRAMEWORK_EXTENSIONS, ...(options.extensions ?? [])];

  // Only the members the framework's own handlers read. Widening this is the
  // signal that a handler has grown a dependency worth knowing about.
  const ctx = {
    gateway: {
      app: (appId: string) => apps.find((a) => a.id === appId),
      apps: () => apps,
    },
  };

  return {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      for (const extension of extensions) {
        const methods = (extension as unknown as { methods?: MethodTable }).methods;
        const handler = methods?.[method];
        if (handler !== undefined) return (await handler(params, ctx)) as T;
      }
      throw new Error(
        `fakeWireCaller: no wire extension handles "${method}". ` +
          `Known namespaces: ${extensions.map((e) => e.namespace).join(", ")}.`,
      );
    },
  };
}

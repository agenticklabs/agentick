/**
 * The dynamic command lane (ADR 51 §3.1, slice 5 / #141).
 *
 * One generic implementation projects every `exposure: "wire"` command
 * to wire clients: `timeline/compact` → verb `timeline:compact` →
 * Authorizer gate → `inbox.ask(address, { type: verb, origin: "wire" })`.
 *
 * Resolution order is exact-beats-dynamic (the registry consults this
 * resolver only when no porcelain method matches), so an earned named
 * method shadows the auto-route by construction. New capability
 * requires new DECLARATIONS, never new plumbing.
 *
 * Deny-by-default posture (§4.3):
 *   - a verb that is not declared `exposure: "wire"` is indistinguishable
 *     from an absent method (MethodNotFound);
 *   - an exposed verb still requires a grant (Forbidden without one);
 *   - THE RESOLVER NEVER SHIPS WITHOUT THE GATE.
 *
 * // TODO(trail-exposure-cache): the per-call `<surface>:commands` ask
 * // is 2 asks per invocation; command declarations are construction-
 * // stable, so a per-address cache with session-close invalidation is
 * // the follow-up.
 */

import { Effect } from "effect";

import {
  WireRpcError,
  type Authorizer,
  type CommandInfo,
  type DynamicWireResolver,
  type MessageInbox,
  type WireExtension,
  type WireExtensionContext,
} from "@agentick/spec";

/** Session-scoped surfaces the dynamic lane can address (VERB-MATRIX). */
const SESSION_SURFACES = [
  "timeline",
  "knobs",
  "skills",
  "prompts",
  "state",
  "elicitation",
  "tasks",
  "gates",
  "resources",
] as const;

interface DynamicParams {
  readonly sessionId?: string;
  readonly serverId?: string;
  readonly [key: string]: unknown;
}

/** Derive the target inbox address for a surface from wire params. */
function resolveAddress(surface: string, params: DynamicParams): string | undefined {
  if (typeof params.sessionId !== "string" || params.sessionId.length === 0) return undefined;
  if (surface === "mcp") {
    if (typeof params.serverId !== "string" || params.serverId.length === 0) return undefined;
    return `mcp:${params.sessionId}:mcp:${params.serverId}`;
  }
  if ((SESSION_SURFACES as readonly string[]).includes(surface)) {
    return `${surface}:${params.sessionId}:${surface}`;
  }
  return undefined;
}

export interface DynamicCommandResolverOptions {
  readonly inbox: MessageInbox;
  readonly authorizer: Authorizer;
}

/** Marker extension identity for dynamically-resolved methods. */
const DYNAMIC_EXTENSION: WireExtension = {
  name: "@agentick/dynamic-commands",
  namespace: "*",
  methods: {},
};

/**
 * Build the ONE dynamic fallthrough resolver. Registered by the
 * gateway before the registry seals.
 */
export function createDynamicCommandResolver(
  options: DynamicCommandResolverOptions,
): DynamicWireResolver {
  const { inbox } = options;

  const askCommands = async (address: string): Promise<readonly CommandInfo[]> => {
    const surface = address.slice(0, address.indexOf(":"));
    const reply = await Effect.runPromise(
      inbox.ask<unknown, { commands?: readonly CommandInfo[] } | readonly CommandInfo[]>(address, {
        type: `${surface}:commands`,
        origin: "wire",
      }),
    );
    if (Array.isArray(reply)) return reply as readonly CommandInfo[];
    return (reply as { commands?: readonly CommandInfo[] } | undefined)?.commands ?? [];
  };

  return (method: string) => {
    const slash = method.indexOf("/");
    if (slash <= 0) return undefined;
    const surface = method.slice(0, slash);
    const rest = method.slice(slash + 1);
    if (rest.length === 0) return undefined;
    const verb = `${surface}:${rest}`;

    const handler = async (params: unknown, _rawCtx: unknown): Promise<unknown> => {
      const p = (params ?? {}) as DynamicParams;

      const address = resolveAddress(surface, p);
      if (address === undefined) throw WireRpcError.methodNotFound(method);

      // `<surface>/commands` is itself the ratified discovery meta-verb —
      // the dispatch choke point already authorized it; serve directly.
      if (rest === "commands") {
        return { commands: await askCommands(address) };
      }

      // Exposure check: deny-by-default — a verb that isn't declared
      // `wire` does not exist as far as the wire is concerned.
      const commands = await askCommands(address);
      const declared = commands.find((c) => c.name === verb);
      if (!declared || declared.exposure !== "wire") {
        throw WireRpcError.methodNotFound(method);
      }

      // Authorization happened at the dispatch choke point (ADR 51
      // §3.3 — ONE gate, both lanes); this handler owns only exposure
      // semantics (deny-by-default: non-wire == absent).
      return Effect.runPromise(inbox.ask(address, { type: verb, origin: "wire", payload: p }));
    };

    return { extension: DYNAMIC_EXTENSION, handler };
  };
}

/**
 * `commands/list` — the runtime discovery surface for dynamic and
 * non-TS clients (ADR 51 §3.2). Enumerates the WIRE-EXPOSED commands
 * across a session's surfaces; surfaces whose harness is absent are
 * skipped.
 */
export function createCommandsListHandler(options: DynamicCommandResolverOptions) {
  const resolver = createDynamicCommandResolver(options);
  return async (params: unknown, rawCtx: unknown): Promise<unknown> => {
    const p = (params ?? {}) as DynamicParams;
    if (typeof p.sessionId !== "string" || p.sessionId.length === 0) {
      throw WireRpcError.methodNotFound("commands/list");
    }
    const ctx = (rawCtx ?? {}) as WireExtensionContext;
    const out: Array<{ method: string; command: CommandInfo }> = [];
    for (const surface of SESSION_SURFACES) {
      // Visibility filter (not a gate — the choke point gated
      // commands/list itself): discovery lists only surfaces whose
      // meta-verb scope this caller holds.
      const visible = await options.authorizer.authorize({
        ...(ctx.principal !== undefined ? { principal: ctx.principal } : {}),
        scope: `${surface}:commands`,
      });
      if (!visible.allowed) continue;
      const resolution = resolver(`${surface}/commands`);
      if (!resolution) continue;
      try {
        const reply = (await resolution.handler(p, rawCtx)) as {
          commands?: readonly CommandInfo[];
        };
        for (const c of reply.commands ?? []) {
          if (c.exposure !== "wire") continue;
          out.push({ method: c.name.replace(":", "/"), command: c });
        }
      } catch {
        // Absent harness / denied surface — skipped, not fatal:
        // discovery lists what THIS caller can see.
      }
    }
    return { commands: out };
  };
}

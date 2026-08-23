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

import { Cause, Effect, Exit } from "effect";

import {
  progressEventQuery,
  resumeSession,
  WireRpcError,
  type Authorizer,
  type CommandInfo,
  type DynamicWireResolver,
  type MessageInbox,
  type WireExtension,
  type WireExtensionContext,
} from "@agentick/spec";

import { fanOutProgressSignals } from "./wire/progress-fanout.js";

/**
 * Surfaces {@link createCommandsListHandler} enumerates for `commands/list`.
 *
 * ADDRESSING no longer consults this list: {@link resolveAddress} mints a
 * deterministic address for ANY surface, and the inbox decides reachability —
 * an ask to an unmounted surface fails `AddressNotFound`, which the resolver
 * maps back to `MethodNotFound`. So an adopter harness routes through this lane
 * the moment it mounts, with no gateway edit (#258, the addressing half).
 *
 * Enumeration still needs a NAME to ask and cannot probe an unbounded
 * namespace, so it walks this known set — a surface absent from it is
 * addressable but not listed (the long-standing `mcp` case).
 *
 * // TODO(#258): derive the ENUMERATION set from the session's mounted
 * // harnesses too, so adopter surfaces list as well as route.
 */
const ENUMERATED_SURFACES = [
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

/**
 * The deterministic inbox address for a surface. Whether anything ANSWERS
 * there is the inbox's call, not ours — an unmounted surface fails the ask
 * with `AddressNotFound`, which the resolver reads as an absent method.
 */
function resolveAddress(surface: string, params: DynamicParams): string | undefined {
  if (typeof params.sessionId !== "string" || params.sessionId.length === 0) return undefined;
  if (surface === "mcp") {
    if (typeof params.serverId !== "string" || params.serverId.length === 0) return undefined;
    return `mcp:${params.sessionId}:mcp:${params.serverId}`;
  }
  return `${surface}:${params.sessionId}:${surface}`;
}

/** The inbox's "nothing mounted here" — an unmounted surface, not a real fault. */
const isAddressNotFound = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { _tag?: unknown })._tag === "AddressNotFound";

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
 * Run an inbox `ask` and reject with the FAILURE VALUE — never with Effect's
 * `FiberFailure` envelope.
 *
 * `Effect.runPromise` rejects with a `FiberFailure`, a plain `Error` whose
 * message is the pretty-printed cause. Everything the dispatcher needs to
 * project a typed failure honestly — the `_tag`, the fields, `toJSON()` — is
 * gone by the time it lands in the `catch`, so `isAgentickError` is false and a
 * `PromptArgumentMissing` reached clients as `-32603 "internal error"` with the
 * real message smuggled into `data.reason` as free text. Running to an `Exit`
 * and squashing the cause hands back the value the effect actually failed with
 * (or the defect it died with), which is what the wire edge knows how to map.
 *
 * @verifiedBy packages/transport-in-process/src/__tests__/typed-error-e2e.spec.ts
 */
async function runAsk<A>(effect: Effect.Effect<A, unknown, never>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

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
    const reply = await runAsk(
      inbox.ask<unknown, { commands?: readonly CommandInfo[] } | readonly CommandInfo[]>(address, {
        type: `${surface}:commands`,
        origin: "wire",
      }),
    );
    if (Array.isArray(reply)) return reply as readonly CommandInfo[];
    return (reply as { commands?: readonly CommandInfo[] } | undefined)?.commands ?? [];
  };

  /** `askCommands`, but an unmounted surface (no inbox handler) reads as absent. */
  const askCommandsOrAbsent = async (
    address: string,
  ): Promise<readonly CommandInfo[] | undefined> => {
    try {
      return await askCommands(address);
    } catch (err) {
      if (isAddressNotFound(err)) return undefined;
      throw err;
    }
  };

  return (method: string) => {
    const slash = method.indexOf("/");
    if (slash <= 0) return undefined;
    const surface = method.slice(0, slash);
    const rest = method.slice(slash + 1);
    if (rest.length === 0) return undefined;
    const verb = `${surface}:${rest}`;

    const handler = async (params: unknown, rawCtx: unknown): Promise<unknown> => {
      const p = (params ?? {}) as DynamicParams;
      const ctx = rawCtx as WireExtensionContext | undefined;

      const address = resolveAddress(surface, p);
      if (address === undefined) throw WireRpcError.methodNotFound(method);

      /**
       * An unmounted surface on a session-addressed verb is ambiguous — the
       * harness may be absent, or the whole session may have been paged out.
       * Take the RESUME door once and ask again (session-doors.md §3), which is
       * what makes any harness read survive eviction through the same hooked,
       * traced door. Generic by construction: no surface is special-cased. A
       * session with no record resumes to nothing and stays MethodNotFound —
       * reads never create.
       */
      const askCommandsOrResume = async (): Promise<readonly CommandInfo[] | undefined> => {
        const mounted = await askCommandsOrAbsent(address);
        if (mounted !== undefined) return mounted;
        const sessionId = p.sessionId;
        if (ctx?.gateway === undefined || sessionId === undefined) return undefined;
        if ((await resumeSession(ctx, sessionId)) === undefined) return undefined;
        return askCommandsOrAbsent(address);
      };

      // `<surface>/commands` is itself the ratified discovery meta-verb —
      // the dispatch choke point already authorized it; serve directly.
      // An unmounted surface answers nothing, so it reads as absent.
      if (rest === "commands") {
        const commands = await askCommandsOrResume();
        if (commands === undefined) throw WireRpcError.methodNotFound(method);
        return { commands };
      }

      // Exposure check: deny-by-default — a verb that isn't declared
      // `wire` (or a surface that isn't mounted) does not exist as far as
      // the wire is concerned.
      const commands = await askCommandsOrResume();
      if (commands === undefined) throw WireRpcError.methodNotFound(method);
      const declared = commands.find((c) => c.name === verb);
      if (!declared || declared.exposure !== "wire") {
        throw WireRpcError.methodNotFound(method);
      }

      // Authorization happened at the dispatch choke point (ADR 51
      // §3.3 — ONE gate, both lanes); this handler owns only exposure
      // semantics (deny-by-default: non-wire == absent).
      const ask = () => runAsk(inbox.ask(address, { type: verb, origin: "wire", payload: p }));

      // A command can be long — a compaction is a model call — and every harness
      // already reports through `ctx.progress`. One generic lane, so a verb
      // becomes observable by emitting, not by earning wire plumbing.
      const progressToken = (p._meta as { readonly progressToken?: string | number } | undefined)
        ?.progressToken;
      if (progressToken === undefined || ctx?.gateway === undefined) return ask();

      const reporter = ctx.wire.progress(progressToken);
      const signals = fanOutProgressSignals((q) => ctx.gateway.events(q), reporter, {
        ...progressEventQuery(),
        scope: { sessionId: p.sessionId as string },
      });
      try {
        return await ask();
      } finally {
        signals.stop();
        void signals.drained.then(() => reporter.close());
      }
    };

    return { extension: DYNAMIC_EXTENSION, handler };
  };
}

/**
 * `commands/list` — the runtime discovery surface for dynamic and
 * non-TS clients (ADR 51 §3.2). Enumerates the WIRE-EXPOSED commands
 * across a session's surfaces; surfaces whose harness is absent are
 * skipped.
 *
 * The cross-surface form of the per-namespace `<ns>/commands` read
 * served above — both answer what is mounted on THIS session. The other
 * lane has its own door: `_extensions/list` (ADR 46) enumerates the
 * EXACT wire-extension routes a server registered, server-wide, which
 * is the question a client's `capabilities.hasNamespace` answers. A
 * client that needs both asks both.
 *
 * @see packages/spec/src/wire/extension.ts — `defineWireExtension`, the other lane
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
    for (const surface of ENUMERATED_SURFACES) {
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

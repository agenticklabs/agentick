/**
 * `@agentick/spec` — the canonical contracts every other v2 package speaks.
 *
 * The firewall between compiler, runtime, executors, harnesses, and the wire:
 * a package may depend on spec plus its own substrate, never on a sibling's
 * implementation. Nine barrels, re-exported flat (import from `@agentick/spec`,
 * not from a subpath):
 *
 *   - `version.ts`         `SPEC_VERSION` — stamped onto every `RenderedTree` /
 *                          `SessionSnapshot` so a restore can refuse a shape it
 *                          doesn't understand.
 *   - `data/`              the wire shapes that cross a harness boundary —
 *                          content blocks, semantic nodes, context entries,
 *                          declarations, `RenderedTree`, operations + events +
 *                          outcomes, execution results/targets, timeline,
 *                          streaming, tool handler/result, `RuntimeContext`,
 *                          observability, stores.
 *   - `errors/`            the `AgentickError` root, its `_tag` registry, the
 *                          JSON codec, and the concrete per-domain classes
 *                          (ADR 41).
 *   - `protocol/`          the harness + substrate INTERFACES: journal / bus /
 *                          inbox, compiler, tool- and model- and loop-executor,
 *                          session, app, gateway, and one file per built-in and
 *                          optional harness (timeline, knobs, state, tasks,
 *                          elicitation, resources, prompts, skills, live,
 *                          credentials, mcp-server), plus the `Store` /
 *                          `LogStore` seams and the command/middleware types.
 *   - `wire/`              JSON-RPC 2.0 envelopes, method-bound params,
 *                          notifications, error codes, subscription scope,
 *                          and the wire method registry.
 *   - `client/`            what a client exposes to application code —
 *                          handles, signals, channels, transports, extensions.
 *   - `server/`            the gateway's side of the same seam.
 *   - `guards/`            structural predicates (`isTextBlock`, …) for
 *                          narrowing the unions above.
 *   - `hooks/derivation.ts` the TYPE-LEVEL derivations that mint the hook and
 *                          guard surfaces from a command registry (`HooksOf`,
 *                          `GuardsOf`, `RegistrarsOf`, and the namespace
 *                          drop-layer twins).
 *
 * Spec holds contracts, not behavior: the runtime values it does export are
 * error classes, type guards, codecs, and constants — no substrate, no
 * harnesses, no I/O. Every third-party import (`effect`,
 * `@opentelemetry/sdk-*`) is TYPE-ONLY, so nothing here loads a runtime
 * dependency and the package is browser-safe.
 *
 * Spec is also the AUGMENTATION target: `HookBridges`, `NamespaceSlots`, and
 * `ToolHandlerCtxExtensions` are seeded EMPTY here and filled by each harness
 * package via `declare module "@agentick/spec"` (the runtime's `CommandRegistry`
 * works the same way, one layer up). Spec never hardcodes a harness's slot
 * (ADR 27).
 *
 * @see docs/proposals/v2/blueprint/ for the architectural blueprint.
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md for the augmentation law.
 */

export { SPEC_VERSION, type SpecVersion } from "./version.js";

export * from "./data/index.js";
export * from "./errors/index.js";
export * from "./protocol/index.js";
export * from "./wire/index.js";
export * from "./client/index.js";
export * from "./server/index.js";
export * from "./guards/index.js";
export * from "./hooks/derivation.js";

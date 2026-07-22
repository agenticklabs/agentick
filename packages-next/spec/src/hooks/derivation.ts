/**
 * Command hook-name derivation (ADR 80) — the pure, registry-agnostic core
 * shared by BOTH sides of the wire: the server (`CommandRegistry` →
 * `CommandHooks` in `@agentick/runtime-next`) and the client (`WireMethods` →
 * typed hooks in `@agentick/client-core-next`). One generic, zero duplication.
 *
 * Everything here is PURE — no Effect, no `RuntimeContext`, no runtime deps.
 * The context type (`Ctx`) is a free type parameter each consumer binds to its
 * own ambient context (`RuntimeContext` on the server, a wire context on the
 * client). Spec must NOT depend on runtime — hence `Ctx` carries no
 * runtime-flavored default.
 *
 * @see docs/proposals/v2/blueprint/ ADR 80 — command lifecycle hooks
 */

import type { Unsubscribe } from "../protocol/inbox.js";

// ============================================================================
// Type-level name derivation
// ============================================================================

/** Uppercase the first char of `S`, leaving the tail untouched. */
export type Cap<S extends string> = S extends `${infer H}${infer T}` ? `${Uppercase<H>}${T}` : S;

/**
 * PascalCase a command id, splitting on the `:` (command), `/` (wire), `-`
 * (kebab word), and `_` (snake word) delimiters — so `session:apply-executor-result`
 * mints the clean, dot-accessible `onBeforeSessionApplyExecutorResult`, and the
 * snake_case wire id `app/run_once` mints `onBeforeWireAppRunOnce` (not the
 * mangled `…AppRun_once`). All four are word boundaries.
 */
export type Pascal<S extends string> = S extends `${infer A}:${infer B}`
  ? `${Cap<A>}${Pascal<B>}`
  : S extends `${infer A}/${infer B}`
    ? `${Cap<A>}${Pascal<B>}`
    : S extends `${infer A}-${infer B}`
      ? `${Cap<A>}${Pascal<B>}`
      : S extends `${infer A}_${infer B}`
        ? `${Cap<A>}${Pascal<B>}`
        : Cap<S>;

// ============================================================================
// Hook shapes (context-parametric)
// ============================================================================

/**
 * A before-hook (ADR 80 §4): receives the command's input plus the ambient
 * context. Return the reshaped input to **transform**, `void` to
 * **observe/passthrough**, or `throw` to **veto** (the op aborts with the
 * thrown error — no verdict DSL).
 *
 * `Ctx` is a free parameter (default `unknown`) — consumers bind it: the server
 * to `RuntimeContext`, the client to its wire context. Spec carries no
 * runtime-flavored default (a wrong-direction dep).
 */
export type BeforeHook<In, Ctx = unknown> = (input: In, ctx: Ctx) => In | void | Promise<In | void>;

/** An after-hook — symmetric to {@link BeforeHook} over the command's output. */
export type AfterHook<Out, Ctx = unknown> = (
  output: Out,
  ctx: Ctx,
) => Out | void | Promise<Out | void>;

// ============================================================================
// Per-chunk interception (ADR 80 Phase 2) — streaming commands only
// ============================================================================
//
// A streaming command (`commandStream`) emits `Chunk`s to a sink between the
// body and the consumption edge. A chunk interceptor SINK-WRAPS that sink —
// it runs BETWEEN the body's emit and the bounded queue, so the iterator (and
// the loop's `fx` sink) sees the TRANSFORMED chunks. Boundary hooks
// (`onBefore`/`onAfter`) bracket the WHOLE run; chunk interceptors intercept
// each item. Two kinds only:
//
//   - **observe** — a tap. Sees each chunk in order, cannot alter or drop it.
//   - **transform** — a stateful map. `onChunk(chunk, emit)` may `emit` zero
//     (buffer/coalesce), one (1:1 map), or many (fan-out) chunks. The optional
//     `onFlush(emit)` runs ONCE at the terminal boundary (after the body's last
//     emit, BEFORE `onAfter`) to release any buffered tail — the
//     flush-on-terminal contract that makes N→1 coalescing lossless. Flush runs
//     only on CLEAN completion; an aborted run never flushes (no bogus tail).
//
// There is deliberately NO per-chunk guard: a `transform` that raises covers
// stop-on-bad-content.

/**
 * A chunk **observer** (ADR 80 Phase 2) — a non-altering tap over a streaming
 * command's items. Runs in order between each body emit and the downstream
 * sink; its return value is ignored (the original chunk always proceeds
 * unchanged). Use for metrics, logging, progress. To alter/drop/coalesce, use a
 * {@link ChunkTransform}.
 */
export type ChunkObserver<Chunk, Ctx = unknown> = (chunk: Chunk, ctx: Ctx) => void | Promise<void>;

/**
 * A chunk **transform** (ADR 80 Phase 2) — a stateful map over a streaming
 * command's items. `onChunk` receives each chunk plus an `emit` callback; call
 * `emit` zero times to BUFFER (coalesce), once for a 1:1 map, or many for
 * fan-out. `onFlush` (optional) fires ONCE at the terminal boundary — after the
 * body's final emit, BEFORE the command's `onAfter` boundary hook — to release
 * any buffered tail. This is the **flush-on-terminal** contract: an N→1
 * combining transform emits its remainder here so no tail is lost. `onFlush`
 * runs only on CLEAN completion; an aborted/interrupted run never reaches it.
 */
export interface ChunkTransform<Chunk, Ctx = unknown> {
  readonly onChunk: (chunk: Chunk, emit: (chunk: Chunk) => void, ctx: Ctx) => void | Promise<void>;
  readonly onFlush?: (emit: (chunk: Chunk) => void, ctx: Ctx) => void | Promise<void>;
}

/**
 * A per-chunk interceptor (ADR 80 Phase 2) — the discriminated union a
 * streaming command's `on<Verb>Chunk` hook (and its `def.chunk` option) accepts.
 * Shape-discriminated: an `{ observe }` object is a {@link ChunkObserver} tap; an
 * `{ onChunk }` object is a {@link ChunkTransform} map. Multiple interceptors
 * compose in registration order into a pipeline (`body → i0 → i1 → … → sink`).
 */
export type ChunkInterceptor<Chunk, Ctx = unknown> =
  | { readonly observe: ChunkObserver<Chunk, Ctx> }
  | ChunkTransform<Chunk, Ctx>;

// ============================================================================
// Generic mapped types over ANY `{ input; output }` registry
// ============================================================================

/**
 * The derived DECLARATIVE hook surface over ANY registry keyed
 * `{ input; output }`: each entry mints `onBefore<Pascal>?` (over its input)
 * and `onAfter<Pascal>?` (over its output). The single generic the server's
 * `CommandHooks` and the client's hook surface both instantiate — one
 * `Pascal`, zero duplication.
 */
export type HooksOf<Reg, Ctx> = {
  [K in keyof Reg as `onBefore${Pascal<K & string>}`]?: BeforeHook<
    Reg[K] extends { input: infer I } ? I : never,
    Ctx
  >;
} & {
  [K in keyof Reg as `onAfter${Pascal<K & string>}`]?: AfterHook<
    Reg[K] extends { output: infer O } ? O : never,
    Ctx
  >;
};

/**
 * The derived IMPERATIVE registrar surface — the same `Pascal<K>` derivation as
 * {@link HooksOf}, valued as `(fn) => Unsubscribe` methods instead of optional
 * properties. Reached via a Proxy: `harness.hooks.onBeforeToolDispatch(fn)`.
 */
export type RegistrarsOf<Reg, Ctx> = {
  [K in keyof Reg as `onBefore${Pascal<K & string>}`]: (
    fn: BeforeHook<Reg[K] extends { input: infer I } ? I : never, Ctx>,
  ) => Unsubscribe;
} & {
  [K in keyof Reg as `onAfter${Pascal<K & string>}`]: (
    fn: AfterHook<Reg[K] extends { output: infer O } ? O : never, Ctx>,
  ) => Unsubscribe;
};

/**
 * The derived DECLARATIVE chunk-hook surface (ADR 80 Phase 2) — mints
 * `on<Pascal>Chunk?` ONLY for registry entries that carry a `chunk` field (i.e.
 * streaming commands declared via `commandStream`). A non-streaming `{ input;
 * output }` entry mints no chunk key, so the surface stays exact: only streams
 * accept per-chunk interceptors. Folded into the server's `CommandHooks`.
 */
export type ChunkHooksOf<Reg, Ctx> = {
  [K in keyof Reg as Reg[K] extends { chunk: unknown }
    ? `on${Pascal<K & string>}Chunk`
    : never]?: ChunkInterceptor<Reg[K] extends { chunk: infer C } ? C : never, Ctx>;
};

/**
 * The derived IMPERATIVE chunk registrar surface — the `(interceptor) =>
 * Unsubscribe` twin of {@link ChunkHooksOf}, reached via the `hooks` Proxy
 * (`harness.hooks.onModelGenerateStreamChunk(interceptor)`). Only streaming
 * commands (entries with `chunk`) mint a callable key. Folded into the server's
 * `HookRegistrars`.
 */
export type ChunkRegistrarsOf<Reg, Ctx> = {
  [K in keyof Reg as Reg[K] extends { chunk: unknown } ? `on${Pascal<K & string>}Chunk` : never]: (
    interceptor: ChunkInterceptor<Reg[K] extends { chunk: infer C } ? C : never, Ctx>,
  ) => Unsubscribe;
};

// ============================================================================
// Runtime name derivation (the exact twins of the type-level `Pascal`)
// ============================================================================

/**
 * Resolve a command's op name (`"<surface>:command:<verb>"`) to its
 * `[onBefore…, onAfter…]` hook names (ADR 80 §5). Strips the `:command:`
 * infix to the canonical `"<who>:<what>"`, then PascalCases (splitting on `:`,
 * `/`, AND `-`). The runtime twin of the type-level `Pascal` — they MUST agree,
 * so `deriveHookNames("tool:command:dispatch")` === `["onBeforeToolDispatch",
 * "onAfterToolDispatch"]`, the names `HooksOf` mints for `"tool:dispatch"`.
 */
export function deriveHookNames(opName: string): [string, string] {
  const pascal = pascalOfOpName(opName);
  return [`onBefore${pascal}`, `onAfter${pascal}`];
}

/**
 * Resolve a streaming command's op name to its per-chunk hook name (ADR 80
 * Phase 2): `on<Pascal>Chunk`. The runtime twin of the type-level
 * `on${Pascal<K>}Chunk` {@link ChunkHooksOf} mints — they MUST agree, so
 * `deriveChunkHookName("model:command:generate_stream")` ===
 * `"onModelGenerateStreamChunk"`. `commandStream` reads THIS name to look up the
 * chunk interceptors the `hooks.on<Pascal>Chunk(...)` registrar stored.
 */
export function deriveChunkHookName(opName: string): string {
  return `on${pascalOfOpName(opName)}Chunk`;
}

/**
 * Strip the `:command:` infix to the canonical `"<who>:<what>"`, then PascalCase
 * (splitting on `:`, `/`, `-`, `_`). The shared core of {@link deriveHookNames}
 * and {@link deriveChunkHookName} — the exact runtime twin of the type-level
 * `Pascal`.
 */
function pascalOfOpName(opName: string): string {
  return opName
    .replace(":command:", ":")
    .split(/[-:/_]/)
    .map((seg) => (seg === "" ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
    .join("");
}

/**
 * Parse a hook key (`onBefore<Pascal>` / `onAfter<Pascal>` / `on<Pascal>Chunk` /
 * bare `on<Pascal>`) into its `{ kind, command }`. Recognizes `onBefore` /
 * `onAfter` (one-sided sugar), the `on<Suffix>Chunk` per-chunk interceptor
 * (ADR 80 Phase 2), and the bare `on<Suffix>` (full-middleware `on<Command>`,
 * ADR 83 amendment). Returns `undefined` for a non-hook key (defensive).
 */
export function parseHookKey(
  key: string,
): { kind: "before" | "after" | "around" | "chunk"; command: string } | undefined {
  // ORDER MATTERS: the `onBefore` / `onAfter` prefixes are tested FIRST so they
  // don't get swallowed by the bare `on<Suffix>` (around) case below; the
  // `Chunk` SUFFIX is tested before the around case so `on<Verb>Chunk` routes to
  // the sink-wrapping chunk path, not to op middleware.
  if (key.startsWith("onBefore")) return { kind: "before", command: key.slice("onBefore".length) };
  if (key.startsWith("onAfter")) return { kind: "after", command: key.slice("onAfter".length) };
  if (key.startsWith("on") && key.endsWith("Chunk") && key.length > "onChunk".length) {
    return { kind: "chunk", command: key.slice("on".length, -"Chunk".length) };
  }
  // Bare `on<Suffix>` (ADR 83 amendment) — the full-middleware `on<Command>`
  // registrar. `fn` is already an AsyncMiddleware; no before/after adaptation.
  if (key.startsWith("on")) return { kind: "around", command: key.slice("on".length) };
  return undefined;
}

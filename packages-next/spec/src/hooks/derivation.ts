/**
 * Command hook-name derivation (ADR 80) — the pure, registry-agnostic core
 * shared by BOTH sides of the wire: the server (`CommandRegistry` →
 * `CommandHooks` in `@agentick/runtime-next`) and the client (`WireMethods` →
 * typed hooks in `@agentick/client-next`). One generic, zero duplication.
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
 * PascalCase a command id, splitting on the `:` (command), `/` (wire), and `-`
 * (kebab word) delimiters — so `session:apply-executor-result` mints the clean,
 * dot-accessible `onBeforeSessionApplyExecutorResult`, not a hyphenated key.
 */
export type Pascal<S extends string> = S extends `${infer A}:${infer B}`
  ? `${Cap<A>}${Pascal<B>}`
  : S extends `${infer A}/${infer B}`
    ? `${Cap<A>}${Pascal<B>}`
    : S extends `${infer A}-${infer B}`
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
  const pascal = opName
    .replace(":command:", ":")
    .split(/[-:/]/)
    .map((seg) => (seg === "" ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
    .join("");
  return [`onBefore${pascal}`, `onAfter${pascal}`];
}

/**
 * Parse a hook key (`onBefore<Pascal>` / `onAfter<Pascal>` / bare
 * `on<Pascal>`) into its `{ kind, command }`. Recognizes `onBefore` / `onAfter`
 * (one-sided sugar) and the bare `on<Suffix>` (full-middleware `on<Command>`,
 * ADR 83 amendment). Returns `undefined` for a non-hook key (defensive).
 */
export function parseHookKey(
  key: string,
): { kind: "before" | "after" | "around"; command: string } | undefined {
  // ORDER MATTERS: the `onBefore` / `onAfter` prefixes are tested FIRST so they
  // don't get swallowed by the bare `on<Suffix>` (around) case below.
  if (key.startsWith("onBefore")) return { kind: "before", command: key.slice("onBefore".length) };
  if (key.startsWith("onAfter")) return { kind: "after", command: key.slice("onAfter".length) };
  // Bare `on<Suffix>` (ADR 83 amendment) — the full-middleware `on<Command>`
  // registrar. `fn` is already an AsyncMiddleware; no before/after adaptation.
  if (key.startsWith("on")) return { kind: "around", command: key.slice("on".length) };
  return undefined;
}

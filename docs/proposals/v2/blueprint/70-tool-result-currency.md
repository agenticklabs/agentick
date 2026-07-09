# ADR 70 — Tool result currency: string sugar + optional envelope closes the `outputSchema` / `structuredContent` seam

**Status:** PROPOSED 2026-07-09 (Fable, for Ryan — shape ratified in design). **Builds on:**
`createTool` (`ToolSpec.inputSchema` / `outputSchema`), `ToolHandlerResult` (data/tool-handler.ts),
`DispatchResult` (protocol/tool-executor.ts), the `ContentBlock` union, MCP `CallToolResult`
(`{ content, isError?, structuredContent? }`). **Fixes:** the dead `outputSchema` → `structuredContent`
seam (a schema that validates a field nothing can return).

## TL;DR

A tool handler returns a bare `ContentBlock[]`. That cannot express two channels the rest of the
stack already assumes:

1. **`structuredContent`** — `createTool` gained `outputSchema` (validates the handler's
   `structuredContent`, emits MCP `Tool.outputSchema`), but **no result type carries a
   `structuredContent` field**. The schema validates something the handler has no way to return —
   a declared-but-dead seam (the same shape `input_required` was before ADR 68 wired it).
2. **`isError`** — a *soft, model-visible domain error* ("file not found", "rate-limited") distinct
   from a thrown/rejected dispatch (hard failure). The bare array can't flag it.

**Decision:** the handler return becomes a small **message-input-style currency** —
`string | ContentBlock[] | { content: string | ContentBlock[]; structuredContent?; isError?; metadata? }`
(+ the existing `Promise` / `Effect` / `TaskHandle` wrappers) — normalized to ONE internal result
at dispatch. `structuredContent` is `outputSchema`-validated and flows to `DispatchResult` + the
MCP wire. `isError` replaces the redundant `DispatchResult.succeeded`. String is sugar for one
text block. **No plain-object→`JsonBlock` guessing** (rejected below).

## The headline motivation: `outputSchema` unlocks *composition*, not just validation

`outputSchema` (via `structuredContent`) is what lets the model treat tools as **composable
building blocks**, not one-shot prose emitters:

- **Chain tools** — feed one tool's *typed* structured output into another tool's *typed* input,
  without re-parsing prose each hop.
- **Write code that calls the tools** — a model that knows each tool's input+output shape can emit
  a program orchestrating them (the "tools as an API" / code-mode pattern), instead of a
  turn-per-call English loop.

Validation is the floor; composition is the payoff. This is why `structuredContent` is the
load-bearing part of this ADR — not `isError`.

## Decision

### 1. `ToolHandlerResult` — the currency (data/tool-handler.ts)
Accept, and normalize to one internal result:
```ts
type ToolResultInput =
  | string                                   // sugar → [{ type: "text", text }]
  | readonly ContentBlock[]                  // today's shape
  | ToolResultEnvelope;                      // the optional full form
interface ToolResultEnvelope {
  readonly content: string | readonly ContentBlock[];   // string sugar here too
  readonly structuredContent?: unknown;                 // outputSchema-validated
  readonly isError?: boolean;                            // soft/domain error; default false
  readonly metadata?: Readonly<Record<string, unknown>>;
}
// ToolHandlerResult = ToolResultInput | Promise<…> | Effect<…, never> | TaskHandle<…> | Promise/Effect<TaskHandle>
```
The three top-level shapes are **discriminable** (string / array / object-with-`content`), so TS
inference stays sharp — a mistyped return is a *type error*, not a silent reinterpretation.

### 2. `structuredContent` — the closed seam
- The handler returns it via the envelope. If the tool declares `outputSchema`, the executor
  **validates `structuredContent` against it** before returning (Standard-Schema, same acceptance
  as `inputSchema`); a validation failure is a typed dispatch error.
- It is DISTINCT from `content`: `content` is model/human-readable display; `structuredContent` is
  the typed machine result. They may be identical or differ (a prose summary + a typed object).
- Flows to `DispatchResult.structuredContent` and, on the MCP wire, to
  `CallToolResult.structuredContent` (config.ts inline mapping ~L705).

### 3. `isError` replaces `succeeded` (breaking, sanctioned)
`DispatchResult.succeeded` is currently set by executors (a BYO executor can resolve
`{ succeeded: false }` without throwing — define-tool-executor). It is **redundant with `isError`**:
MCP already collapses "couldn't run" and "ran-with-error" into a single `isError:true` from the
model's view; the couldn't-run vs ran-with-error nuance lives in the error *content/reason*, not a
second boolean. So:
- **Drop `DispatchResult.succeeded`; add `DispatchResult.isError` + `structuredContent`.**
- The handler sets `isError` via the envelope; the executor may also set it (provider-side
  failure). Default `false`.
- **Throw / reject stays the HARD-failure path** (dispatch didn't complete) — unchanged.
  `isError:true` is the SOFT path (dispatch completed, result is a domain error the model reasons
  about / retries).
- Migrate `define-tool-executor` + its tests + any `succeeded` reader.

### 4. Normalization — one internal result at dispatch
`string → [{type:"text", text}]`; `ContentBlock[] → { content }`; envelope → as-is (its `content`
string-sugar normalized the same way). **Reuse the existing string→text-block content normalizer**
(messages/sections already accept `string | ContentBlock[]` — grep `@agentick/shared` /
`@agentick/core` message-content handling first; if there is no shared util, create the canonical
one in `@agentick/shared` and have messages/sections use it too — do NOT hand-roll a second).

## Rejected

- **Plain-object → `JsonBlock[]` auto-conversion.** Tempting DX (`return { temp: 72 }`), but (a) it
  **collides with the envelope** — both are plain objects; `{ content: … }` is ambiguous — and
  (b) it **destroys compile-time safety**: `return { contnet: x }` (typo) silently becomes a
  `JsonBlock` instead of a type error. Structured data goes through `structuredContent`
  (outputSchema-validated) — typed AND safe — not a bare-object guess.
- **A mandatory envelope on every return.** Regresses the 90% ergonomic (`return "42"` /
  `return [block]`) for channels most tools don't use. The envelope is opt-in.
- **Keeping `succeeded` alongside `isError`.** Two booleans for one question ("did this tool call
  give a usable result"). MCP collapses them; we do too.
- **`structuredContent` as a `{type:"json"}` content block.** Conflates display with machine result
  and isn't `outputSchema`-validated. They're separate channels by design (MCP's split).

## MCP wire (round-trip)
- outbound: `DispatchResult.{content, structuredContent?, isError?}` →
  `CallToolResult.{content, structuredContent?, isError?}` at the inline mapping (config.ts ~L705).
  `isError` also still set by the existing throw→isError path.
- `outputSchema` already emits as MCP `Tool.outputSchema`; `structuredContent` is its runtime
  companion. Providers that don't support structured tool output: the adapter down-converts
  (a model-adapter concern, per ADR 57's currency — content down-conversion already lives there).

## Build scope
1. spec: `ToolResultEnvelope` + widen `ToolHandlerResult` (data/tool-handler.ts); `DispatchResult`
   drop `succeeded`, add `isError` + `structuredContent` (protocol/tool-executor.ts).
2. `createTool` / the executor: normalize the three shapes → one internal result; validate
   `structuredContent` against `outputSchema` when declared; reuse/create the string→text
   normalizer.
3. `define-tool-executor` + tests: migrate `succeeded` → `isError`.
4. MCP server codec: map `structuredContent` + `isError` onto `CallToolResult` (config.ts).
5. Docs: `createTool` / tool README — the return currency (string / array / envelope), the
   `structuredContent`+`outputSchema` composition story, `isError` vs throw. Examples typecheck.

## Tests
- string return → one text block; bare array unchanged (parity); envelope round-trip.
- `structuredContent` validated against `outputSchema` (pass + a validation-failure → typed error).
- `isError:true` from a handler surfaces on `DispatchResult.isError` + MCP `CallToolResult.isError`;
  throw still → hard failure (rejected dispatch), distinct from `isError`.
- a mistyped/wrong-shape return is a TS error (inference-sharpness guard — the anti-plain-object
  property).
- MCP round-trip: `structuredContent` + `isError` cross the wire.
- Full existing tool / tool-executor / mcp suites green (the `succeeded`→`isError` migration is the
  main parity surface).

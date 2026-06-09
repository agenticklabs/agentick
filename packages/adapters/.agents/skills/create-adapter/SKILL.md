---
name: create-adapter
description: Create a new v2 model adapter for agentick. Use when the user asks to add support for a new model provider (Anthropic, Mistral, Cohere, Bedrock, etc.) under the `feat/v2` branch architecture. Each adapter implements LanguageModelExecutor and passes the shared ExecutorProtocol conformance suite.
---

# Create a v2 Model Adapter

This skill produces a new `@agentick/executor-<provider>` package that
implements `LanguageModelExecutor` from `@agentick@agentick/spec-next`. Every new
adapter must pass the conformance suite AND surface every feature the
v1 adapters did — the `V1-PARITY-TRACKER.md` document is the gap
checklist you walk through to confirm parity.

**Before writing any code, read these files in this exact order.**
They contain the contract, the reference implementations, and the
parity bar.

## Required reading (in order)

1. **`docs/proposals/v2/V1-PARITY-TRACKER.md`** — the v1 → v2
   feature gap list. Every adapter MUST surface the closed items
   (G1–G7, G12, G15). The deferred items (model-catalog, embedding
   API, capability discovery via `/v1/models`) can be skipped only
   if explicitly noted in the tracker.

2. **`packages@agentick/spec-next/src/protocol@agentick/executor-next.ts`** — the
   `LanguageModelExecutor` interface. This is the contract.
   Specifically internalize:
   - `project(input)` is **pure** and deterministic
   - `execute(input)` calls the provider, returns raw output
   - `executeStream(input)` returns `ExecutorStream<T>` (an
     `AsyncIterable<AdapterDelta>` plus `.result` plus `.abort`)
   - `normalize(input)` is **deterministic** from raw output
   - `run(input)` composes the three above
   - `abort(input)` cancels in-flight executions

3. **`packages@agentick/spec-next/src/data/streaming.ts`** — the `AdapterDelta`
   union your `executeStream` produces. Every delta you emit MUST
   be a member of this union. The pattern is symmetric:
   `*-start` → `*-delta?` → `*-end` → `*` (summary). Reasoning,
   tool calls, text content, and custom blocks all follow this
   shape.

4. **`packages@agentick/executor-openai-next/src/openai-executor.ts`** — the
   reference implementation. Read it end-to-end. This is what your
   adapter should look like in structure (constructor, target,
   phases, streaming loop, accumulator, normalize).

5. **`packages@agentick/executor-ai-sdk-next/src/ai-sdk-executor.ts`** — the
   wrapper-style reference. Read this if your provider's SDK has a
   high-level abstraction layer (think Vercel AI SDK pattern).
   Most direct provider adapters (Anthropic, Cohere, Mistral)
   should follow the OpenAI pattern instead.

6. **`packages@agentick/spec-conformance-next/src@agentick/executor-next.ts`** — the suite your
   adapter must pass. Skim the test names to internalize what
   behaviors are required.

## Package scaffolding

Create `packages/executor-<provider>/`:

```
packages/executor-<provider>/
  src/
    <provider>-executor.ts    -- main adapter implementation
    <provider>-factory.ts     -- factory function exported as `<provider>()`
    index.ts                  -- public exports
    __tests__/
      <provider>-executor.spec.ts   -- provider-specific behavior
      <provider>-factory.spec.ts    -- factory wiring
      conformance.spec.ts            -- runs runExecutorConformance
      stub-<provider>-client.ts      -- test-only stub for the SDK
  package.json
  tsconfig.json
  tsconfig.build.json
  README.md
```

### `package.json`

```jsonc
{
  "name": "@agentick/executor-<provider>",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.build.json --noEmit"
  },
  "dependencies": {
    "@agentick@agentick/runtime-next": "workspace:*",
    "@agentick@agentick/spec-next": "workspace:*",
    "effect": "^3.21.2",
    "<provider-sdk-pkg>": "^<version>"
  },
  "devDependencies": {
    "@agentick@agentick/spec-conformance-next": "workspace:*"
  },
  "publishConfig": {
    "access": "public",
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js",
        "default": "./dist/index.js"
      }
    }
  }
}
```

**Note**: the provider SDK goes in `dependencies`, NOT `peerDependencies`.
Mirror the exact shape of `packages@agentick/executor-openai-next/package.json`.

Match the exact `tsconfig.json` and `tsconfig.build.json` shape of
`packages@agentick/executor-openai-next/`. No customization needed.

## Implementation contract

Your executor class extends `BaseHarness<"executor">` and
implements `LanguageModelExecutor`:

```typescript
export class <Provider>Executor
  extends BaseHarness<"executor">
  implements LanguageModelExecutor
{
  readonly family = "language-model" as const;
  readonly target: ExecutionTarget;

  private readonly client: <ProviderSdk>;
  private readonly defaultModel: string | undefined;
  private readonly streamByDefault: boolean;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: <Provider>ExecutorOptions = {},
  ) {
    super("executor", scopeId, journal, bus, inbox);
    this.client = options.client ?? new <ProviderSdk>(buildClientOptions(options));
    this.defaultModel = options.model;
    this.streamByDefault = options.stream ?? false;
    this.target = options.target ?? {
      kind: "language-model",
      provider: "<provider>",
      modelId: options.model ?? "<default-model>",
      capabilities: {
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: <true if provider supports>,
        supportsReasoning: <true if provider supports>,
        contextWindow: <model-specific>,
        maxOutputTokens: <model-specific>,
      },
    };
  }

  project(input: ProjectInput): Promise<LanguageModelInput> { ... }
  execute(input: ExecuteInput<LanguageModelInput>): Promise<unknown> { ... }
  executeStream(input: ExecuteInput<LanguageModelInput>): ExecutorStream<unknown> { ... }
  normalize(input: NormalizeInput<unknown>): Promise<LanguageModelExecutionResult> { ... }
  run(input: RunInput): Promise<ExecutorTerminal<LanguageModelExecutionResult>> { ... }
  abort(input: AbortExecutorInput): Promise<void> { ... }
}
```

Use `OpenAIExecutor` as the literal template. Copy its structure,
swap the SDK type names, replace the per-phase translation
functions with provider-specific ones.

## Translation tables (the provider-specific work)

### `to<Provider>Messages(LanguageModelMessage[]) → <SdkMessage>[]`

Converts the canonical message + content-part shape into the
provider's expected message shape. **MUST handle:**
- text parts
- image parts (URL **AND base64** — G4 in the parity tracker;
  use a helper `imageUrlFromSource(source, mimeType)` that returns
  data URLs for `Base64Source`)
- tool_use parts (assistant role)
- tool_result parts (tool role)

### `to<Provider>Tools(LanguageModelTool[]) → <SdkTool>[]`

Maps tool declarations to provider tool shape. **MUST honor**
tool-level `providerOptions.<provider>` if the adapter supports
tool-level escape hatches.

### `to<Provider>Params(input, target, defaultModel) → <SdkRequest>`

Builds the request body. Honor every sampling param the PROVIDER
supports (G1: temperature, maxOutputTokens, topP, frequencyPenalty,
presencePenalty, stopSequences, responseFormat). For params the
provider doesn't support, silently drop them (see the reasoning
caveat above for the Anthropic example). **MUST spread**
`target.providerOptions.<provider>` AFTER canonical params (G5
adopter escape hatch). Example:

```typescript
const overrides = target.providerOptions?.<provider>;
if (overrides && typeof overrides === "object") {
  Object.assign(params, overrides);
}
return params;
```

**Provider quirks to verify before writing this function:**
- Is `max_tokens` REQUIRED or optional? (Anthropic: required,
  defaults to 4096 in v1. OpenAI: optional.)
- Is there a system message form vs system content? (Anthropic:
  separate `system: string | ContentBlock[]` field. OpenAI:
  system goes in `messages[0]`.)
- Does the provider require strict user/assistant alternation?
  (Anthropic: yes, must coalesce same-role consecutive messages.
  OpenAI: no constraint.)
- Are empty content arrays allowed? (Anthropic: rejects empty
  `tool_result.content` — insert a placeholder text part. OpenAI:
  accepts empty.)

Spend 10 minutes with the v1 adapter at
`packages/adapters/<provider>/src/<provider>.ts` checking which of
these quirks apply. Don't skip — provider rejects on these will
ship as runtime errors.

### `mapChunkToAdapterDeltas(chunk, state) → AdapterDelta[]`

1:1 translation from provider stream chunk to v2 `AdapterDelta`.
State carries per-block tracking (text block opened?, tool-call
block opened by index?, reasoning block started?).

**Reasoning extraction (G3) varies by provider** — the OpenAI
adapter duck-types `delta.reasoning_content` (vLLM) and
`delta.reasoning` (LM Studio) since OpenAI-compatible servers
expose reasoning via non-standard fields. **Other providers expose
reasoning natively** and use different code paths:

- **Anthropic**: `thinking` content blocks arrive as first-class
  `content_block_*` events; treat them like text blocks but route
  to reasoning AdapterDeltas.
- **Google Gemini**: `thought` parts on the candidate; route the
  same way.
- **AI SDK passthrough**: AI SDK 5 has a `reasoning-delta` event
  type; map it directly.

The skill says "MUST handle reasoning content" — pick the right
code path for YOUR provider, don't blindly copy OpenAI's
duck-typing.

**Sampling param caveat (G1)**: providers vary on what they
support. OpenAI honors all of `topP`/`frequencyPenalty`/
`presencePenalty`. Anthropic supports `topP` + `topK` but NOT
`frequencyPenalty` / `presencePenalty` — silently drop them with
a code comment instead of failing. v1 adapters do this; v2 must
too.

### Post-stream summary emission

After the provider stream completes, emit (in order):
- `content-end` then `content` (summary) for the text block
- `tool-call-end` then `tool-call` (summary) for each tool call
- `message-end` then `message` (summary)
- **MUST surface** `cachedInputTokens` / `cacheCreationTokens`
  (G2) when the provider supports it (Anthropic
  `cache_read_input_tokens` / `cache_creation_input_tokens`,
  OpenAI `prompt_tokens_details.cached_tokens`).

### `mapFinishReason(providerReason) → LanguageModelStopReason`

Map provider's finish reason vocabulary to the framework's
`LanguageModelStopReason` enum. Inspect spec for valid values.

### `normalize(providerOutput) → LanguageModelExecutionResult`

Non-streaming path. Same content-block translation as the
streaming summary emits. Returns the canonical result.

## Picking the SDK's stream entry point

Some SDKs (Anthropic, AWS Bedrock) expose multiple streaming
surfaces: `client.foo.create({ stream: true })` returning a raw
async iterable, AND `client.foo.stream(...)` returning a wrapped
helper with extra events. **Use the `create({ stream: true })`
form** — same surface as the non-streaming path with one boolean
flag, easier to stub in tests (dispatch-by-stream-flag pattern in
the OpenAI stub), and avoids depending on SDK helper APIs that
vary between provider libraries. The helper form often adds
provider-specific event types you'd just have to unwrap anyway.

## Bus envelope mirror (G6)

Every `emit(adapterDelta)` in `executeStream` MUST also call
`this.emitDeltaLazy(streamOp, () => delta)` so observability
subscribers see the streaming deltas. Pattern (verbatim from the
OpenAI reference):

```typescript
const executionId = input.scope?.executionId ?? `exec:${ulid()}`;
const streamOp: Operation<ExecuteInput<LanguageModelInput>, unknown> = {
  opId: `executor:executeStream:${executionId}:${ulid()}`,
  surface: "executor",
  name: "executor:command:execute",
  scope: input.scope ?? { executionId },
  input,
};

const emit = (delta: AdapterDelta): void => {
  if (done) return;
  void Effect.runPromise(
    this.emitDeltaLazy(streamOp, () => delta).pipe(Effect.catchAll(() => Effect.void)),
  );
  const r = resolvers.shift();
  if (r) r({ value: delta, done: false });
  else queue.push(delta);
};
```

## ProviderOptions module augmentation (G5)

Contribute typed `providerOptions.<provider>` slot via TypeScript
declaration merging. Right after the imports in
`<provider>-executor.ts`:

```typescript
declare module "@agentick@agentick/spec-next" {
  interface ProviderOptions {
    readonly <provider>?: {
      readonly <provider-specific-knob-1>?: <type>;
      readonly <provider-specific-knob-2>?: <type>;
      readonly [key: string]: unknown;
    };
  }
}
```

Adopters get full type safety:
`target.providerOptions?.<provider>?.<knob>`.

## Custom block parsing (G7 + G12)

If the adapter wants to support `customBlocks` + `parseThinkTags`,
import `StreamTagParser` from `@agentick@agentick/executor-openai-next`. **Do
NOT re-port the parser** — it's the shared primitive. See the
OpenAI adapter's `buildTagRouter` function for the integration
pattern. The tag router translates `block-*` events into either
`reasoning-*` (for `parseThinkTags`) or `custom-block-*` deltas
(for adopter-declared `customBlocks`).

**Add `@agentick@agentick/executor-openai-next: "workspace:*"` to `dependencies`**
when you import `StreamTagParser`. The skill's package.json
template doesn't include this by default — add it if you wire
parseThinkTags / customBlocks.

## Environment variable fallbacks (G16)

Build SDK options from constructor opts with env var fallbacks:
- `<PROVIDER>_API_KEY` for the API key
- `<PROVIDER>_BASE_URL` for custom endpoints
- `<PROVIDER>_ORGANIZATION` / `<PROVIDER>_PROJECT_ID` if applicable

## Factory function

`<provider>-factory.ts` exports a function with this shape:

```typescript
export interface <Provider>FactoryOptions extends Omit<<Provider>ExecutorOptions, "model"> {}

export function <provider>(
  modelId: string,
  options: <Provider>FactoryOptions = {},
): ExecutorFactory {
  return (deps) =>
    new <Provider>Executor(deps.scopeId, deps.journal, deps.bus, deps.inbox, {
      ...options,
      model: modelId,
    });
}
```

Adopters call `<provider>("model-name", { apiKey: ... })` and get
back an `ExecutorFactory` the App harness invokes.

## Public exports — `index.ts`

```typescript
export {
  <Provider>Executor,
  type <Provider>ExecutorOptions,
} from "./<provider>-executor.js";
export { <provider>, type <Provider>FactoryOptions } from "./<provider>-factory.js";
```

## Tests

Three required test files:

### `__tests__/conformance.spec.ts` — REQUIRED

Drives the universal `runExecutorConformance` suite. **This is
the parity contract.** Factory MUST return both the executor and
the bus the executor was constructed with.

```typescript
import { describe } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick@agentick/runtime-next";
import { runExecutorConformance } from "@agentick@agentick/spec-conformance-next";

import { <Provider>Executor } from "../<provider>-executor.js";
import { Stub<Provider>Client, asClient } from "./stub-<provider>-client.js";

describe("<Provider>Executor — ExecutorProtocol conformance", () =>
  runExecutorConformance(async ({ harnessId, scripted }) => {
    const stub = new Stub<Provider>Client(/* canned responses */);
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const exec = new <Provider>Executor(harnessId, journal, bus, inbox, {
      client: asClient(stub),
      model: "<default>",
    });
    await exec.ready; // CRITICAL — BaseHarness construction is async
    return { executor: exec, bus };
  }));
```

**`await exec.ready` is non-negotiable.** `BaseHarness` finishes
substrate setup asynchronously after the constructor returns —
omitting the await produces races where the first `project()` /
`execute()` call fires before the FiberRef scope is wired. Every
existing adapter factory does this. The conformance suite WILL
catch a missing await but it'll surface as a flaky test.

**Type note**: `LanguageModelExecutor` (the protocol type) does
NOT declare `ready` — only the concrete class does via
`BaseHarness`. Conformance test files reference `exec.ready` on
the concrete class instance returned from the factory closure.
Your tests' tsconfig excludes the `__tests__` dir from build, so
the strict-mode `.ready` access works in test files without
typecheck friction. Don't try to widen the public protocol type
to expose `ready` — keep it on the implementation.

The stub MUST handle BOTH streaming and non-streaming requests
(the conformance suite exercises both paths). See
`packages@agentick/executor-openai-next/src/__tests__/stub-openai-client.ts` for
the dispatch-by-stream-flag pattern.

### `__tests__/<provider>-executor.spec.ts` — REQUIRED

Provider-specific behaviors not covered by the universal
conformance. Required test categories:

- **Non-streaming basics**: returns succeeded terminal, normalizes
  finish_reason vocabulary, threads model id through
- **Tool-use round-trip**: extracts toolCalls, emits `tool_use`
  blocks, threads `tool_result` messages back to the provider
- **Streaming**: emits one `executor:delta` envelope per content
  chunk (use a Stream subscriber to count), result matches
  non-streaming output
- **Abort**: `abort()` flips next `run()` to outcome `"canceled"`
- **Cache tokens** (G2): scripted response with provider's cache
  token shape produces `cachedInputTokens` /
  `cacheCreationTokens` on `result.usage`
- **Reasoning extraction** (G3): if the provider exposes
  reasoning (native fields or via `parseThinkTags`), assert a
  ReasoningBlock appears in the output
- **Sampling params plumbing** (G1): assert the stub received
  `topP`, `frequencyPenalty`, etc. when set on the spec config
- **providerOptions spread** (G5): assert the stub received the
  provider-specific keys when set on `target.providerOptions`
- **Journaled lifecycle**: `run` produces `requested` +
  `terminal` envelopes on the journal

### `__tests__/<provider>-factory.spec.ts` — REQUIRED

- Factory returns a function that produces a `<Provider>Executor`
- Options are merged correctly
- Model id propagates

### `__tests__/stub-<provider>-client.ts` — REQUIRED

Test-only stub of the provider SDK surface the executor uses.
**MUST handle both streaming and non-streaming requests** —
dispatch by the request's stream flag if applicable. Records every
call's params + abort signal so tests assert request shape.

Pattern: see
`packages@agentick/executor-openai-next/src/__tests__/stub-openai-client.ts`.

## Workspace registration

After scaffolding:

1. **`.changeset/config.json`**: add the package to **`fixed[0]`**
   (NOT `linked[0]` — the repo uses fixed-version groups). The
   array already contains every workspace package; append yours.
2. **`website/typedoc.json`**: add `"./packages/executor-<provider>/src/index.ts"`
   to the `entryPoints` array.
3. **`website/.vitepress/config.mts`**: add the package to the
   `PACKAGE_GROUPS` constant under the appropriate group
   (executors live in the same group as `@agentick@agentick/executor-openai-next`).
4. **`pnpm install`** to register the workspace package symlinks.

## README.md

`packages@agentick/executor-openai-next` does not yet ship its own README — you
need to write yours from scratch. Use this structure:

```markdown
# @agentick/executor-<provider>

`LanguageModelExecutor` for <Provider>. Streams + non-streaming
both supported. Conforms to the shared `runExecutorConformance`
suite.

## Quick start

\`\`\`typescript
import { createApp } from "@agentick@agentick/app-next";
import { <provider> } from "@agentick/executor-<provider>";

const app = createApp({
  executor: <provider>("<model-id>", { apiKey: process.env.<PROVIDER>_API_KEY }),
});
\`\`\`

## Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | `string` | `process.env.<PROVIDER>_API_KEY` | Provider API key |
| `baseURL` | `string` | provider default | Override endpoint |
| `model` | `string` | — | Model id |
| `stream` | `boolean` | `false` | Stream every execute |
| ... | | | |

## Capabilities

Lists which features the adapter advertises (`supportsTools`,
`supportsVision`, etc.) and which it currently doesn't.

## Provider-specific knobs

`target.providerOptions.<provider>` is typed via this package's
module augmentation. Document every field with type + default.

## Limitations

Anything the v1 adapter does that v2 doesn't (yet), or
provider-specific features deliberately gapped.
```

## Verification checklist — DO NOT MARK COMPLETE WITHOUT THIS

Before declaring the adapter done, confirm each item:

- [ ] `pnpm --filter @agentick/executor-<provider> typecheck` clean.
- [ ] `pnpm exec vitest run packages/executor-<provider>` shows
      conformance + provider-specific tests passing.
- [ ] `pnpm typecheck` (full workspace) is clean.
- [ ] Walk through `V1-PARITY-TRACKER.md` Critical + High gaps.
      Confirm each one is addressed by the new adapter or noted
      as N/A for this provider (e.g., embedding API — only
      implement if the provider supports embeddings).
- [ ] `ProviderOptions` augmentation contributes the typed
      `<provider>` slot.
- [ ] `parseThinkTags` (G7) works if applicable — verify with a
      streaming test using a `<think>...</think>` payload.
- [ ] `customBlocks` (G12) works — verify with a streaming test
      using an adopter-declared XML tag.
- [ ] `imageUrlFromSource` is implemented and Base64Source
      produces a data URL (not "[binary]").
- [ ] Streaming + non-streaming paths produce equivalent final
      results.
- [ ] Bus envelopes fire on the streaming path (test subscribes
      to `{ surface: "executor", phase: "delta" }`).
- [ ] Env var fallbacks work.
- [ ] Tool-use round-trip: model can call tools, tool results
      flow back, model can call more tools.

## When in doubt

Read the OpenAI reference implementation. It's the most complete
v2 adapter and the parity bar is calibrated against it. If the
question is "should I do X this way?", check whether
`OpenAIExecutor` does X — if so, mirror that.

For provider-specific concepts (Anthropic's `system` arrays vs
OpenAI's `system` message, Google's `parts` vs OpenAI's `content`
arrays, etc.), study the v1 adapter at
`packages/adapters/<provider>/src/<provider>.ts` BUT translate it
into v2's vocabulary — the v2 contract is `LanguageModelExecutor`,
not v1's `createAdapter` factory.

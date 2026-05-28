---
name: create-adapter
description: Create a new v2 model adapter for agentick. Use when the user asks to add support for a new model provider (Anthropic, Mistral, Cohere, Bedrock, etc.) under the `feat/v2` branch architecture. Each adapter implements LanguageModelExecutor and passes the shared ExecutorProtocol conformance suite.
---

# Create a v2 Model Adapter

This skill produces a new `@agentick/executor-<provider>` package that
implements `LanguageModelExecutor` from `@agentick/spec`. Every new
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

2. **`packages/spec/src/protocol/executor.ts`** — the
   `LanguageModelExecutor` interface. This is the contract.
   Specifically internalize:
   - `project(input)` is **pure** and deterministic
   - `execute(input)` calls the provider, returns raw output
   - `executeStream(input)` returns `ExecutorStream<T>` (an
     `AsyncIterable<AdapterDelta>` plus `.result` plus `.abort`)
   - `normalize(input)` is **deterministic** from raw output
   - `run(input)` composes the three above
   - `abort(input)` cancels in-flight executions

3. **`packages/spec/src/data/streaming.ts`** — the `AdapterDelta`
   union your `executeStream` produces. Every delta you emit MUST
   be a member of this union. The pattern is symmetric:
   `*-start` → `*-delta?` → `*-end` → `*` (summary). Reasoning,
   tool calls, text content, and custom blocks all follow this
   shape.

4. **`packages/executor-openai/src/openai-executor.ts`** — the
   reference implementation. Read it end-to-end. This is what your
   adapter should look like in structure (constructor, target,
   phases, streaming loop, accumulator, normalize).

5. **`packages/executor-ai-sdk/src/ai-sdk-executor.ts`** — the
   wrapper-style reference. Read this if your provider's SDK has a
   high-level abstraction layer (think Vercel AI SDK pattern).
   Most direct provider adapters (Anthropic, Cohere, Mistral)
   should follow the OpenAI pattern instead.

6. **`packages/spec-conformance/src/executor.ts`** — the suite your
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
    "@agentick/runtime": "workspace:*",
    "@agentick/spec": "workspace:*",
    "effect": "^3.21.2"
  },
  "peerDependencies": {
    "<provider-sdk-pkg>": "^<version>"
  },
  "devDependencies": {
    "@agentick/spec-conformance": "workspace:*",
    "<provider-sdk-pkg>": "^<version>"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

Match the exact `tsconfig.json`, `tsconfig.build.json`, and
`publishConfig.exports` shape of `packages/executor-openai/`. No
customization needed.

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

Builds the request body. **MUST include all sampling params**
(G1: temperature, maxOutputTokens, topP, frequencyPenalty,
presencePenalty, stopSequences, responseFormat). **MUST spread**
`target.providerOptions.<provider>` AFTER canonical params (G5
adopter escape hatch). Example:

```typescript
const overrides = target.providerOptions?.<provider>;
if (overrides && typeof overrides === "object") {
  Object.assign(params, overrides);
}
return params;
```

### `mapChunkToAdapterDeltas(chunk, state) → AdapterDelta[]`

1:1 translation from provider stream chunk to v2 `AdapterDelta`.
State carries per-block tracking (text block opened?, tool-call
block opened by index?, reasoning block started?). **MUST handle**
reasoning content from non-standard fields where applicable (G3 —
vLLM `reasoning_content`, LM Studio `reasoning`).

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
declare module "@agentick/spec" {
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
import `StreamTagParser` from `@agentick/executor-openai`. **Do
NOT re-port the parser** — it's the shared primitive. See the
OpenAI adapter's `buildTagRouter` function for the integration
pattern. The tag router translates `block-*` events into either
`reasoning-*` (for `parseThinkTags`) or `custom-block-*` deltas
(for adopter-declared `customBlocks`).

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
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { runExecutorConformance } from "@agentick/spec-conformance";

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
    await exec.ready;
    return { executor: exec, bus };
  }));
```

The stub MUST handle BOTH streaming and non-streaming requests
(the conformance suite exercises both paths). See
`packages/executor-openai/src/__tests__/stub-openai-client.ts` for
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
`packages/executor-openai/src/__tests__/stub-openai-client.ts`.

## Workspace registration

After scaffolding:

1. **`.changeset/config.json`**: add the package to `linked[0]`.
2. **`website/typedoc.json`**: add to `entryPoints`.
3. **`website/.vitepress/config.mts`**: add to `PACKAGE_GROUPS`.
4. **`pnpm install`** to register the workspace.

## README.md

Adopt the structure of `packages/executor-openai/README.md`:
Purpose, Quick Start, Options, Capabilities, Provider-specific
knobs, Limitations.

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

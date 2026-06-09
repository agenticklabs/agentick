# Loop Executor

## Status: Living Draft

Last updated: 2026-05-08

The loop executor is the orchestration harness that runs one agent execution.
It sits between the session harness and the lower-level React runtime, executor,
and tool executor harnesses.

It is the part of v1 currently embedded inside `Session`: the tick loop,
compilation call, model execution, tool execution, ingestion, continuation, and
result assembly.

## Role in the Architecture

```
Session harness
  -> Loop executor
       -> React runtime harness
       -> Executor harness
            -> Tool executor harness
```

This is not a process topology. It is an ownership boundary.

## Purpose

The session owns identity, timeline, persistence, and public commands.

The loop executor owns execution mechanics:

- one execution run
- tick loop
- abort/max tick policy
- compilation timing
- executor invocation
- tool dispatch handoff
- executor terminal outcome ingestion
- continuation policy
- usage/result assembly
- event sequencing for the execution

Extracting this boundary makes the loop reusable and testable without making
session own every execution detail.

## Design Principles

1. **Library core.** The loop executor should be usable as a library primitive:
   provide a React runtime, executor, tool executor, state applicator, and policy;
   get a deterministic execution loop.
2. **Executor-agnostic.** The loop executor does not care whether the execution
   uses AI SDK, native OpenAI/Anthropic/Google SDKs, local models, or another
   executor.
3. **Compiler-agnostic above protocol.** It consumes `CompiledStructure`; v2
   ships the React runtime harness, but the loop boundary should only require
   the protocol command.
4. **Runtime-owned state.** Normalized executor results and tool outputs are
   applied by runtime/session state logic, not by the React runtime.
5. **Explicit phases.** Compile, execute, dispatch tools, ingest, continue/stop
   are distinct protocol phases with observable events.
6. **No topology assumptions.** In-process and clustered sessions use the same
   loop semantics.

## Commands In

- `runExecution(input)`
- `abort(executionId)`

`runExecution` input includes:

- session state reference
- root React element or mounted React runtime reference
- execution messages/props
- max tick policy
- executor reference
- tool executor reference
- cancellation signal
- runtime state applicator

## Events Out

The loop executor emits execution-scoped events:

- `execution:start`
- `tick:start`
- `compile:start`
- `compile:terminal`
- `executor:start`
- `executor:delta`
- `executor:terminal`
- `tool-dispatch:start`
- `tool-dispatch:terminal`
- `ingest:terminal`
- `tick:terminal`
- `execution:terminal`

These should be expressed using the shared `EventEnvelope` / `ProtocolEvent`
shape from the harness principle.

## Interceptors

Interceptors may attach to:

- `execution`
- `tick`
- `compile`
- `executor`
- `tool-dispatch`
- `ingest`
- `continuation`

The loop executor owns ordering for execution-local interceptors. Global,
app-level, and session-level ordering is defined by the shared interceptor
protocol.

## Execution Algorithm

Normative skeleton:

```
1. Emit execution requested/start events
2. While continuation policy allows and max tick not exceeded:
   a. Check cancellation
   b. Emit tick requested/start events
   c. Invoke React harness compileContext -> CompiledStructure
   d. If compile requests stop, terminate tick/execution
   e. Resolve execution target
   f. Invoke executor with CompiledStructure and target
   g. Consume ExecutorTerminal from executor (consolidated terminal outcome;
      streaming deltas were observed via executor:delta events)
   h. If terminal outcome is succeeded or replaced, read terminal.result
   i. Invoke tool executor for any entries in result.toolCalls when
      runtime policy requires Agentick-managed dispatch
   j. Apply result.output and tool results to runtime session state via
      the state applicator
   k. Invoke continuation policy/interceptors using result.stopReason and
      tool dispatch outcomes
   l. Emit tick terminal event
3. Assemble execution result payload
4. Emit execution terminal event
```

For the v2 language-model executor family, the success result type is
`LanguageModelExecutionResult` (extends `ExecutionResult`) and is carried inside
`ExecutorTerminal { outcome: "succeeded" | "replaced" }`. The loop executor
reads `output`, `toolCalls`, `stopReason`, and `usage` from that result to drive
state application and continuation. It MUST NOT inspect provider-native output
directly.

The current v1 `Session` implementation already follows this shape, but
the responsibilities are fused inside one class.

## Relationship to React Runtime

The loop executor calls the React runtime for snapshots:

- `compileContext` for agent execution
- possibly `snapshot`/`restore` during hibernation workflows

It does not control React internals, hook execution, renderer implementation, or
component lifecycle beyond the React runtime protocol.

The React runtime can be used without the loop executor for:

- JSX to rendered string/content
- MCP resource rendering
- tests that inspect compiled structure
- documentation/prompt previews

## Relationship to Executor

The loop executor passes `CompiledStructure` plus an execution target to
an executor. The executor owns:

- IR -> target input projection
- target/provider request execution
- target/provider stream normalization
- target/provider output -> `ExecutionResult` normalization
- target/provider failure classification

The executor returns a consolidated `ExecutorTerminal`. For the language-model
family, successful and replaced outcomes carry `LanguageModelExecutionResult`,
with fields `output: ContentBlock[]`, `toolCalls?: ToolCall[]`, `stopReason`,
`usage?`, and `finishMetadata?`. Failed/canceled/vetoed outcomes do not carry a
result. The loop executor reads from the terminal envelope and result fields
directly; it does not inspect provider-native shapes.

The loop executor owns:

- whether to continue after executor terminal outcome
- whether and how tool calls are dispatched
- applying `terminal.result.output` and tool results to session state on
  successful/replaced outcomes

## Relationship to Tool Executor

The loop executor invokes the tool executor for any entries in
`result.toolCalls` when runtime policy says they should be executed by
Agentick.

Some executors may execute tools internally (provider-side function
execution). In that case, the executor returns the resolved tool results
inside `result.output` as `tool_result` content blocks and omits the
corresponding `result.toolCalls` entries. This keeps the loop executor's
dispatch loop honest: anything in `toolCalls` is a request for Agentick
to dispatch.

This policy is part of the executor output contract.

## Testing Strategy

Loop executor tests should mock:

- React runtime harness
- executor harness
- tool executor harness
- session state applicator
- continuation policy

Tests should cover:

- single tick success
- multi-tick tool loop
- max tick termination
- cancellation at each phase
- executor failure
- tool failure
- continuation veto/replace/defer behavior
- usage/result accumulation

## Open Questions

1. **Package home.** Does loop executor live in `@agentick/runtime-next`, or a lower
   `@agentick/loop` / `@agentick/execution` package?
2. **Public API.** Is loop executor a public advanced primitive or internal
   runtime implementation detail?
3. **Tool execution ownership.** Exact executor output marker for provider- or
   adapter-executed tools.
4. **State applicator shape.** How narrow can the interface be between loop
   executor and session state?
5. **Continuation protocol.** Is continuation just an interceptor boundary, or a
   named policy object with its own contract?

## Decision Log

- **Loop executor is distinct from session.** (2026-05-08)
- **Session owns state/identity; loop executor owns execution mechanics.**
  (2026-05-08)
- **React harness, executor, and tool executor are called by the loop
  executor.** (2026-05-08)
- **Compiler/renderer can be used without the loop executor.**
  (2026-05-08)
- **Loop executor consumes `ExecutorTerminal` from the executor.**
  (2026-05-08) Reason: clean handoff between executor (provider mechanics)
  and loop (state and continuation); no provider-native output inspection
  in the loop.
- **Loop executor is an internal harness contract, not a public package
  surface in v2.** (2026-05-08) Reason: harness shape gives testability
  and observability without locking a public API; promote later if
  external use cases emerge.

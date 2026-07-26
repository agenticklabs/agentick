# Gates

Gates are continuation conditions: named checkpoints that block an execution from completing until they're cleared. While a gate is engaged, the model can't end the loop — any attempt to stop is converted into another tick, with the gate's instructions rendered into context.

A gate composes two primitives you already know: a [knob](/docs/knobs) (the named, inspectable state) and a tick-end continuation callback (the blocking). `useGate` wires both in one call and auto-renders an `<Ephemeral>` element with instructions while active.

There are two species of gate, discriminated by their descriptor.

## Latch Gates — the model attests

A latch gate arms itself when something risky happens, then waits for the model to explicitly clear it. Use it when the condition isn't checkable in code and you want the model to attest — "you edited files, verify your work before finishing":

```tsx
import { gate, useGate, Knobs } from "agentick";

const verificationGate = gate({
  description: "Verify your changes before completing",
  instructions: `VERIFICATION PENDING: You've modified files.
Run appropriate checks (typecheck, tests, lint).
Clear the verification gate when satisfied.`,
  activateWhen: (result) =>
    result.toolCalls.some((tc) => ["write_file", "edit_file"].includes(tc.name)),
});

function CodingAgent() {
  const verification = useGate("verification", verificationGate);

  return (
    <>
      <System>You are a coding agent.</System>
      <Timeline />
      <Knobs />
      {verification.element}
    </>
  );
}
```

The flow:

```
Tick N: Model edits files
  └─ tick end: activateWhen fires → gate active

Tick N+1: Model tries to finish → gate forces another tick
  └─ model sees "VERIFICATION PENDING: ..." → runs checks
  └─ calls set_knob(name="verification", value="inactive")
  └─ gate cleared → execution completes
```

`activateWhen` is **edge-triggered**: it's checked only while the gate is inactive, and arms it once. From then on the model owns the gate through `set_knob` — it can clear it, or set it to `"deferred"` to acknowledge it without addressing it immediately. Deferred gates still block exit (they flip back to active when the model tries to stop), but don't render their instructions in the meantime.

## Verified Gates — code decides

A verified gate replaces `activateWhen` with `satisfied`: a predicate over the tick result, evaluated at the end of **every** tick. The gate engages whenever the predicate fails and clears automatically the moment it passes — including re-engaging if a later tick regresses the condition. Use it when code _can_ check the condition:

```tsx
const extractionGate = gate({
  description: "Submitted extraction must reconcile against document totals",
  instructions: `GATE: your submission failed validation.
See the submit_extraction tool result for row-level diagnostics.
Fix ONLY the failing rows and resubmit.`,
  satisfied: (result) => lastSubmission.current?.valid === true,
});
```

Three properties make verified gates the right tool for output validation:

1. **Level-triggered, both directions.** The predicate is the single source of truth. No `clear()` bookkeeping — it clears when the condition holds and re-engages if a later submission breaks it again.
2. **Unforgeable.** The backing knob is read-only to the model (`set_knob` rejects writes), so the model can't knob itself past a failing check. The predicate is the only authority.
3. **Runs after tool results.** Tick-end callbacks run after the tick's tool phase, so the predicate can inspect `result.toolResults` directly, or read state a tool handler wrote earlier in the same tick.

The predicate may be async. It must not throw — a thrown error propagates out of the tick loop and fails the execution.

### Scoping with `activateWhen` (arming)

A verified gate may also declare `activateWhen` — not as a latch trigger, but as an **arming scope**. While unarmed, the gate is dormant: `satisfied` is never evaluated and the gate never blocks, so an irrelevant obligation costs nothing. The first tick where `activateWhen` fires arms the gate — sticky for the rest of the execution — and verification takes over immediately, same tick:

```tsx
const typecheckGate = gate({
  description: "Typecheck must pass after edits",
  instructions: "GATE: the typecheck is failing. Fix the errors before finishing.",
  activateWhen: (r) => r.toolCalls.some((tc) => ["write_file", "edit_file"].includes(tc.name)),
  satisfied: () => lastTypecheck.current?.clean === true,
});
```

A pure Q&A turn completes freely; the moment an edit happens, code decides when the model is done — including re-engaging on regression, with no new edit required. Omitting `activateWhen` means "armed from tick 1": the obligation always applies (the submit-and-verify pattern below).

### The submit-and-verify pattern

The canonical use: a terminal "submit" tool paired with a verified gate. The tool runs deterministic validation and returns structured diagnostics; the gate guarantees the loop can't end without a passing submission.

```tsx
function ExtractorAgent() {
  const submission = useRef<{ data: Extraction; valid: boolean } | null>(null);

  const g = useGate("extraction-verified", {
    description: "A validated extraction must be submitted before finishing",
    instructions:
      "GATE: no valid extraction submitted yet. Call submit_extraction; " +
      "if it returned diagnostics, fix the failing rows and resubmit.",
    satisfied: () => submission.current?.valid === true,
  });

  return (
    <>
      <System>Extract line items from the attached document.</System>
      <Tool
        name="submit_extraction"
        description="Submit the extracted data for validation"
        input={extractionSchema}
        handler={async (input) => {
          const diagnostics = validate(input); // pure, deterministic
          submission.current = { data: input, valid: diagnostics.length === 0 };
          return diagnostics.length === 0
            ? [{ type: "text", text: "Accepted." }]
            : [{ type: "text", text: formatDiagnostics(diagnostics) }];
        }}
      />
      <Timeline />
      <Knobs />
      {g.element}
    </>
  );
}
```

The division of labor: the **tool result** carries the specific, actionable feedback ("rows 7 and 12 fail the quantity × price invariant by 100x"), while the **gate** guarantees a valid submission happens at all — the model can't simply skip the tool and end with prose.

Each condition of continuation can be its own gate. Several verified gates compose naturally: every engaged gate independently blocks completion, each renders only its own instructions while failing, and the loop ends when all are satisfied — a declarative checklist the model works down.

## Gates vs. budget guards

Gates force _continuation_; sometimes you need the opposite — a ceiling that forces _termination_. Explicit `stop()` requests win over gate continuations in tick-control arbitration, so a budget guard composes cleanly with any number of gates:

```tsx
useContinuation((result) => {
  if (result.tick >= 12) return { stop: true, reason: "budget-exceeded" };
});
```

Even with every gate engaged, this ends the execution. `maxTicks` on `createApp` is the hard backstop behind both.

## States

| State      | `active` | `deferred` | `engaged` | Blocks exit | Shows instructions |
| ---------- | -------- | ---------- | --------- | ----------- | ------------------ |
| `inactive` | `false`  | `false`    | `false`   | No          | No                 |
| `active`   | `true`   | `false`    | `true`    | Yes         | Yes (Ephemeral)    |
| `deferred` | `false`  | `true`     | `true`    | Yes         | No                 |

Verified gates use only `inactive`/`active`; `defer()` is a no-op on them and `clear()` is transient (the predicate re-engages at the next tick end if still unsatisfied).

## GateState reference

`useGate(name, descriptor)` returns:

| Field      | Type                  | Description                                          |
| ---------- | --------------------- | ---------------------------------------------------- |
| `active`   | `boolean`             | Gate is in `"active"` state                          |
| `deferred` | `boolean`             | Gate is in `"deferred"` state                        |
| `engaged`  | `boolean`             | `active \|\| deferred` — gate is blocking            |
| `clear()`  | `() => void`          | Release the gate (transient on verified gates)       |
| `defer()`  | `() => void`          | Postpone (latch gates only; no-op on verified gates) |
| `element`  | `JSX.Element \| null` | Ephemeral with instructions — render it in your tree |

Gates render into the knobs section (group `"gates"`), so their state is visible to the model and observable from session state — useful for telemetry like "ticks until gate cleared."

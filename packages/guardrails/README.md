# @tentickle/guardrails

Guardrail middleware for Tentickle — gate tool execution with rules and classifiers.

## Install

```bash
pnpm add @tentickle/guardrails
```

## Quick Start

```typescript
import { toolGuardrail, deny, allow } from "@tentickle/guardrails";

const guardrail = toolGuardrail({
  rules: [
    deny("file_delete", "exec_*"),
    allow("file_read", "file_write"),
  ],
});

app.use(guardrail);
```

## API

### `toolGuardrail(config)`

Create middleware that gates tool execution.

```typescript
toolGuardrail({
  rules?: GuardrailRule[],
  classify?: GuardrailClassifier,
  onDeny?: (toolName: string, reason: string) => void,
})
```

Only intercepts procedures with `operationName === "tool:run"`. Other procedures pass through.

### `deny(...patterns)`

Create a deny rule.

```typescript
deny("file_delete", "exec_*")
// { patterns: ["file_delete", "exec_*"], action: "deny" }
```

### `allow(...patterns)`

Create an allow rule.

```typescript
allow("file_read", "search")
// { patterns: ["file_read", "search"], action: "allow" }
```

## Rule Patterns

Patterns support `*` wildcard matching:

| Pattern     | Matches                          |
| ----------- | -------------------------------- |
| `"search"`  | Exact match only                 |
| `"file_*"`  | `file_read`, `file_write`, ...   |
| `"*_admin"` | `read_admin`, `write_admin`, ... |
| `"*"`       | Everything                       |

## Evaluation Order

1. **Static rules** — first-match-wins
   - `deny` → throw `GuardrailDenied`
   - `allow` → skip classifier, proceed
2. **Classifier** — only runs if no rule matched
   - Return `{ action: "deny", reason }` to block
   - Return `null` / `undefined` / `{ action: "allow" }` to proceed
3. **Default** — allow

## Classifier

```typescript
const guardrail = toolGuardrail({
  classify: async (call, envelope) => {
    if (call.input?.dangerous) {
      return { action: "deny", reason: "Dangerous input detected" };
    }
    return null; // allow
  },
});
```

## Error Handling

Denied tools throw `GuardrailDenied` (extends `GuardError`):

```typescript
import { isGuardError } from "@tentickle/shared";

try {
  await tool.run(input);
} catch (error) {
  if (isGuardError(error)) {
    // Access denied — error.code === "GUARD_DENIED"
  }
}
```

The model sees a tool error result with the denial reason, allowing it to try a different approach.

## Future

- `inputGuardrail` — gate based on user input content
- `outputGuardrail` — gate based on model output content

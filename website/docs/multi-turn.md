# Multi-turn Conversations

Sessions enable ongoing conversations where the model remembers previous turns.

## Creating a Session

```tsx
const app = createApp(() => (
  <>
    <System>You are a helpful assistant.</System>
    <SearchTool />
    <Timeline />
  </>
));

const session = await app.session({ id: "user-123" });
```

## Sending Messages

```tsx
// First turn
await session.send({
  messages: [{ role: "user", content: "My name is Ryan." }],
}).result;

// Second turn — the model remembers
const result = await session.send({
  messages: [{ role: "user", content: "What's my name?" }],
}).result;

console.log(result.response); // "Your name is Ryan."
```

Each `send()` call adds messages to the timeline and runs a new execution. The `<Timeline />` component includes all previous messages, so the model has full context.

## Session State

Component state (from `useState`, `useKnob`, etc.) persists across turns within a session:

```tsx
function Agent() {
  const [notepad, setNotepad] = useState<string[]>([]);

  return (
    <>
      <System>You are an assistant with a notepad.</System>
      <Tool
        name="add_note"
        description="Add a note"
        input={z.object({ note: z.string() })}
        handler={({ note }) => {
          setNotepad(n => [...n, note]);
          return "Noted.";
        }}
      />
      {notepad.length > 0 && (
        <Section id="notepad">
          {notepad.map(n => `- ${n}`).join("\n")}
        </Section>
      )}
      <Timeline />
    </>
  );
}
```

Notes added in turn 1 are visible in turn 2. The reconciler preserves component state across executions within the same session.

## Session Identity

Sessions have an ID that enables persistence and routing:

```tsx
// Same ID = same conversation
const session = await app.session({ id: "user-123" });
```

With a [Gateway](/docs/gateway), sessions can be managed across connections and recovered after disconnects.

## Render vs Send

- **`session.send()`** — adds messages to the timeline and runs
- **`session.render()`** — re-renders the component tree and runs (useful for state-driven re-execution)

Both are Procedures that return `ProcedurePromise<SessionExecutionHandle>`.

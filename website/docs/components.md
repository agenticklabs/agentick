# Components & JSX

Agentick components define what the model sees. They're function components — like React — that return JSX describing the agent's context.

## Built-in Components

### `<System>`

Sets the system prompt.

```tsx
<System>You are a helpful assistant specialized in {topic}.</System>
```

### `<Section>`

A named block of content visible to the model.

```tsx
<Section id="user-profile" audience="model">
  Name: {user.name}
  Plan: {user.plan}
  Preferences: {JSON.stringify(user.prefs)}
</Section>
```

The `audience` prop controls visibility: `"model"` (default), `"user"`, or `"both"`.

### `<Tool>`

Registers a tool the model can call. See [Tools](/docs/tools) for details.

```tsx
<Tool
  name="search"
  description="Search the web"
  input={z.object({ query: z.string() })}
  handler={async ({ query }) => searchWeb(query)}
/>
```

### `<Timeline>`

Renders the conversation history. Required for multi-turn conversations.

```tsx
<Timeline />
```

Supports render props for custom rendering:

```tsx
<Timeline>{(messages) => messages.map((m) => <CustomMessage msg={m} />)}</Timeline>
```

### `<Message>`

Adds a message to the timeline.

```tsx
<Message role="user">What is the weather?</Message>
```

### `<Knobs>`

Renders knob controls as a section and registers the `set_knob` tool. See [Knobs](/docs/knobs).

```tsx
<Knobs />
```

## Custom Components

Write your own components exactly like React:

```tsx
function SearchTools({ maxResults = 5 }) {
  const [lastQuery, setLastQuery] = useState("");

  return (
    <>
      <Tool
        name="web_search"
        description="Search the web"
        input={z.object({ query: z.string() })}
        handler={async ({ query }) => {
          setLastQuery(query);
          return await search(query, maxResults);
        }}
      />
      {lastQuery && <Section id="last-search">Last search: {lastQuery}</Section>}
    </>
  );
}
```

Components compose normally:

```tsx
function MyAgent() {
  return (
    <>
      <System>You are a research assistant.</System>
      <SearchTools maxResults={10} />
      <WritingTools />
      <Timeline />
    </>
  );
}
```

## How Compilation Works

The reconciler walks the fiber tree and the compiler transforms it into a model-ready structure:

```
JSX Component Tree → Fiber Tree → Compiled Structure → Model Input
```

Each tick, the reconciler diffs changes (like React's virtual DOM diff), the compiler produces a flat structure of system prompt, sections, tools, and messages, and the adapter formats it for the specific model provider.

Components that return `null` or `false` produce no output — conditional rendering works exactly as in React.

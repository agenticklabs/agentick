# Timeline

The Timeline is the conversation history. It's an intrinsic component that renders messages to the model context.

## Basic Usage

```tsx
function Agent() {
  return (
    <>
      <System>You are a helpful assistant.</System>
      <Timeline />
    </>
  );
}
```

`<Timeline />` renders all messages in the current session — user messages, assistant responses, tool calls, and tool results. Without it, the model has no conversation history.

## The Timeline IS the Conversation

Unlike frameworks where conversation history is a separate array you pass around, in agentick the Timeline is a component in the tree. This means:

- **Conditional rendering**: show/hide history based on state
- **Custom rendering**: transform messages before the model sees them
- **Multiple timelines**: different views of the same history
- **Token management**: budget-aware message truncation

## Render Props

Customize how messages render:

```tsx
<Timeline>
  {(messages) =>
    messages.map((msg) => (
      <Message role={msg.role}>{msg.content}</Message>
    ))
  }
</Timeline>
```

## Messages

Add messages to the timeline with `<Message>`:

```tsx
<Message role="user">What is the weather?</Message>
<Message role="assistant">Let me check that for you.</Message>
```

Messages are part of the component tree — they can be conditional, dynamic, and reactive.

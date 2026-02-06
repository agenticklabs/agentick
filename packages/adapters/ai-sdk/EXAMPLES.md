# AI SDK Compiler Adapter Examples

Progressive adoption: Use as little or as much of tentickle as you want.

## Level 1: Just JSX Compilation (Minimal Change)

Keep your existing `generateText`/`streamText` calls. Add JSX for dynamic context.

```typescript
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { createAiSdkCompiler } from '@tentickle/ai-sdk';

const compiler = createAiSdkCompiler();

// Define your agent in JSX
function MyAgent() {
  return (
    <>
      <System>You are a helpful assistant.</System>
      <User>What is 2+2?</User>
    </>
  );
}

// YOU control the model execution
const result = await compiler.run(
  <MyAgent />,
  [], // initial messages (optional)
  async (formatted) => {
    // formatted.messages is ai-sdk format
    // You call generateText exactly as before
    return await generateText({
      model: openai('gpt-5.2'),
      messages: formatted.messages,
      temperature: 0.7,
    });
  }
);

console.log(result.text);
```

**What this gets you:**

- JSX-based agent definition
- Dynamic compilation before each model call
- Multi-tick execution (components can request continuation)
- Fork/spawn for parallel execution
- **Zero changes to your model execution code**

## Level 2: Add Streaming

Use JSX with your existing streaming code.

```typescript
for await (const event of compiler.stream(
  <MyAgent />,
  initialMessages,
  async function* (formatted) {
    // Stream exactly as you do now
    for await (const chunk of streamText({
      model: openai('gpt-5.2'),
      messages: formatted.messages,
      tools: formatted.tools,
    }).fullStream) {
      yield chunk;
    }
  }
)) {
  if (event.type === 'chunk') {
    process.stdout.write(event.chunk.textDelta || '');
  }

  if (event.type === 'tick_end') {
    console.log(`\n[Tick ${event.result.tick} complete]`);
  }
}
```

## Level 3: Use State Management

Add React-style state to your components.

```typescript
import { Component, comState } from 'tentickle';

class SearchAgent extends Component {
  // State persists across ticks
  private searchQuery = comState('');
  private results = comState<any[]>([]);

  render(ctx, state) {
    // Extract query from conversation
    const lastMessage = state.previous?.timeline?.at(-1);
    if (lastMessage?.role === 'user') {
      this.searchQuery.value = extractQuery(lastMessage.content);
    }

    return (
      <>
        <System>You are a search assistant.</System>

        {/* Show search results if we have them */}
        {this.results.value.length > 0 && (
          <User>
            Search results for "{this.searchQuery.value}":
            {JSON.stringify(this.results.value, null, 2)}
          </User>
        )}
      </>
    );
  }
}

// Use exactly as before
const result = await compiler.run(
  <SearchAgent />,
  initialMessages,
  async (formatted) => {
    return await generateText({
      model: openai('gpt-5.2'),
      messages: formatted.messages,
    });
  }
);
```

## Level 4: Add Tools

Provide tools to the compilation.

```typescript
import { defineTool } from 'tentickle';

const searchTool = defineTool({
  name: 'web_search',
  description: 'Search the web',
  input: z.object({
    query: z.string(),
  }),
  execute: async ({ query }) => {
    const results = await fetch(`https://api.example.com/search?q=${query}`);
    return await results.json();
  },
});

const compiler = createAiSdkCompiler({
  serviceConfig: {
    tools: [searchTool],
  },
});

// Tools are automatically included in formatted.tools
const result = await compiler.run(
  <MyAgent />,
  initialMessages,
  async (formatted) => {
    return await generateText({
      model: openai('gpt-5.2'),
      messages: formatted.messages,
      tools: formatted.tools, // ai-sdk ToolSet format
    });
  }
);
```

## Level 5: Use Fork/Spawn

Run sub-agents in parallel.

```typescript
import { Fork, Spawn } from 'tentickle';

function ParallelAgent() {
  return (
    <>
      <System>Running parallel tasks...</System>

      {/* Fork inherits state from parent */}
      <Fork
        ref="task1"
        input={{ timeline: [] }}
        waitUntilComplete={true}
      >
        <System>Task 1: Analyze sentiment</System>
      </Fork>

      {/* Spawn is independent */}
      <Spawn
        ref="task2"
        input={{ timeline: [] }}
        waitUntilComplete={true}
      >
        <System>Task 2: Extract entities</System>
      </Spawn>

      {/* Access results via refs */}
      {state.refs.task1?.status === 'completed' && (
        <User>
          Sentiment: {state.refs.task1.result}
        </User>
      )}
    </>
  );
}

// Fork/spawn use the SAME execution callback you provided
const result = await compiler.run(
  <ParallelAgent />,
  initialMessages,
  async (formatted) => {
    return await generateText({
      model: openai('gpt-5.2'),
      messages: formatted.messages,
    });
  }
);
```

## Level 6: Fully Managed (Optional)

Let tentickle handle model execution entirely.

```typescript
const compiler = createAiSdkCompiler({
  model: openai('gpt-5.2'),
  manageExecution: true,
  modelOptions: {
    temperature: 0.7,
    maxOutputTokens: 1000,
  },
});

// No executor needed - we call generateText for you
const result = await compiler.run(<MyAgent />, initialMessages);

// Streaming too
for await (const event of compiler.stream(<MyAgent />, initialMessages)) {
  // ...
}
```

## Level 7: Adopt the Full Engine

When you're ready, migrate to the full tentickle Engine for maximum power.

```typescript
import { Engine } from 'tentickle';
import { createAiSdkModel } from '@tentickle/ai-sdk';

const engine = new Engine({
  model: createAiSdkModel({ model: openai('gpt-5.2') }),
  tools: [searchTool],
  lifecycleHooks: {
    onTickStart: [(tick) => console.log(`Starting tick ${tick}`)],
  },
});

// Full Engine features: persistence, recovery, metrics, etc.
const result = await engine.execute(<MyAgent />, initialMessages);
```

## AI SDK-Native Components

Use ai-sdk message format directly in JSX.

```typescript
import { Message, System, User, Assistant } from '@tentickle/ai-sdk';

function ConversationAgent() {
  return (
    <>
      <System>You are helpful.</System>

      {/* ai-sdk content format */}
      <Message
        role="user"
        content={[
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', image: 'https://example.com/image.png' },
        ]}
      />

      {/* Convenience wrappers */}
      <User>Follow-up question</User>
      <Assistant>Previous response</Assistant>
    </>
  );
}
```

## Key Principles

1. **Progressive Adoption**: Start small, add features as needed
2. **Minimal Changes**: Keep your existing code, add JSX on top
3. **User Control**: You decide how much tentickle manages
4. **Library-Native**: Accept and return ai-sdk types, not EngineInput/EngineResponse
5. **Flexibility**: Use as much or as little as you want

## Migration Path

```
You are here → Just JSX → Add state → Add tools → Fork/spawn → Full Engine
     ↓           ↓          ↓          ↓          ↓           ↓
   0% tentickle    10% tentickle   30% tentickle   50% tentickle   70% tentickle   100% tentickle
```

Start anywhere. Move at your own pace. Never break existing code.

# Agentick Example App

A full-stack example demonstrating idiomatic Agentick usage with an Express backend and React frontend.

## Features

This example showcases:

- **JSX Agent Definition** - Declarative agent composition with `<Section>`, `<Timeline>`, `<Model>` components
- **Tool Integration** - Custom tools with Zod schema validation (TodoList, Calculator)
- **Dynamic Model Selection** - Switch between OpenAI and Google models via config
- **Real-time Streaming** - SSE-based event streaming with `useStreamingText` + `useEvents`
- **Multimodal Rendering** - Content blocks for text, images, audio, video, and files
- **Tool Visibility** - Tool calls and tool results shown inline in chat
- **Channel Sync** - Bidirectional state sync between agent and UI via channels
- **REST Integration** - Direct API access alongside agent communication

## Architecture

```
┌─────────────────┐     ┌─────────────────────────────────────────┐
│   React App     │     │            Express Server               │
│                 │     │                                         │
│  ┌───────────┐  │ SSE │  ┌─────────────────────────────────┐   │
│  │ Chat UI   │◄─┼─────┼──│  createAgentickRouter          │   │
│  │           │  │     │  │  ├─ POST /sessions              │   │
│  │ useSession│  │     │  │  ├─ GET  /events (SSE)          │   │
│  │ useStream │──┼─────┼──│  └─ POST /events                │   │
│  └───────────┘  │     │  └─────────────────────────────────┘   │
│                 │     │                                         │
│  ┌───────────┐  │REST │  ┌─────────────────────────────────┐   │
│  │ Todo UI   │◄─┼─────┼──│  todoRoutes (REST)              │   │
│  │           │  │     │  │  ├─ GET  /api/tasks             │   │
│  │ useChannel│◄─┼─────┼──│  ├─ POST /api/tasks             │   │
│  └───────────┘  │     │  │  └─ Channel broadcast           │   │
│                 │     │  └─────────────────────────────────┘   │
└─────────────────┘     │                                         │
                        │  ┌─────────────────────────────────┐   │
                        │  │  TaskAssistantAgent             │   │
                        │  │  ├─ <DynamicModel />            │   │
                        │  │  ├─ <Section /> (instructions)  │   │
                        │  │  ├─ <TodoListTool />            │   │
                        │  │  ├─ <CalculatorTool />          │   │
                        │  │  └─ <Timeline /> (history)      │   │
                        │  └─────────────────────────────────┘   │
                        └─────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- OpenAI API key (or Google AI API key)

### Setup

1. **Install dependencies**

   ```bash
   cd example
   pnpm install
   ```

2. **Configure environment**

   ```bash
   cd express
   cp .env.example .env
   # Edit .env and add your API key
   ```

3. **Start the backend**

   ```bash
   pnpm dev:express
   ```

4. **In another terminal, start the frontend**

   ```bash
   pnpm dev:react
   ```

5. **Open the app**

   Navigate to http://localhost:5173

## Usage

### Chat with the Agent

The assistant can manage your todo list and perform calculations:

- "Add a task to buy groceries"
- "Mark task 1 as done"
- "What is 42 \* 17?"
- "Delete all completed tasks"

### Direct Todo Manipulation

The todo panel on the right allows direct task management:

- Click the checkbox to toggle completion
- Click × to delete
- Use the form to add tasks

Changes sync bidirectionally - tasks created via chat appear in the UI, and UI changes are visible to the agent.

## Project Structure

```
example/
├── package.json              # Workspace root
├── pnpm-workspace.yaml
│
├── express/                  # Backend
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── server.ts         # Express entry point
│       ├── setup.ts          # createApp configuration
│       ├── agents/
│       │   └── task-assistant.tsx
│       ├── tools/
│       │   ├── todo-list.tool.tsx
│       │   └── calculator.tool.ts
│       ├── services/
│       │   └── todo-list.service.ts
│       └── routes/
│           └── todos.ts
│
└── react/                    # Frontend
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── App.css
        ├── components/
        │   ├── ChatInterface.tsx
        │   └── TodoListUI.tsx
        └── hooks/
            └── useTodoList.ts
```

## Key Patterns Demonstrated

### JSX Agent Definition

```tsx
function TaskAssistantAgent() {
  return (
    <>
      <DynamicModel />
      <Section id="instructions" audience="model">
        You are a helpful task management assistant...
      </Section>
      <TodoListTool />
      <CalculatorTool />
      <Timeline>{(history) => history.map((e, i) => <Message key={i} {...e.message} />)}</Timeline>
    </>
  );
}
```

### Tool Creation

```tsx
const CalculatorTool = createTool({
  name: "calculator",
  description: "Evaluates mathematical expressions",
  input: z.object({
    expression: z.string(),
  }),
  handler: async ({ expression }) => {
    const result = eval(expression);
    return [{ type: "text", text: `${expression} = ${result}` }];
  },
});
```

### React Hooks

```tsx
function Chat() {
  const { isConnected, send, tick } = useSession();
  const { text, isStreaming } = useStreamingText();
  const { event } = useEvents({ filter: ["message", "tool_call", "tool_result"] });

  const handleSend = async (message: string) => {
    await send(message);
    await tick();
  };

  useEffect(() => {
    if (!event) return;
    // Accumulate messages, tool calls, and tool results for rendering
  }, [event]);

  return <ChatInterface />;
}
```

### Channel Sync

```tsx
function TodoPanel() {
  const [todos, setTodos] = useState([]);
  const channel = useChannel("todo-list");

  useEffect(() => {
    return channel.subscribe((payload, event) => {
      if (event.type === "state_changed") {
        setTodos(payload.todos);
      }
    });
  }, [channel]);
}
```

## Environment Variables

| Variable           | Description                 | Required                       |
| ------------------ | --------------------------- | ------------------------------ |
| `OPENAI_API_KEY`   | OpenAI API key              | Yes (if using OpenAI)          |
| `OPENAI_MODEL`     | OpenAI model name           | No (default: gpt-4o-mini)      |
| `USE_GOOGLE_MODEL` | Set to "true" to use Google | No                             |
| `GOOGLE_API_KEY`   | Google AI API key           | Yes (if using Google)          |
| `GOOGLE_MODEL`     | Google model name           | No (default: gemini-2.0-flash) |
| `PORT`             | Server port                 | No (default: 3000)             |

## API Endpoints

### Agentick Routes (via `createAgentickRouter`)

| Method | Path                | Description        |
| ------ | ------------------- | ------------------ |
| POST   | `/api/sessions`     | Create new session |
| GET    | `/api/sessions/:id` | Get session state  |
| DELETE | `/api/sessions/:id` | Delete session     |
| GET    | `/api/events`       | SSE event stream   |
| POST   | `/api/events`       | Send client event  |

### Custom REST Routes

| Method | Path                      | Description    |
| ------ | ------------------------- | -------------- |
| GET    | `/api/tasks`              | List all todos |
| POST   | `/api/tasks`              | Create todo    |
| PATCH  | `/api/tasks/:id`          | Update todo    |
| POST   | `/api/tasks/:id/complete` | Mark complete  |
| DELETE | `/api/tasks/:id`          | Delete todo    |

## License

MIT

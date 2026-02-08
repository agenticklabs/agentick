# Your First Agent

This guide walks through building a complete agent from scratch — a research assistant that can search the web, read pages, and write summaries.

## Setup

```bash
npm install agentick @agentick/openai zod
```

## Define the tools

```tsx
import { createTool } from "agentick";
import { z } from "zod";

const SearchTool = createTool({
  name: "web_search",
  description: "Search the web for information",
  input: z.object({
    query: z.string().describe("The search query"),
  }),
  handler: async ({ query }) => {
    // Replace with real search API
    return `Results for "${query}":\n1. Result one\n2. Result two`;
  },
});

const ReadPageTool = createTool({
  name: "read_page",
  description: "Read the content of a web page",
  input: z.object({
    url: z.string().url().describe("URL to read"),
  }),
  handler: async ({ url }) => {
    const response = await fetch(url);
    return await response.text();
  },
});
```

## Define the agent

```tsx
import { createApp } from "agentick";
import { OpenAIModel } from "@agentick/openai";

const app = createApp(() => {
  const [findings, setFindings] = useState<string[]>([]);

  return (
    <>
      <OpenAIModel model="gpt-4o" />
      <System>
        You are a research assistant. Search for information,
        read relevant pages, and compile your findings.
      </System>
      <SearchTool />
      <ReadPageTool />
      <Tool
        name="save_finding"
        description="Save a key finding from your research"
        input={z.object({ finding: z.string() })}
        handler={({ finding }) => {
          setFindings(f => [...f, finding]);
          return "Saved.";
        }}
      />
      {findings.length > 0 && (
        <Section id="findings" audience="model">
          ## Saved Findings
          {findings.map((f, i) => `${i + 1}. ${f}`).join("\n")}
        </Section>
      )}
      <Timeline />
    </>
  );
});
```

## Run it

```tsx
const result = await app.run({
  messages: [{
    role: "user",
    content: "Research the latest developments in WebAssembly.",
  }],
}).result;

console.log(result.response);
```

## What happened

1. `createApp` wraps your function component in an application
2. `run` creates a temporary session, sends your message, and waits for completion
3. The reconciler compiled the component tree: system prompt + tools + timeline
4. The model called `web_search`, then `read_page`, then `save_finding`
5. Each tool call was a new tick — the tree recompiled between each one
6. When the `findings` state updated, the `<Section>` appeared in the tree
7. The model saw the updated context on the next tick and used it

## Next

- [Adding Tools](/docs/adding-tools) — deeper dive into tool patterns
- [Stateful Tools](/docs/stateful-tools) — tools that render context
- [Testing](/docs/testing) — test your agents with mock adapters

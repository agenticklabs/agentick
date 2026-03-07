# Custom Blocks

Custom blocks let model adapters intercept XML-like tags in the model's text output, strip them from the visible text stream, and handle them as structured content blocks.

## Overview

When an LLM outputs text containing registered XML tags like `<interpretation>insight</interpretation>` or `<done/>`, the adapter:

1. **Strips** the tags from the text stream — downstream consumers see clean text
2. **Emits** streaming events (`custom_block_start`, `custom_block_delta`, `custom_block_end`) for real-time UI
3. **Accumulates** complete blocks as `CustomContentBlock` in `message.content`, preserving temporal position relative to text

## Quick Start

```typescript
import { createAdapter, StopReason } from "@agentick/core/model";

const model = createAdapter({
  metadata: { id: "my-model", provider: "my-provider", capabilities: [] },
  prepareInput: (input) => ({ ... }),
  mapChunk: (chunk) => ({ type: "text", delta: chunk.text }),
  execute: (input) => provider.generate(input),
  executeStream: (input) => provider.stream(input),

  // Define custom blocks
  customBlocks: {
    interpretation: {
      description: "Analytical insight.",
      instructions: "Wrap insights when synthesizing information.",
    },
    done: {
      description: "Signals task completion.",
      transform() { return []; },   // suppress from output
    },
    debugInfo: {
      tag: "debug-info",            // remap XML tag
    },
  },
});
```

## CustomBlockDefinition

Each key in `customBlocks` is a semantic name used in application code. The definition controls interception and handling:

```typescript
interface CustomBlockDefinition {
  /** XML tag to intercept. Defaults to the config key. */
  tag?: string;

  /** Short description of what this block represents. Auto-injected into system prompt. */
  description?: string;

  /** Detailed usage instructions for the model. Appended after description in system prompt. */
  instructions?: string;

  /** Transform the complete block before accumulation.
   *  - Return void → passthrough as CustomContentBlock
   *  - Return AdapterDelta[] → emit these instead ([] suppresses) */
  transform?(block: CustomBlockInput): AdapterDelta[] | void;

  /** Called when opening tag found, before content arrives. */
  onStart?(attrs: Record<string, string>): void;
}
```

### Passthrough (default)

The simplest form — tags are intercepted and accumulated as `CustomContentBlock`:

```typescript
customBlocks: {
  citation: {},
}
```

Model outputs `text<citation url="...">quote</citation>more` → content array has `[TextBlock("text"), CustomContentBlock(tag: "citation", ...), TextBlock("more")]`.

### Transform

Rewrite a custom block into different deltas:

```typescript
customBlocks: {
  interpretation: {
    transform(block) {
      // Rewrite as visible text
      return [{ type: "text", delta: `[${block.content}]` }];
    },
  },
}
```

### Suppress

Consume as a side effect and remove from output:

```typescript
customBlocks: {
  done: {
    transform(block) {
      continuationFlag.set(true);
      return []; // empty array = suppress
    },
  },
}
```

### Tag Remapping

Use a different XML tag than the config key:

```typescript
customBlocks: {
  debugInfo: {
    tag: "debug-info", // intercepts <debug-info>, key is "debugInfo"
  },
}
```

The resulting `CustomContentBlock.tag` will be `"debugInfo"` (the config key), not `"debug-info"` (the XML tag).

### Model Instructions (description + instructions)

The `description` and `instructions` fields tell the model what a block is and how to use it. The adapter automatically appends this to the system prompt — no manual prompt maintenance needed.

`description` is a short label for the tag listing. `instructions` elaborates on when and how to use it. Either field alone triggers injection; both together produce a two-line entry:

```typescript
customBlocks: {
  interpretation: {
    description: "Analytical insight derived from evidence.",
    instructions: "Use when synthesizing information or drawing conclusions. Do not use for direct observations.",
  },
  done: {
    description: "Signals task completion.",
    transform() { return []; },
  },
  citation: {
    instructions: "Quote relevant passages from sources using <citation url=\"...\">text</citation>.",
  },
}
```

The adapter collects all blocks with `description` or `instructions` and appends a single text block to the last system message:

```
You can use the following XML tags in your output:
- <interpretation>: Analytical insight derived from evidence.
  Use when synthesizing information or drawing conclusions. Do not use for direct observations.
- <done>: Signals task completion.
- <citation>: Quote relevant passages from sources using <citation url="...">text</citation>.
```

If no system message exists, one is created. Blocks with neither field are still intercepted and processed — they just don't get system prompt documentation.

## CustomContentBlock

Custom blocks are stored in the message content array as `CustomContentBlock`, preserving temporal position:

```typescript
interface CustomContentBlock {
  readonly type: "custom";
  readonly tag: string;
  readonly content: string;
  readonly attrs: Record<string, string>;
  readonly selfClosing?: boolean;
}
```

Use the `isCustomBlock` type guard:

```typescript
import { isCustomBlock } from "@agentick/shared";

for (const block of message.content) {
  if (isCustomBlock(block)) {
    switch (block.tag) {
      case "interpretation":
        renderInterpretation(block.content, block.attrs);
        break;
      case "citation":
        renderCitation(block.content, block.attrs);
        break;
    }
  }
}
```

## Streaming Events

Custom blocks emit four event types during streaming:

| Event                | Fields                                    | When                                   |
| -------------------- | ----------------------------------------- | -------------------------------------- |
| `custom_block_start` | `tag`, `attrs`                            | Opening tag detected                   |
| `custom_block_delta` | `tag`, `delta`                            | Content chunk within tag               |
| `custom_block_end`   | `tag`                                     | Closing tag detected                   |
| `custom_block`       | `tag`, `content`, `attrs`, `selfClosing?` | Complete block (triggers accumulation) |

The lifecycle events (start/delta/end) are for real-time UI updates. The complete `custom_block` event triggers accumulation into the content array.

## Delta Transforms

Custom blocks are built on a lower-level abstraction: delta transforms. These are streaming middleware that sit between `mapChunk` and `StreamAccumulator` in the adapter pipeline.

```typescript
interface DeltaTransform {
  process(delta: AdapterDelta): AdapterDelta[];
  flush(): AdapterDelta[];
}
```

### Pipeline Order

```
provider chunk → mapChunk() → AdapterDelta
  → custom blocks extraction (implicit)
    → user deltaTransform
      → StreamAccumulator → StreamEvent
```

Custom blocks always run first. User `deltaTransform` receives clean text with tags already stripped.

### Composing Transforms

```typescript
import { composeDeltaTransforms } from "@agentick/core/model";

createAdapter({
  ...options,
  // Array form — auto-composed
  deltaTransform: [markdownBufferer, contentRewriter],
});

// Or explicit composition
const pipeline = composeDeltaTransforms(transform1, transform2);
```

On flush, upstream flush output cascades through downstream `process()` before each downstream flushes its own state.

### StreamTagParser (Advanced)

For direct control over tag parsing, use `StreamTagParser` as a delta transform:

```typescript
import { StreamTagParser } from "@agentick/core/model";

const parser = new StreamTagParser({
  tags: {
    think: {
      onStart(attrs) {},
      onContent(content, attrs) {},
      onSelfClosing(attrs) {},
    },
  },
});

createAdapter({ ...options, deltaTransform: parser });
```

This is the lower-level API that the `customBlocks` config builds on internally.

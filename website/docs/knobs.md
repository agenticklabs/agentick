# Knobs & Controls

Knobs are model-visible, model-settable reactive state. One hook call creates a value, renders it as a form control the model can see, and registers a tool for the model to change it.

This is the killer feature of the reconciler approach. Without a component model, you'd need to manually:

1. Define the state variable
2. Add it to the system prompt
3. Register a tool to modify it
4. Update the prompt when it changes
5. Validate the new value

`useKnob` does all five in one line.

## Basic Usage

```tsx
function Agent() {
  const [depth, setDepth] = useKnob("search_depth", 3, {
    min: 1,
    max: 10,
    description: "Number of search results to analyze",
  });

  return (
    <>
      <System>Analyze the top {depth} results for each query.</System>
      <SearchTool maxResults={depth} />
      <Knobs />
      <Timeline />
    </>
  );
}
```

The model sees something like:

```
### Knobs
- search_depth [range]: 3 (min: 1, max: 10) — Number of search results to analyze
  Use set_knob to change.
```

And has access to a `set_knob` tool to modify it.

## Type-Safe Constraints

Constraints are inferred from the value type:

```tsx
// Number knobs: min, max, step
const [temp] = useKnob("temperature", 0.7, { min: 0, max: 2, step: 0.1 });

// String knobs: maxLength, pattern
const [format] = useKnob("output_format", "markdown", {
  maxLength: 20,
  pattern: "^(markdown|html|text)$",
});

// Boolean knobs: rendered as toggles
const [verbose] = useKnob("verbose", false, {
  description: "Include detailed explanations",
});

// Enum knobs: rendered as selects
const [style] = useKnob("writing_style", "academic", {
  options: ["academic", "casual", "technical", "creative"],
  description: "Output writing style",
});
```

## Semantic Types

Agentick infers a semantic type from the value and constraints:

| Value + Constraints     | Semantic Type |
| ----------------------- | ------------- |
| `boolean`               | `[toggle]`    |
| `number` with min+max   | `[range]`     |
| `number` without range  | `[number]`    |
| Any type with `options` | `[select]`    |
| `string`                | `[text]`      |

## Groups

Organize knobs into named groups:

```tsx
const [temp] = useKnob("temperature", 0.7, {
  group: "Model Settings",
  min: 0,
  max: 2,
});
const [maxTokens] = useKnob("max_tokens", 1000, {
  group: "Model Settings",
  min: 100,
  max: 4000,
});
const [style] = useKnob("style", "helpful", {
  group: "Behavior",
  options: ["helpful", "concise", "creative"],
});
```

Groups render with `### GroupName` headers in the model context.

## Rendering Modes

### Default

`<Knobs />` renders a section and registers the `set_knob` tool:

```tsx
<Knobs />
```

### Render Prop

Custom section rendering, tool auto-registered:

```tsx
<Knobs>
  {(groups) => (
    <Section id="my-knobs">
      {groups.map((g) => `## ${g.name}\n${g.knobs.map((k) => k.display).join("\n")}`).join("\n")}
    </Section>
  )}
</Knobs>
```

### Provider

Full control — provider registers the tool, you handle rendering:

```tsx
<Knobs.Provider>
  <MyCustomKnobUI />
</Knobs.Provider>;

// In MyCustomKnobUI:
function MyCustomKnobUI() {
  const { knobs, groups, get } = useKnobsContext();
  // Full custom rendering
}
```

## Validation

The `set_knob` tool handler validates automatically:

1. Type check (number, string, boolean)
2. Options check (if `options` defined)
3. Range check (min/max for numbers)
4. Length/pattern check (for strings)
5. Custom `validate` function (if provided)

```tsx
const [priority] = useKnob("priority", 5, {
  min: 1,
  max: 10,
  validate: (v) => (v % 1 === 0 ? true : "Must be a whole number"),
});
```

## Config-Level Knobs

For declaring knobs outside components (e.g., in `createAgent` config):

```tsx
import { knob } from "agentick";

const agent = createAgent({
  knobs: {
    temperature: knob(0.7, { min: 0, max: 2 }),
    style: knob("helpful", { options: ["helpful", "concise"] }),
  },
});
```

`knob()` returns a `KnobDescriptor` — a branded object detected by `isKnob()` at runtime.

## Momentary Knobs

Momentary knobs auto-reset to their default value at the end of each execution. The model sets the knob to expand context, acts on it, and the knob resets automatically — reclaiming tokens.

```tsx
import { knob, useKnob, Knobs } from "agentick";

// Config-level
const planningWorkflow = knob.momentary(false, {
  description: "Account planning workflow",
});

// Or inline
function Agent() {
  const [showPlanning] = useKnob("planning", false, {
    description: "Account planning workflow",
    momentary: true,
  });

  return (
    <>
      <Knobs />
      {showPlanning && (
        <Section id="planning" audience="model">
          ...
        </Section>
      )}
      <Timeline />
    </>
  );
}
```

The model sees `planning [momentary toggle]: false — Account planning workflow (resets after use)`. The reset happens after the tick loop but before the snapshot is persisted, so restored sessions always start clean.

## Conditional Context (Accordion Pattern)

Like accordions in a UI — the model sees section headers and expands what it needs. Combine `useKnob` + `momentary` + conditional rendering:

### Toggle

```tsx
function Agent() {
  const [showDocs] = useKnob("show_docs", false, {
    description: "Expand the full API reference",
    momentary: true,
  });

  return (
    <>
      <System>Set show_docs when you need the full reference.</System>
      <Section id="api-ref" audience="model">
        {showDocs ? fullApiDocs : "API Reference (set show_docs to expand)"}
      </Section>
      <Knobs />
      <Timeline />
    </>
  );
}
```

Model sees the collapsed placeholder → sets the knob → reads the content → answers. After the execution, `momentary` resets the knob and the section collapses. Tokens reclaimed automatically.

### Mutual Exclusion

Only one section open at a time:

```tsx
const sections = ["api", "billing", "troubleshooting"] as const;
const content: Record<string, string> = {
  /* ... */
};

function SupportAgent() {
  const [active] = useKnob("section", "none", {
    options: ["none", ...sections],
    description: "Which documentation section to expand",
    momentary: true,
  });

  return (
    <>
      <System>Expand a section when you need it.</System>
      {sections.map((s) => (
        <Section key={s} id={s} audience="model">
          {active === s ? content[s] : `${s} (expand to read)`}
        </Section>
      ))}
      <Knobs />
      <Timeline />
    </>
  );
}
```

The model sees all headers at once, picks the one it needs. Momentary reset means every turn starts with a clean table of contents.

### Detail Levels

Progressive disclosure with a number knob:

```tsx
const [detail] = useKnob("detail_level", 1, {
  min: 1,
  max: 3,
  description: "1=headers, 2=summaries, 3=full content",
  momentary: true,
});

return (
  <Section id="context" audience="model">
    {detail >= 1 && headers}
    {detail >= 2 && summaries}
    {detail >= 3 && fullContent}
  </Section>
);
```

The pattern works with any knob type — booleans for toggles, enums for mutual exclusion, numbers for granularity. The model controls its own attention window.

# Expandable Context

Agents accumulate content over a conversation — screenshots, file contents, audio clips, documents. Each item burns tokens on every subsequent tick, even when the model doesn't need it. Expandable context collapses rich content to text summaries. The model expands what it needs to "re-see" or "re-hear" on demand, and it auto-collapses when the turn ends.

## The Problem

A coding agent that takes screenshots at each step:

```
Turn 1: screenshot (500 tokens) + response
Turn 2: screenshot (500 tokens) + turn 1 screenshot (500 tokens) + response
Turn 3: three screenshots (1500 tokens) + response
...
Turn 10: ten screenshots (5000 tokens) + response
```

By turn 10, the context window has 5000 tokens of images the model probably doesn't need to see. But it _might_ — it might need to compare the current state to a previous screenshot to check a visual regression.

## The `collapsed` Prop

The simplest way to make content collapsible. Add `collapsed` to any `<Section>`, `<Message>`, or content component (`<Text>`, `<Image>`, `<Code>`, `<Json>`, `<Audio>`, `<Video>`, `<Document>`):

```tsx
<Image source={screenshot} collapsed="Login page screenshot (1284x720)" />
```

**Collapsed** (default): the model sees `<collapsed name="img:1">Login page screenshot (1284x720)</collapsed>`.

**Expanded**: the model calls `set_knob("img:1", true)` — the full image renders into context.

**Auto-collapse**: when the execution ends, the knob resets and the content collapses back.

### `collapsed` Value Types

The `collapsed` prop accepts three value types:

```tsx
// String: use as the collapsed summary text
<Image source={src} collapsed="Login page screenshot (1284x720)" />

// true: auto-generate summary from the component type and props
<Image source={src} altText="Login page" collapsed />
// → summary: "[image: Login page]"

// ReactNode: render rich content as the collapsed summary
<Image source={src} collapsed={<Text>Login page with <strong>error state</strong></Text>} />
```

Auto-summary varies by component type:

| Component    | Auto-summary example             |
| ------------ | -------------------------------- |
| `<Text>`     | First 80 chars of text content   |
| `<Image>`    | `[image: altText]` or `[image]`  |
| `<Code>`     | `[code: typescript]` or `[code]` |
| `<Json>`     | `[json]`                         |
| `<Document>` | `[document: title]`              |
| `<Audio>`    | `[audio]`                        |
| `<Video>`    | `[video]`                        |

### Additional Props

| Prop             | Type     | Default        | Description                                       |
| ---------------- | -------- | -------------- | ------------------------------------------------- |
| `collapsedName`  | `string` | auto-generated | Explicit knob name for the expand/collapse toggle |
| `collapsedGroup` | `string` | —              | Group name for batch expansion via `set_knob`     |

### Collapsible Sections

Sections collapse their entire content, including nested children:

```tsx
<Section title="Database Schema" collapsed="23 tables, 156 columns">
  <Code language="sql">{fullSchema}</Code>
</Section>
```

Auto-summary uses the section's `title` or `id`:

```tsx
<Section title="Database Schema" collapsed>
  <Code language="sql">{fullSchema}</Code>
</Section>
// → summary: "Database Schema"
```

### Collapsible Messages

Messages collapse with role-aware summaries:

```tsx
<Message role="assistant" content={longResponse} collapsed="Explained the auth flow" />
```

Auto-summary for messages:

```tsx
<Message role="user" content={blocks} collapsed />
// → summary: "user: first 80 chars of text content..."
```

Assistant messages auto-summarize to text-only (no tool/media metadata) to avoid ICL corruption.

## Rich Collapsed Content

Collapsed summaries preserve inline formatting. The collector builds a semantic tree from inline HTML intrinsics, and the renderer formats them appropriately:

```tsx
<Section
  title="References"
  collapsed={
    <Text>
      User asked about <strong>Python</strong> and <a href="/docs">documentation</a>
    </Text>
  }
>
  {fullReferenceContent}
</Section>
```

The model sees: `<collapsed name="ref:1">User asked about **Python** and [documentation](/docs)</collapsed>` (in Markdown) or `<collapsed name="ref:1">User asked about <strong>Python</strong> and <a href="/docs">documentation</a></collapsed>` (in XML).

Supported inline elements in collapsed content: `<strong>`, `<b>`, `<em>`, `<i>`, `<inlineCode>`, `<mark>`, `<u>`, `<s>`, `<del>`, `<sub>`, `<sup>`, `<small>`, `<a>`, `<kbd>`.

Content blocks inside collapsed summaries are also preserved:

```tsx
<Section title="API Schema" collapsed>
  <Code language="json">{schemaSnippet}</Code>
  <Text>Plus 47 more endpoints</Text>
</Section>
```

The renderer converts code blocks to fenced code, JSON to fenced JSON, etc. — everything becomes text for the `<collapsed>` tag.

## The `<Expandable>` Component

`<Expandable>` is the low-level building block. It's a headless component — it manages a knob and passes `(expanded, name)` to a render function. You decide what both states look like:

```tsx
<Expandable name="login-screenshot" summary="Screenshot: login page (1284x720)">
  {(expanded, name) =>
    expanded ? (
      <Image source={loginScreenshot} />
    ) : (
      <Collapsed name={name}>Screenshot: login page (1284x720)</Collapsed>
    )
  }
</Expandable>
```

Most use cases are better served by the `collapsed` prop on built-in components. Use `<Expandable>` directly when you need custom rendering logic for either state.

### Props

| Prop        | Type                                             | Default        | Description                                    |
| ----------- | ------------------------------------------------ | -------------- | ---------------------------------------------- |
| `name`      | `string`                                         | auto-generated | Identifier for the expand/collapse knob        |
| `summary`   | `string`                                         | required       | Text shown in `set_knob` tool description      |
| `group`     | `string`                                         | —              | Group related expandables for batch operations |
| `momentary` | `boolean`                                        | `true`         | Auto-collapse after execution ends             |
| `children`  | `(expanded: boolean, name: string) => ReactNode` | —              | Render function for both states                |

### How It Works

`<Expandable>` is built on `useKnob` with `momentary: true`:

1. **Collapsed**: render function receives `(false, name)` — typically renders a `<Collapsed>` node
2. **Model expands**: calls `set_knob` — the knob flips, reconciler diffs, render function receives `(true, name)`
3. **Turn ends**: `momentary` resets the knob — render function receives `(false, name)` again

The model gets full agency over what it sees. It pays the token cost only when it decides the content is worth examining.

## Patterns

### Collapsible Screenshots

```tsx
function ScreenshotSection({ screenshots }: { screenshots: Screenshot[] }) {
  return (
    <Section title="Screenshots">
      {screenshots.map((s) => (
        <Image
          key={s.id}
          source={s.image}
          altText={s.label}
          collapsed={s.label}
          collapsedName={s.id}
          collapsedGroup="screenshots"
        />
      ))}
    </Section>
  );
}
```

The model sees a list of one-line summaries. When it needs to check a specific screenshot, it expands just that one.

### Reference Material

Collapse large documents that the model may or may not need:

```tsx
<Section title="Project Context">
  <Section title="Database Schema" collapsed="23 tables, 156 columns">
    <Code language="sql">{fullSchema}</Code>
  </Section>
  <Section title="API Specification" collapsed="89 endpoints">
    <Code language="yaml">{fullApiSpec}</Code>
  </Section>
  <Section title="Style Guide" collapsed>
    <Text>{styleGuide}</Text>
  </Section>
</Section>
```

### Progressive Detail

Nest collapsible sections for drill-down:

```tsx
<Section title="Test Results" collapsed="47 passed, 3 failed">
  <Text>3 failures in auth module:</Text>
  <Section title="login_test.ts:42" collapsed="timeout after 5000ms">
    <Code>{fullStackTrace1}</Code>
  </Section>
  <Section title="session_test.ts:18" collapsed="assertion: expected 200, got 401">
    <Code>{fullStackTrace2}</Code>
  </Section>
</Section>
```

The model first sees "47 passed, 3 failed". Expands to see failure summaries. Expands only the one it wants to investigate.

### Custom Expand/Collapse Behavior

When you need different rendering for each state, use `<Expandable>` directly:

```tsx
<Expandable name="diff-view" summary="Changed 14 files (+203/-47)">
  {(expanded, name) =>
    expanded ? (
      <Code language="diff">{fullDiff}</Code>
    ) : (
      <Collapsed name={name}>
        <Text>
          Changed <strong>14 files</strong>: +203/-47 lines
        </Text>
      </Collapsed>
    )
  }
</Expandable>
```

## Token Economics

For an agent that takes 10 screenshots per session:

| Approach              | Tokens at turn 10            |
| --------------------- | ---------------------------- |
| No collapsing         | ~5000 (all 10 images)        |
| Collapse all          | ~100 (10 one-line summaries) |
| Collapse + 1 expanded | ~600 (9 summaries + 1 image) |

The savings compound — every tick after content is produced benefits from the reduction. For long-running agents with heavy multimodal usage, this can mean the difference between fitting in context and running out.

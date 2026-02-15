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

By turn 10, the context window has 5000 tokens of images the model probably doesn't need to see. But it *might* — it might need to compare the current state to a previous screenshot to check a visual regression.

## The `<Expandable>` Component

`<Expandable>` wraps any content with a collapsed/expanded toggle that the model controls:

```tsx
<Expandable name="login-screenshot" summary="Screenshot: login page (1284x720)">
  <Image source={loginScreenshot} />
</Expandable>
```

**Collapsed** (default): the model sees `<collapsed name="login-screenshot">Screenshot: login page (1284x720)</collapsed>` — a few tokens of text.

**Expanded**: the model calls `set_knob("login-screenshot", true)` — the full image renders into context for that tick.

**Auto-collapse**: when the execution loop ends, the knob resets to `false` and the content collapses back. Next turn starts clean.

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `name` | `string` | auto-generated | Identifier for the expand/collapse knob |
| `summary` | `string` | required | Text shown when collapsed |
| `group` | `string` | — | Group related expandables for knob organization |
| `momentary` | `boolean` | `true` | Auto-collapse after execution loop |
| `children` | `ReactNode` | — | Full content rendered when expanded |

### How It Works

`<Expandable>` is built on `useKnob` with `momentary: true`:

1. **Collapsed**: renders a `<Collapsed>` node — the compiler outputs it as a text summary
2. **Model expands**: calls `set_knob` — the knob flips, reconciler diffs, children render
3. **Turn ends**: `momentary` resets the knob — content collapses back

The model gets full agency over what it sees. It pays the token cost only when it decides the content is worth examining.

## Patterns

### Collapsible Screenshots

Wrap tool results that return images:

```tsx
function ScreenshotSection({ screenshots }: { screenshots: Screenshot[] }) {
  return (
    <Section title="Screenshots">
      {screenshots.map((s) => (
        <Expandable key={s.id} name={s.id} group="screenshots" summary={s.label}>
          <Image source={s.image} alt={s.label} />
        </Expandable>
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
  <Expandable name="schema" summary="Database schema (23 tables, 156 columns)">
    {fullSchemaMarkdown}
  </Expandable>
  <Expandable name="api" summary="API specification (89 endpoints)">
    {fullApiSpec}
  </Expandable>
  <Expandable name="style" summary="Code style guide and conventions">
    {styleGuide}
  </Expandable>
</Section>
```

### Progressive Detail

Nest expandables for drill-down:

```tsx
<Expandable name="test-results" summary="Test results: 47 passed, 3 failed">
  <Paragraph>3 failures in auth module:</Paragraph>
  <Expandable name="failure-1" summary="login_test.ts:42 — timeout">
    {fullStackTrace1}
  </Expandable>
  <Expandable name="failure-2" summary="session_test.ts:18 — assertion">
    {fullStackTrace2}
  </Expandable>
</Expandable>
```

The model first sees "47 passed, 3 failed". Expands to see failure summaries. Expands only the one it wants to investigate.

## Token Economics

For an agent that takes 10 screenshots per session:

| Approach | Tokens at turn 10 |
|----------|-------------------|
| No collapsing | ~5000 (all 10 images) |
| Collapse all | ~100 (10 one-line summaries) |
| Collapse + 1 expanded | ~600 (9 summaries + 1 image) |

The savings compound — every tick after content is produced benefits from the reduction. For long-running agents with heavy multimodal usage, this can mean the difference between fitting in context and running out.

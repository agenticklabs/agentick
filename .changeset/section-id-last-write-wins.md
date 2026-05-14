---
"@agentick/core": patch
---

Section ids: switch from append-merge to last-write-wins, warn on duplicates.

`collectSection` previously merged content from multiple `<Section id="x">` instances by appending — convenient for "split a long section across components", but turning every render-time duplicate (intentional or not) into silent accumulation. Render-loop retries (fiber-compiler retrying on suspended `useData`) that partially commit before re-rendering produced N copies of the same section, all merged into one bloated output. In production this manifested as MCP resource listings duplicated 6× in the system prompt across ticks.

**New behavior:** last-write-wins per id, plus a `Logger.warn` when duplicates appear in a single collect pass. The warning surfaces both authoring mistakes and render-loop bugs immediately rather than letting them accumulate silently.

**Migration:** authors who relied on declaring the same id twice to compose content should pass children to a single `<Section>`:

```tsx
// before — relied on append-merge
<Section id="x"><A /></Section>
<Section id="x"><B /></Section>

// after
<Section id="x">
  <A />
  <B />
</Section>
```

The single existing test asserting append-merge was updated to assert last-write-wins.

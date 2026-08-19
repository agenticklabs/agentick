---
title: A hyphen makes it yours
date: 2026-08-19
editLink: false
---

# A hyphen makes it yours

_August 19, 2026_

Prompt engineering keeps reinventing one idea: wrap the important context in
a tag the model can see. `<relevant-context>`, `<current-user>`,
`<retrieved-facts>` — every serious prompt ends up growing its own little
markup vocabulary.

In agentick, your JSX **is** that vocabulary now:

```tsx
<relevant-context source="rag" limit={3}>
  <about-user name="ryan">prefers terse answers</about-user>
</relevant-context>
```

No declaration, no registration, no `<custom tag="...">` ceremony. It
typechecks, and it renders — in every formatter dialect — as exactly the
markup you wrote:

```
<relevant-context source="rag" limit="3">
  <about-user name="ryan">prefers terse answers</about-user>
</relevant-context>
```

## The rule

**Any lowercase tag containing a hyphen is yours.** We imported this rule
wholesale from the web platform's custom-elements spec, which spent a decade
validating the tradeoff: hyphenated names can never collide with a built-in
element, today or in any future version — so your tags are forward-compatible
by construction, and the framework never has to break you.

The flip side is what makes it safe: **single-word unknown tags stay
reserved.** A typo like `<mesage>` is still a compile error instead of a
silent prompt bug, and wrapper components keep composing transparently.

## Structure survives

The tag isn't cosmetic. It lowers to a structured content block that carries
the tag, its attributes, and its children as data — so the markdown, XML, and
plain-text formatters each render it faithfully, nested tags keep their
shape, and the model sees structure instead of scraped words.

One law holds underneath: **content blocks are parents, never children.** A
native block (`<Code>`, `<Image>`) lives directly on a message — the shape
every provider wire actually takes — so nesting one inside a custom tag is
unrepresentable by design, and the compiler tells you so with a diagnostic
instead of silently dropping it.

Available now in `@agentick/compiler-react` `1.0.0-next.131`.

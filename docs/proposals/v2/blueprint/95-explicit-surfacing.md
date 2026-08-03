# ADR 95 — Explicit surfacing: the framework injects nothing positional

**Status:** Proposed — 2026-08-02.
**Supersedes in part:** ADR 63 (compiler surfacing) — its "lazy default
projection" mechanism survives only for non-positional contributions.
**Driver:** a production defect in Ernesto, diagnosed by measurement on
2026-08-02. See §1.

**Touches:** `@agentick/compiler` (`collect.ts` default-projection fold,
`projection.ts` `DefaultProjection`), `@agentick/compiler-react`
(`default-projections.ts`, new surfacing components), `@agentick/resources`
(`/react`), `@agentick/mcp` (`/react` — does not exist yet).

---

## 1. Driver — what actually happened

Ernesto (Gemini) produced assistant replies opening with fragments that
appeared in neither codebase: `", profiles, agents, tasks"`,
`" (online, functions, embed), chat (online)"`. Five rounds of investigation
failed to settle whether the model emitted them or the framework spliced them,
because nothing captured the provider's own bytes.

The round-trip recorder captured all seven spans and settled it in one run:

- **The transport is clean.** Raw provider chunks → canonical deltas →
  persisted message are byte-identical. The adapter, the stream accumulator,
  and the timeline write are all faithful. Verified across two runs.
- **The model generated the fragments.** `profiles`, `agents`, `tasks`,
  `# External capabilities`, and a fabricated MCP server `prompt v0.0.1`
  appear ZERO times anywhere upstream. Invention, not transport corruption.
- **It was completing the prompt.** The final Gemini turn was
  `[functionResponse][35,250 chars grounding][149 chars grounding]`, ending
  `…capabilities: tools, resources, prompts, logging, completions` — an
  unterminated enumeration in the generation seat. The model continued it.
- **The corruption self-reinforces.** A fragment persisted in one tick
  reappears in a later tick's history as an assistant message that _starts_
  with a comma-fragment — an in-context exemplar raising the prior.

Root cause, in one line: `packages/compiler/src/collect/collect.ts:557`
appends default-projection entries AFTER the tree-order stream, "because they
have no tree position."

**Ernesto was not at fault.** Its tree deliberately orders question-last
(`<Timeline filter={trailing} />` last, with a spec pinning the rule and a
comment explaining why). The framework appended 35 KB after it.

### 1.1 A rejected fix, recorded so it is not retried

Terminating the grounding with `\n` was published (next.66), verified on the
wire 8/8, and **failed**. Continuation rate moved 2/6 (33%) → 2/7 (29%) —
unchanged. Only the FORM changed: instead of finishing a comma list inline,
the model started on the newline we supplied and continued the _document_,
inventing headings and list items. The pre-fix "newline-first" openings were
the model supplying its own terminator and continuing anyway.

**Punctuation was never the signal. Position was.** Do not revisit.

---

## 2. The rule

> **The framework may auto-contribute only what has no position. Anything
> that lands in an ordered stream must be placed by the tree.**

A contribution landing in a non-positional slot (`config.tools`,
`response_format`) raises no ordering question and cannot reach the generation
seat. A contribution landing in `context.entries` is positional, and **only
the tree knows the right position** — which is the entire premise of a
framework whose pitch is that the tree IS the context surface.

Injecting into a positional stream from outside the tree is spooky action at
a distance. It is also unfixable from userland: the adopter cannot see it,
cannot move it, and cannot suppress it.

### 2.1 What this changes

Four default projections exist. Exactly one survives:

| default         | produces          | lands in       | verdict                         |
| --------------- | ----------------- | -------------- | ------------------------------- |
| `tools`         | tool declarations | `config.tools` | **KEEP** — non-positional       |
| `timeline`      | entries           | message stream | **DROP** — `<Timeline>` exists  |
| `resources`     | entries           | message stream | **DROP** — needs `<Resources>`  |
| `mcpServerInfo` | entries           | message stream | **DROP** — needs `<McpServers>` |

**CAVEAT — `tools` surviving is a judgment call, not a law.** It is safe
_because_ `config.tools` is non-positional today. If a provider ever wants tool
descriptions inline in the prompt — or an adopter wants them rendered as prose
for a model without native tool-calling — `tools` becomes positional and this
exact defect returns through it. The rule in §2 is the invariant; `tools`
merely happens to satisfy it right now. Re-check this the moment a tool surface
starts producing entries.

`knobs` never had a default: you render `<Knobs />` or you get nothing. The
explicit model is already the majority behavior; the positional three are the
exception, and they are the ones that produced a defect.

Deleting them also deletes machinery: the ordering fold, `overriddenKeys`, the
`default:<key>` provenance tag, and the "did a component override this key"
dance in `collect.ts`. This is a net removal.

### 2.2 Warn, do not fill

> **The framework may warn about an absence; it must not fill it.**

Dropping the `timeline` default means an app that forgets `<Timeline />` loses
its conversation. That is a real footgun and the answer is a dev-mode
diagnostic, not injection. Same for "you mounted `<MCP>` but never rendered
`<McpServers>`, so the model does not know those servers exist."

Ernesto's agent already carries the comment `<Timeline /> is load-bearing, not
decorative: nothing injects history` — a sophisticated adopter holding exactly
the mental model this ADR makes true. The code was what diverged.

---

## 3. Register vs. surface

`projection.ts` already states the axis:

> Registration (`<Tool>`, `<Resource>`) feeds a source into its harness and is
> a separate axis from surfacing.

`<MCP>` is a **registration** mount — it connects to servers and feeds the
harness. There is no surfacing component, so surfacing was done for you,
positionally, invisibly. `<Tool>` has the same split and escapes the problem
only because tools land in `config.tools`.

**Register explicitly, surface explicitly.** Today only the first is possible.

---

## 4. The surfacing grammar

`<Knobs>` already documents the shape; `<Timeline>` implements it too. Every
collection-shaped surface follows it:

```
1. <X />                        default rendering
2. <X>{(items) => …}</X>        render prop
3. <X.Provider>{children}</X>   context provider (full control)
   useX()                       the data, for hand-rolling
```

Plus one ingredient neither existing implementation has, and the reason
"customize one of 20 MCP servers" is currently impossible:

> **Every default must be reachable as a component, or overriding it means
> reimplementing it.**

Partial override needs the default ITEM renderer exported:

```jsx
<McpServers>
  {(servers) =>
    servers.map((s) =>
      s.id === "knowify" ? <MyBlock server={s} /> : <McpServerContext server={s} />,
    )
  }
</McpServers>
```

Without `<McpServerContext>` exported, customizing one server means
hand-writing the other nineteen. This is the same defect as the projection-level
one, one level down: **no way to say "render the default, here."**

### 4.1 The surfaces

| surface     | registration  | surfacing                                                                                                                                                          | item component       |
| ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| timeline    | —             | `<Timeline>` ✅                                                                                                                                                    | —                    |
| knobs       | `useKnob`     | `<Knobs>` ✅                                                                                                                                                       | (groups)             |
| resources   | `<Resource>`  | `<Resources>` **build**                                                                                                                                            | `<ResourceEntry>`    |
| mcp servers | `<MCP>`       | `<McpServers>` **build**                                                                                                                                           | `<McpServerContext>` |
| skills      | `withSkills`  | **open — audit**                                                                                                                                                   |                      |
| prompts     | `withPrompts` | **open — audit**                                                                                                                                                   |                      |
| connectors  | —             | **open — audit**                                                                                                                                                   |                      |
| gates       | `useGate`     | rides `<Knobs>` (a gate's value IS a knob value, ADR 27) — likely nothing to build                                                                                 |                      |
| tasks       | `ctx.tasks`   | **NOT a projection** — in-flight work whose status changes mid-execution, surfaced on `session:channel:task-status`. Different problem; deliberately out of scope. |                      |

### 4.2 Ownership rule for overlapping catalogs

A resource reachable through an MCP server is renderable twice — once under
`<Resources>`, once inside `<McpServerContext>`. Without a rule this
duplicates catalog entries in the prompt.

**Rule: a resource is surfaced by its owner.** `<Resources>` renders
locally-registered resources; MCP-owned resources render under their server's
`<McpServerContext>`, which also renders that server's prompts. One entry, one
place, and the grouping matches how the model should reason about provenance.

---

## 5. Ordering, for the surfaces that stay auto

Not applicable after §2.1 — `tools` is the only survivor and it is
non-positional. Recorded because the question will be asked: had we kept
positional defaults, the placement would have had to be declared by the
projection (`placement: "grounding" | "conversation"`) rather than computed,
because the `timeline` default IS the conversation and cannot sit "before the
history." Making the contribution declare its own nature was the only
non-carve-out formulation. Explicit surfacing dissolves the question.

---

## 6. Why this is also the cache fix

Prefix caching matches the longest common prefix of the token sequence.

```
today:     [system][history_t  ][35KB]   → cache ends at history_t
           [system][history_t+1][35KB]      the 35KB is AFTER the divergence

explicit:  [system][35KB][history_t  ]   → cache includes the 35KB
           [system][35KB][history_t+1]      paid once per session
```

Appending after a growing history means the block is re-processed **every
tick, unconditionally**. Placed early it is part of the stable prefix: paid
once, plus once per actual change. At ~10 ticks per turn that is an order of
magnitude.

This argument stands independent of the defect. Ernesto's tree comments
already reason this way about its own grounding, which is why `UserContext` /
`ThreadContext` sit above `<Timeline>`.

**Not verified:** `prefix-stability.spec.tsx` does NOT cover default-projection
position. It pins an adjacent and valuable invariant — _the framework injects
no time-varying content into the stable prefix_ — but says nothing about this.
The claim above is reasoned, not measured. §8 makes it a test.

---

## 7. Not system-prompt by default

A resource catalog is a **fact about the world**, not a standing instruction.
That is the same distinction Ernesto used to keep `UserContext` /
`ThreadContext` out of `<System>`. Folding framework grounding into the system
message would contradict it, and would grow Ernesto's `systemInstruction` from
13,511 chars to ~48 KB, most of it a URI listing.

Explicit surfacing lets the adopter choose; the framework declines to.

---

## 8. Verification

Every claim here is a test or it does not ship.

- **No positional auto-injection.** Mount a tree with `<MCP>` and `<Resource>`
  and NO surfacing components; assert `context.entries` contains only what the
  tree wrote. This is the regression guard for the whole ADR.
- **The generation seat.** Drive a real execution through `createApp` and
  assert the final entry is the trailing user/tool content — never a
  framework contribution. Pairs with `dispatch-scope-inheritance.spec.tsx`'s
  posture: assert the invariant, not the seam.
- **Prefix stability under a growing timeline.** Two consecutive ticks; assert
  tick _t_'s full prompt is a strict PREFIX of tick _t+1_'s. This is what §6
  claims and what nothing currently tests.
- **Partial override.** Render 3 MCP servers, override one via the render prop,
  assert the other two are byte-identical to the default — proves
  `<McpServerContext>` is genuinely reusable rather than decorative.
- **Ownership.** A resource reachable via MCP appears exactly ONCE in the
  compiled entries (§4.2).
- **Warn-not-fill.** No `<Timeline>` ⇒ a diagnostic is emitted AND the entries
  contain no history.

## 9. Documentation — the load-bearing part

The adopter-facing question this ADR answers is **"how do I get something into
the model's context?"** and the answer must be findable without reading an ADR.

- `packages/compiler-react/README.md` — one section, _Getting content into
  context_, stating the rule (the tree is the whole surface; nothing is
  injected) and listing the surfacing components with their three forms.
- Per-package READMEs (`resources`, `mcp`) — the surfacing component beside
  the registration one, since finding `<MCP>` and not `<McpServers>` is exactly
  how an adopter ends up with servers the model never hears about.
- A migration note: apps relying on the three dropped defaults must render
  `<Timeline>` / `<Resources>` / `<McpServers>`. In-policy per CLAUDE.md (no
  back-compat, no deprecations) but it IS a break and must be stated.

---

## 10. Open questions

1. **skills / prompts / connectors** — do they project into entries today? If
   so they belong in §4.1 with the same treatment. Not audited.
2. **MCP server `instructions` are dropped.** A connected server's
   `InitializeResult.instructions` — the field whose entire purpose is
   steering the model — is not carried into the structural view the projection
   reads (`implementation` and `capabilities` only). `resource-surface.spec.ts`
   notes that Knowify's server instructions tell the model to read
   `knowify://me`; we render `capabilities: tools, resources, prompts` instead.
   Separate gap, surfaced by this work, worth its own fix.
3. **`defaults` is a real seam but unreachable.** `collect()` accepts
   `defaults?: readonly DefaultProjection[]` (`collect.ts:73`), but it is not
   plumbed through `CompilerHarness` or `createApp`. Adopters cannot suppress
   today — which is why Ernesto has no workaround and this ADR is the only
   path.

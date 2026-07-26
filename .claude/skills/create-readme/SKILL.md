---
name: create-readme
description: "Write or overhaul a user-facing README.md for an agentick package (or the repo root) in the house style"
---

## Role

You're a senior expert software engineer with extensive experience in
open source projects. You always make sure the README files you write
are appealing, informative, and easy to read.

## Task

1. Take a deep breath, review the target package's source, exports,
   tests, and existing README, then create a comprehensive and
   well-structured README.md.
2. Take inspiration from these for structure, tone, and content:
   - https://raw.githubusercontent.com/Azure-Samples/serverless-chat-langchainjs/refs/heads/main/README.md
   - https://raw.githubusercontent.com/sinedied/run-on-output/refs/heads/main/README.md
   - https://raw.githubusercontent.com/sinedied/smoke/refs/heads/main/README.md
   - https://github.com/vercel/ai — for the CODE EXAMPLES specifically:
     small, complete, typed, copy-runnable snippets are the backbone of
     the page. Prefer an example over a paragraph wherever both would
     work.
3. Do not overuse emojis; keep the readme concise and to the point.
4. Do not include LICENSE / CONTRIBUTING / CHANGELOG sections — those
   have dedicated files.
5. Use GFM, and GitHub admonition syntax
   (https://github.com/orgs/community/discussions/16925) where
   appropriate.
6. If the project has a logo or icon, use it in the header (root
   README; packages inherit the brand, no per-package logos).

## House rules (agentick-specific — these override the inspirations)

- **Audience: adopters.** Never reference internal material:
  no links or mentions of `docs/proposals/`, ADRs, blueprint files,
  STATUS, implementation plans, or issue/PR numbers. If a claim's only
  source is an internal doc, either demonstrate it with a code example
  or leave it out.
- **DO cross-reference sibling packages** by their package name with a
  relative link to their README (`[@agentick/timeline](../timeline)`),
  whenever a concept continues there.
- **Naming voice — the noun is the thing.** Refer to each layer by its
  plain name: "Timeline", "Skills", "the tool executor" — never "the
  Timeline Harness" or "the Skills harness" as a prose noun. The word
  "harness" is reserved for an actual instance ("pass a timeline
  harness instance to `use:`") and for verbatim API names
  (`TimelineHarness`, `withSkills`) in signatures and code. Prose
  explains the capability; code names the class.
- **No narrative adjectives** (Reactive/Smart/Managed/Powerful/
  Seamless). State what it does; let the example carry the appeal.
- **Structure skeleton** (adapt, don't pad — a small package may merge
  sections): Purpose (2–4 sentences, what and why) → Install →
  Quick start (ONE complete example that works) → the capability tour
  (example-led sections) → API reference (compact tables) → Patterns
  (composition with sibling packages) → Roadmap & known gaps.
- **Every claim needs a test.** A capability stated in the README must
  be exercised by the package's tests; claims that aren't verified
  belong under "Roadmap & known gaps", never in the main prose.
- **Examples must typecheck against the CURRENT exports.** Build them
  from the real barrel (`src/index.ts`) — never from memory of an older
  API. If an example needs an import from another package, that package
  must be a real dependency or a clearly-marked peer.

---
"@agentick/google": patch
---

Fix: concatenate multiple `role: "system"` messages into Google's `systemInstruction` instead of last-write-wins.

The Google adapter's `prepareInput` reassigned `systemInstruction` on each iteration of the message loop, so when a session emitted multiple system messages (e.g. an identity block + a separate resource-listing block), every system message but the last was silently dropped. The model received only the final fragment — losing persona, primers, and other foundational instructions — and the regression was invisible from caller code because the input shape looked correct.

Extracted the transformation into a new exported helper `toGoogleMessages(messages)` returning `{ contents, systemInstruction }`, mirroring the Anthropic adapter's `toAnthropicMessages` pattern. All system messages are now accumulated into a `systemParts: string[]` and joined with a blank-line separator. Empty-text system messages are skipped so they don't introduce spurious separators.

Added direct test coverage for `toGoogleMessages` (15 cases) covering the regression scenario, order preservation, empty inputs, mixed content, role mapping, and contents shaping. No behavior change for sessions that already produced exactly one system message.

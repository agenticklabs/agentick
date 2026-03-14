---
"@agentick/openai": patch
---

fix: guard response.data and response.error in embed function

OpenAI-compatible endpoints may return an error object in the response
body instead of throwing (e.g. when the model doesn't support embeddings).
Previously this caused a cryptic `.sort() of undefined` crash.

Now checks response.error first (with descriptive message), then guards
response.data before accessing it.

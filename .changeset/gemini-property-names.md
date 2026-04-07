---
"@agentick/google": patch
---

fix(google): strip `propertyNames` from tool schemas sent to Gemini

Gemini rejects `propertyNames` in function declaration schemas with a 400 error. Add it to the unsupported keyword list in `sanitizeSchemaForGemini`.

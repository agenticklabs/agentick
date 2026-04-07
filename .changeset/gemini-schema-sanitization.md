---
"@agentick/google": patch
---

fix(google): sanitize tool schemas for Gemini compatibility

Gemini supports a strict subset of JSON Schema in function declarations. `sanitizeSchemaForGemini` now recursively strips unsupported features (`$ref`, `additionalItems`, tuple-style `items`, `$defs`/`$definitions`) and simplifies `anyOf`/`oneOf` with `$ref` entries before passing tool definitions to the API.

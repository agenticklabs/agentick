---
"@agentick/google": patch
"@agentick/bedrock": patch
"@agentick/anthropic": patch
"@agentick/openai": patch
---

Add document (PDF) content-block support across model adapters, plus Bedrock structured output.

- **google**: `document` blocks map to Gemini `inlineData` (base64) / `fileData` (`gs://` URI), matching the existing image handling.
- **bedrock**: `document` blocks map to Converse document `bytes` (base64) / `s3Location` (`s3://` URI); `responseFormat: { type: "json_schema" }` now maps to a forced tool-use so Converse can return structured output.
- **anthropic**: `document` blocks now support `url` and Files API (`file_id`) sources in addition to `base64`.
- **openai**: `document` blocks map to Chat Completions `file` parts (base64 data URI, or `file_id`).

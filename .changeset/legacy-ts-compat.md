---
"agentick": patch
"@agentick/client": patch
"@agentick/core": patch
"@agentick/gateway": patch
"@agentick/kernel": patch
"@agentick/sandbox": patch
"@agentick/sandbox-local": patch
"@agentick/shared": patch
---

Add typesVersions fallback for legacy moduleResolution: node consumers. Relax generic prop constraint from `P extends Record<string, unknown>` to unconstrained `P` so TypeScript interfaces work as component props.

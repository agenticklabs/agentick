---
"@agentick/kernel": patch
"@agentick/shared": patch
"@agentick/core": patch
"@agentick/client": patch
"@agentick/server": patch
"@agentick/sandbox": patch
"@agentick/sandbox-docker": patch
"@agentick/sandbox-local": patch
"@agentick/connector": patch
"@agentick/connector-imessage": patch
"@agentick/connector-telegram": patch
"@agentick/guardrails": patch
"@agentick/scheduler": patch
"@agentick/secrets": patch
"@agentick/tui": patch
"agentick": patch
---

fix: add "default" export condition to publishConfig exports

Node's CJS resolver needs "default" or "require" in the exports map. Without it, require() throws ERR_PACKAGE_PATH_NOT_EXPORTED. Fixes intermittent crashes when nx's node executor loads packages via require().

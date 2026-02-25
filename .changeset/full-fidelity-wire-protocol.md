---
"@agentick/shared": patch
"@agentick/gateway": patch
---

Pass full SendInput through WebSocket/Unix RPC transport

The RPC transport was silently dropping multi-modal content by extracting
plain text from SendInput before sending over the wire. Now the full
SendInput (messages with ContentBlock arrays) passes through untouched.

- SendParams accepts `input?: SendInput` (full multi-modal) alongside
  `message?: string` (text-only convenience shorthand)
- Delete dead `attachments` field from SendParams
- Delete `extractSendMessage` and helpers from transport-utils
- Fix HistoryPayload.content type to `ContentBlock[] | string`

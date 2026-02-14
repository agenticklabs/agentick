---
"@agentick/client": minor
"@agentick/react": minor
---

Add AttachmentManager for multimodal message support. Platforms add images, PDFs, and other files before submit(), which drains them into ContentBlock[] automatically. Includes default validator (image/png, jpeg, gif, webp, pdf), default block mapper (image/\* → ImageBlock, else → DocumentBlock), and full integration with ChatSession and useChat hook.

---
"@agentick/shared": patch
---

Switch to NodeNext module resolution with explicit .js extensions on all relative imports. Fixes ESM compatibility for consumers using plain Node without a bundler. Bump target/lib to ES2023.

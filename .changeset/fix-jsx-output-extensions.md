---
"@agentick/core": patch
---

Switch root tsconfig from `jsx: "preserve"` to `jsx: "react-jsx"` so tsc emits `.js` files instead of `.jsx`. Node's module resolver doesn't look for `.jsx` extensions, causing `ERR_MODULE_NOT_FOUND` at runtime for any package with `.tsx` source files.

---
"@agentick/angular": patch
---

Switch build from `tsc` to `ngc` (Angular compiler) with partial compilation mode. Fixes JIT compilation error when consuming the library in AOT apps. Also widen `@angular/core` peer dep to include Angular 20.

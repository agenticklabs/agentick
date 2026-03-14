---
"@agentick/core": patch
---

fix: useData fetcher rejection no longer causes infinite render loop

When a useData fetcher rejected, the rejected promise stayed in
pendingFetches forever (the .then cleanup never ran). This caused the
compiler's render loop to retry indefinitely — storeHasPendingData
returned true, storeResolvePendingData rejected, and the cycle repeated.

Now the rejection handler caches the error with a sentinel value and
cleans up pendingFetches. On re-render, the cached error is re-thrown
synchronously (not as a promise), so the compiler loop exits cleanly.
When deps change, the cache invalidates and a fresh fetch is attempted.

Also changed storeResolvePendingData to use Promise.allSettled so one
failing fetch doesn't block other concurrent fetches from resolving.

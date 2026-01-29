export function mergeAbortSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 0) {
    return new AbortController().signal; // Never-aborting signal
  }

  if (signals.length === 1) {
    return signals[0];
  }

  // Create a new controller for the merged signal
  const mergedController = new AbortController();

  // Track if we've already aborted (to avoid multiple abort calls)
  let aborted = false;

  // Abort handler that aborts the merged signal
  const abortHandler = () => {
    if (!aborted) {
      aborted = true;
      mergedController.abort();
      // Clean up listeners (they'll be removed when signals abort anyway, but be explicit)
      for (const signal of signals) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  };

  // Add abort listeners to all signals
  for (const signal of signals) {
    // If any signal is already aborted, abort immediately
    if (signal.aborted) {
      abortHandler();
      return mergedController.signal;
    }
    signal.addEventListener("abort", abortHandler);
  }

  return mergedController.signal;
}

import { AbortError, isAbortError as isSharedAbortError } from "@tentickle/shared";

export { AbortError };

export function isAbortError(error: any): boolean {
  if (!error) return false;
  // Check for our AbortError class first
  if (isSharedAbortError(error)) return true;
  // Legacy checks for compatibility
  if (error.name === "AbortError") return true;
  if (error.name === "DOMException" && error.code === 20) return true; // AbortError DOMException code
  const message = String(error.message || error);
  return message.toLowerCase().includes("abort") || message.toLowerCase().includes("cancelled");
}

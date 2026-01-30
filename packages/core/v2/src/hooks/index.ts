/**
 * V2 Hooks
 *
 * Custom hooks for Tentickle components.
 */

// Context hooks
export { useCom, useTickState, COMProvider, TickStateProvider, TentickleProvider } from "./context";

// Runtime context (per-session state)
export {
  createRuntimeStore,
  useRuntimeStore,
  RuntimeProvider,
  storeHasPendingData,
  storeResolvePendingData,
  storeRunTickStartCallbacks,
  storeRunTickEndCallbacks,
  storeRunAfterCompileCallbacks,
  storeClearLifecycleCallbacks,
  storeClearDataCache,
  storeGetSerializableDataCache,
  storeSetDataCache,
  storeInvalidateData,
  type RuntimeStore,
  type CacheEntry,
  type SerializableCacheEntry,
} from "./runtime-context";

// Lifecycle hooks
export { useTickStart, useTickEnd, useAfterCompile } from "./lifecycle";

// Data hook
export { useData, useInvalidateData } from "./data";

// Signal hooks
export { useSignal, useComputed, createSignal } from "./signal";

// Types
export * from "./types";

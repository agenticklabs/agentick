import { useRuntimeStore } from "./runtime-context";

export function useResolved<T = unknown>(key: string): T | undefined {
  const store = useRuntimeStore();
  return store.resolvedData[key] as T | undefined;
}

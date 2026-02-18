import type { JobStore } from "./job-store.js";

let _store: JobStore | null = null;

export function bindSchedulerStore(store: JobStore): void {
  _store = store;
}

export function getSchedulerStore(): JobStore | null {
  return _store;
}

/**
 * `fakeCredentialsHarness()` — working in-memory harness for tests.
 *
 * Real {@link CredentialsHarness} wired to `MemoryJournal`,
 * `LocalEventBus`, `LocalInbox`, and (by default) an
 * `inMemoryCredentialsStore`. Consumer code exercises the same code
 * path the production substrate hits; only the journal/bus/inbox/store
 * are in-memory.
 *
 * Unique default id — ULID-suffixed to prevent inbox-address
 * collisions across concurrent `fakeCredentialsHarness()` calls.
 */

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ulid } from "@agentick/utils-next";

import { CredentialsHarness, type CredentialsHarnessOptions } from "../harness.js";
import { inMemoryCredentialsStore } from "../stores/in-memory.js";
import type { CredentialsStore } from "../store.js";

export interface FakeCredentialsOptions extends CredentialsHarnessOptions {
  /** Override the default in-memory store with a custom adapter (e.g. for testing the env adapter). */
  readonly store?: CredentialsStore;
  readonly harnessId?: string;
}

export interface FakeCredentialsBundle {
  readonly harness: CredentialsHarness;
  readonly store: CredentialsStore;
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  close: () => Promise<void>;
}

export function fakeCredentialsHarness(
  options: FakeCredentialsOptions = {},
): FakeCredentialsBundle {
  const { harnessId = `fake-credentials-${ulid()}`, store } = options;
  const resolvedStore = store ?? inMemoryCredentialsStore();
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new CredentialsHarness(harnessId, resolvedStore, journal, bus, inbox);
  return {
    harness,
    store: resolvedStore,
    journal,
    bus,
    inbox,
    close: () => harness.close(),
  };
}

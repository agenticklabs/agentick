/**
 * `fakeCredentialsHarness()` — a working harness for tests.
 *
 * Real {@link CredentialsHarness} wired to `MemoryJournal`, `LocalEventBus`,
 * `LocalInbox`, and — unless the caller supplies their own set — the `ephemeral`
 * in-memory provider a real deployment gets from the slot. Consumer code
 * exercises the production path; only the substrate is in-memory.
 *
 * Unique default id — ULID-suffixed to prevent inbox-address collisions between
 * concurrently-live harnesses in one test file.
 */

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { generateId } from "@agentick/utils";

import { CredentialsHarness, type CredentialsHarnessOptions } from "../harness.js";
import { inMemoryCredentialProvider } from "../providers/in-memory.js";
import type { CredentialProvider } from "../provider.js";

export interface FakeCredentialsOptions extends CredentialsHarnessOptions {
  readonly harnessId?: string;
}

export interface FakeCredentialsBundle {
  readonly harness: CredentialsHarness;
  readonly providers: readonly CredentialProvider[];
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  close: () => Promise<void>;
}

export function fakeCredentialsHarness(
  options: FakeCredentialsOptions = {},
): FakeCredentialsBundle {
  const { harnessId = `fake-credentials-${generateId()}`, providers, ...rest } = options;
  const resolved = providers ?? [inMemoryCredentialProvider()];
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const harness = new CredentialsHarness(harnessId, journal, bus, inbox, {
    ...rest,
    providers: resolved,
  });
  return {
    harness,
    providers: resolved,
    journal,
    bus,
    inbox,
    close: () => harness.close(),
  };
}

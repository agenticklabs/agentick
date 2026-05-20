/**
 * Test fixtures for the tool executor harness.
 *
 * `createTestHarness({ tools? })` wires up in-memory substrate
 * (journal / bus / inbox) plus the harness and returns a ready bundle.
 * Use it from any test that wants to dispatch against the reference
 * impl without spelling out substrate boilerplate.
 */

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ToolRegistration } from "@agentick/spec";
import { InMemoryHandlerResolver } from "../handler-resolver.js";
import { ToolExecutorHarness } from "../harness.js";
import type { ToolExecutorHarnessOptions, ToolHandler, Validator } from "../types.js";

export interface TestHarnessOptions {
  /** Pre-registered tool declarations + their handler refs. */
  readonly tools?: readonly ToolRegistration[];
  /** Per-handlerRef bindings — applied to the bundled resolver. */
  readonly handlers?: ReadonlyArray<{
    readonly handlerRef: string;
    readonly handler: ToolHandler;
    readonly validator?: Validator;
  }>;
  /** Harness-level default timeout. */
  readonly defaultTimeoutMs?: number;
  /** Scope ID; defaults to a random ULID-ish string. */
  readonly scopeId?: string;
}

export interface TestHarnessBundle {
  readonly harness: ToolExecutorHarness;
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  readonly resolver: InMemoryHandlerResolver;
}

/**
 * Build and return a ready-to-use tool executor harness. The returned
 * `harness.ready` is already awaited — callers can dispatch immediately.
 */
export async function createTestHarness(
  options: TestHarnessOptions = {},
): Promise<TestHarnessBundle> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const resolver = new InMemoryHandlerResolver();

  for (const h of options.handlers ?? []) {
    resolver.register(h.handlerRef, h.handler, h.validator);
  }

  const harnessOptions: ToolExecutorHarnessOptions = {
    handlerResolver: resolver,
    ...(options.tools ? { initialTools: options.tools } : {}),
    ...(options.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: options.defaultTimeoutMs }
      : {}),
  };

  const harness = new ToolExecutorHarness(
    options.scopeId ?? `t_${Math.random().toString(36).slice(2)}`,
    journal,
    bus,
    inbox,
    harnessOptions,
  );

  await harness.ready;
  return { harness, journal, bus, inbox, resolver };
}

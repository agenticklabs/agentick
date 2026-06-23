/**
 * Test fixtures for the tool executor harness.
 *
 * `createTestHarness({ tools? })` wires up in-memory substrate
 * (journal / bus / inbox), an `ElicitationHarness` for the
 * confirmation gate, and the tool executor — all on the same
 * substrate so bus subscriptions see envelopes from both harnesses.
 * Use it from any test that wants to dispatch against the reference
 * impl without spelling out substrate boilerplate.
 */

import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type {
  ElicitationHarnessProtocol,
  TasksHarnessProtocol,
  ToolBinding,
  ToolDeclaration,
  ToolRegistration,
} from "@agentick/spec-next";
import { ElicitationHarness } from "@agentick/elicitation-next";
import { TasksHarness } from "@agentick/tasks-next";

import { InMemoryHandlerResolver } from "../handler-resolver.js";
import { ToolExecutorHarness } from "../harness.js";
import type { ToolExecutorHarnessOptions, ToolHandler, Validator } from "../types.js";

/**
 * Build a {@link ToolRegistration} for tests with sensible defaults.
 *
 * `binding` defaults to `{ scope: "runtime" }` — provenance for
 * tests/ad-hoc registrations that aren't bound to a specific
 * gateway/app/session/execution/reconciler scope. Override when a test
 * needs to exercise precedence resolution (e.g., pass
 * `binding: { scope: "session", sessionId }` to verify a session-level
 * tool wins over a runtime one).
 */
export function fakeRegistration(input: {
  readonly declaration: ToolDeclaration;
  readonly handlerRef?: string;
  readonly useDeps?: Readonly<Record<string, unknown>>;
  readonly binding?: ToolBinding;
}): ToolRegistration {
  return {
    declaration: input.declaration,
    handlerRef: input.handlerRef ?? `h.${input.declaration.name}`,
    ...(input.useDeps !== undefined ? { useDeps: input.useDeps } : {}),
    binding: input.binding ?? { scope: "runtime" },
  };
}

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
  /** Default elicitation/confirmation wait bound. */
  readonly defaultConfirmationTimeoutMs?: number;
  /** Scope ID; defaults to a random ULID-ish string. */
  readonly scopeId?: string;
  /**
   * Inject a custom elicitation harness (e.g., a stub). When omitted,
   * a real `ElicitationHarness` is constructed on the same substrate
   * so confirmation envelopes appear on `bus` and replies route
   * through `inbox`.
   */
  readonly elicitation?: ElicitationHarnessProtocol;
  /**
   * Inject a custom tasks harness. When omitted, a real
   * `TasksHarness` is constructed on the same substrate so
   * TaskHandle-return integration tests (#156) see live status +
   * progress envelopes on the bus.
   */
  readonly tasks?: TasksHarnessProtocol;
}

export interface TestHarnessBundle {
  readonly harness: ToolExecutorHarness;
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  readonly resolver: InMemoryHandlerResolver;
  /**
   * The elicitation harness wired to the same substrate. Tests
   * use this to respond to confirmation prompts —
   * `await elicitation.respond({ correlationId, outcome, value })`.
   */
  readonly elicitation: ElicitationHarnessProtocol;
  /** The tasks harness wired to the same substrate. */
  readonly tasks: TasksHarnessProtocol;
}

/**
 * Build and return a ready-to-use tool executor harness. Both the
 * tool executor and its elicitation harness are `ready` by the time
 * this resolves — callers can dispatch immediately.
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

  const scopeId = options.scopeId ?? `t_${ulid()}`;

  let elicitation: ElicitationHarnessProtocol;
  if (options.elicitation !== undefined) {
    elicitation = options.elicitation;
  } else {
    const elicHarness = new ElicitationHarness(`${scopeId}:elicitation`, journal, bus, inbox);
    await elicHarness.ready;
    elicitation = elicHarness;
  }

  let tasks: TasksHarnessProtocol;
  if (options.tasks !== undefined) {
    tasks = options.tasks;
  } else {
    const tasksHarness = new TasksHarness(`${scopeId}:tasks`, journal, bus, inbox);
    await tasksHarness.ready;
    tasks = tasksHarness;
  }

  const harnessOptions: ToolExecutorHarnessOptions = {
    handlerResolver: resolver,
    elicitation,
    tasks,
    ...(options.tools ? { initialTools: options.tools } : {}),
    ...(options.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: options.defaultTimeoutMs }
      : {}),
    ...(options.defaultConfirmationTimeoutMs !== undefined
      ? { defaultConfirmationTimeoutMs: options.defaultConfirmationTimeoutMs }
      : {}),
  };

  const harness = new ToolExecutorHarness(scopeId, journal, bus, inbox, harnessOptions);

  await harness.ready;
  return { harness, journal, bus, inbox, resolver, elicitation, tasks };
}

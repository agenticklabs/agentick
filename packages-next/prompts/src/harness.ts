/**
 * `PromptsHarness` — durable parameterized prompt library.
 *
 * Per ADR 32, Shape 1 harness:
 *   - Audit envelopes for every register / update / remove / invoke
 *   - Snapshot/restore via `SnapshotCapable` (declarations only —
 *     `template` and `render` aren't serializable; adopter
 *     re-registers content alongside snapshot load)
 *   - Inbox-addressable for cross-actor mutations + invocation
 *   - Substrate slot pattern inherited from BaseHarness
 *
 * Renderer dispatch:
 *   - `string` content → `stringToSystemMessage` (built-in)
 *   - `readonly MessageEntry[]` content → passthrough (built-in)
 *   - Anything else → first matching `PromptRenderer` from the
 *     registered array (`opts.renderers` at construction). Framework
 *     bindings ship their own renderer + convenience extension.
 *
 * `invoke()` queues to the session timeline via `bridges.timeline.queue`
 * (same channel as explicit user input). `get()` renders without
 * queueing for external consumers (MCP server `prompts/get`, snapshot
 * tests, doc generators).
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 * @see packages-next/spec/src/protocol/prompts-harness.ts
 */

import { Effect } from "effect";
import { BaseHarness, runHarnessProtocol, ulid, type Unsubscribe } from "@agentick/runtime-next";
import type {
  EventBus,
  MessageEntry,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  Operation,
  OperationJournal,
  PromptArgument,
  PromptDeclaration,
  PromptsError,
  PromptsGetInput,
  PromptsGetResult,
  PromptsHarnessProtocol,
  PromptsInboxMessage,
  PromptsInvokeInput,
  PromptsRegisterInput,
  PromptsRemoveInput,
  PromptsSnapshotEntry,
  PromptsUpdateInput,
  StandardSchemaIssue,
  StandardSchemaV1,
  TimelineHarnessProtocol,
} from "@agentick/spec-next";
import { createKeyedNotifier, type KeyedNotifier } from "@agentick/pubsub-next";
import { omitUndefined } from "@agentick/utils-next";

import { isMessageEntryArray, stringToSystemMessage, type PromptRenderer } from "./renderer.js";

const SURFACE = "prompts" as const;
type PromptsSurface = typeof SURFACE;

export interface PromptsHarnessOptions {
  /**
   * Renderers for non-native content shapes (anything other than
   * `string` and `MessageEntry[]`). Framework bindings (e.g.
   * `@agentick/prompts-react-next`) ship their own. First-match-wins
   * on `renderer.handles(content)`.
   */
  readonly renderers?: readonly PromptRenderer[];
  /**
   * Source of the session's `bridges.timeline` for `invoke()` queue
   * injection. Injected at construction by the extension installer.
   * When absent, `invoke()` skips queueing (renders + returns the
   * messages exactly like `get()` does).
   */
  readonly timeline?: TimelineHarnessProtocol;
}

export class PromptsHarness extends BaseHarness<PromptsSurface> implements PromptsHarnessProtocol {
  private readonly prompts = new Map<string, PromptDeclaration>();
  private readonly notifier: KeyedNotifier = createKeyedNotifier();
  private readonly renderers: readonly PromptRenderer[];
  private readonly timeline?: TimelineHarnessProtocol;

  /** Cached snapshot for `list()`. Invalidated on every mutation. */
  private listCache: readonly PromptDeclaration[] | null = null;

  get id(): string {
    return this.scopeId;
  }

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: PromptsHarnessOptions = {},
  ) {
    super(SURFACE, scopeId, journal, bus, inbox);
    this.renderers = options.renderers ?? [];
    this.timeline = options.timeline;
  }

  // ─────────── Sync surface ───────────

  getDeclaration(name: string): PromptDeclaration | undefined {
    return this.prompts.get(name);
  }

  has(name: string): boolean {
    return this.prompts.has(name);
  }

  list(): readonly PromptDeclaration[] {
    if (this.listCache !== null) return this.listCache;
    const out = Array.from(this.prompts.values());
    out.sort((a, b) => a.name.localeCompare(b.name));
    this.listCache = out;
    return out;
  }

  subscribe(name: string, listener: () => void): Unsubscribe {
    return this.notifier.subscribe(name, listener);
  }

  subscribeAll(listener: () => void): Unsubscribe {
    return this.notifier.subscribeAll(listener);
  }

  // ─────────── Async surface ───────────

  register(input: PromptsRegisterInput): Promise<PromptDeclaration> {
    const op: Operation<PromptsRegisterInput, PromptDeclaration, PromptsError> = {
      opId: `prompts:register:${ulid()}`,
      surface: SURFACE,
      name: "prompts:command:register",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.applyRegister(i)));
  }

  update(input: PromptsUpdateInput): Promise<PromptDeclaration> {
    const op: Operation<PromptsUpdateInput, PromptDeclaration, PromptsError> = {
      opId: `prompts:update:${ulid()}`,
      surface: SURFACE,
      name: "prompts:command:update",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.applyUpdate(i)));
  }

  remove(input: PromptsRemoveInput): Promise<void> {
    const op: Operation<PromptsRemoveInput, void, never> = {
      opId: `prompts:remove:${ulid()}`,
      surface: SURFACE,
      name: "prompts:command:remove",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(
      this.runOperation(op, (i) =>
        Effect.sync(() => {
          this.applyRemove(i);
        }),
      ),
    );
  }

  invoke(input: PromptsInvokeInput): Promise<PromptsGetResult> {
    const op: Operation<PromptsInvokeInput, PromptsGetResult, PromptsError> = {
      opId: `prompts:invoke:${ulid()}`,
      surface: SURFACE,
      name: "prompts:command:invoke",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.applyInvoke(i)));
  }

  get(input: PromptsGetInput): Promise<PromptsGetResult> {
    const op: Operation<PromptsGetInput, PromptsGetResult, PromptsError> = {
      opId: `prompts:get:${ulid()}`,
      surface: SURFACE,
      name: "prompts:command:get",
      scope: { sessionId: this.scopeId },
      input,
    };
    return runHarnessProtocol(this.runOperation(op, (i) => this.applyGet(i)));
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): Readonly<Record<string, PromptsSnapshotEntry>> {
    const out: Record<string, PromptsSnapshotEntry> = {};
    for (const [k, decl] of this.prompts) {
      out[k] = {
        name: decl.name,
        description: decl.description,
        ...omitUndefined({ arguments: decl.arguments, metadata: decl.metadata }),
      };
    }
    return out;
  }

  importSnapshot(snapshot: Readonly<Record<string, PromptsSnapshotEntry>>): void {
    this.prompts.clear();
    for (const [k, entry] of Object.entries(snapshot)) {
      // Restored declarations carry name/description/args/metadata
      // only — `template` and `render` are non-serializable.
      // Adopters must re-register content alongside snapshot load
      // if they want invoke/get to work.
      this.prompts.set(k, {
        name: entry.name,
        description: entry.description,
        ...omitUndefined({ arguments: entry.arguments, metadata: entry.metadata }),
      });
    }
    this.listCache = null;
    this.notifier.notifyAll();
  }

  // ─────────── Inbox handler ───────────

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    const inbound = { type: msg.type, payload: msg.payload } as PromptsInboxMessage;
    switch (inbound.type) {
      case "prompts:register":
        return Effect.tryPromise({
          try: () => this.register(inbound.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "prompts:update":
        return Effect.tryPromise({
          try: () => this.update(inbound.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "prompts:remove":
        return Effect.tryPromise({
          try: () => this.remove(inbound.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      case "prompts:invoke":
        return Effect.tryPromise({
          try: () => this.invoke(inbound.payload),
          catch: (cause): MessageHandlerError => ({ _tag: "HandlerError", cause }),
        });
      default:
        return Effect.fail({
          _tag: "InvalidPayload",
          reason: `Unknown prompts inbox message type: ${msg.type}`,
        } satisfies MessageHandlerError);
    }
  }

  // ─────────── Private mutation + invoke ───────────

  private applyRegister(
    input: PromptsRegisterInput,
  ): Effect.Effect<PromptDeclaration, PromptsError, never> {
    return Effect.suspend((): Effect.Effect<PromptDeclaration, PromptsError, never> => {
      const decl = input.declaration;
      if (this.prompts.has(decl.name)) {
        return Effect.fail({ _tag: "PromptAlreadyExists", name: decl.name });
      }
      this.prompts.set(decl.name, decl);
      this.invalidateAndNotify(decl.name);
      return Effect.succeed(decl);
    });
  }

  private applyUpdate(
    input: PromptsUpdateInput,
  ): Effect.Effect<PromptDeclaration, PromptsError, never> {
    return Effect.suspend((): Effect.Effect<PromptDeclaration, PromptsError, never> => {
      const existing = this.prompts.get(input.name);
      if (!existing) {
        return Effect.fail({ _tag: "PromptNotFound", name: input.name });
      }
      const updated: PromptDeclaration = {
        name: input.name,
        description: input.declaration.description ?? existing.description,
        ...omitUndefined({
          arguments: input.declaration.arguments ?? existing.arguments,
          template: input.declaration.template ?? existing.template,
          render: input.declaration.render ?? existing.render,
          metadata: input.declaration.metadata ?? existing.metadata,
        }),
      };
      this.prompts.set(input.name, updated);
      this.invalidateAndNotify(input.name);
      return Effect.succeed(updated);
    });
  }

  private applyRemove(input: PromptsRemoveInput): void {
    if (this.prompts.delete(input.name)) {
      this.invalidateAndNotify(input.name);
    }
  }

  private applyInvoke(
    input: PromptsInvokeInput,
  ): Effect.Effect<PromptsGetResult, PromptsError, never> {
    return Effect.tryPromise({
      try: async () => {
        const result = await this.renderToMessages(input.name, input.args);
        // Queue the rendered messages onto the session timeline so
        // they drain into the durable timeline on the next send. When
        // no timeline is wired (e.g., test setup without session),
        // skip queueing — adopters use `get()` for that path.
        if (this.timeline) {
          for (const msg of result.messages) {
            await this.timeline.queue({
              role: msg.role,
              content: msg.content,
              ...omitUndefined({ metadata: msg.metadata }),
            });
          }
        }
        return result;
      },
      catch: (cause): PromptsError =>
        isPromptsError(cause) ? cause : { _tag: "PromptsBackendError", cause },
    });
  }

  private applyGet(input: PromptsGetInput): Effect.Effect<PromptsGetResult, PromptsError, never> {
    return Effect.tryPromise({
      try: () => this.renderToMessages(input.name, input.args),
      catch: (cause): PromptsError =>
        isPromptsError(cause) ? cause : { _tag: "PromptsBackendError", cause },
    });
  }

  private async renderToMessages(
    name: string,
    rawArgs: Readonly<Record<string, unknown>> | undefined,
  ): Promise<PromptsGetResult> {
    const decl = this.prompts.get(name);
    if (!decl) throw { _tag: "PromptNotFound", name } satisfies PromptsError;

    // 1. Validate args against the declared schemas.
    const args = await validateArgs(name, decl.arguments, rawArgs ?? {});

    // 2. Resolve the content — `render(args)` wins; fall back to `template`.
    let content: unknown;
    if (decl.render) {
      try {
        content = await Promise.resolve(decl.render(args));
      } catch (cause) {
        throw { _tag: "PromptRenderFailed", name, cause } satisfies PromptsError;
      }
    } else if (decl.template !== undefined) {
      content = decl.template;
    } else {
      throw { _tag: "PromptMissingContent", name } satisfies PromptsError;
    }

    // 3. Dispatch to native handler or matching renderer.
    const messages = await this.dispatchContent(name, content, args);

    return { description: decl.description, messages };
  }

  private async dispatchContent(
    name: string,
    content: unknown,
    args: Readonly<Record<string, unknown>>,
  ): Promise<readonly MessageEntry[]> {
    if (typeof content === "string") {
      return [stringToSystemMessage(content)];
    }
    if (isMessageEntryArray(content)) {
      return content;
    }
    for (const renderer of this.renderers) {
      if (renderer.handles(content)) {
        try {
          return await renderer.render(content, args);
        } catch (cause) {
          throw { _tag: "PromptRenderFailed", name, cause } satisfies PromptsError;
        }
      }
    }
    throw {
      _tag: "PromptRenderFailed",
      name,
      cause: `no registered renderer handles content (typeof=${typeof content}); registered: [${this.renderers.map((r) => r.name).join(", ")}]`,
    } satisfies PromptsError;
  }

  private invalidateAndNotify(name: string): void {
    this.listCache = null;
    this.notifier.notify(name);
  }
}

// ─────────── Argument validation ───────────

async function validateArgs(
  promptName: string,
  argDecls: readonly PromptArgument[] | undefined,
  raw: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  if (!argDecls || argDecls.length === 0) return raw;
  const validated: Record<string, unknown> = {};
  for (const arg of argDecls) {
    const value = raw[arg.name];
    if (value === undefined) {
      if (arg.required === true) {
        throw {
          _tag: "PromptArgumentMissing",
          name: promptName,
          argument: arg.name,
        } satisfies PromptsError;
      }
      continue;
    }
    if (arg.schema) {
      const result = await runStandardSchema(arg.schema, value);
      if (result.issues) {
        throw {
          _tag: "PromptArgumentInvalid",
          name: promptName,
          argument: arg.name,
          issues: result.issues.map((iss) => ({
            ...omitUndefined({ path: iss.path?.map(coercePathSegment) }),
            message: iss.message,
          })),
        } satisfies PromptsError;
      }
      validated[arg.name] = result.value;
    } else {
      validated[arg.name] = value;
    }
  }
  // Pass through any unknown args (not declared) — adopter choice
  // whether they care about extras; harness doesn't reject.
  for (const key of Object.keys(raw)) {
    if (!(key in validated) && !argDecls.some((a) => a.name === key)) {
      validated[key] = raw[key];
    }
  }
  return validated;
}

async function runStandardSchema(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<
  | { value: unknown; issues?: undefined }
  | { value?: undefined; issues: readonly StandardSchemaIssue[] }
> {
  const result = await Promise.resolve(schema["~standard"].validate(value));
  if ("issues" in result && result.issues) {
    return { issues: result.issues };
  }
  return { value: (result as { value: unknown }).value };
}

function coercePathSegment(seg: PropertyKey | { readonly key: PropertyKey }): string | number {
  const key = typeof seg === "object" && seg !== null && "key" in seg ? seg.key : seg;
  if (typeof key === "number") return key;
  return String(key);
}

const PROMPTS_ERROR_TAGS = [
  "PromptNotFound",
  "PromptAlreadyExists",
  "PromptArgumentMissing",
  "PromptArgumentInvalid",
  "PromptMissingContent",
  "PromptRenderFailed",
  "PromptsBackendError",
] as const;

function isPromptsError(value: unknown): value is PromptsError {
  if (typeof value !== "object" || value === null) return false;
  const tag = (value as { _tag?: unknown })._tag;
  if (typeof tag !== "string") return false;
  return (PROMPTS_ERROR_TAGS as readonly string[]).includes(tag);
}

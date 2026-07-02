/**
 * `PromptsHarness` — durable parameterized prompt library.
 *
 * Per ADR 32, Shape 1 harness:
 *   - Audit envelopes for every register / update / remove / invoke
 *   - Snapshot/restore via `SnapshotCapable` (declarations only —
 *     `template` and `render` aren't serializable; adopter
 *     re-registers content alongside snapshot load)
 *   - Substrate slot pattern inherited from BaseHarness
 *
 * **Invocation (ADR 51)** — every verb is a DECLARED COMMAND
 * (constructor, `this.command()`): `prompts:register`, `prompts:update`,
 * `prompts:remove`, `prompts:invoke`, and `prompts:get`. One canonical
 * string per verb is simultaneously the inbox message type over
 * `prompts:{scopeId}`, the op-name root, the authz scope label, and the
 * (matrix-gated) wire method name. Cross-boundary payloads carry
 * serializable declarations only (`template` as data); the optional
 * `render` fn is an in-process convenience that never travels.
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
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 * @see packages-next/spec/src/protocol/prompts-harness.ts
 */

import { Effect } from "effect";
import { BaseHarness, type Unsubscribe } from "@agentick/runtime-next";
import type {
  EventBus,
  MessageEntry,
  MessageEnvelope,
  MessageHandlerError,
  MessageInbox,
  OperationJournal,
  PromptArgument,
  PromptDeclaration,
  PromptsError,
  PromptsGetInput,
  PromptsGetResult,
  PromptsHarnessProtocol,
  PromptsInvokeInput,
  PromptsRegisterInput,
  PromptsRemoveInput,
  PromptsSnapshotEntry,
  PromptsUpdateInput,
  StandardSchemaIssue,
  StandardSchemaV1,
  TimelineHarnessProtocol,
} from "@agentick/spec-next";
import {
  HandlerError,
  PromptAlreadyExists,
  PromptArgumentInvalid,
  PromptArgumentMissing,
  PromptMissingContent,
  PromptNotFound,
  PromptRenderFailed,
  PromptsBackendError,
} from "@agentick/spec-next";
import { createKeyedNotifier, type KeyedNotifier } from "@agentick/pubsub-next";
import { omitUndefined } from "@agentick/utils-next";

import type { PromptLoader } from "./loaders.js";
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

  /**
   * Loaders retained from `withPrompts({ loaders })`. Drive
   * post-startup `reload()` + lookup-on-miss in `invoke()` / `get()`.
   */
  private loaders: readonly PromptLoader[] = [];

  /** Cached snapshot for `list()`. Invalidated on every mutation. */
  private listCache: readonly PromptDeclaration[] | null = null;

  /**
   * Declared commands (ADR 51) — pure layer logic in the bodies; the
   * registry owns construction, inbox routing, and enumeration.
   *
   * `invoke` renders + queues onto the session timeline (via
   * `bridges.timeline.queue`, same channel as explicit user input);
   * `get` renders without queueing (MCP `prompts/get`, snapshot tests,
   * doc generators). Both perform lookup-on-miss against configured
   * loaders inside the command body, so inbox-delivered invocations
   * resolve lazily exactly like in-process calls.
   */
  readonly register: (input: PromptsRegisterInput) => Promise<PromptDeclaration>;
  readonly update: (input: PromptsUpdateInput) => Promise<PromptDeclaration>;
  readonly remove: (input: PromptsRemoveInput) => Promise<void>;
  readonly invoke: (input: PromptsInvokeInput) => Promise<PromptsGetResult>;
  readonly get: (input: PromptsGetInput) => Promise<PromptsGetResult>;

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

    // ─── Declared commands (ADR 51) — the single declaration site per
    // verb. Inbox message types, canonical op naming, and enumeration
    // all derive from these; the pre-registry `handleMessage` switch is
    // gone. Payloads carried no validation before the registry; schemas
    // stay off for parity. The optional `render` fn on register/update
    // declarations is in-process-only convenience (ADR 51 §1.2 excludes
    // ops with REQUIRED function parameters; the addressable form
    // carries `template` data — same precedent as `knobs:register`'s
    // optional `validate`).
    const scope = () => ({ sessionId: this.scopeId });
    this.register = this.command({
      name: "prompts:register",
      scope,
      handler: (i: PromptsRegisterInput) => this.applyRegister(i),
    });
    this.update = this.command({
      name: "prompts:update",
      scope,
      handler: (i: PromptsUpdateInput) => this.applyUpdate(i),
    });
    this.remove = this.command({
      name: "prompts:remove",
      scope,
      handler: (i: PromptsRemoveInput) =>
        Effect.sync(() => {
          this.applyRemove(i);
        }),
    });
    this.invoke = this.command({
      name: "prompts:invoke",
      scope,
      handler: (i: PromptsInvokeInput) => this.applyInvoke(i),
    });
    this.get = this.command({
      name: "prompts:get",
      scope,
      handler: (i: PromptsGetInput) => this.applyGet(i),
    });
  }

  /**
   * Replace the loader set used by `reload()` and the lookup-on-miss
   * fallback in `invoke()` / `get()`. Called by `withPrompts` at
   * install time; adopters can also swap the loader set at runtime.
   */
  setLoaders(loaders: readonly PromptLoader[]): void {
    this.loaders = loaders;
  }

  // ─────────── Dynamic surface ───────────

  /**
   * Re-run every configured loader, diff against current state, apply
   * adds + updates (and removes when `pruneMissing: true`). Returns
   * a summary of names touched.
   *
   * **Caveat:** the diff only looks at registered prompts; loaded
   * prompts that lack `template` and `render` are still passed through
   * to `register` (the harness will reject at `register` time if the
   * declaration is malformed).
   */
  async reload(opts: { pruneMissing?: boolean } = {}): Promise<{
    readonly added: readonly string[];
    readonly updated: readonly string[];
    readonly removed: readonly string[];
  }> {
    const batches = await Promise.all(this.loaders.map((l) => l.load()));
    const fresh = new Map<string, PromptDeclaration>();
    for (const batch of batches) {
      for (const input of batch) fresh.set(input.declaration.name, input.declaration);
    }
    const added: string[] = [];
    const updated: string[] = [];
    for (const [name, decl] of fresh) {
      if (this.prompts.has(name)) {
        await this.update({
          name,
          declaration: {
            description: decl.description,
            ...(decl.arguments ? { arguments: decl.arguments } : {}),
            ...(decl.template !== undefined ? { template: decl.template } : {}),
            ...(decl.render !== undefined ? { render: decl.render } : {}),
            ...(decl.metadata ? { metadata: decl.metadata } : {}),
          },
        });
        updated.push(name);
      } else {
        await this.register({ declaration: decl });
        added.push(name);
      }
    }
    const removed: string[] = [];
    if (opts.pruneMissing) {
      for (const name of Array.from(this.prompts.keys())) {
        if (!fresh.has(name)) {
          await this.remove({ name });
          removed.push(name);
        }
      }
    }
    return { added, updated, removed };
  }

  /**
   * Lookup-on-miss internal helper used by `invoke()` / `get()` and
   * by the public `resolve()`. Returns the registered prompt if
   * present; otherwise asks each loader (via `lookup` or `load()` +
   * filter). On hit, registers + returns the declaration. `null` if
   * no loader has the name.
   */
  async resolve(name: string): Promise<PromptDeclaration | null> {
    const existing = this.prompts.get(name);
    if (existing) return existing;
    for (const loader of this.loaders) {
      const found = loader.lookup
        ? await loader.lookup(name)
        : ((await loader.load()).find((p) => p.declaration.name === name) ?? null);
      if (found) {
        await this.register(found);
        return this.prompts.get(name) ?? null;
      }
    }
    return null;
  }

  /**
   * Throw-on-miss sister of {@link resolve}. Same lookup path; throws
   * a `PromptNotFound`-tagged error instead of returning `null` when
   * no loader has the name. Use when the absence of a name is a
   * programming error (must-exist contract). For "render this prompt"
   * use `invoke()` instead — it already throws PromptNotFound on miss.
   */
  async require(name: string): Promise<PromptDeclaration> {
    const resolved = await this.resolve(name);
    if (resolved !== null) return resolved;
    throw new PromptNotFound({ name });
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

  // ─────────── Inbox routing ───────────

  /**
   * `prompts:register/update/remove/invoke/get` are declared commands —
   * routed by the BaseHarness command registry before this fallthrough.
   * Only unknown types land here.
   */
  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `Unknown prompts message type: ${msg.type}` }));
  }

  // ─────────── Private mutation + invoke ───────────

  private applyRegister(
    input: PromptsRegisterInput,
  ): Effect.Effect<PromptDeclaration, PromptsError, never> {
    return Effect.suspend((): Effect.Effect<PromptDeclaration, PromptsError, never> => {
      const decl = input.declaration;
      if (this.prompts.has(decl.name)) {
        return Effect.fail(new PromptAlreadyExists({ name: decl.name }));
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
        return Effect.fail(new PromptNotFound({ name: input.name }));
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
        // Lookup-on-miss: if the name isn't yet registered, ask
        // configured loaders. On hit, the prompt is registered (a
        // nested `prompts:register` command) + invoke proceeds; on
        // miss, `renderToMessages` throws `PromptNotFound`.
        if (!this.prompts.has(input.name) && this.loaders.length > 0) {
          await this.resolve(input.name);
        }
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
        isPromptsError(cause) ? cause : new PromptsBackendError({ cause }),
    });
  }

  private applyGet(input: PromptsGetInput): Effect.Effect<PromptsGetResult, PromptsError, never> {
    return Effect.tryPromise({
      try: async () => {
        // Same lookup-on-miss path as `applyInvoke`.
        if (!this.prompts.has(input.name) && this.loaders.length > 0) {
          await this.resolve(input.name);
        }
        return this.renderToMessages(input.name, input.args);
      },
      catch: (cause): PromptsError =>
        isPromptsError(cause) ? cause : new PromptsBackendError({ cause }),
    });
  }

  private async renderToMessages(
    name: string,
    rawArgs: Readonly<Record<string, unknown>> | undefined,
  ): Promise<PromptsGetResult> {
    const decl = this.prompts.get(name);
    if (!decl) throw new PromptNotFound({ name });

    // 1. Validate args against the declared schemas.
    const args = await validateArgs(name, decl.arguments, rawArgs ?? {});

    // 2. Resolve the content — `render(args)` wins; fall back to `template`.
    let content: unknown;
    if (decl.render) {
      try {
        content = await Promise.resolve(decl.render(args));
      } catch (cause) {
        throw new PromptRenderFailed({ name, cause });
      }
    } else if (decl.template !== undefined) {
      content = decl.template;
    } else {
      throw new PromptMissingContent({ name });
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
          throw new PromptRenderFailed({ name, cause });
        }
      }
    }
    throw new PromptRenderFailed({
      name,
      cause: `no registered renderer handles content (typeof=${typeof content}); registered: [${this.renderers.map((r) => r.name).join(", ")}]`,
    });
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
        throw new PromptArgumentMissing({
          name: promptName,
          argument: arg.name,
        }) satisfies PromptsError;
      }
      continue;
    }
    if (arg.schema) {
      const result = await runStandardSchema(arg.schema, value);
      if (result.issues) {
        throw new PromptArgumentInvalid({
          name: promptName,
          argument: arg.name,
          issues: result.issues.map((iss) => ({
            ...omitUndefined({ path: iss.path?.map(coercePathSegment) }),
            message: iss.message,
          })),
        });
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

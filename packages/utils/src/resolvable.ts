/**
 * `Resolvable<T>` — a value that's either a literal or a no-arg
 * synchronous thunk producing one. The pattern shows up wherever
 * an adopter wants to defer a config value's resolution until
 * factory-invocation time:
 *
 *   nodeId: () => process.env.NODE_ID ?? generateId()
 *   keyPrefix: () => `${process.env.TENANT}:`
 *   port: () => Number(process.env.PORT ?? 8080)
 *
 * Pair with {@link resolveSync} to consume.
 *
 * **Why no async by default?** Most adopter-supplied thunks read env
 * vars or generate ids — synchronous. Forcing async resolution
 * makes every consumer site reach for `await`, which forces every
 * containing factory to be async, which cascades. If you genuinely
 * need async lazy resolution, use {@link ResolvableAsync}.
 *
 * @example
 * ```ts
 * interface Config {
 *   readonly nodeId: Resolvable<string>;
 * }
 *
 * function build(opts: Config) {
 *   const nodeId = resolveSync(opts.nodeId);
 *   // ... use the concrete string ...
 * }
 *
 * build({ nodeId: "node-A" });                              // literal
 * build({ nodeId: () => process.env.NODE_ID ?? "default" }); // thunk
 * ```
 */
export type Resolvable<T> = T | (() => T);

/**
 * `ResolvableAsync<T>` — a value that's a literal, sync thunk, or
 * async thunk. Use ONLY when async resolution is genuinely
 * unavoidable (the value depends on a network read, file system,
 * or other I/O). Consumers must `await` {@link resolveAsync},
 * which forces them to be async too — most of the time
 * {@link Resolvable} is the right choice.
 */
export type ResolvableAsync<T> = T | (() => T | Promise<T>);

/**
 * Resolve a {@link Resolvable} to its concrete value. Calls the
 * thunk if `v` is a function; returns `v` directly otherwise.
 *
 * Sync. Throws if the thunk throws — by design; callers want the
 * error at the resolution site, not later when the consumer uses
 * the result.
 */
export function resolveSync<T>(v: Resolvable<T>): T {
  return typeof v === "function" ? (v as () => T)() : v;
}

/**
 * Resolve a {@link ResolvableAsync} to its concrete value. Calls
 * the thunk and awaits its result if `v` is a function; returns
 * `v` directly otherwise.
 */
export async function resolveAsync<T>(v: ResolvableAsync<T>): Promise<T> {
  if (typeof v === "function") {
    const result = (v as () => T | Promise<T>)();
    return result instanceof Promise ? await result : result;
  }
  return v;
}

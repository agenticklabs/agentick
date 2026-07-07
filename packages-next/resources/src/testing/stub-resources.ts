/**
 * `stubResources()` — canned-answer double, no substrate round-trip.
 *
 * Returns an object satisfying {@link ResourcesHarnessProtocol} that
 * serves a fixed map of `uri → ResourceContents[]`. Registration is a
 * no-op (throws nothing), reads return the canned contents or throw
 * `ResourceNotFound`, and the notifier surface is a working in-memory
 * fan-out (so subscribe/`notifyUpdated` assertions still hold) without
 * the bus + inbox + journal machinery.
 *
 * Use this when the system-under-test consumes the protocol surface but
 * doesn't need the declared-command journaling path exercised. Prefer
 * `fakeResources()` for consumers that should hit the real code path.
 */

import type {
  ResourceContents,
  ResourceDescriptor,
  ResourcesHarnessProtocol,
  ResourcesListResult,
  ResourcesListTemplatesResult,
  ResourceTemplateDescriptor,
} from "@agentick/spec-next";
import { ResourceNotFound } from "@agentick/spec-next";
import type { Unsubscribe } from "@agentick/runtime-next";
import { createKeyedNotifier, createNotifier } from "@agentick/pubsub-next";

export interface StubResourcesOptions {
  /** Canned `uri → contents` map served by `read`. */
  readonly contents?: Readonly<Record<string, readonly ResourceContents[]>>;
  /** Descriptors served by `list`. Defaults to keys of `contents`. */
  readonly resources?: readonly ResourceDescriptor[];
  /** Descriptors served by `listTemplates`. Defaults to `[]`. */
  readonly templates?: readonly ResourceTemplateDescriptor[];
  /** Override the harness id surfaced via `.id`. */
  readonly id?: string;
}

export function stubResources(options: StubResourcesOptions = {}): ResourcesHarnessProtocol {
  const contents = options.contents ?? {};
  const resources =
    options.resources ??
    Object.keys(contents).map((uri): ResourceDescriptor => ({ uri, name: uri }));
  const templates = options.templates ?? [];
  const id = options.id ?? "stub-resources";

  const updated = createKeyedNotifier();
  const listChanged = createNotifier();

  return {
    id,
    ready: Promise.resolve(),
    backend: "stub",
    async close(): Promise<void> {
      /* no-op */
    },
    register(): Unsubscribe {
      // Canned stub — registration doesn't mutate the served map.
      return () => {};
    },
    registerTemplate(): Unsubscribe {
      return () => {};
    },
    has(uri: string): boolean {
      return uri in contents;
    },
    list(): Promise<ResourcesListResult> {
      return Promise.resolve({ resources });
    },
    listTemplates(): Promise<ResourcesListTemplatesResult> {
      return Promise.resolve({ templates });
    },
    read(uri: string): Promise<readonly ResourceContents[]> {
      const hit = contents[uri];
      if (hit === undefined) return Promise.reject(new ResourceNotFound({ uri }));
      return Promise.resolve(hit);
    },
    subscribe(uri: string, listener: () => void): Unsubscribe {
      return updated.subscribe(uri, listener);
    },
    subscribeListChanged(listener: () => void): Unsubscribe {
      return listChanged.subscribe(listener);
    },
    notifyUpdated(uri: string): void {
      updated.notify(uri);
    },
  };
}

/**
 * SandboxHarness — smoke tests.
 *
 * Uses a fake `SandboxHandle` to exercise the harness's command
 * surface, ACL flow, and bridge registration. Provider integration
 * tests live in each provider package.
 */

import { describe, expect, it, vi } from "vitest";
import { Chunk, Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ElicitationHarness } from "@agentick/elicitation-next";

import type {
  SandboxMount,
  ProtocolEvent,
  SandboxHandle,
  SandboxACL,
  SandboxEdit,
  SandboxEditResult,
  SandboxExecDelta,
  SandboxExecOptions,
  SandboxExecResult,
} from "@agentick/spec-next";

import { SandboxHarness } from "../harness.js";
import { applyEdits } from "@agentick/sandbox-edit-next";
import { inMemorySandboxBridge } from "../bridge.js";

function makeHandle(
  opts: {
    execMap?: Record<string, string>;
    streamChunks?: readonly SandboxExecDelta[];
    /** When true, expose the capability-tiered runtime-mount methods. */
    withMounts?: boolean;
  } = {},
): SandboxHandle {
  const files = new Map<string, string>();
  const mounts: SandboxMount[] = [];
  const mountMethods: Partial<SandboxHandle> = opts.withMounts
    ? {
        async addMount(mount: SandboxMount): Promise<void> {
          mounts.push(mount);
        },
        async removeMount(sandboxPath: string): Promise<void> {
          const i = mounts.findIndex((m) => m.sandboxPath === sandboxPath);
          if (i >= 0) mounts.splice(i, 1);
        },
        async listMounts(): Promise<readonly SandboxMount[]> {
          return [...mounts];
        },
      }
    : {};
  return {
    ...mountMethods,
    id: "h",
    workspacePath: "/tmp/h",
    async exec(command: string, o?: SandboxExecOptions): Promise<SandboxExecResult> {
      // Simulate a streaming provider: forward the canned chunks to the
      // harness-supplied onOutput callback as they'd arrive live.
      if (opts.streamChunks && o?.onOutput) {
        for (const chunk of opts.streamChunks) o.onOutput(chunk);
      }
      const stdout = opts.execMap?.[command] ?? "";
      return {
        stdout,
        stderr: "",
        exitCode: stdout.length > 0 ? 0 : 1,
        signaled: false,
        durationMs: 1,
      };
    },
    async readFile(path: string): Promise<string> {
      const v = files.get(path);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    // Real edit op: layered-matching applyEdits over the in-memory file.
    async editFile(path: string, edits: readonly SandboxEdit[]): Promise<SandboxEditResult> {
      const current = files.get(path);
      if (current === undefined) throw new Error("ENOENT");
      const result = applyEdits(current, edits);
      files.set(path, result.content);
      return result;
    },
    async destroy(): Promise<void> {},
  };
}

interface HarnessBundle {
  readonly harness: SandboxHarness;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  readonly journal: MemoryJournal;
  readonly elicitation: ElicitationHarness;
}

async function makeHarnessBundle(
  acl?: SandboxACL,
  handle: SandboxHandle = makeHandle(),
  opts: {
    readonly permissionTimeoutMs?: number;
    readonly permissionTimeoutDecision?: "allow-once" | "deny";
  } = {},
): Promise<HarnessBundle> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const elicitation = new ElicitationHarness("test-sb:elicitation", journal, bus, inbox);
  await elicitation.ready;
  const harness = new SandboxHarness(journal, bus, inbox, {
    sandboxId: "test-sb",
    handle,
    providerName: "test",
    elicitation,
    ...(acl !== undefined ? { acl } : {}),
    permissionTimeoutDecision: opts.permissionTimeoutDecision ?? "deny",
    permissionTimeoutMs: opts.permissionTimeoutMs ?? 10,
  });
  await harness.ready;
  return { harness, bus, inbox, journal, elicitation };
}

function makeHarness(acl?: SandboxACL, handle = makeHandle()): SandboxHarness {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const elicitation = new ElicitationHarness("test-sb:elicitation", journal, bus, inbox);
  return new SandboxHarness(journal, bus, inbox, {
    sandboxId: "test-sb",
    handle,
    providerName: "test",
    elicitation,
    ...(acl !== undefined ? { acl } : {}),
    permissionTimeoutDecision: "deny",
    permissionTimeoutMs: 10, // fast timeout → fallback decision
  });
}

describe("SandboxHarness — static ACL", () => {
  it("allows reads matching the static allow list", async () => {
    const handle = makeHandle();
    await handle.writeFile("/workspace/note.md", "hi");
    const h = makeHarness({ read: ["/workspace/*"] }, handle);
    await h.ready;
    const out = await h.readFile({ path: "/workspace/note.md" });
    expect(out).toBe("hi");
  });

  it("denies reads outside the static allow list (no policy)", async () => {
    const handle = makeHandle();
    await handle.writeFile("/etc/passwd", "root:x:0:0");
    const h = makeHarness({ read: ["/workspace/*"] }, handle);
    await h.ready;
    await expect(h.readFile({ path: "/etc/passwd" })).rejects.toMatchObject({
      _tag: "SandboxPermissionDeniedError",
      kind: "read",
      target: "/etc/passwd",
    });
  });

  it("allows exec commands matching the static allow.exec.allow", async () => {
    const handle = makeHandle({ execMap: { "ls -l": "drwxr-xr-x" } });
    const h = makeHarness({ exec: { allow: ["ls *"] } }, handle);
    await h.ready;
    const result = await h.exec({ command: "ls -l" });
    expect(result.stdout).toBe("drwxr-xr-x");
  });

  it("denies exec commands not on the allow list", async () => {
    const h = makeHarness({ exec: { allow: ["ls *"] } });
    await h.ready;
    await expect(h.exec({ command: "rm -rf /" })).rejects.toMatchObject({
      _tag: "SandboxPermissionDeniedError",
      kind: "exec",
    });
  });

  it("denies regardless of allow when static exec.deny matches", async () => {
    const h = makeHarness({
      exec: { allow: ["*"], deny: ["rm *"] },
    });
    await h.ready;
    await expect(h.exec({ command: "rm /tmp/foo" })).rejects.toMatchObject({
      _tag: "SandboxPermissionDeniedError",
    });
  });
});

describe("SandboxHarness — session-learned ACL via snapshot import", () => {
  it("respects imported session allows", async () => {
    const handle = makeHandle();
    await handle.writeFile("/etc/passwd", "root:x:0:0");
    const h = makeHarness(undefined, handle);
    await h.ready;
    h.importACLSnapshot({
      readAllows: ["/etc/passwd"],
      writeAllows: [],
      execAllows: [],
      readDenies: [],
      writeDenies: [],
      execDenies: [],
    });
    const out = await h.readFile({ path: "/etc/passwd" });
    expect(out).toBe("root:x:0:0");
  });

  it("export/import round-trip", () => {
    const h = makeHarness();
    h.importACLSnapshot({
      readAllows: ["/foo/*"],
      writeAllows: ["/tmp/*"],
      execAllows: ["git *"],
      readDenies: ["/secret/*"],
      writeDenies: [],
      execDenies: ["rm *"],
    });
    const snap = h.exportACLSnapshot();
    expect(snap).toEqual({
      readAllows: ["/foo/*"],
      writeAllows: ["/tmp/*"],
      execAllows: ["git *"],
      readDenies: ["/secret/*"],
      writeDenies: [],
      execDenies: ["rm *"],
    });
  });
});

describe("SandboxHarness — write + edit", () => {
  it("writeFile + readFile round-trip", async () => {
    const h = makeHarness({ read: ["/tmp/*"], write: ["/tmp/*"] });
    await h.ready;
    await h.writeFile({ path: "/tmp/x.txt", content: "hello" });
    const out = await h.readFile({ path: "/tmp/x.txt" });
    expect(out).toBe("hello");
  });

  it("editFile applies replace + reports changes", async () => {
    const h = makeHarness({ read: ["/tmp/*"], write: ["/tmp/*"] });
    await h.ready;
    await h.writeFile({ path: "/tmp/log.txt", content: "alpha\nbeta\ngamma" });
    const result = await h.editFile({
      path: "/tmp/log.txt",
      edits: [{ old: "beta", new: "BETA" }],
    });
    expect(result.applied).toBe(1);
    expect(result.content).toBe("alpha\nBETA\ngamma");
    expect(result.changes).toEqual([{ line: 2, removed: 1, added: 1 }]);
    expect(await h.readFile({ path: "/tmp/log.txt" })).toBe("alpha\nBETA\ngamma");
  });

  // The crown jewel: the real ported `applyEdits` runs through the
  // harness (delegated via handle.editFile), not the deleted
  // `applyEditsLocal` lite regression. Fuzzy indent-adjusted matching
  // + range mode are the two behaviors the lite version never had.
  it("editFile matches indent-adjusted anchors (real applyEdits, not the lite fake)", async () => {
    const h = makeHarness({ read: ["/tmp/*"], write: ["/tmp/*"] });
    await h.ready;
    const source = ["class Foo {", "  method() {", "    return 1;", "  }", "}"].join("\n");
    await h.writeFile({ path: "/tmp/foo.ts", content: source });
    // The model supplies an UNINDENTED anchor; strategy 3 recovers it
    // and adjusts the replacement's indentation to match the source.
    const result = await h.editFile({
      path: "/tmp/foo.ts",
      edits: [{ old: "method() {\n  return 1;\n}", new: "method() {\n  return 2;\n}" }],
    });
    expect(result.applied).toBe(1);
    expect(await h.readFile({ path: "/tmp/foo.ts" })).toBe(
      ["class Foo {", "  method() {", "    return 2;", "  }", "}"].join("\n"),
    );
  });

  it("editFile supports range mode (replace block between from/to, inclusive)", async () => {
    const h = makeHarness({ read: ["/tmp/*"], write: ["/tmp/*"] });
    await h.ready;
    const source = [
      "function calculate() {",
      "  const x = 1;",
      "  const y = 2;",
      "  return x + y;",
      "}",
    ].join("\n");
    await h.writeFile({ path: "/tmp/calc.ts", content: source });
    const result = await h.editFile({
      path: "/tmp/calc.ts",
      edits: [
        {
          from: "function calculate() {",
          to: "}",
          content: "function calculate() {\n  return 42;\n}",
        },
      ],
    });
    expect(result.applied).toBe(1);
    expect(await h.readFile({ path: "/tmp/calc.ts" })).toBe(
      "function calculate() {\n  return 42;\n}",
    );
  });
});

describe("SandboxHarness — exec streaming (#219)", () => {
  it("bridges the provider onOutput callback to the exec delta phase", async () => {
    const chunks: readonly SandboxExecDelta[] = [
      { stream: "stdout", chunk: "building...\n" },
      { stream: "stderr", chunk: "warn: deprecated\n" },
      { stream: "stdout", chunk: "done\n" },
    ];
    const handle = makeHandle({ execMap: { "build.sh": "done\n" }, streamChunks: chunks });
    const { harness, bus } = await makeHarnessBundle({ exec: { allow: ["*"] } }, handle);

    // Fork the collector, then let the subscription register (setImmediate)
    // BEFORE exec fires onOutput — emitDeltaLazy probes hasSubscriberFor.
    const fiber = Effect.runFork(
      Stream.runCollect(
        Stream.take(
          bus.subscribe({
            surface: "sandbox",
            name: { exact: "sandbox:command:exec" },
            phase: "delta",
          }) as Stream.Stream<ProtocolEvent, unknown, never>,
          chunks.length,
        ),
      ),
    );
    await new Promise((r) => setImmediate(r));

    const result = await harness.exec({ command: "build.sh" });
    expect(result.exitCode).toBe(0);

    const deltas = Array.from(Chunk.toReadonlyArray(await Effect.runPromise(Fiber.join(fiber))));
    expect(deltas.map((d) => d.payload)).toEqual(chunks);
    // Deltas are correlated to the exec op (same opId across the stream).
    expect(new Set(deltas.map((d) => d.opId)).size).toBe(1);
  });
});

describe("SandboxHarness — dynamic mounts (allow-list gated, capability-tiered)", () => {
  function mountHarness(mountAllow?: readonly string[], withMounts = true): SandboxHarness {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const elicitation = new ElicitationHarness("test-sb:elicitation", journal, bus, inbox);
    return new SandboxHarness(journal, bus, inbox, {
      sandboxId: "test-sb",
      handle: makeHandle({ withMounts }),
      providerName: "test",
      elicitation,
      permissionTimeoutDecision: "deny",
      permissionTimeoutMs: 10,
      ...(mountAllow !== undefined ? { mountAllow } : {}),
    });
  }

  it("adds a mount whose host path matches the allow-list ceiling", async () => {
    const h = mountHarness(["/host/**"]);
    await h.ready;
    await h.addMount({ mount: { hostPath: "/host/data", sandboxPath: "/data", readOnly: true } });
    expect(await h.listMounts()).toEqual([
      { hostPath: "/host/data", sandboxPath: "/data", readOnly: true },
    ]);
  });

  it("rejects a mount outside the allow-list ceiling", async () => {
    const h = mountHarness(["/host/**"]);
    await h.ready;
    await expect(
      h.addMount({ mount: { hostPath: "/etc", sandboxPath: "/etc" } }),
    ).rejects.toMatchObject({
      _tag: "SandboxPermissionDeniedError",
      kind: "mount",
      target: "/etc",
    });
  });

  it("denies all runtime mounts when no allow-list is declared (default-deny)", async () => {
    const h = mountHarness(undefined);
    await h.ready;
    await expect(
      h.addMount({ mount: { hostPath: "/host/data", sandboxPath: "/data" } }),
    ).rejects.toMatchObject({ _tag: "SandboxPermissionDeniedError", kind: "mount" });
  });

  it("removeMount (keyed by sandbox mount point) takes effect", async () => {
    const h = mountHarness(["/host/**"]);
    await h.ready;
    await h.addMount({ mount: { hostPath: "/host/a", sandboxPath: "/a" } });
    await h.removeMount({ sandboxPath: "/a" });
    expect(await h.listMounts()).toEqual([]);
  });

  it("throws SandboxUnsupportedError when the provider can't do runtime mounts", async () => {
    // Ceiling allows it, but the handle omits the capability methods.
    const h = mountHarness(["/host/**"], false);
    await h.ready;
    await expect(
      h.addMount({ mount: { hostPath: "/host/data", sandboxPath: "/data" } }),
    ).rejects.toMatchObject({ _tag: "SandboxUnsupportedError", capability: "addMount" });
    await expect(h.listMounts()).rejects.toMatchObject({
      _tag: "SandboxUnsupportedError",
      capability: "listMounts",
    });
  });
});

describe("SandboxHarness — permission gate (via ElicitationHarness)", () => {
  type EnvelopeWithMetadata = ProtocolEvent & {
    readonly metadata?: Readonly<Record<string, unknown>>;
  };

  function nextElicitationEnvelope(bus: LocalEventBus): Promise<EnvelopeWithMetadata> {
    return Effect.runPromise(
      Stream.runCollect(
        Stream.take(
          bus.subscribe({
            surface: "session",
            name: { exact: "session:channel:elicitation" },
          }) as Stream.Stream<EnvelopeWithMetadata, unknown, never>,
          1,
        ),
      ),
    ).then((chunk) => Array.from(Chunk.toReadonlyArray(chunk))[0]!);
  }

  it("publishes an elicitation request with hints.kind='sandbox_permission' on pending check", async () => {
    const handle = makeHandle();
    await handle.writeFile("/etc/passwd", "x");
    const { harness, bus, elicitation } = await makeHarnessBundle(undefined, handle, {
      permissionTimeoutMs: 500,
    });

    const envP = nextElicitationEnvelope(bus);
    const readP = harness.readFile({ path: "/etc/passwd" });

    const env = await envP;
    const payload = env.payload as {
      readonly mode: string;
      readonly message: string;
      readonly hints?: { readonly kind?: string };
      readonly metadata?: {
        readonly kind?: string;
        readonly path?: string;
        readonly sandboxId?: string;
      };
    };
    expect(payload.mode).toBe("form");
    expect(payload.hints?.kind).toBe("sandbox_permission");
    expect(payload.metadata).toMatchObject({
      kind: "read",
      path: "/etc/passwd",
      sandboxId: "test-sb",
    });

    await elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "accepted",
      value: { decision: "allow-once" },
    });

    expect(await readP).toBe("x");
  });

  it("allow-session-pattern remembers the pattern; future matching reads skip the gate", async () => {
    const handle = makeHandle();
    await handle.writeFile("/var/log/a.log", "a");
    await handle.writeFile("/var/log/b.log", "b");
    const { harness, bus, elicitation } = await makeHarnessBundle(undefined, handle, {
      permissionTimeoutMs: 500,
    });

    const envP = nextElicitationEnvelope(bus);
    const firstP = harness.readFile({ path: "/var/log/a.log" });
    const env = await envP;
    await elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "accepted",
      value: { decision: "allow-session-pattern", pattern: "/var/log/*" },
    });
    expect(await firstP).toBe("a");

    // No elicitation envelope expected — session ACL now allows the pattern.
    const second = await harness.readFile({ path: "/var/log/b.log" });
    expect(second).toBe("b");
  });

  it("deny outcome short-circuits with SandboxPermissionDeniedError", async () => {
    const handle = makeHandle();
    await handle.writeFile("/etc/passwd", "x");
    const { harness, bus, elicitation } = await makeHarnessBundle(undefined, handle, {
      permissionTimeoutMs: 500,
    });

    const envP = nextElicitationEnvelope(bus);
    const readP = harness.readFile({ path: "/etc/passwd" });
    const env = await envP;
    await elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "accepted",
      value: { decision: "deny" },
    });
    await expect(readP).rejects.toMatchObject({
      _tag: "SandboxPermissionDeniedError",
      kind: "read",
    });
  });

  it("timeout falls back to permissionTimeoutDecision ('deny')", async () => {
    const handle = makeHandle();
    await handle.writeFile("/etc/passwd", "x");
    const { harness } = await makeHarnessBundle(undefined, handle, {
      permissionTimeoutMs: 20,
      permissionTimeoutDecision: "deny",
    });

    await expect(harness.readFile({ path: "/etc/passwd" })).rejects.toMatchObject({
      _tag: "SandboxPermissionDeniedError",
      kind: "read",
    });
  });

  it("timeout fallback 'allow-once' lets the operation through", async () => {
    const handle = makeHandle();
    await handle.writeFile("/etc/passwd", "x");
    const { harness } = await makeHarnessBundle(undefined, handle, {
      permissionTimeoutMs: 20,
      permissionTimeoutDecision: "allow-once",
    });

    expect(await harness.readFile({ path: "/etc/passwd" })).toBe("x");
  });

  it("declined outcome treated as fallback decision", async () => {
    const handle = makeHandle();
    await handle.writeFile("/etc/passwd", "x");
    const { harness, bus, elicitation } = await makeHarnessBundle(undefined, handle, {
      permissionTimeoutMs: 500,
      permissionTimeoutDecision: "deny",
    });

    const envP = nextElicitationEnvelope(bus);
    const readP = harness.readFile({ path: "/etc/passwd" });
    const env = await envP;
    await elicitation.respond({
      correlationId: env.metadata!.correlationId as string,
      outcome: "declined",
      reason: "user clicked Deny",
    });
    await expect(readP).rejects.toMatchObject({
      _tag: "SandboxPermissionDeniedError",
    });
  });
});

describe("inMemorySandboxBridge", () => {
  it("registers and lists by id", async () => {
    const bridge = inMemorySandboxBridge();
    const h = makeHarness();
    await h.ready;
    bridge.register(h);
    expect(bridge.get("test-sb")).toBe(h);
    expect(bridge.list()).toEqual([{ id: "test-sb", workspacePath: "/tmp/h", status: "ready" }]);
  });

  it("subscribe fires on register/unregister", async () => {
    const bridge = inMemorySandboxBridge();
    const h = makeHarness();
    await h.ready;
    const listener = vi.fn();
    bridge.subscribe(listener);
    const unsub = bridge.register(h);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

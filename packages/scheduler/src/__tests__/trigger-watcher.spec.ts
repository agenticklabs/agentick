import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { TriggerWatcher } from "../trigger-watcher.js";
import type { Trigger } from "../types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockClient() {
  const sessions = new Map<string, { sends: Array<{ input: unknown; resolve: () => void }> }>();

  function getSession(id: string) {
    if (!sessions.has(id)) {
      sessions.set(id, { sends: [] });
    }
    return sessions.get(id)!;
  }

  const client = {
    session(id: string) {
      return {
        send(input: unknown) {
          const session = getSession(id);
          let resolve!: () => void;
          const result = new Promise<void>((r) => {
            resolve = r;
          });
          session.sends.push({ input, resolve });
          return { result };
        },
      };
    },
    _sessions: sessions,
    _getSession: getSession,
    // Resolve all pending sends immediately
    _resolveAll() {
      for (const [, session] of sessions) {
        for (const send of session.sends) {
          send.resolve();
        }
      }
    },
    // Auto-resolve: immediately resolve any send
    _autoResolve: false,
  };

  return client;
}

function createMockStore() {
  const store = new EventEmitter() as EventEmitter & {
    deleted: string[];
    delete(id: string): boolean;
  };
  store.deleted = [];
  store.delete = (id: string) => {
    store.deleted.push(id);
    return true;
  };
  return store;
}

function writeTrigger(dir: string, filename: string, trigger: Partial<Trigger>) {
  const full: Trigger = {
    jobId: trigger.jobId ?? "test-job",
    jobName: trigger.jobName ?? "Test Job",
    target: trigger.target ?? "tui",
    prompt: trigger.prompt ?? "Hello",
    firedAt: trigger.firedAt ?? new Date().toISOString(),
    oneshot: trigger.oneshot ?? false,
    ...trigger,
  };
  writeFileSync(join(dir, filename), JSON.stringify(full, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TriggerWatcher", () => {
  let triggersDir: string;

  beforeEach(() => {
    triggersDir = mkdtempSync(join(tmpdir(), "triggers-"));
  });

  afterEach(() => {
    rmSync(triggersDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Startup drain
  // =========================================================================

  it("drains pending triggers on start", async () => {
    const client = createMockClient();
    const store = createMockStore();

    // Write triggers before starting
    writeTrigger(triggersDir, "1000-job1.json", { jobId: "job1", prompt: "first" });
    writeTrigger(triggersDir, "2000-job2.json", { jobId: "job2", prompt: "second" });

    const processed: Trigger[] = [];
    const watcher = new TriggerWatcher(triggersDir, client as any, store as any, {
      onTriggerProcessed: (t) => processed.push(t),
    });

    // Auto-resolve sends so drain completes
    const origSession = client.session.bind(client);
    client.session = (id: string) => {
      const s = origSession(id);
      return {
        send(input: unknown) {
          const handle = s.send(input);
          // Resolve immediately
          const session = client._getSession(id);
          session.sends[session.sends.length - 1].resolve();
          return handle;
        },
      };
    };

    await watcher.start();
    watcher.stop();

    expect(processed).toHaveLength(2);
    expect(processed[0].prompt).toBe("first");
    expect(processed[1].prompt).toBe("second");

    // Trigger files should be deleted after processing
    expect(readdirSync(triggersDir)).toHaveLength(0);
  });

  it("sends triggers as event-role messages, not user messages", async () => {
    const client = createMockClient();
    const store = createMockStore();

    writeTrigger(triggersDir, "1000-job.json", {
      jobId: "my-job",
      jobName: "My Job",
      prompt: "scheduled prompt",
    });

    // Auto-resolve
    const origSession = client.session.bind(client);
    client.session = (id: string) => {
      const s = origSession(id);
      return {
        send(input: unknown) {
          const handle = s.send(input);
          const session = client._getSession(id);
          session.sends[session.sends.length - 1].resolve();
          return handle;
        },
      };
    };

    const watcher = new TriggerWatcher(triggersDir, client as any, store as any);
    await watcher.start();
    watcher.stop();

    const session = client._getSession("tui");
    expect(session.sends).toHaveLength(1);
    const sentInput = session.sends[0].input as any;
    expect(sentInput.messages).toHaveLength(1);
    expect(sentInput.messages[0].role).toBe("event");
    expect(sentInput.messages[0].content[0].text).toBe("scheduled prompt");
    expect(sentInput.messages[0].metadata.source).toEqual({ type: "cron" });
    expect(sentInput.messages[0].metadata.event_type).toBe("cron_trigger");
    expect(sentInput.messages[0].metadata.job_id).toBe("my-job");
  });

  // =========================================================================
  // Oneshot deletion
  // =========================================================================

  it("deletes oneshot job after trigger is processed", async () => {
    const client = createMockClient();
    const store = createMockStore();

    writeTrigger(triggersDir, "1000-oneshot.json", {
      jobId: "oneshot-job",
      oneshot: true,
    });

    // Auto-resolve
    const origSession = client.session.bind(client);
    client.session = (id: string) => {
      const s = origSession(id);
      return {
        send(input: unknown) {
          const handle = s.send(input);
          const session = client._getSession(id);
          session.sends[session.sends.length - 1].resolve();
          return handle;
        },
      };
    };

    const watcher = new TriggerWatcher(triggersDir, client as any, store as any);
    await watcher.start();
    watcher.stop();

    expect(store.deleted).toContain("oneshot-job");
  });

  it("does NOT delete non-oneshot job after trigger", async () => {
    const client = createMockClient();
    const store = createMockStore();

    writeTrigger(triggersDir, "1000-recurring.json", {
      jobId: "recurring-job",
      oneshot: false,
    });

    const origSession = client.session.bind(client);
    client.session = (id: string) => {
      const s = origSession(id);
      return {
        send(input: unknown) {
          const handle = s.send(input);
          const session = client._getSession(id);
          session.sends[session.sends.length - 1].resolve();
          return handle;
        },
      };
    };

    const watcher = new TriggerWatcher(triggersDir, client as any, store as any);
    await watcher.start();
    watcher.stop();

    expect(store.deleted).not.toContain("recurring-job");
  });

  // =========================================================================
  // Adversarial: malformed triggers
  // =========================================================================

  it("handles malformed JSON trigger files without crashing", async () => {
    const client = createMockClient();
    const store = createMockStore();

    writeFileSync(join(triggersDir, "1000-bad.json"), "{ not valid json }}}");
    writeTrigger(triggersDir, "2000-good.json", { jobId: "good", prompt: "works" });

    const errors: Array<{ error: Error; context: string }> = [];

    const origSession = client.session.bind(client);
    client.session = (id: string) => {
      const s = origSession(id);
      return {
        send(input: unknown) {
          const handle = s.send(input);
          const session = client._getSession(id);
          session.sends[session.sends.length - 1].resolve();
          return handle;
        },
      };
    };

    const processed: Trigger[] = [];
    const watcher = new TriggerWatcher(triggersDir, client as any, store as any, {
      onTriggerProcessed: (t) => processed.push(t),
      onError: (err, ctx) => errors.push({ error: err, context: ctx }),
    });

    await watcher.start();
    watcher.stop();

    // Good trigger still processed
    expect(processed).toHaveLength(1);
    expect(processed[0].jobId).toBe("good");
    // Error reported for bad trigger
    expect(errors).toHaveLength(1);
    expect(errors[0].context).toContain("1000-bad.json");
  });

  it("handles empty trigger files", async () => {
    const client = createMockClient();
    const store = createMockStore();

    writeFileSync(join(triggersDir, "1000-empty.json"), "");

    const errors: Array<{ error: Error; context: string }> = [];
    const watcher = new TriggerWatcher(triggersDir, client as any, store as any, {
      onError: (err, ctx) => errors.push({ error: err, context: ctx }),
    });

    await watcher.start();
    watcher.stop();

    expect(errors).toHaveLength(1);
  });

  // =========================================================================
  // Adversarial: missing target session
  // =========================================================================

  it("errors when trigger has no target and no default configured", async () => {
    const client = createMockClient();
    const store = createMockStore();

    writeTrigger(triggersDir, "1000-notarget.json", { target: "" });

    const errors: Array<{ error: Error; context: string }> = [];
    const watcher = new TriggerWatcher(triggersDir, client as any, store as any, {
      onError: (err, ctx) => errors.push({ error: err, context: ctx }),
    });

    await watcher.start();
    watcher.stop();

    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toContain("no target");
  });

  it("falls back to defaultTarget when trigger target is empty", async () => {
    const client = createMockClient();
    const store = createMockStore();

    writeTrigger(triggersDir, "1000-fallback.json", { target: "" });

    const origSession = client.session.bind(client);
    client.session = (id: string) => {
      const s = origSession(id);
      return {
        send(input: unknown) {
          const handle = s.send(input);
          const session = client._getSession(id);
          session.sends[session.sends.length - 1].resolve();
          return handle;
        },
      };
    };

    const processed: Trigger[] = [];
    const watcher = new TriggerWatcher(triggersDir, client as any, store as any, {
      defaultTarget: "telegram",
      onTriggerProcessed: (t) => processed.push(t),
    });

    await watcher.start();
    watcher.stop();

    expect(processed).toHaveLength(1);
    // Verify it sent to the default target
    expect(client._getSession("telegram").sends).toHaveLength(1);
  });

  // =========================================================================
  // Adversarial: trigger file deleted before processing
  // =========================================================================

  it("handles trigger file that vanishes before read", async () => {
    const client = createMockClient();
    const store = createMockStore();

    // Write then immediately delete
    writeTrigger(triggersDir, "1000-vanished.json", { jobId: "v" });
    rmSync(join(triggersDir, "1000-vanished.json"));

    const errors: Array<{ error: Error; context: string }> = [];
    const watcher = new TriggerWatcher(triggersDir, client as any, store as any, {
      onError: (err, ctx) => errors.push({ error: err, context: ctx }),
    });

    await watcher.start();
    watcher.stop();

    // Should not crash, should not error (file simply doesn't exist)
    expect(errors).toHaveLength(0);
  });

  // =========================================================================
  // Adversarial: large backlog
  // =========================================================================

  it("drains 100+ pending triggers on startup", async () => {
    const client = createMockClient();
    const store = createMockStore();

    for (let i = 0; i < 150; i++) {
      writeTrigger(triggersDir, `${1000 + i}-job${i}.json`, {
        jobId: `job-${i}`,
        prompt: `prompt-${i}`,
      });
    }

    const origSession = client.session.bind(client);
    client.session = (id: string) => {
      const s = origSession(id);
      return {
        send(input: unknown) {
          const handle = s.send(input);
          const session = client._getSession(id);
          session.sends[session.sends.length - 1].resolve();
          return handle;
        },
      };
    };

    const processed: Trigger[] = [];
    const watcher = new TriggerWatcher(triggersDir, client as any, store as any, {
      onTriggerProcessed: (t) => processed.push(t),
    });

    await watcher.start();
    watcher.stop();

    expect(processed).toHaveLength(150);
    expect(readdirSync(triggersDir)).toHaveLength(0);
  });

  // =========================================================================
  // Adversarial: send failure does NOT delete trigger (retry on restart)
  // =========================================================================

  it("preserves trigger file when send fails", async () => {
    const store = createMockStore();

    writeTrigger(triggersDir, "1000-fail.json", { jobId: "fail-job" });

    // Client that always rejects
    const failClient = {
      session(_id: string) {
        return {
          send(_input: unknown) {
            return { result: Promise.reject(new Error("session closed")) };
          },
        };
      },
    };

    const errors: Array<{ error: Error; context: string }> = [];
    const watcher = new TriggerWatcher(triggersDir, failClient as any, store as any, {
      onError: (err, ctx) => errors.push({ error: err, context: ctx }),
    });

    await watcher.start();
    watcher.stop();

    // Error reported
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toBe("session closed");
    // Trigger file preserved for retry on next startup
    expect(existsSync(join(triggersDir, "1000-fail.json"))).toBe(true);
  });

  // =========================================================================
  // Adversarial: fs.watch deduplication
  // =========================================================================

  it("deduplicates concurrent processing of same file", async () => {
    const client = createMockClient();
    const store = createMockStore();

    writeTrigger(triggersDir, "1000-dupe.json", { jobId: "dupe" });

    let sendCount = 0;
    const origSession = client.session.bind(client);
    client.session = (id: string) => {
      const s = origSession(id);
      return {
        send(input: unknown) {
          sendCount++;
          const handle = s.send(input);
          const session = client._getSession(id);
          session.sends[session.sends.length - 1].resolve();
          return handle;
        },
      };
    };

    const watcher = new TriggerWatcher(triggersDir, client as any, store as any);
    await watcher.start();

    // Simulate fs.watch firing duplicate events for the same file
    // Access internal _processFile to simulate duplicate fs.watch events
    const processFile = (watcher as any)._processFile.bind(watcher);
    await Promise.all([
      processFile("1000-dupe.json"),
      processFile("1000-dupe.json"),
      processFile("1000-dupe.json"),
    ]);

    watcher.stop();

    // Should only process once (drain already handled it, duplicates are no-ops)
    // The file was already processed during drain, so the Set dedup AND the
    // file-not-found check both prevent re-processing
    expect(sendCount).toBeLessThanOrEqual(1);
  });

  // =========================================================================
  // Adversarial: stop during drain
  // =========================================================================

  it("stops processing when stopped during drain", async () => {
    const store = createMockStore();

    // Write many triggers
    for (let i = 0; i < 20; i++) {
      writeTrigger(triggersDir, `${1000 + i}-job${i}.json`, { jobId: `job-${i}` });
    }

    let sendCount = 0;
    // Client that resolves but slowly
    const slowClient = {
      session(_id: string) {
        return {
          send(_input: unknown) {
            sendCount++;
            return {
              result: new Promise<void>((resolve) => {
                setTimeout(resolve, 10);
              }),
            };
          },
        };
      },
    };

    const watcher = new TriggerWatcher(triggersDir, slowClient as any, store as any);

    // Start drain, then stop after a brief delay
    const startPromise = watcher.start();
    setTimeout(() => watcher.stop(), 25);
    await startPromise;

    // Should have processed fewer than all 20 (stopped mid-drain)
    expect(sendCount).toBeLessThan(20);
  });

  // =========================================================================
  // Routes to correct session
  // =========================================================================

  it("routes triggers to their specified target session", async () => {
    const client = createMockClient();
    const store = createMockStore();

    writeTrigger(triggersDir, "1000-tui.json", { target: "tui", prompt: "for tui" });
    writeTrigger(triggersDir, "2000-telegram.json", { target: "telegram", prompt: "for telegram" });

    const origSession = client.session.bind(client);
    client.session = (id: string) => {
      const s = origSession(id);
      return {
        send(input: unknown) {
          const handle = s.send(input);
          const session = client._getSession(id);
          session.sends[session.sends.length - 1].resolve();
          return handle;
        },
      };
    };

    const watcher = new TriggerWatcher(triggersDir, client as any, store as any);
    await watcher.start();
    watcher.stop();

    expect(client._getSession("tui").sends).toHaveLength(1);
    expect(client._getSession("telegram").sends).toHaveLength(1);
  });
});

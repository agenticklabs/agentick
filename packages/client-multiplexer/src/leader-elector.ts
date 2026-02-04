/**
 * Leader Elector
 *
 * Uses Web Locks API for instant, reliable leader election across browser tabs.
 * Falls back to BroadcastChannel-based election if Web Locks unavailable.
 */

export interface LeaderElector {
  readonly isLeader: boolean;
  readonly tabId: string;
  awaitLeadership(): Promise<void>;
  resign(): void;
  onLeadershipChange(callback: (isLeader: boolean) => void): () => void;
}

/**
 * Create a leader elector for the given channel name.
 * Uses Web Locks API (instant) with BroadcastChannel fallback.
 */
export function createLeaderElector(channelName: string): LeaderElector {
  const tabId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let _isLeader = false;
  let leadershipPromise: Promise<void> | null = null;
  let leadershipResolve: (() => void) | null = null;
  let lockHeld = false;
  const callbacks = new Set<(isLeader: boolean) => void>();

  // Check if Web Locks API is available
  const hasWebLocks = typeof navigator !== "undefined" && "locks" in navigator;

  function setLeader(value: boolean): void {
    if (_isLeader !== value) {
      _isLeader = value;
      for (const cb of callbacks) {
        try {
          cb(value);
        } catch (e) {
          console.error("Error in leadership callback:", e);
        }
      }
      if (value && leadershipResolve) {
        leadershipResolve();
        leadershipResolve = null;
      }
    }
  }

  // Store the release function for resign()
  let releaseLock: (() => void) | null = null;

  async function acquireWithWebLocks(): Promise<void> {
    const lockName = `tentickle:leader:${channelName}`;

    // First, try to acquire the lock WITHOUT waiting (ifAvailable: true)
    // This tells us immediately if we can become leader
    const acquired = await navigator.locks.request(
      lockName,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (lock) {
          // We got the lock - we're the leader!
          lockHeld = true;
          setLeader(true);

          // Now hold it by waiting on a promise that only resolves on resign()
          await new Promise<void>((resolve) => {
            releaseLock = resolve;
          });

          // Lock released
          lockHeld = false;
          setLeader(false);
          return true;
        }
        // Lock is held by someone else - we're a follower
        return false;
      },
    );

    if (!acquired) {
      // Someone else is leader - resolve the leadership promise anyway
      // so connect() can proceed (we're a follower)
      if (leadershipResolve) {
        leadershipResolve();
        leadershipResolve = null;
      }

      // Now wait in queue for when we might become leader later
      // (when current leader closes their tab)
      navigator.locks
        .request(lockName, { mode: "exclusive" }, async () => {
          lockHeld = true;
          setLeader(true);

          await new Promise<void>((resolve) => {
            releaseLock = resolve;
          });

          lockHeld = false;
          setLeader(false);
        })
        .catch(console.error);
    }
  }

  // Fallback: BroadcastChannel-based election (for older browsers)
  let fallbackChannel: BroadcastChannel | null = null;
  let fallbackHeartbeat: ReturnType<typeof setInterval> | null = null;
  let fallbackTimeout: ReturnType<typeof setTimeout> | null = null;

  async function acquireWithFallback(): Promise<void> {
    fallbackChannel = new BroadcastChannel(`tentickle:election:${channelName}`);

    const HEARTBEAT_INTERVAL = 1000;
    const LEADER_TIMEOUT = 2500;

    let currentLeaderId: string | null = null;

    fallbackChannel.onmessage = (event) => {
      const msg = event.data;

      if (msg.type === "heartbeat") {
        if (msg.leaderId !== tabId) {
          // Another leader exists
          currentLeaderId = msg.leaderId;
          setLeader(false);

          // Reset timeout
          if (fallbackTimeout) clearTimeout(fallbackTimeout);
          fallbackTimeout = setTimeout(() => {
            // Leader went silent, try to become leader
            tryBecomeLeader();
          }, LEADER_TIMEOUT);
        }
      }
    };

    function tryBecomeLeader(): void {
      // Announce candidacy
      fallbackChannel?.postMessage({ type: "heartbeat", leaderId: tabId });
      currentLeaderId = tabId;
      setLeader(true);

      // Start heartbeat
      if (fallbackHeartbeat) clearInterval(fallbackHeartbeat);
      fallbackHeartbeat = setInterval(() => {
        if (_isLeader) {
          fallbackChannel?.postMessage({ type: "heartbeat", leaderId: tabId });
        }
      }, HEARTBEAT_INTERVAL);
    }

    // Wait a bit to see if a leader announces
    await new Promise<void>((resolve) => {
      fallbackTimeout = setTimeout(() => {
        if (!currentLeaderId) {
          tryBecomeLeader();
        }
        resolve();
      }, LEADER_TIMEOUT);

      // Also resolve early if we see a leader
      const originalOnMessage = fallbackChannel!.onmessage;
      fallbackChannel!.onmessage = (event) => {
        originalOnMessage?.call(fallbackChannel, event);
        if (event.data.type === "heartbeat") {
          resolve();
        }
      };
    });
  }

  return {
    get isLeader() {
      return _isLeader;
    },

    get tabId() {
      return tabId;
    },

    awaitLeadership(): Promise<void> {
      if (_isLeader) {
        return Promise.resolve();
      }

      if (!leadershipPromise) {
        leadershipPromise = new Promise((resolve) => {
          leadershipResolve = resolve;
        });

        // Start trying to acquire leadership
        if (hasWebLocks) {
          acquireWithWebLocks().catch(console.error);
        } else {
          acquireWithFallback().catch(console.error);
        }
      }

      return leadershipPromise;
    },

    resign(): void {
      if (!_isLeader) return;

      if (hasWebLocks && lockHeld && releaseLock) {
        // Release the web lock
        releaseLock();
        releaseLock = null;
      }

      if (fallbackHeartbeat) {
        clearInterval(fallbackHeartbeat);
        fallbackHeartbeat = null;
      }
      if (fallbackTimeout) {
        clearTimeout(fallbackTimeout);
        fallbackTimeout = null;
      }
      if (fallbackChannel) {
        fallbackChannel.close();
        fallbackChannel = null;
      }

      setLeader(false);
    },

    onLeadershipChange(callback: (isLeader: boolean) => void): () => void {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
  };
}

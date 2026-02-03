/**
 * Session Manager
 *
 * Manages persistent sessions across apps.
 */

import type { Session } from "@tentickle/core";
import { devToolsEmitter, type DTGatewaySessionEvent } from "@tentickle/shared";
import type { AppRegistry, AppInfo } from "./app-registry.js";
import type { SessionState } from "./types.js";
import { parseSessionKey, formatSessionKey } from "./protocol.js";

interface ManagedSession {
  state: SessionState;
  coreSession: Session | null;
  appInfo: AppInfo;
}

/**
 * SessionManager configuration
 */
export interface SessionManagerConfig {
  /** Gateway ID for DevTools events */
  gatewayId: string;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private registry: AppRegistry;
  private gatewayId: string;
  private devToolsSequence = 0;

  constructor(registry: AppRegistry, config?: SessionManagerConfig) {
    this.registry = registry;
    this.gatewayId = config?.gatewayId ?? "gateway";
  }

  /**
   * Emit a DevTools session event
   */
  private emitDevToolsEvent(
    action: DTGatewaySessionEvent["action"],
    sessionId: string,
    appId: string,
    messageCount?: number,
    clientId?: string,
  ): void {
    if (!devToolsEmitter.hasSubscribers()) return;

    devToolsEmitter.emitEvent({
      type: "gateway_session",
      executionId: this.gatewayId,
      action,
      sessionId,
      appId,
      messageCount,
      clientId,
      sequence: this.devToolsSequence++,
      timestamp: Date.now(),
    } as DTGatewaySessionEvent);
  }

  /**
   * Get or create a session
   */
  async getOrCreate(sessionKey: string, clientId?: string): Promise<ManagedSession> {
    // Check if session exists
    let session = this.sessions.get(sessionKey);
    if (session) {
      session.state.lastActivityAt = new Date();
      return session;
    }

    // Parse session key to get app and name
    const { appId, sessionName } = parseSessionKey(sessionKey, this.registry.defaultId);

    // Get the app
    const appInfo = this.registry.resolve(appId);

    // Create session state
    const state: SessionState = {
      id: formatSessionKey({ appId, sessionName }),
      appId,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messageCount: 0,
      isActive: false,
      subscribers: new Set(),
    };

    // Create the managed session
    session = {
      state,
      coreSession: null,
      appInfo,
    };

    this.sessions.set(state.id, session);

    // Emit DevTools event for session creation
    this.emitDevToolsEvent("created", state.id, appId, 0, clientId);

    return session;
  }

  /**
   * Get an existing session
   */
  get(sessionKey: string): ManagedSession | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * Check if a session exists
   */
  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  /**
   * Close a session
   */
  async close(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    const { id, appId, messageCount } = session.state;

    // Clean up session if active
    if (session.coreSession) {
      session.coreSession.close();
      session.coreSession = null;
    }

    this.sessions.delete(sessionKey);

    // Emit DevTools event for session closure
    this.emitDevToolsEvent("closed", id, appId, messageCount);
  }

  /**
   * Reset a session (clear history but keep session)
   */
  async reset(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    const { id, appId, messageCount } = session.state;

    // Reset session state
    session.state.messageCount = 0;
    session.state.lastActivityAt = new Date();
    if (session.coreSession) {
      session.coreSession.close();
      session.coreSession = null;
    }

    // Emit DevTools event for session reset (treated as closed + recreated)
    this.emitDevToolsEvent("closed", id, appId, messageCount);

    // TODO: Clear persisted history
  }

  /**
   * Get all session IDs
   */
  ids(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get all sessions
   */
  all(): ManagedSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get sessions for a specific app
   */
  forApp(appId: string): ManagedSession[] {
    return this.all().filter((s) => s.state.appId === appId);
  }

  /**
   * Get session count
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Add a subscriber to a session
   */
  subscribe(sessionKey: string, clientId: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.state.subscribers.add(clientId);
    }
  }

  /**
   * Remove a subscriber from a session
   */
  unsubscribe(sessionKey: string, clientId: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.state.subscribers.delete(clientId);
    }
  }

  /**
   * Remove a client from all subscriptions
   */
  unsubscribeAll(clientId: string): void {
    for (const session of this.sessions.values()) {
      session.state.subscribers.delete(clientId);
    }
  }

  /**
   * Get subscribers for a session
   */
  getSubscribers(sessionKey: string): Set<string> {
    const session = this.sessions.get(sessionKey);
    return session?.state.subscribers ?? new Set();
  }

  /**
   * Update message count for a session
   */
  incrementMessageCount(sessionKey: string, clientId?: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.state.messageCount++;
      session.state.lastActivityAt = new Date();

      // Emit DevTools event for session message
      this.emitDevToolsEvent(
        "message",
        session.state.id,
        session.state.appId,
        session.state.messageCount,
        clientId,
      );
    }
  }

  /**
   * Set session active state
   */
  setActive(sessionKey: string, isActive: boolean): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.state.isActive = isActive;
    }
  }
}

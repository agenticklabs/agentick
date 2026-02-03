/**
 * App Registry
 *
 * Manages available apps and their configurations.
 */

import type { App } from "@tentickle/core";

export interface AppInfo {
  id: string;
  app: App;
  name?: string;
  description?: string;
  isDefault: boolean;
}

export class AppRegistry {
  private apps = new Map<string, AppInfo>();
  private defaultAppId: string;

  constructor(apps: Record<string, App>, defaultApp: string) {
    if (!apps[defaultApp]) {
      throw new Error(
        `Default app "${defaultApp}" not found in apps: ${Object.keys(apps).join(", ")}`,
      );
    }

    this.defaultAppId = defaultApp;

    for (const [id, app] of Object.entries(apps)) {
      this.apps.set(id, {
        id,
        app,
        isDefault: id === defaultApp,
      });
    }
  }

  /**
   * Get an app by ID
   */
  get(id: string): AppInfo | undefined {
    return this.apps.get(id);
  }

  /**
   * Get the default app
   */
  getDefault(): AppInfo {
    return this.apps.get(this.defaultAppId)!;
  }

  /**
   * Get the default app ID
   */
  get defaultId(): string {
    return this.defaultAppId;
  }

  /**
   * Check if an app exists
   */
  has(id: string): boolean {
    return this.apps.has(id);
  }

  /**
   * Get all app IDs
   */
  ids(): string[] {
    return Array.from(this.apps.keys());
  }

  /**
   * Get all apps
   */
  all(): AppInfo[] {
    return Array.from(this.apps.values());
  }

  /**
   * Get app count
   */
  get size(): number {
    return this.apps.size;
  }

  /**
   * Resolve an app ID, falling back to default
   */
  resolve(id?: string): AppInfo {
    if (!id) {
      return this.getDefault();
    }

    const app = this.apps.get(id);
    if (!app) {
      throw new Error(`Unknown app "${id}". Available: ${this.ids().join(", ")}`);
    }

    return app;
  }
}

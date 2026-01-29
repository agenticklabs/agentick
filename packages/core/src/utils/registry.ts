import type { ExecutableTool } from "../tool/tool";
import type { ModelInstance } from "../model/model";

export class Registry<T> {
  private items = new Map<string, T>();

  constructor(private name: string) {}

  register(id: string, item: T): void {
    if (this.items.has(id)) {
      console.warn(`[Registry:${this.name}] Overwriting item with id '${id}'`);
    }
    this.items.set(id, item);
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  list(): T[] {
    return Array.from(this.items.values());
  }

  clear(): void {
    this.items.clear();
  }
}

export const toolRegistry = new Registry<ExecutableTool>("Tool");
export const modelRegistry = new Registry<ModelInstance>("Model");

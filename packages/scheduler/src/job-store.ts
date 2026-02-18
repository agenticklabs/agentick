import { EventEmitter } from "node:events";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type { Job, CreateJobInput } from "./types.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export class JobStore extends EventEmitter {
  private jobs = new Map<string, Job>();
  private readonly jobsDir: string;

  constructor(jobsDir: string) {
    super();
    this.jobsDir = jobsDir;
    mkdirSync(jobsDir, { recursive: true });
    this._load();
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  listEnabled(): Job[] {
    return this.list().filter((j) => j.enabled);
  }

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  create(input: CreateJobInput): Job {
    const id = input.id ?? this._generateId(input.name);
    if (this.jobs.has(id)) {
      throw new Error(`Job "${id}" already exists`);
    }

    const job: Job = {
      ...input,
      id,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(id, job);
    this._save(job);
    this.emit("change");
    return job;
  }

  update(
    id: string,
    updates: Partial<
      Pick<
        Job,
        "name" | "cron" | "target" | "prompt" | "oneshot" | "enabled" | "lastFiredAt" | "metadata"
      >
    >,
  ): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, updates);
    this._save(job);
    this.emit("change");
    return job;
  }

  delete(id: string): boolean {
    const existed = this.jobs.delete(id);
    if (existed) {
      this._remove(id);
      this.emit("change");
    }
    return existed;
  }

  private _generateId(name: string): string {
    const base = slugify(name);
    if (!base) return this._nanoid();
    if (!this.jobs.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!this.jobs.has(candidate)) return candidate;
    }
    return `${base}-${this._nanoid()}`;
  }

  private _nanoid(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    for (const b of bytes) id += chars[b % chars.length];
    return id;
  }

  private _load(): void {
    if (!existsSync(this.jobsDir)) return;
    for (const file of readdirSync(this.jobsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(this.jobsDir, file), "utf-8");
        const job = JSON.parse(raw) as Job;
        if (job.id) this.jobs.set(job.id, job);
      } catch {
        // Skip malformed files
      }
    }
  }

  private _save(job: Job): void {
    writeFileSync(join(this.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2) + "\n");
  }

  private _remove(id: string): void {
    const path = join(this.jobsDir, `${id}.json`);
    try {
      unlinkSync(path);
    } catch {
      // Already gone
    }
  }
}

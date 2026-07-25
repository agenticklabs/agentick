/**
 * Structural type matching the subset of `ioredis`'s `Redis` client
 * surface we use. Declared here (not imported from `ioredis`) so
 * adopters can pass any RESP-protocol-compatible client (real ioredis,
 * mock for tests, ioredis-against-Valkey/KeyDB/Dragonfly) without
 * cluster-redis-next forcing a specific implementation type.
 *
 * The shape is intentionally narrow — only the methods this package
 * actually calls. Widening here is a public-API change.
 */

export interface RedisLikeClient {
  // Pub/sub side
  publish(channel: string, message: Buffer | string): Promise<number>;
  subscribe(...channels: string[]): Promise<number>;
  unsubscribe(...channels: string[]): Promise<number>;
  on(event: "messageBuffer", listener: (channel: Buffer, message: Buffer) => void): unknown;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;

  // Membership side (SET + TTL)
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<"OK" | null>;
  expire(key: string, seconds: number): Promise<number>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;

  // Lifecycle
  quit(): Promise<"OK">;
  readonly status: string;
}

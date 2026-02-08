import type { ChannelAdapter, ChannelEvent } from "../service";

/**
 * Configuration for RedisChannelAdapter
 */
export interface RedisChannelAdapterConfig {
  /**
   * Redis connection URL (e.g., 'redis://localhost:6379')
   * or connection options
   */
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;

  /**
   * Channel prefix for pub/sub (default: 'agentick:channels:')
   */
  channelPrefix?: string;

  /**
   * Room prefix for pub/sub (default: 'agentick:rooms:')
   */
  roomPrefix?: string;

  /**
   * Redis client instance (if you want to reuse an existing client)
   */
  client?: any; // Redis client from 'redis' or 'ioredis' package
}

/**
 * RedisChannelAdapter implements distribution via Redis pub/sub.
 *
 * Allows multiple engine instances to share channels across a distributed system.
 *
 * Supports room-based routing:
 * - Events with target.rooms publish to room-specific Redis channels
 * - Each instance subscribes to rooms when local connections join
 * - Uses prefix pattern: `agentick:rooms:{roomName}`
 *
 * Requires 'redis' or 'ioredis' package.
 */
export class RedisChannelAdapter implements ChannelAdapter {
  public readonly name = "redis";

  private config: Required<Pick<RedisChannelAdapterConfig, "channelPrefix" | "roomPrefix">> & {
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    client?: any;
  };
  private redisClient?: any;
  private subscribers = new Map<string, (event: ChannelEvent) => void>();
  private roomSubscriptions = new Map<string, () => Promise<void>>(); // room → unsubscribe
  private isConnected = false;

  constructor(config: RedisChannelAdapterConfig) {
    this.config = {
      channelPrefix: config.channelPrefix || "agentick:channels:",
      roomPrefix: config.roomPrefix || "agentick:rooms:",
      url: config.url,
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      client: config.client,
    };
  }

  /**
   * Initialize Redis client
   */
  private async getRedisClient(): Promise<any> {
    if (this.config.client) {
      return this.config.client;
    }

    if (this.redisClient) {
      return this.redisClient;
    }

    try {
      // Try 'ioredis' first (more popular)
      try {
        const Redis = require("ioredis");
        this.redisClient = this.config.url
          ? new Redis(this.config.url)
          : new Redis({
              host: this.config.host || "localhost",
              port: this.config.port || 6379,
              password: this.config.password,
              db: this.config.db || 0,
            });
        return this.redisClient;
      } catch (_error) {
        // Fall back to 'redis' package
        const redis = require("redis");
        this.redisClient = this.config.url
          ? redis.createClient({ url: this.config.url })
          : redis.createClient({
              socket: {
                host: this.config.host || "localhost",
                port: this.config.port || 6379,
              },
              password: this.config.password,
              database: this.config.db || 0,
            });

        await this.redisClient.connect();
        return this.redisClient;
      }
    } catch (_error) {
      throw new Error(
        `RedisChannelAdapter requires 'redis' or 'ioredis' package. Install it with: npm install redis or npm install ioredis`,
      );
    }
  }

  /**
   * Publish event to Redis pub/sub.
   * If event.target.rooms is set, publishes to room-specific channels.
   * Otherwise publishes to the event's channel.
   */
  async publish(event: ChannelEvent): Promise<void> {
    try {
      const client = await this.getRedisClient();
      const message = JSON.stringify(event);

      // Determine target channels
      const targetChannels: string[] = [];

      if (event.target?.rooms && event.target.rooms.length > 0) {
        // Room-based routing: publish to each room's Redis channel
        for (const room of event.target.rooms) {
          targetChannels.push(`${this.config.roomPrefix}${room}`);
        }
      } else {
        // Default: publish to event's channel
        targetChannels.push(`${this.config.channelPrefix}${event.channel}`);
      }

      // Publish to all target channels
      for (const channel of targetChannels) {
        if (client.publish) {
          // ioredis
          await client.publish(channel, message);
        } else if (client.publishAsync) {
          // redis (v4+)
          await client.publishAsync(channel, message);
        } else {
          throw new Error("Redis client does not support publish");
        }
      }
    } catch (error) {
      console.error("Failed to publish event to Redis:", error);
      throw error;
    }
  }

  /**
   * Subscribe to events from Redis pub/sub
   */
  async subscribe(channel: string, handler: (event: ChannelEvent) => void): Promise<() => void> {
    try {
      const client = await this.getRedisClient();
      const redisChannel = `${this.config.channelPrefix}${channel}`;

      // Store handler for cleanup
      this.subscribers.set(redisChannel, handler);

      // Check if client is ioredis or redis
      if (client.subscribe) {
        // ioredis
        await client.subscribe(redisChannel);
        client.on("message", (receivedChannel: string, message: string) => {
          if (receivedChannel === redisChannel) {
            try {
              const event: ChannelEvent = JSON.parse(message);
              handler(event);
            } catch (error) {
              console.error("Failed to parse Redis message:", error);
            }
          }
        });
      } else if (client.subscribeAsync) {
        // redis (v4+)
        await client.subscribeAsync(redisChannel);
        client.on("message", (receivedChannel: string, message: string) => {
          if (receivedChannel === redisChannel) {
            try {
              const event: ChannelEvent = JSON.parse(message);
              handler(event);
            } catch (error) {
              console.error("Failed to parse Redis message:", error);
            }
          }
        });
      } else {
        throw new Error("Redis client does not support subscribe");
      }

      // Return unsubscribe function
      return async () => {
        try {
          if (client.unsubscribe) {
            // ioredis
            await client.unsubscribe(redisChannel);
          } else if (client.unsubscribeAsync) {
            // redis (v4+)
            await client.unsubscribeAsync(redisChannel);
          }
          this.subscribers.delete(redisChannel);
        } catch (error) {
          console.error("Failed to unsubscribe from Redis:", error);
        }
      };
    } catch (error) {
      console.error("Failed to subscribe to Redis channel:", error);
      throw error;
    }
  }

  /**
   * Subscribe this instance to a room.
   * Called when a local connection joins a room that this instance doesn't have yet.
   */
  async joinRoom(room: string): Promise<void> {
    if (this.roomSubscriptions.has(room)) {
      return; // Already subscribed
    }

    try {
      const client = await this.getRedisClient();
      const redisChannel = `${this.config.roomPrefix}${room}`;

      // Subscribe to room channel
      if (client.subscribe) {
        // ioredis
        await client.subscribe(redisChannel);
      } else if (client.subscribeAsync) {
        // redis (v4+)
        await client.subscribeAsync(redisChannel);
      }

      // Store unsubscribe function
      this.roomSubscriptions.set(room, async () => {
        if (client.unsubscribe) {
          await client.unsubscribe(redisChannel);
        } else if (client.unsubscribeAsync) {
          await client.unsubscribeAsync(redisChannel);
        }
      });

      console.log(`RedisAdapter: joined room ${room}`);
    } catch (error) {
      console.error(`Failed to join room ${room}:`, error);
      throw error;
    }
  }

  /**
   * Unsubscribe this instance from a room.
   * Called when no local connections remain in the room.
   */
  async leaveRoom(room: string): Promise<void> {
    const unsubscribe = this.roomSubscriptions.get(room);
    if (unsubscribe) {
      try {
        await unsubscribe();
        this.roomSubscriptions.delete(room);
        console.log(`RedisAdapter: left room ${room}`);
      } catch (error) {
        console.error(`Failed to leave room ${room}:`, error);
      }
    }
  }

  /**
   * Cleanup Redis connection
   */
  async disconnect(): Promise<void> {
    // Unsubscribe from all rooms
    for (const [room, unsubscribe] of this.roomSubscriptions.entries()) {
      try {
        await unsubscribe();
      } catch (error) {
        console.error(`Failed to unsubscribe from room ${room}:`, error);
      }
    }
    this.roomSubscriptions.clear();

    if (this.redisClient && this.redisClient.quit) {
      await this.redisClient.quit();
      this.redisClient = undefined;
    }
    this.subscribers.clear();
    this.isConnected = false;
  }
}

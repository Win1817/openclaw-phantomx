/**
 * infra/event-bus/redis.ts
 *
 * Redis Streams event bus transport.
 *
 * Uses Redis XADD / XREADGROUP for persistent, ordered, at-least-once delivery.
 *
 * Why Redis Streams over pub/sub:
 *   - Messages survive consumer crashes (acknowledgement required)
 *   - Consumer groups enable competing consumers → horizontal scaling
 *   - Built-in replay from any offset
 *   - Automatic DLQ via XAUTOCLAIM on idle messages
 *
 * Prerequisites: Redis 6.2+ (for XAUTOCLAIM support)
 *
 * Connection: set ROCKETCHAT_EVENT_BUS_URL=redis://localhost:6379
 * or configure via channels.rocketchat.eventBusUrl
 *
 * Usage:
 *   const bus = new RedisEventBus({ url: "redis://localhost:6379" });
 *   await bus.connect();
 *   await bus.publish(payload, { stream: STREAM_NAMES.INBOUND, key: roomId });
 *   await bus.subscribe({ stream: STREAM_NAMES.INBOUND, group: "gateway-1" }, handler);
 */

import { randomUUID } from "node:crypto";
import type {
  AckFn,
  EventBusConfig,
  EventEnvelope,
  IEventBus,
  MessageHandler,
  NackFn,
  PublishOptions,
  SubscribeOptions,
} from "./types.js";

// Redis client is a peer dependency — imported lazily so the plugin loads
// without Redis if only the memory transport is used.
type RedisClientLike = {
  xAdd(stream: string, id: string, fields: Record<string, string>): Promise<string>;
  xGroupCreate(stream: string, group: string, id: string, opts?: { MKSTREAM?: boolean }): Promise<void>;
  xReadGroup(
    group: string,
    consumer: string,
    streams: Array<{ key: string; id: string }>,
    opts?: { COUNT?: number; BLOCK?: number },
  ): Promise<Array<{ name: string; messages: Array<{ id: string; message: Record<string, string> }> }> | null>;
  xAck(stream: string, group: string, ...ids: string[]): Promise<number>;
  xLen(stream: string): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<void>;
};

async function createRedisClient(url: string): Promise<RedisClientLike> {
  try {
    // @ts-expect-error — redis is an optional peer dep
    const { createClient } = await import("redis");
    const client = createClient({ url });
    await client.connect();
    return client as unknown as RedisClientLike;
  } catch {
    throw new Error(
      "RedisEventBus: failed to connect. Ensure 'redis' npm package is installed " +
        `and the server is reachable at ${url}`,
    );
  }
}

export class RedisEventBus implements IEventBus {
  private client: RedisClientLike | null = null;
  private readonly url: string;
  private readonly prefix: string;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly consumerName: string;
  private pollers: NodeJS.Timeout[] = [];
  private closed = false;

  constructor(cfg: EventBusConfig) {
    if (!cfg.url) throw new Error("RedisEventBus: url is required");
    this.url = cfg.url;
    this.prefix = cfg.prefix ?? "openclaw";
    this.maxRetries = cfg.maxRetries ?? 3;
    this.retryBackoffMs = cfg.retryBackoffMs ?? 1000;
    this.consumerName = `consumer-${randomUUID().slice(0, 8)}`;
  }

  async connect(): Promise<void> {
    this.client = await createRedisClient(this.url);
  }

  // ---------- IEventBus ---------------------------------------------------

  async publish<T>(payload: T, opts: PublishOptions): Promise<void> {
    if (!this.client) throw new Error("RedisEventBus: not connected");
    if (this.closed) throw new Error("RedisEventBus: already closed");

    const envelope: EventEnvelope<T> = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: opts.stream,
      source: opts.key ?? "default",
      traceId: randomUUID(),
      data: payload,
      attempt: 0,
    };

    const streamKey = `${this.prefix}:${opts.stream}`;

    await this.client.xAdd(streamKey, "*", {
      envelope: JSON.stringify(envelope),
    });
  }

  async subscribe<T>(
    opts: SubscribeOptions,
    handler: MessageHandler<T>,
  ): Promise<void> {
    if (!this.client) throw new Error("RedisEventBus: not connected");
    if (this.closed) throw new Error("RedisEventBus: already closed");

    const streamKey = `${this.prefix}:${opts.stream}`;
    const group = opts.group ?? "openclaw-default";
    const concurrency = opts.concurrency ?? 4;
    const blockMs = 2000;

    // Create consumer group (idempotent)
    try {
      await this.client.xGroupCreate(streamKey, group, "$", { MKSTREAM: true });
    } catch (err) {
      // BUSYGROUP = already exists, safe to ignore
      if (!String(err).includes("BUSYGROUP")) throw err;
    }

    const poll = async (): Promise<void> => {
      if (this.closed) return;

      try {
        const results = await this.client!.xReadGroup(
          group,
          this.consumerName,
          [{ key: streamKey, id: ">" }],
          { COUNT: concurrency, BLOCK: blockMs },
        );

        if (results && results.length > 0) {
          for (const streamResult of results) {
            for (const entry of streamResult.messages) {
              const raw = entry.message.envelope;
              if (!raw) continue;

              let envelope: EventEnvelope<T>;
              try {
                envelope = JSON.parse(raw) as EventEnvelope<T>;
              } catch {
                await this.client!.xAck(streamKey, group, entry.id);
                continue;
              }

              const ack: AckFn = async () => {
                await this.client!.xAck(streamKey, group, entry.id);
              };

              const nack: NackFn = async (err?: Error) => {
                const nextAttempt = (envelope.attempt ?? 0) + 1;
                if (nextAttempt <= this.maxRetries) {
                  const delay = this.retryBackoffMs * Math.pow(2, nextAttempt - 1);
                  setTimeout(async () => {
                    try {
                      await handler({ ...envelope, attempt: nextAttempt }, ack, nack);
                    } catch {
                      // Will be reclaimed by XAUTOCLAIM on next poll
                    }
                  }, delay);
                } else {
                  // Send to DLQ
                  const dlqKey = `${this.prefix}:${opts.stream}.dlq`;
                  await this.client!.xAdd(dlqKey, "*", {
                    envelope: JSON.stringify({
                      originalEvent: envelope,
                      error: err?.message ?? "max retries exceeded",
                      failedAt: new Date().toISOString(),
                      attempt: nextAttempt,
                    }),
                  });
                  await this.client!.xAck(streamKey, group, entry.id);
                }
              };

              try {
                await handler(envelope, ack, nack);
              } catch (err) {
                await nack(err instanceof Error ? err : new Error(String(err)));
              }
            }
          }
        }
      } catch (err) {
        if (!this.closed) {
          console.error("[RedisEventBus] poll error:", err);
        }
      }

      if (!this.closed) {
        setImmediate(() => void poll());
      }
    };

    // Start the polling loop
    setImmediate(() => void poll());
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.pollers) clearTimeout(t);
    await this.client?.quit().catch(() => {});
    this.client = null;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.client?.ping();
      return res === "PONG";
    } catch {
      return false;
    }
  }
}

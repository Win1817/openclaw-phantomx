/**
 * infra/event-bus/memory.ts
 *
 * In-memory event bus transport.
 *
 * Uses Node.js EventEmitter under the hood. Suitable for:
 *   - Single-instance deployments (no external broker required)
 *   - Integration testing
 *   - Local development
 *
 * Limitations: no persistence, no cross-process delivery, no replay.
 * For production horizontal scaling use the Redis or NATS transport.
 */

import { EventEmitter } from "node:events";
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

export class MemoryEventBus implements IEventBus {
  private readonly emitter = new EventEmitter();
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private closed = false;

  constructor(cfg?: EventBusConfig) {
    this.maxRetries = cfg?.maxRetries ?? 3;
    this.retryBackoffMs = cfg?.retryBackoffMs ?? 500;
    // Allow many subscribers (one per stream type)
    this.emitter.setMaxListeners(50);
  }

  async publish<T>(payload: T, opts: PublishOptions): Promise<void> {
    if (this.closed) throw new Error("MemoryEventBus: already closed");

    const envelope: EventEnvelope<T> = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: opts.stream,
      source: opts.key ?? "default",
      traceId: randomUUID(),
      data: payload,
      attempt: 0,
    };

    // Emit asynchronously so publish() never blocks on handler execution
    setImmediate(() => {
      this.emitter.emit(opts.stream, envelope);
    });
  }

  async subscribe<T>(
    opts: SubscribeOptions,
    handler: MessageHandler<T>,
  ): Promise<void> {
    if (this.closed) throw new Error("MemoryEventBus: already closed");

    const maxRetries = this.maxRetries;
    const backoffMs = this.retryBackoffMs;
    const dlqStream = `${opts.stream}.dlq`;

    this.emitter.on(opts.stream, async (envelope: EventEnvelope<T>) => {
      const attemptWithRetry = async (attempt: number): Promise<void> => {
        const env = { ...envelope, attempt };

        const ack: AckFn = async () => {
          /* no-op in memory bus — message is already consumed */
        };

        const nack: NackFn = async (err?: Error) => {
          if (attempt < maxRetries) {
            const delay = backoffMs * Math.pow(2, attempt);
            setTimeout(() => attemptWithRetry(attempt + 1), delay);
          } else {
            // Route to DLQ stream
            this.emitter.emit(dlqStream, {
              ...env,
              type: dlqStream,
              data: {
                originalEvent: env,
                error: err?.message ?? "max retries exceeded",
                failedAt: new Date().toISOString(),
                attempt,
              },
            });
          }
        };

        try {
          await handler(env, ack, nack);
        } catch (err) {
          await nack(err instanceof Error ? err : new Error(String(err)));
        }
      };

      await attemptWithRetry(0);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emitter.removeAllListeners();
  }

  async ping(): Promise<boolean> {
    return !this.closed;
  }
}

/**
 * infra/event-bus/types.ts
 *
 * Transport-agnostic event bus contract for OpenClaw × Rocket.Chat.
 *
 * The event bus decouples inbound message ingestion from agent execution
 * and outbound delivery. This enables:
 *
 *   1. Horizontal scaling — multiple gateway instances share the bus
 *   2. Async tool execution — agent jobs queued independently of chat delivery
 *   3. Dead-letter handling — failed deliveries retried without blocking
 *   4. Observability — every event carries a correlation trace ID
 *
 * Supported transports (pluggable via EventBusFactory):
 *   - Redis Streams (default, production)
 *   - NATS JetStream (cloud-native)
 *   - In-memory (testing / single-instance)
 */

// ---------------------------------------------------------------------------
// Core event envelope
// ---------------------------------------------------------------------------

export type EventEnvelope<T = unknown> = {
  /** Globally unique event ID (nanoid / UUID v4) */
  id: string;
  /** ISO-8601 timestamp when the event was created */
  ts: string;
  /** Logical event type (e.g. "rocketchat.message.inbound") */
  type: string;
  /** Source account / stream identifier */
  source: string;
  /** Correlation ID for distributed tracing (propagated across hops) */
  traceId: string;
  /** The typed payload */
  data: T;
  /** Retry attempt counter (0 = first attempt) */
  attempt: number;
};

// ---------------------------------------------------------------------------
// Specific event payloads
// ---------------------------------------------------------------------------

export type RocketChatInboundMessageEvent = {
  accountId: string;
  roomId: string;
  messageId: string;
  threadId?: string;
  senderId: string;
  senderUsername: string;
  text: string;
  chatType: "direct" | "channel" | "group";
  timestamp: number;
};

export type RocketChatOutboundDeliveryEvent = {
  accountId: string;
  roomId: string;
  text: string;
  replyToId?: string;
  traceId: string;
  sessionKey: string;
};

export type AgentExecutionEvent = {
  sessionKey: string;
  agentId?: string;
  skillName?: string;
  text: string;
  channel: string;
  accountId: string;
  roomId: string;
  traceId: string;
};

export type DeliveryFailureEvent = {
  originalEvent: EventEnvelope;
  error: string;
  failedAt: string;
  attempt: number;
};

// ---------------------------------------------------------------------------
// Stream / subject names
// ---------------------------------------------------------------------------

export const STREAM_NAMES = {
  INBOUND: "rocketchat.inbound",
  OUTBOUND: "rocketchat.outbound",
  AGENT_EXEC: "openclaw.agent.exec",
  DLQ: "openclaw.dlq",
  METRICS: "openclaw.metrics",
} as const;

export type StreamName = (typeof STREAM_NAMES)[keyof typeof STREAM_NAMES];

// ---------------------------------------------------------------------------
// Publisher / Subscriber interfaces
// ---------------------------------------------------------------------------

export type PublishOptions = {
  /** Stream / subject to publish to */
  stream: string;
  /** Optional message key for partitioning (e.g. roomId) */
  key?: string;
};

export type SubscribeOptions = {
  /** Stream / subject to subscribe to */
  stream: string;
  /** Consumer group name (for competing consumers / load balancing) */
  group?: string;
  /** Start from the beginning of the stream (default: latest) */
  fromBeginning?: boolean;
  /** Max messages to process concurrently */
  concurrency?: number;
};

export type AckFn = () => Promise<void>;
export type NackFn = (error?: Error) => Promise<void>;

export type MessageHandler<T = unknown> = (
  envelope: EventEnvelope<T>,
  ack: AckFn,
  nack: NackFn,
) => Promise<void>;

/**
 * Core event bus interface implemented by each transport adapter.
 */
export interface IEventBus {
  /** Publish an event envelope to the given stream. */
  publish<T>(payload: T, opts: PublishOptions): Promise<void>;

  /** Subscribe a handler to a stream with at-least-once delivery semantics. */
  subscribe<T>(opts: SubscribeOptions, handler: MessageHandler<T>): Promise<void>;

  /** Graceful shutdown — drain in-flight messages then disconnect. */
  close(): Promise<void>;

  /** Transport health check. */
  ping(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type EventBusConfig = {
  /** Transport type. Default: "memory" */
  transport: "redis" | "nats" | "memory";
  /** Connection URL (e.g. "redis://localhost:6379" or "nats://localhost:4222") */
  url?: string;
  /** Stream name prefix. Default: "openclaw" */
  prefix?: string;
  /** Max retry attempts before routing to DLQ. Default: 3 */
  maxRetries?: number;
  /** Backoff base delay in ms. Default: 1000 */
  retryBackoffMs?: number;
};

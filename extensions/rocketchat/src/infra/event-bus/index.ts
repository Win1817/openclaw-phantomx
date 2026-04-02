/**
 * infra/event-bus/index.ts
 *
 * Factory that selects the right transport based on config,
 * plus high-level publish helpers used by the Rocket.Chat monitor.
 *
 * Usage:
 *   import { createEventBus, publishInboundMessage } from "./infra/event-bus/index.js";
 *
 *   const bus = createEventBus({ transport: "redis", url: "redis://localhost:6379" });
 *   await publishInboundMessage(bus, { accountId, roomId, text, ... });
 */

import { MemoryEventBus } from "./memory.js";
import { RedisEventBus } from "./redis.js";
import {
  STREAM_NAMES,
  type AgentExecutionEvent,
  type EventBusConfig,
  type IEventBus,
  type RocketChatInboundMessageEvent,
  type RocketChatOutboundDeliveryEvent,
} from "./types.js";

export * from "./types.js";
export { MemoryEventBus } from "./memory.js";
export { RedisEventBus } from "./redis.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an event bus transport from config.
 *
 * Selects:
 *   - "redis"  → RedisEventBus (production, requires redis npm pkg + Redis server)
 *   - "memory" → MemoryEventBus (default, zero deps)
 *   - "nats"   → future transport (not yet implemented; falls back to memory)
 */
export async function createEventBus(cfg: EventBusConfig): Promise<IEventBus> {
  switch (cfg.transport) {
    case "redis": {
      const bus = new RedisEventBus(cfg);
      // Connect is called separately to allow error handling at the call site
      await (bus as unknown as { connect(): Promise<void> }).connect();
      return bus;
    }

    case "nats":
      // NATS JetStream transport — placeholder for future implementation
      console.warn(
        "[EventBus] NATS transport not yet implemented — falling back to memory bus",
      );
      return new MemoryEventBus(cfg);

    case "memory":
    default:
      return new MemoryEventBus(cfg);
  }
}

// ---------------------------------------------------------------------------
// High-level publish helpers
// ---------------------------------------------------------------------------

/**
 * Publish an inbound Rocket.Chat message to the event bus.
 * Called by the DDP monitor after the security gate passes.
 */
export async function publishInboundMessage(
  bus: IEventBus,
  event: RocketChatInboundMessageEvent,
): Promise<void> {
  await bus.publish(event, {
    stream: STREAM_NAMES.INBOUND,
    key: event.roomId,
  });
}

/**
 * Publish an outbound delivery task to the event bus.
 * Called by the agent reply pipeline when it has a response ready.
 */
export async function publishOutboundDelivery(
  bus: IEventBus,
  event: RocketChatOutboundDeliveryEvent,
): Promise<void> {
  await bus.publish(event, {
    stream: STREAM_NAMES.OUTBOUND,
    key: event.roomId,
  });
}

/**
 * Publish an agent execution job to the event bus.
 * Decouples message ingestion from agent execution, enabling async job queues.
 */
export async function publishAgentExecution(
  bus: IEventBus,
  event: AgentExecutionEvent,
): Promise<void> {
  await bus.publish(event, {
    stream: STREAM_NAMES.AGENT_EXEC,
    key: event.sessionKey,
  });
}

// ---------------------------------------------------------------------------
// Singleton bus manager (optional — avoids passing bus through every call)
// ---------------------------------------------------------------------------

let _globalBus: IEventBus | null = null;

export function setGlobalEventBus(bus: IEventBus): void {
  _globalBus = bus;
}

export function getGlobalEventBus(): IEventBus | null {
  return _globalBus;
}

/**
 * Try to publish inbound event via the global bus.
 * No-ops gracefully if no bus is configured (memory-only deployments).
 */
export async function tryPublishInbound(
  event: RocketChatInboundMessageEvent,
): Promise<void> {
  const bus = getGlobalEventBus();
  if (!bus) return;
  try {
    await publishInboundMessage(bus, event);
  } catch (err) {
    console.error("[EventBus] tryPublishInbound failed:", err);
  }
}

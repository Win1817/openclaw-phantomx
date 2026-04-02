/**
 * rocketchat/send.ts
 *
 * Outbound message delivery for the Rocket.Chat channel plugin.
 * Handles text chunking, threading, attachment formatting,
 * and activity recording — mirroring the Mattermost send layer.
 */

import { getRocketChatRuntime } from "../runtime.js";
import { resolveRocketChatAccount } from "./accounts.js";
import { RocketChatClient, type RCAttachment, type RCSendResult } from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RocketChatSendOpts = {
  cfg?: OpenClawConfig;
  accountId?: string | null;
  authToken?: string;
  userId?: string;
  serverUrl?: string;
  replyToId?: string | null;   // tmid — thread parent message id
  attachments?: RCAttachment[];
  mediaUrl?: string;
  /** Pre-built alias to display instead of bot username */
  alias?: string;
  emoji?: string;
};

export type RocketChatSendResult = {
  messageId: string;
  roomId: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recordOutboundActivity(accountId: string): void {
  try {
    const runtime = getRocketChatRuntime();
    runtime.channel.activity.record({
      channel: "rocketchat",
      accountId,
      direction: "outbound",
    });
  } catch {
    // runtime not yet initialized — safe to swallow during startup
  }
}

function buildRocketChatClient(opts: {
  serverUrl: string;
  authToken: string;
  userId: string;
  timeoutMs?: number;
}): RocketChatClient {
  return new RocketChatClient({
    baseUrl: opts.serverUrl,
    authToken: opts.authToken,
    userId: opts.userId,
    timeoutMs: opts.timeoutMs,
  });
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    // Try to break on a newline near the limit
    let cutAt = remaining.lastIndexOf("\n", limit);
    if (cutAt < limit * 0.5) cutAt = limit;
    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Core send
// ---------------------------------------------------------------------------

export async function sendMessageRocketChat(
  roomId: string,
  text: string,
  opts: RocketChatSendOpts = {},
): Promise<RocketChatSendResult> {
  const runtime = getRocketChatRuntime();
  const logger = runtime.logging.getChildLogger({ module: "rocketchat.send" });

  const cfg = opts.cfg ?? runtime.cfg;
  const accountId = opts.accountId ?? "default";
  const account = resolveRocketChatAccount({ cfg, accountId });

  const authToken = opts.authToken ?? account.authToken;
  const userId = opts.userId ?? account.userId;
  const serverUrl = opts.serverUrl ?? account.serverUrl;

  if (!authToken || !userId || !serverUrl) {
    throw new Error(
      `rocketchat.send: missing credentials for account "${accountId}" — ` +
        "ensure authToken, userId, and serverUrl are configured.",
    );
  }

  const client = buildRocketChatClient({
    serverUrl,
    authToken,
    userId,
    timeoutMs: account.restTimeoutMs,
  });

  const chunkLimit = account.textChunkLimit ?? 4000;
  const chunks = chunkText(text, chunkLimit);

  let lastResult: RCSendResult | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const payload = {
      roomId,
      text: chunk,
      tmid: opts.replyToId ?? undefined,
      alias: opts.alias,
      emoji: opts.emoji,
      // Only attach on the last chunk
      attachments: i === chunks.length - 1 ? opts.attachments : undefined,
    };

    try {
      lastResult = await client.sendMessage(payload);
      recordOutboundActivity(accountId);
      logger.debug(
        { roomId, messageId: lastResult._id, chunk: i + 1, total: chunks.length },
        "sent Rocket.Chat message chunk",
      );
    } catch (err) {
      logger.error(
        { err, roomId, accountId, chunk: i + 1 },
        "failed to send Rocket.Chat message chunk",
      );
      throw err;
    }
  }

  if (!lastResult) throw new Error("rocketchat.send: no chunks produced");

  return {
    messageId: lastResult._id,
    roomId: lastResult.rid,
  };
}

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

export async function sendRocketChatTyping(
  roomId: string,
  botUsername: string,
  opts: { serverUrl: string; authToken: string; userId: string },
): Promise<void> {
  // Rocket.Chat typing via REST: POST /api/v1/chat.sendMessage with empty text
  // is not ideal; use the DDP method instead
  try {
    const client = buildRocketChatClient(opts);
    // DDP method: "stream-notify-room" — but REST fallback is to call
    // the /api/v1/rooms.setTyping endpoint (Rocket.Chat 6.x+)
    await fetch(`${opts.serverUrl}/api/v1/rooms.setTyping`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": opts.authToken,
        "X-User-Id": opts.userId,
      },
      body: JSON.stringify({ roomId, typing: true }),
    });
  } catch {
    // Typing indicators are best-effort
  }
}

// ---------------------------------------------------------------------------
// React to message
// ---------------------------------------------------------------------------

export async function reactToRocketChatMessage(params: {
  roomId: string;
  messageId: string;
  emoji: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<void> {
  const account = resolveRocketChatAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });

  if (!account.authToken || !account.userId || !account.serverUrl) {
    throw new Error("rocketchat.react: missing credentials");
  }

  const client = buildRocketChatClient({
    serverUrl: account.serverUrl,
    authToken: account.authToken,
    userId: account.userId,
    timeoutMs: account.restTimeoutMs,
  });

  await client.setReaction(params.emoji, params.messageId);
  recordOutboundActivity(params.accountId ?? "default");
}

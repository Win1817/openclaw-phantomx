/**
 * rocketchat/monitor.ts
 *
 * Real-time monitor for Rocket.Chat via DDP (WebSocket).
 *
 * Responsibilities:
 *   - Connect to Rocket.Chat DDP endpoint and authenticate
 *   - Subscribe to relevant room streams
 *   - Gate inbound messages (mention, chatmode, security)
 *   - Route messages to the OpenClaw agent reply pipeline
 *   - Manage reconnection, status sink, and lifecycle signals
 *
 * Architecture:
 *   DDPClient (ws) → monitorRocketChatProvider → createChannelReplyPipeline
 */

import { getRocketChatRuntime } from "../runtime.js";
import {
  isRocketChatAccountConfigured,
  resolveRocketChatAccount,
  resolveRocketChatReplyToMode,
  type ResolvedRocketChatAccount,
} from "./accounts.js";
import { RocketChatClient } from "./client.js";
import { DDPClient, type RocketChatMessage } from "./ddp-client.js";
import { sendMessageRocketChat, sendRocketChatTyping } from "./send.ts";
import { runInboundSecurityGate, checkSenderAllowed } from "./security.js";
import type {
  ChannelAccountSnapshot,
  ChatType,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "./runtime-api.js";
import {
  createChannelReplyPipeline,
  logInboundDrop,
  createChannelPairingController,
} from "./runtime-api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MonitorRocketChatOpts = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

type RocketChatRoomType = "c" | "d" | "p" | "l";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRoomTypeToChatType(t: RocketChatRoomType): ChatType {
  if (t === "d") return "direct";
  if (t === "p") return "group";
  return "channel";
}

function buildDDPUrl(serverUrl: string): string {
  // Convert https://chat.example.com → wss://chat.example.com/websocket
  return serverUrl
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    .replace(/\/$/, "") + "/websocket";
}

function isBotMessage(msg: RocketChatMessage, botUserId: string): boolean {
  return msg.u._id === botUserId;
}

function isMentioned(
  msg: RocketChatMessage,
  botUserId: string,
  botUsername: string,
): boolean {
  if (!msg.mentions) return false;
  return msg.mentions.some(
    (m) => m._id === botUserId || m.username === botUsername,
  );
}

function isOncharTrigger(text: string, prefixes: string[]): boolean {
  return prefixes.some((p) => text.trimStart().startsWith(p));
}

function stripOncharPrefix(text: string, prefixes: string[]): string {
  for (const p of prefixes) {
    if (text.trimStart().startsWith(p)) {
      return text.trimStart().slice(p.length).trimStart();
    }
  }
  return text;
}

function shouldRespondToMessage(
  msg: RocketChatMessage,
  account: ResolvedRocketChatAccount,
  chatType: ChatType,
  meUserId: string,
): { respond: boolean; text: string } {
  const rawText = msg.msg ?? "";

  switch (account.chatmode) {
    case "onmessage":
      return { respond: true, text: rawText };

    case "onchar": {
      const prefixes = account.oncharPrefixes ?? [">", "!"];
      if (isOncharTrigger(rawText, prefixes)) {
        return { respond: true, text: stripOncharPrefix(rawText, prefixes) };
      }
      return { respond: false, text: rawText };
    }

    case "oncall":
    default: {
      if (chatType === "direct") return { respond: true, text: rawText };
      if (isMentioned(msg, meUserId, account.botUsername ?? "")) {
        // Strip the @mention from text before forwarding
        const stripped = rawText.replace(
          new RegExp(`@${account.botUsername ?? ""}\\b`, "gi"),
          "",
        ).trim();
        return { respond: true, text: stripped };
      }
      return { respond: false, text: rawText };
    }
  }
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

export async function monitorRocketChatProvider(
  opts: MonitorRocketChatOpts,
): Promise<void> {
  const runtime = getRocketChatRuntime();
  const logger = runtime.logging.getChildLogger({ module: "rocketchat.monitor" });
  const cfg = opts.config ?? runtime.cfg;
  const accountId = opts.accountId ?? "default";
  const account = resolveRocketChatAccount({ cfg, accountId });

  if (!isRocketChatAccountConfigured(account)) {
    logger.warn({ accountId }, "Rocket.Chat account not fully configured — skipping monitor");
    opts.statusSink?.({ connected: false, error: "Missing credentials" });
    return;
  }

  const { serverUrl, authToken, userId: botUserId } = account;
  const ddpUrl = buildDDPUrl(serverUrl!);

  logger.info({ accountId, ddpUrl }, "Starting Rocket.Chat monitor");
  opts.statusSink?.({ connecting: true });

  // REST client for lookups
  const restClient = new RocketChatClient({
    baseUrl: serverUrl!,
    authToken: authToken!,
    userId: botUserId!,
    timeoutMs: account.restTimeoutMs,
  });

  // Resolve bot's own username (for mention detection)
  let botUsername = account.botUsername;
  if (!botUsername) {
    try {
      const me = await restClient.getMe();
      botUsername = me.username;
      logger.debug({ botUsername }, "Resolved bot username");
    } catch (err) {
      logger.warn({ err }, "Could not resolve bot username — mention detection may be degraded");
    }
  }

  // Room-type cache (room_id → RoomType)
  const roomTypeCache = new Map<string, RocketChatRoomType>();

  async function getRoomType(roomId: string): Promise<RocketChatRoomType> {
    if (roomTypeCache.has(roomId)) return roomTypeCache.get(roomId)!;
    try {
      const room = await restClient.getRoomInfo(roomId);
      roomTypeCache.set(roomId, room.t);
      return room.t;
    } catch {
      return "c"; // assume public channel on lookup failure
    }
  }

  // Reply pipeline — routes agent output back to Rocket.Chat
  const replyPipeline = createChannelReplyPipeline({
    channel: "rocketchat",
    accountId,
    async deliver(roomId: string, payload: ReplyPayload) {
      const text = typeof payload === "string" ? payload : payload.text ?? "";
      const tmid =
        resolveRocketChatReplyToMode(account) !== "off"
          ? (payload as { replyToId?: string }).replyToId
          : undefined;
      await sendMessageRocketChat(roomId, text, {
        cfg,
        accountId,
        replyToId: tmid,
      });
    },
  });

  // DDP client
  const ddp = new DDPClient({
    url: ddpUrl,
    reconnectDelayMs: account.reconnectDelayMs,
    maxReconnectAttempts: account.maxReconnectAttempts,
    pingIntervalMs: account.pingIntervalMs,
    onError: (err) => {
      logger.error({ err }, "Rocket.Chat DDP error");
      opts.statusSink?.({ connected: false, error: String(err) });
    },
    onReconnect: () => {
      logger.info({ accountId }, "Rocket.Chat DDP reconnected");
      opts.statusSink?.({ connected: true, error: undefined });
    },
    async onMessage(msg: RocketChatMessage, roomId: string) {
      // Skip bot's own messages
      if (isBotMessage(msg, botUserId!)) return;
      // Skip system messages (joins, leaves, etc.)
      if (msg.t) return;

      await handleInboundMessage(msg, roomId);
    },
  });

  // Abort signal support
  opts.abortSignal?.addEventListener("abort", () => {
    logger.info({ accountId }, "Abort signal received — stopping Rocket.Chat monitor");
    ddp.destroy();
  });

  // ------------------------------------------------------------------
  // Connect + authenticate
  // ------------------------------------------------------------------
  try {
    await ddp.connect();
  } catch (err) {
    logger.error({ err, accountId }, "Rocket.Chat DDP initial connect failed");
    opts.statusSink?.({ connected: false, error: String(err) });
    return;
  }

  // DDP login with auth token
  try {
    await ddp.call("login", {
      resume: authToken,
    });
    logger.info({ accountId }, "Rocket.Chat DDP authenticated");
  } catch (err) {
    logger.error({ err, accountId }, "Rocket.Chat DDP authentication failed");
    opts.statusSink?.({ connected: false, error: `Auth failed: ${err}` });
    ddp.destroy();
    return;
  }

  // Subscribe to __my_messages__ (all rooms the bot is in)
  try {
    ddp.subscribe("__my_messages__");
    logger.info({ accountId }, "Subscribed to Rocket.Chat room stream");
  } catch (err) {
    logger.error({ err }, "Rocket.Chat DDP subscribe failed");
  }

  opts.statusSink?.({ connected: true, error: undefined });
  logger.info({ accountId, botUsername }, "Rocket.Chat monitor active");

  // ------------------------------------------------------------------
  // Message handler
  // ------------------------------------------------------------------
  async function handleInboundMessage(
    msg: RocketChatMessage,
    roomId: string,
  ): Promise<void> {
    // Security gate
    const gate = runInboundSecurityGate(msg, account);
    if (!gate.pass) {
      logInboundDrop({ channel: "rocketchat", accountId, reason: gate.reason });
      return;
    }

    const text = gate.sanitised;
    const roomType = await getRoomType(roomId);
    const chatType = mapRoomTypeToChatType(roomType);

    // Sender allowlist check for DMs
    if (chatType === "direct") {
      const senderCheck = checkSenderAllowed(
        msg.u._id,
        msg.u.username,
        account.config.allowFrom,
      );
      if (!senderCheck.allowed) {
        logInboundDrop({ channel: "rocketchat", accountId, reason: senderCheck.reason });
        return;
      }
    }

    // Chatmode gate
    const { respond, text: gatedText } = shouldRespondToMessage(
      msg,
      account,
      chatType,
      botUserId!,
    );
    if (!respond) return;

    // Thread context
    const threadId = msg.tmid ?? msg._id;
    const sessionKey = `rocketchat:${accountId}:${roomId}:${threadId}`;

    logger.debug(
      { roomId, chatType, messageId: msg._id, sessionKey },
      "Routing inbound Rocket.Chat message",
    );

    // Typing indicator (best-effort)
    if (botUsername) {
      sendRocketChatTyping(roomId, botUsername, {
        serverUrl: serverUrl!,
        authToken: authToken!,
        userId: botUserId!,
      }).catch(() => {});
    }

    // Forward to agent reply pipeline
    try {
      await replyPipeline.handle({
        sessionKey,
        roomId,
        text: gatedText,
        from: msg.u.username,
        fromId: msg.u._id,
        chatType,
        messageId: msg._id,
        threadId: msg.tmid,
        channel: "rocketchat",
        accountId,
        timestamp: msg.ts?.$date ?? Date.now(),
      });
    } catch (err) {
      logger.error({ err, roomId, sessionKey }, "Error in Rocket.Chat reply pipeline");
    }
  }

  // Keep the monitor alive — the ddp client manages reconnection internally.
  // This promise resolves only when aborted or max reconnects exceeded.
  await new Promise<void>((resolve) => {
    ddp.on("max_reconnect_exceeded", () => {
      logger.error({ accountId }, "Rocket.Chat DDP max reconnect attempts exceeded");
      opts.statusSink?.({ connected: false, error: "Max reconnect attempts exceeded" });
      resolve();
    });
    opts.abortSignal?.addEventListener("abort", resolve);
  });
}

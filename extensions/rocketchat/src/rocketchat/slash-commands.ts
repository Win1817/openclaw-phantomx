/**
 * rocketchat/slash-commands.ts
 *
 * Slash-command integration for Rocket.Chat.
 *
 * Rocket.Chat supports slash commands via either:
 *   A) Apps Engine (server-side extension — not applicable here)
 *   B) Incoming webhooks / outgoing webhooks triggered by slash commands
 *
 * This module handles the HTTP callback that Rocket.Chat calls when a
 * configured outgoing webhook slash command fires, then routes the
 * invocation to the appropriate OpenClaw skill or agent session.
 *
 * Flow:
 *   User types /claw <skill> [args]
 *   → Rocket.Chat POSTs to <gateway>/rocketchat/slash/<accountId>
 *   → This handler validates, routes, triggers the agent
 *   → Agent reply is delivered back to the originating room
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getRocketChatRuntime } from "../runtime.js";
import { resolveRocketChatAccount } from "./accounts.js";
import { sendMessageRocketChat } from "./send.ts";
import type { OpenClawConfig } from "./runtime-api.js";
import { createChannelReplyPipeline } from "./runtime-api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RocketChatSlashPayload = {
  token: string;
  command: string;
  text?: string;
  response_url?: string;
  trigger_id?: string;
  user_id: string;
  user_name: string;
  channel_id: string;
  channel_name?: string;
  team_id?: string;
  team_domain?: string;
};

export type SlashCommandContext = {
  cfg: OpenClawConfig;
  accountId: string;
  payload: RocketChatSlashPayload;
};

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/**
 * Register the slash-command HTTP route on the gateway.
 * Called from index.ts during plugin bootstrap.
 */
export function registerRocketChatSlashCommandRoute(api: {
  registerHttpRoute(path: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void;
}): void {
  const runtime = getRocketChatRuntime();
  const logger = runtime.logging.getChildLogger({ module: "rocketchat.slash" });

  api.registerHttpRoute("/rocketchat/slash/:accountId", async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    // Parse body
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const payload = parseSlashPayload(body);
        if (!payload) {
          res.writeHead(400);
          res.end("Bad Request");
          return;
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        const segments = url.pathname.split("/");
        const accountId = segments[segments.length - 1] ?? "default";

        const cfg = runtime.cfg;
        const account = resolveRocketChatAccount({ cfg, accountId });

        // Verify token if configured
        const expectedToken = account.config.commands?.callbackPath
          ? process.env[`ROCKETCHAT_SLASH_TOKEN_${accountId.toUpperCase()}`]
          : undefined;
        if (expectedToken && payload.token !== expectedToken) {
          logger.warn({ accountId }, "Slash command token mismatch");
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        // Immediate 200 — process async
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "⚙️ Processing…" }));

        await handleSlashCommand({ cfg, accountId, payload });
      } catch (err) {
        logger.error({ err }, "Slash command handler error");
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

async function handleSlashCommand(ctx: SlashCommandContext): Promise<void> {
  const runtime = getRocketChatRuntime();
  const logger = runtime.logging.getChildLogger({ module: "rocketchat.slash" });
  const { cfg, accountId, payload } = ctx;

  const commandText = payload.text?.trim() ?? "";
  const roomId = payload.channel_id;
  const userId = payload.user_id;
  const username = payload.user_name;

  logger.info(
    { command: payload.command, text: commandText, roomId, username },
    "Received Rocket.Chat slash command",
  );

  // Route: /claw skill <skillName> [args]
  //        /claw agent <agentId> [message]
  //        /claw help
  const [subCommand, ...rest] = commandText.split(/\s+/);
  const args = rest.join(" ");

  const sessionKey = `rocketchat:slash:${accountId}:${roomId}:${userId}`;

  const replyPipeline = createChannelReplyPipeline({
    channel: "rocketchat",
    accountId,
    async deliver(targetRoomId: string, payload) {
      const text = typeof payload === "string" ? payload : payload.text ?? "";
      await sendMessageRocketChat(targetRoomId, text, { cfg, accountId });
    },
  });

  switch (subCommand?.toLowerCase()) {
    case "skill": {
      const skillName = args.trim();
      if (!skillName) {
        await sendMessageRocketChat(roomId, "Usage: `/claw skill <skillName> [args]`", {
          cfg,
          accountId,
        });
        return;
      }
      await replyPipeline.handle({
        sessionKey,
        roomId,
        text: `Execute skill: ${skillName}`,
        from: username,
        fromId: userId,
        chatType: "channel",
        messageId: `slash-${Date.now()}`,
        channel: "rocketchat",
        accountId,
        timestamp: Date.now(),
        slashCommand: true,
        skillName,
      });
      break;
    }

    case "agent": {
      const [agentId, ...msgParts] = args.split(/\s+/);
      const message = msgParts.join(" ");
      await replyPipeline.handle({
        sessionKey: `rocketchat:slash:${accountId}:${roomId}:agent:${agentId}`,
        roomId,
        text: message || "(agent invoked via slash command)",
        from: username,
        fromId: userId,
        chatType: "channel",
        messageId: `slash-${Date.now()}`,
        channel: "rocketchat",
        accountId,
        timestamp: Date.now(),
        slashCommand: true,
        targetAgentId: agentId,
      });
      break;
    }

    case "help":
    default: {
      const helpText = [
        "**OpenClaw Rocket.Chat Commands**",
        "• `/claw skill <name>` — run a skill",
        "• `/claw agent <id> [message]` — invoke a specific agent",
        "• `/claw help` — show this message",
      ].join("\n");
      await sendMessageRocketChat(roomId, helpText, { cfg, accountId });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSlashPayload(body: string): RocketChatSlashPayload | null {
  try {
    // Try JSON first
    return JSON.parse(body) as RocketChatSlashPayload;
  } catch {
    // Fall back to URL-encoded
    try {
      const params = new URLSearchParams(body);
      const obj: Record<string, string> = {};
      for (const [k, v] of params) obj[k] = v;
      if (!obj.user_id || !obj.channel_id) return null;
      return obj as unknown as RocketChatSlashPayload;
    } catch {
      return null;
    }
  }
}

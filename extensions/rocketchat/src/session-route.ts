/**
 * session-route.ts
 *
 * Outbound session routing for the Rocket.Chat plugin.
 * Maps a target string → session key + chat-type context
 * so OpenClaw can associate replies with the right agent session.
 */

import {
  buildChannelOutboundSessionRoute,
  resolveThreadSessionKeys,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { normalizeOutboundThreadId } from "openclaw/plugin-sdk/routing";

export function resolveRocketChatOutboundSessionRoute(
  params: ChannelOutboundSessionRouteParams,
) {
  let trimmed = stripChannelTargetPrefix(params.target, "rocketchat");
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  const resolvedKind = params.resolvedTarget?.kind;

  const isUser =
    resolvedKind === "user" ||
    (resolvedKind !== "channel" &&
      resolvedKind !== "group" &&
      (lower.startsWith("user:") || trimmed.startsWith("@")));

  if (trimmed.startsWith("@")) {
    trimmed = trimmed.slice(1).trim();
  }

  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) return null;

  const baseRoute = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "rocketchat",
    accountId: params.accountId,
    peer: {
      kind: isUser ? "direct" : "channel",
      id: rawId,
    },
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `rocketchat:${rawId}` : `rocketchat:room:${rawId}`,
    to: isUser ? `user:${rawId}` : `room:${rawId}`,
  });

  const threadId = normalizeOutboundThreadId(params.replyToId ?? params.threadId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: baseRoute.baseSessionKey,
    threadId,
  });

  return {
    ...baseRoute,
    sessionKey: threadKeys.sessionKey,
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

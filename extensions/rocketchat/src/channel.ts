/**
 * channel.ts
 *
 * Main ChannelPlugin implementation for Rocket.Chat.
 *
 * This is the root export consumed by OpenClaw's plugin registry.
 * It wires together all adapters — config, gateway, outbound, security,
 * status, threading, messaging, actions, pairing — into a single
 * production-grade plugin object.
 */

import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { createLoggedPairingApprovalNotifier } from "openclaw/plugin-sdk/channel-pairing";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { rocketchatApprovalAuth } from "./approval-auth.js";
import { RocketChatChannelConfigSchema } from "./config-schema.js";
import {
  isRocketChatAccountConfigured,
  listRocketChatAccountIds,
  resolveDefaultRocketChatAccountId,
  resolveRocketChatAccount,
  resolveRocketChatReplyToMode,
  type ResolvedRocketChatAccount,
} from "./rocketchat/accounts.js";
import { monitorRocketChatProvider } from "./rocketchat/monitor.js";
import { probeRocketChat } from "./rocketchat/probe.js";
import { reactToRocketChatMessage, sendMessageRocketChat } from "./rocketchat/send.ts";
import {
  formatRocketChatAllowEntry,
  looksLikeRocketChatId,
  normalizeRocketChatAllowEntry,
  normalizeRocketChatMessagingTarget,
} from "./normalize.js";
import {
  chunkTextForOutbound,
  createAccountStatusSink,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
} from "./runtime-api.js";
import { getRocketChatRuntime } from "./runtime.js";
import { resolveRocketChatOutboundSessionRoute } from "./session-route.js";
import { rocketchatSetupAdapter } from "./setup-core.js";

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  id: "rocketchat",
  label: "Rocket.Chat",
  selectionLabel: "Rocket.Chat (plugin)",
  detailLabel: "Rocket.Chat Bot",
  docsPath: "/channels/rocketchat",
  docsLabel: "rocketchat",
  blurb:
    "self-hosted team chat with real-time DDP, slash commands, multi-agent orchestration, and event-bus scaling.",
  systemImage: "bubble.left.and.bubble.right",
  order: 64,
  quickstartAllowFrom: true,
} as const;

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

const rocketchatSecurityAdapter = createRestrictSendersChannelSecurity<ResolvedRocketChatAccount>({
  channelKey: "rocketchat",
  resolveDmPolicy: (account) => account.config.dmPolicy,
  resolveDmAllowFrom: (account) => account.config.allowFrom,
  resolveGroupPolicy: (account) => account.config.groupPolicy,
  surface: "Rocket.Chat channels",
  openScope: "any member",
  groupPolicyPath: "channels.rocketchat.groupPolicy",
  groupAllowFromPath: "channels.rocketchat.groupAllowFrom",
  policyPathSuffix: "dmPolicy",
  normalizeDmEntry: (raw) => normalizeRocketChatAllowEntry(raw),
});

// ---------------------------------------------------------------------------
// Message actions (send + react)
// ---------------------------------------------------------------------------

function describeRocketChatMessageTool({
  cfg,
}: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0]): ChannelMessageToolDiscovery {
  const enabledAccounts = listRocketChatAccountIds(cfg)
    .map((accountId) => resolveRocketChatAccount({ cfg, accountId }))
    .filter((a) => a.enabled)
    .filter((a) => isRocketChatAccountConfigured(a));

  const actions: ChannelMessageActionName[] = [];
  if (enabledAccounts.length > 0) {
    actions.push("send");
    actions.push("react");
  }

  return {
    actions,
    capabilities: [],
    schema: null,
  };
}

function readTrimmedString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const rocketchatMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeRocketChatMessageTool,
  supportsAction: ({ action }) => action === "send" || action === "react",
  handleAction: async ({ action, params, cfg, accountId }) => {
    const resolvedAccountId = accountId ?? resolveDefaultRocketChatAccountId(cfg);

    // ---- React -----------------------------------------------------------
    if (action === "react") {
      const messageId = readTrimmedString(params.messageId);
      const roomId = readTrimmedString(params.roomId ?? params.to);
      const emoji = readTrimmedString(params.emoji)?.replace(/^:+|:+$/g, "");

      if (!messageId) throw new Error("rocketchat react: messageId is required");
      if (!roomId) throw new Error("rocketchat react: roomId is required");
      if (!emoji) throw new Error("rocketchat react: emoji is required");

      await reactToRocketChatMessage({
        roomId,
        messageId,
        emoji: `:${emoji}:`,
        cfg,
        accountId: resolvedAccountId,
      });

      return {
        content: [{ type: "text" as const, text: `Reacted :${emoji}: on message ${messageId}` }],
        details: {},
      };
    }

    // ---- Send ------------------------------------------------------------
    if (action !== "send") throw new Error(`Unsupported Rocket.Chat action: ${action}`);

    const to = readTrimmedString(params.to ?? params.target ?? params.roomId);
    if (!to) throw new Error("rocketchat send: target room/user (to) is required");

    const message = typeof params.message === "string" ? params.message : "";
    const replyToId =
      readTrimmedString(params.replyToId) ?? readTrimmedString(params.threadId);
    const mediaUrl = readTrimmedString(params.media);

    const result = await sendMessageRocketChat(to, message, {
      cfg,
      accountId: resolvedAccountId,
      replyToId,
      mediaUrl,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            channel: "rocketchat",
            messageId: result.messageId,
            roomId: result.roomId,
          }),
        },
      ],
      details: {},
    };
  },
};

// ---------------------------------------------------------------------------
// Config adapter
// ---------------------------------------------------------------------------

const rocketchatConfigAdapter = createScopedChannelConfigAdapter<ResolvedRocketChatAccount>({
  sectionKey: "rocketchat",
  listAccountIds: listRocketChatAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveRocketChatAccount),
  defaultAccountId: resolveDefaultRocketChatAccountId,
  clearBaseFields: ["authToken", "userId", "serverUrl", "name"],
  resolveAllowFrom: (account: ResolvedRocketChatAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: formatRocketChatAllowEntry,
    }),
});

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const rocketchatPlugin: ChannelPlugin<ResolvedRocketChatAccount> =
  createChatChannelPlugin({
    base: {
      id: "rocketchat",
      meta: { ...meta },
      setup: rocketchatSetupAdapter,
      capabilities: {
        chatTypes: ["direct", "channel", "group", "thread"],
        reactions: true,
        threads: true,
        media: false,
        nativeCommands: true,
      },
      streaming: {
        blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
      },
      reload: { configPrefixes: ["channels.rocketchat"] },
      configSchema: RocketChatChannelConfigSchema,
      config: {
        ...rocketchatConfigAdapter,
        isConfigured: (account) => isRocketChatAccountConfigured(account),
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: isRocketChatAccountConfigured(account),
            extra: {
              authTokenSource: account.authTokenSource,
              serverUrl: account.serverUrl,
            },
          }),
      },
      auth: rocketchatApprovalAuth,
      groups: {
        resolveRequireMention: (params) => {
          const account = resolveRocketChatAccount({
            cfg: params.cfg,
            accountId: params.accountId,
          });
          return account.requireMention ?? true;
        },
      },
      actions: rocketchatMessageActions,
      messaging: {
        normalizeTarget: normalizeRocketChatMessagingTarget,
        resolveOutboundSessionRoute: (params) =>
          resolveRocketChatOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeRocketChatId,
          hint: "<roomId|room:ID|user:ID|@username>",
          resolveTarget: async ({ input }) => {
            const trimmed = input.trim();
            if (!trimmed) return null;
            // Room ID or prefixed form → direct route
            if (looksLikeRocketChatId(trimmed)) {
              const rawId = trimmed.replace(/^(room|channel|user):/i, "");
              return { to: rawId, kind: "channel", source: "id" };
            }
            return null;
          },
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedRocketChatAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
          connected: false,
          lastConnectedAt: null,
          lastDisconnect: null,
        }),
        buildChannelSummary: ({ snapshot }) =>
          buildPassiveProbedChannelStatusSummary(snapshot, {
            botTokenSource: snapshot.authTokenSource ?? "none",
            connected: snapshot.connected ?? false,
            baseUrl: snapshot.serverUrl ?? null,
          }),
        probeAccount: async ({ account, timeoutMs }) => {
          if (!isRocketChatAccountConfigured(account)) {
            return { ok: false, error: "credentials not configured" };
          }
          return probeRocketChat(
            account.serverUrl!,
            account.authToken!,
            account.userId!,
            timeoutMs,
          );
        },
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: isRocketChatAccountConfigured(account),
          extra: {
            authTokenSource: account.authTokenSource,
            serverUrl: account.serverUrl,
            botUsername: account.botUsername,
            connected: runtime?.connected ?? false,
            lastConnectedAt: runtime?.lastConnectedAt ?? null,
            lastDisconnect: runtime?.lastDisconnect ?? null,
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          const statusSink = createAccountStatusSink({
            accountId: ctx.accountId,
            setStatus: ctx.setStatus,
          });
          statusSink({
            serverUrl: account.serverUrl,
            authTokenSource: account.authTokenSource,
          });
          ctx.log?.info(
            `[rocketchat:${account.accountId}] starting Rocket.Chat monitor`,
          );
          return monitorRocketChatProvider({
            accountId: account.accountId,
            config: ctx.cfg,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
            statusSink,
          });
        },
      },
    },

    // ---- Pairing ---------------------------------------------------------
    pairing: {
      text: {
        idLabel: "rocketchatUserId",
        message: "OpenClaw: your access has been approved.",
        normalizeAllowEntry: (entry) => normalizeRocketChatAllowEntry(entry),
        notify: createLoggedPairingApprovalNotifier(
          ({ id }) => `[rocketchat] User ${id} approved for pairing`,
        ),
      },
    },

    // ---- Threading -------------------------------------------------------
    threading: {
      scopedAccountReplyToMode: {
        resolveAccount: (cfg, accountId) =>
          resolveRocketChatAccount({ cfg, accountId: accountId ?? "default" }),
        resolveReplyToMode: (account) => resolveRocketChatReplyToMode(account),
      },
    },

    // ---- Security --------------------------------------------------------
    security: rocketchatSecurityAdapter,

    // ---- Outbound --------------------------------------------------------
    outbound: {
      base: {
        deliveryMode: "direct",
        chunker: chunkTextForOutbound,
        chunkerMode: "markdown",
        textChunkLimit: 4000,
        resolveTarget: ({ to }) => {
          const trimmed = to?.trim();
          if (!trimmed) {
            return {
              ok: false,
              error: new Error(
                "Delivering to Rocket.Chat requires --to <roomId|@username|user:ID|room:ID>",
              ),
            };
          }
          return { ok: true, to: trimmed };
        },
      },
      attachedResults: {
        channel: "rocketchat",
        sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) =>
          sendMessageRocketChat(to, text, {
            cfg,
            accountId: accountId ?? undefined,
            replyToId: replyToId ?? (threadId != null ? String(threadId) : undefined),
          }),
        sendMedia: async ({ cfg, to, text, accountId, replyToId, threadId }) =>
          sendMessageRocketChat(to, text, {
            cfg,
            accountId: accountId ?? undefined,
            replyToId: replyToId ?? (threadId != null ? String(threadId) : undefined),
          }),
      },
    },
  });

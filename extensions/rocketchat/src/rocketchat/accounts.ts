/**
 * rocketchat/accounts.ts
 *
 * Account resolution for the Rocket.Chat channel plugin.
 * Supports a single default account and named multi-account configs
 * under channels.rocketchat.accounts.<id>.
 */

import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveSecretInputSync } from "../secret-input.js";
import type {
  RocketChatAccountConfig,
  RocketChatConfig,
  RocketChatMode,
  RocketChatReplyToMode,
} from "../types.js";
import type { OpenClawConfig } from "./runtime-api.js";

// ---------------------------------------------------------------------------
// Resolved account shape
// ---------------------------------------------------------------------------

export type RocketChatTokenSource = "env" | "config" | "none";

export type ResolvedRocketChatAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;

  authToken?: string;
  authTokenSource: RocketChatTokenSource;
  userId?: string;
  userIdSource: RocketChatTokenSource;
  botUsername?: string;
  serverUrl?: string;

  chatmode?: RocketChatMode;
  oncharPrefixes?: string[];
  requireMention?: boolean;
  replyTo?: RocketChatReplyToMode;

  textChunkLimit?: number;
  blockStreaming?: boolean;

  allowedRoomIds?: string[];
  blockedRoomIds?: string[];
  maxInboundMessageLength?: number;
  promptInjectionGuard?: boolean;

  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  pingIntervalMs?: number;
  restTimeoutMs?: number;

  eventBusUrl?: string;
  eventStreamPrefix?: string;

  config: RocketChatAccountConfig;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rcAccountHelpers = createAccountListHelpers("rocketchat");

export function listRocketChatAccountIds(cfg: OpenClawConfig): string[] {
  return rcAccountHelpers.listAccountIds(cfg);
}

export function resolveDefaultRocketChatAccountId(cfg: OpenClawConfig): string {
  return rcAccountHelpers.resolveDefaultAccountId(cfg);
}

function mergeRocketChatAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): RocketChatAccountConfig {
  return resolveMergedAccountConfig<RocketChatAccountConfig>({
    channelConfig: cfg.channels?.rocketchat as RocketChatAccountConfig | undefined,
    accounts: cfg.channels?.rocketchat?.accounts as
      | Record<string, Partial<RocketChatAccountConfig>>
      | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
    nestedObjectKeys: ["commands"],
  });
}

function resolveTokenSource(
  raw: string | undefined,
): RocketChatTokenSource {
  if (!raw) return "none";
  return "config";
}

function resolveRequireMention(config: RocketChatAccountConfig): boolean | undefined {
  if (config.chatmode === "oncall") return true;
  if (config.chatmode === "onmessage") return false;
  if (config.chatmode === "onchar") return true;
  return config.requireMention;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

export function resolveRocketChatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedRocketChatAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.rocketchat?.enabled !== false;
  const merged = mergeRocketChatAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;

  const rawAuthToken = resolveSecretInputSync(merged.authToken);
  const rawUserId = resolveSecretInputSync(merged.userId);

  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name,

    authToken: rawAuthToken,
    authTokenSource: resolveTokenSource(rawAuthToken),
    userId: rawUserId,
    userIdSource: resolveTokenSource(rawUserId),
    botUsername: merged.botUsername,
    serverUrl: merged.serverUrl?.replace(/\/$/, ""),

    chatmode: merged.chatmode ?? "oncall",
    oncharPrefixes: merged.oncharPrefixes ?? [">", "!"],
    requireMention: resolveRequireMention(merged) ?? true,
    replyTo: merged.replyTo ?? "off",

    textChunkLimit: merged.textChunkLimit ?? 4000,
    blockStreaming: merged.blockStreaming ?? false,

    allowedRoomIds: merged.allowedRoomIds,
    blockedRoomIds: merged.blockedRoomIds,
    maxInboundMessageLength: merged.maxInboundMessageLength ?? 8000,
    promptInjectionGuard: merged.promptInjectionGuard !== false,

    reconnectDelayMs: merged.reconnectDelayMs ?? 2_000,
    maxReconnectAttempts: merged.maxReconnectAttempts ?? 10,
    pingIntervalMs: merged.pingIntervalMs ?? 30_000,
    restTimeoutMs: merged.restTimeoutMs ?? 15_000,

    eventBusUrl: merged.eventBusUrl,
    eventStreamPrefix: merged.eventStreamPrefix ?? "openclaw.rocketchat",

    config: merged,
  };
}

export function resolveRocketChatReplyToMode(
  account: ResolvedRocketChatAccount,
): RocketChatReplyToMode {
  return account.replyTo ?? "off";
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

export function isRocketChatAccountConfigured(
  account: ResolvedRocketChatAccount,
): boolean {
  return Boolean(
    account.authToken &&
      account.userId &&
      account.serverUrl,
  );
}

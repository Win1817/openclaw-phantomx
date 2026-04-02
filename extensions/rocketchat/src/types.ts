/**
 * types.ts — Rocket.Chat plugin domain types.
 *
 * Covers account config shape, chat modes, reply modes,
 * and security policies mirroring the OpenClaw plugin-sdk conventions.
 */

import type { DmPolicy, GroupPolicy } from "./runtime-api.js";
import type { SecretInput } from "./secret-input.js";

// ---------------------------------------------------------------------------
// Chat & reply modes
// ---------------------------------------------------------------------------

/**
 * Controls when Rocket.Chat messages trigger the agent.
 *
 * - "oncall"    → only respond when @mentioned
 * - "onmessage" → respond to every channel message the bot can see
 * - "onchar"    → respond when a trigger-character prefix is detected
 */
export type RocketChatMode = "oncall" | "onmessage" | "onchar";

/**
 * Controls whether outbound replies are threaded.
 *
 * - "off"   → never thread (send to room root)
 * - "first" → reply in a thread under the triggering message
 * - "all"   → always thread; create new thread if none exists
 */
export type RocketChatReplyToMode = "off" | "first" | "all";

export type RocketChatChatTypeKey = "direct" | "channel" | "group";

// ---------------------------------------------------------------------------
// Slash-command config
// ---------------------------------------------------------------------------

export type RocketChatSlashCommandsConfig = {
  /** Enable native slash-command handler. Default: false. */
  native?: boolean | "auto";
  /** Also register skill-based slash commands. Default: false. */
  nativeSkills?: boolean | "auto";
  /** HTTP path for the slash-command callback (on gateway HTTP server). */
  callbackPath?: string;
  /** Full callback URL when behind a reverse proxy. */
  callbackUrl?: string;
};

// ---------------------------------------------------------------------------
// Per-account config
// ---------------------------------------------------------------------------

export type RocketChatAccountConfig = {
  /** Human-readable label for CLI/UI lists. */
  name?: string;
  /** Optional provider-capability tags for agent guidance. */
  capabilities?: string[];
  /** If false, skip starting this account. Default: true. */
  enabled?: boolean;

  // --- Credentials --------------------------------------------------------
  /** Bot user auth token (from Admin > Users > Bot > Personal Access Token). */
  authToken?: SecretInput;
  /** Bot user ID (paired with authToken). */
  userId?: SecretInput;
  /** Bot username (used for mention detection). */
  botUsername?: string;
  /** Rocket.Chat server base URL (e.g. https://chat.example.com). */
  serverUrl?: string;

  // --- Behaviour ----------------------------------------------------------
  /** When to respond. Default: "oncall". */
  chatmode?: RocketChatMode;
  /** Prefix chars for "onchar" mode. Default: [">", "!"]. */
  oncharPrefixes?: string[];
  /** Require @mention in channels. Default: true. */
  requireMention?: boolean;

  // --- DM policy ----------------------------------------------------------
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;

  // --- Group/channel policy -----------------------------------------------
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;

  // --- Outbound formatting ------------------------------------------------
  /** Max text chunk size in chars. Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode. Default: "length". */
  chunkMode?: "length" | "newline";
  /** Disable streaming block replies. */
  blockStreaming?: boolean;
  /** Per-account response prefix override. */
  responsePrefix?: string;

  // --- Threading ----------------------------------------------------------
  replyTo?: RocketChatReplyToMode;

  // --- Slash commands -----------------------------------------------------
  commands?: RocketChatSlashCommandsConfig;

  // --- Connection tuning --------------------------------------------------
  /** Reconnect delay in ms. Default: 2000. */
  reconnectDelayMs?: number;
  /** Max reconnect attempts before giving up. Default: 10. */
  maxReconnectAttempts?: number;
  /** WebSocket ping interval in ms. Default: 30000. */
  pingIntervalMs?: number;
  /** REST API timeout in ms. Default: 15000. */
  restTimeoutMs?: number;

  // --- Security -----------------------------------------------------------
  /** Allowed room IDs. Empty = all rooms allowed. */
  allowedRoomIds?: string[];
  /** Blocked room IDs. */
  blockedRoomIds?: string[];
  /** Max incoming message length (prompt-injection guard). Default: 8000. */
  maxInboundMessageLength?: number;
  /** Strip suspected prompt-injection patterns. Default: true. */
  promptInjectionGuard?: boolean;

  // --- Event bus ----------------------------------------------------------
  /** Redis/NATS URL for async event publishing. Optional. */
  eventBusUrl?: string;
  /** Event stream name/subject prefix. Default: "openclaw.rocketchat". */
  eventStreamPrefix?: string;
};

// ---------------------------------------------------------------------------
// Top-level channel config (root channels.rocketchat)
// ---------------------------------------------------------------------------

export type RocketChatConfig = RocketChatAccountConfig & {
  /** Named account map for multi-account setups. */
  accounts?: Record<string, Partial<RocketChatAccountConfig>>;
  /** Default account to use when no accountId is specified. */
  defaultAccount?: string;
};

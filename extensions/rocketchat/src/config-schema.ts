/**
 * config-schema.ts
 *
 * Zod schema for the Rocket.Chat channel config block.
 * This schema is registered with OpenClaw and used for:
 *   - CLI setup wizard validation
 *   - Config reload preflight checks
 *   - UI hint generation
 */

import {
  DmPolicySchema,
  GroupPolicySchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-primitives";
import { z } from "openclaw/plugin-sdk/zod";

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const SecretInputSchema = z.union([
  z.string().min(1),
  z.object({ env: z.string().min(1) }).strict(),
  z.object({ file: z.string().min(1) }).strict(),
]);

const RocketChatSlashCommandsSchema = z
  .object({
    native: z.union([z.boolean(), z.literal("auto")]).optional(),
    nativeSkills: z.union([z.boolean(), z.literal("auto")]).optional(),
    callbackPath: z.string().optional(),
    callbackUrl: z.string().url().optional(),
  })
  .strict()
  .optional();

// ---------------------------------------------------------------------------
// Per-account schema
// ---------------------------------------------------------------------------

const RocketChatAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),

    // Credentials
    authToken: SecretInputSchema.optional(),
    userId: SecretInputSchema.optional(),
    botUsername: z.string().optional(),
    serverUrl: z.string().url().optional(),

    // Chat behaviour
    chatmode: z.enum(["oncall", "onmessage", "onchar"]).optional(),
    oncharPrefixes: z.array(z.string().min(1)).optional(),
    requireMention: z.boolean().optional(),

    // DM policy
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),

    // Group policy
    groupPolicy: GroupPolicySchema.optional().default("open"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),

    // Outbound
    textChunkLimit: z.number().int().min(100).max(40_000).optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    responsePrefix: z.string().optional(),

    // Threading
    replyTo: z.enum(["off", "first", "all"]).optional(),

    // Slash commands
    commands: RocketChatSlashCommandsSchema,

    // Connection
    reconnectDelayMs: z.number().int().min(500).max(60_000).optional(),
    maxReconnectAttempts: z.number().int().min(0).max(100).optional(),
    pingIntervalMs: z.number().int().min(5_000).max(300_000).optional(),
    restTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),

    // Security
    allowedRoomIds: z.array(z.string()).optional(),
    blockedRoomIds: z.array(z.string()).optional(),
    maxInboundMessageLength: z.number().int().min(100).max(100_000).optional(),
    promptInjectionGuard: z.boolean().optional(),

    // Event bus
    eventBusUrl: z.string().optional(),
    eventStreamPrefix: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Root config (with refines)
// ---------------------------------------------------------------------------

export const RocketChatChannelConfigSchema = RocketChatAccountSchemaBase.extend({
  accounts: z
    .record(z.string(), RocketChatAccountSchemaBase.partial())
    .optional(),
  defaultAccount: z.string().optional(),
})
  .strict()
  .superRefine((data, ctx) => {
    // Enforce allowFrom when dmPolicy="open"
    requireOpenAllowFrom({
      policy: data.dmPolicy,
      allowFrom: data.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.rocketchat.dmPolicy="open" requires channels.rocketchat.allowFrom to include "*"',
    });
  });

export type RocketChatChannelConfig = z.infer<typeof RocketChatChannelConfigSchema>;

// ---------------------------------------------------------------------------
// UI hints (surfaced in the OpenClaw config UI)
// ---------------------------------------------------------------------------

export const ROCKETCHAT_CONFIG_UI_HINTS: Record<
  string,
  { label?: string; help?: string; sensitive?: boolean; advanced?: boolean }
> = {
  serverUrl: {
    label: "Server URL",
    help: "Full URL to your Rocket.Chat server (e.g. https://chat.example.com)",
  },
  authToken: {
    label: "Auth Token",
    help: "Personal access token for the bot user (Admin > Users > <bot> > PAT)",
    sensitive: true,
  },
  userId: {
    label: "User ID",
    help: "The _id field for the bot user (visible in Admin > Users)",
    sensitive: true,
  },
  botUsername: {
    label: "Bot Username",
    help: "Username of the bot (used for @mention detection). Auto-resolved if omitted.",
  },
  chatmode: {
    label: "Chat Mode",
    help: '"oncall" = only respond when @mentioned; "onmessage" = respond to every message; "onchar" = respond to trigger-prefixed messages',
  },
  dmPolicy: {
    label: "DM Policy",
    help: "Who can send direct messages to the bot",
  },
  replyTo: {
    label: "Reply Threading",
    help: '"off" = reply in room root; "first" = thread under triggering message; "all" = always thread',
    advanced: true,
  },
  promptInjectionGuard: {
    label: "Prompt Injection Guard",
    help: "Block messages matching known prompt-injection patterns (recommended: true)",
    advanced: true,
  },
  eventBusUrl: {
    label: "Event Bus URL",
    help: "Optional Redis/NATS URL for async event publishing (e.g. redis://localhost:6379)",
    advanced: true,
  },
};

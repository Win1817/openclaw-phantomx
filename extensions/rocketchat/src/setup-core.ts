/**
 * setup-core.ts
 *
 * CLI setup adapter for the Rocket.Chat channel plugin.
 * Handles `openclaw channel setup rocketchat` wizard steps:
 *   1. Validate provided credentials
 *   2. Patch the OpenClaw config with authToken / userId / serverUrl
 */

import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/channel-setup";
import { createSetupInputPresenceValidator } from "openclaw/plugin-sdk/setup-runtime";
import {
  resolveRocketChatAccount,
  type ResolvedRocketChatAccount,
} from "./rocketchat/accounts.js";
import {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  DEFAULT_ACCOUNT_ID,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  type OpenClawConfig,
} from "./runtime-api.js";

const channel = "rocketchat" as const;

export function isRocketChatConfigured(account: ResolvedRocketChatAccount): boolean {
  return Boolean(account.authToken && account.userId && account.serverUrl);
}

export const rocketchatSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),

  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),

  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError:
      "Rocket.Chat env vars can only be used for the default account.",
    whenNotUseEnv: [
      {
        someOf: ["token", "accessToken"],
        message:
          "Rocket.Chat requires --token (auth token), --user-id, and --http-url (or --use-env).",
      },
      {
        someOf: ["userId"],
        message:
          "Rocket.Chat requires --token (auth token), --user-id, and --http-url (or --use-env).",
      },
      {
        someOf: ["httpUrl"],
        message:
          "Rocket.Chat requires --token (auth token), --user-id, and --http-url (or --use-env).",
      },
    ],
    validate: ({ input }) => {
      if (input.useEnv) return null;
      const token = input.token ?? input.accessToken;
      if (!token) {
        return "Rocket.Chat --token (auth token) is required.";
      }
      if (!input.userId) {
        return "Rocket.Chat --user-id is required.";
      }
      const url = input.httpUrl?.trim();
      if (!url) {
        return "Rocket.Chat --http-url (server URL) is required.";
      }
      try {
        new URL(url);
      } catch {
        return `Rocket.Chat --http-url "${url}" is not a valid URL.`;
      }
      return null;
    },
  }),

  applyAccountConfig: ({ cfg, accountId, input }) => {
    const token = input.token ?? input.accessToken;
    const serverUrl = input.httpUrl?.trim().replace(/\/$/, "");

    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: input.name,
    });

    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: channel })
        : namedConfig;

    return applySetupAccountConfigPatch({
      cfg: next,
      channelKey: channel,
      accountId,
      patch: input.useEnv
        ? {}
        : {
            ...(token ? { authToken: token } : {}),
            ...(input.userId ? { userId: input.userId } : {}),
            ...(serverUrl ? { serverUrl } : {}),
            ...(input.name ? { botUsername: input.name } : {}),
          },
    });
  },
};

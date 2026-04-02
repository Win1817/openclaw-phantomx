/**
 * approval-auth.ts
 *
 * Pairing/approval auth adapter for the Rocket.Chat plugin.
 * Validates that the DM sender is in the configured allowFrom list
 * before granting pairing access.
 */

import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import { resolveRocketChatAccount } from "./rocketchat/accounts.js";

/** Rocket.Chat user IDs: 17 alphanumeric chars */
const RC_USER_ID_RE = /^[a-zA-Z0-9]{17}$/;

function normalizeRocketChatApproverId(value: string | number): string | undefined {
  const normalized = String(value)
    .trim()
    .replace(/^(rocketchat|user):/i, "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
  // Accept either an ID or a username
  return normalized.length > 0 ? normalized : undefined;
}

export const rocketchatApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Rocket.Chat",
  resolveApprovers: ({ cfg, accountId }) => {
    const account = resolveRocketChatAccount({ cfg, accountId }).config;
    return resolveApprovalApprovers({
      allowFrom: account.allowFrom,
      normalizeApprover: normalizeRocketChatApproverId,
    });
  },
  normalizeSenderId: (value) => normalizeRocketChatApproverId(value),
});

/**
 * rocketchat/security.ts
 *
 * Security hardening layer for the Rocket.Chat channel plugin.
 *
 * Covers:
 *   1. Prompt-injection detection & sanitisation
 *   2. Room allowlist / blocklist enforcement
 *   3. Per-sender permission checks
 *   4. Message-length cap (DoS guard)
 *   5. Rate-limiting stub (pluggable)
 *
 * This module is stateless — all context is passed in explicitly so it
 * can be unit-tested without a running gateway.
 */

import type { ResolvedRocketChatAccount } from "./accounts.js";
import type { RocketChatMessage } from "./ddp-client.js";

// ---------------------------------------------------------------------------
// Prompt-injection patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that signal likely prompt-injection attempts.
 * Each regex is checked against the raw incoming message text.
 *
 * References:
 *   - OWASP LLM Top-10 #01 (Prompt Injection)
 *   - NIST AI RMF MG-2.5
 */
const INJECTION_PATTERNS: RegExp[] = [
  // Role-override attempts
  /\bignore\s+(all\s+)?previous\s+instructions?\b/i,
  /\bforget\s+(everything|all)\s+(you|above)\b/i,
  /\byou\s+are\s+now\s+(a|an)\b.*\bassistant\b/i,
  /\bact\s+as\s+(if\s+you\s+are|a|an)\b/i,
  /\bpretend\s+(you\s+are|to\s+be)\b/i,

  // System-prompt exfiltration attempts
  /\brepeat\s+(your\s+)?(system\s+prompt|instructions)\b/i,
  /\bwhat\s+are\s+your\s+(system\s+)?instructions\b/i,
  /\bprint\s+your\s+(full\s+)?prompt\b/i,
  /\bshow\s+(me\s+)?your\s+(system\s+)?message\b/i,

  // Jailbreak framing
  /\bDAN\b.*\bmode\b/i,
  /\bjailbreak\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bconfidential\s+mode\b/i,

  // Shell/code execution escalation via chat
  /```\s*(bash|sh|zsh|fish|cmd|powershell|python|ruby|perl|node)\s/i,
  /\bexec\s*\(.*\)/,
  /\beval\s*\(.*\)/,
  /\bos\.system\s*\(/,
  /\bsubprocess\s*\./,

  // Null-byte / unicode trickery
  /\x00/,
  /\u202e/, // right-to-left override
];

export type InjectionCheckResult =
  | { safe: true }
  | { safe: false; reason: string; pattern: string };

/**
 * Check a message for prompt-injection signatures.
 * Returns `{ safe: true }` or `{ safe: false, reason, pattern }`.
 */
export function checkPromptInjection(text: string): InjectionCheckResult {
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) {
      return {
        safe: false,
        reason: "Potential prompt-injection pattern detected",
        pattern: re.source,
      };
    }
  }
  return { safe: true };
}

/**
 * Sanitise a message by stripping null bytes and suspicious Unicode.
 * Does NOT remove any user-visible content — only invisible control chars.
 */
export function sanitiseInboundMessage(text: string): string {
  return text
    .replace(/\x00/g, "")           // null bytes
    .replace(/\u202e/g, "")         // right-to-left override
    .replace(/[\u200b-\u200f]/g, "") // zero-width chars
    .replace(/\uFEFF/g, "");        // BOM
}

// ---------------------------------------------------------------------------
// Room-level access control
// ---------------------------------------------------------------------------

export type RoomAccessResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Enforce room allowlist and blocklist for a given account config.
 */
export function checkRoomAccess(
  roomId: string,
  account: ResolvedRocketChatAccount,
): RoomAccessResult {
  const blocked = account.blockedRoomIds ?? [];
  if (blocked.includes(roomId)) {
    return { allowed: false, reason: `Room ${roomId} is in the blocklist` };
  }

  const allowed = account.allowedRoomIds ?? [];
  if (allowed.length > 0 && !allowed.includes(roomId)) {
    return { allowed: false, reason: `Room ${roomId} is not in the allowlist` };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Message-length DoS guard
// ---------------------------------------------------------------------------

export type LengthCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

export function checkMessageLength(
  text: string,
  account: ResolvedRocketChatAccount,
): LengthCheckResult {
  const max = account.maxInboundMessageLength ?? 8_000;
  if (text.length > max) {
    return {
      ok: false,
      reason: `Message length ${text.length} exceeds configured maximum ${max}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Combined inbound gate
// ---------------------------------------------------------------------------

export type InboundGateResult =
  | { pass: true; sanitised: string }
  | { pass: false; reason: string };

/**
 * Run all security checks on an inbound Rocket.Chat message.
 *
 * Returns `{ pass: true, sanitised }` when the message may proceed,
 * or `{ pass: false, reason }` when it should be dropped.
 */
export function runInboundSecurityGate(
  msg: RocketChatMessage,
  account: ResolvedRocketChatAccount,
): InboundGateResult {
  const text = msg.msg ?? "";

  // 1. Room access
  const roomAccess = checkRoomAccess(msg.rid, account);
  if (!roomAccess.allowed) {
    return { pass: false, reason: roomAccess.reason };
  }

  // 2. Length cap
  const lengthCheck = checkMessageLength(text, account);
  if (!lengthCheck.ok) {
    return { pass: false, reason: lengthCheck.reason };
  }

  // 3. Sanitise
  const sanitised = sanitiseInboundMessage(text);

  // 4. Prompt-injection guard (optional — controllable via config)
  if (account.promptInjectionGuard !== false) {
    const injectionCheck = checkPromptInjection(sanitised);
    if (!injectionCheck.safe) {
      return {
        pass: false,
        reason: `Inbound message blocked by prompt-injection guard: ${injectionCheck.reason}`,
      };
    }
  }

  return { pass: true, sanitised };
}

// ---------------------------------------------------------------------------
// Sender allowlist check
// ---------------------------------------------------------------------------

export type SenderCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Check whether a sender (by userId or username) is allowed to interact.
 *
 * The allowFrom list supports:
 *   - "*"             → any sender
 *   - "user:ID"       → match by Rocket.Chat user _id
 *   - "@username"     → match by username
 *   - plain string    → match by username (no @ prefix)
 */
export function checkSenderAllowed(
  senderId: string,
  senderUsername: string,
  allowFrom: Array<string | number> | undefined,
): SenderCheckResult {
  if (!allowFrom || allowFrom.length === 0) {
    // No allowlist configured → allow all (rely on dmPolicy/groupPolicy)
    return { allowed: true };
  }

  for (const entry of allowFrom) {
    const s = String(entry).trim();
    if (s === "*") return { allowed: true };
    if (s.startsWith("user:") && s.slice(5) === senderId) return { allowed: true };
    const normalised = s.startsWith("@") ? s.slice(1) : s;
    if (normalised === senderUsername) return { allowed: true };
    if (s === senderId) return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Sender ${senderUsername} (${senderId}) not in allowFrom list`,
  };
}

/**
 * normalize.ts
 *
 * Target normalisation and ID detection helpers for the Rocket.Chat plugin.
 * Used by the messaging adapter and outbound session router.
 *
 * Rocket.Chat room IDs are 17-char alphanumeric strings.
 * Direct-message room IDs follow the pattern: <userId1><userId2> (sorted, 34 chars)
 * or legacy "d" type rooms returned by the API.
 */

/** RC room/user IDs: 17 alphanumeric chars */
const RC_ID_RE = /^[a-zA-Z0-9]{17}$/;
/** Direct-message room composed of two 17-char IDs */
const RC_DM_ID_RE = /^[a-zA-Z0-9]{17}[a-zA-Z0-9]{17}$/;

export function looksLikeRocketChatId(raw: string): boolean {
  const t = raw.trim();
  return RC_ID_RE.test(t) || RC_DM_ID_RE.test(t) || /^(room|user|channel|direct):/i.test(t);
}

/**
 * Normalise a user-supplied target string into a canonical form.
 *
 * Canonical forms:
 *   - `room:<roomId>`   → send directly to a room
 *   - `user:<userId>`   → look up DM room by userId
 *   - `@<username>`     → look up DM room by username
 *   - `#<roomName>`     → look up channel by name
 *
 * Returns `undefined` when the raw value cannot be normalised, prompting
 * the core to attempt a directory lookup.
 */
export function normalizeRocketChatMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();

  if (lower.startsWith("room:")) {
    const id = trimmed.slice(5).trim();
    return id ? `room:${id}` : undefined;
  }
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice(8).trim();
    return id ? `room:${id}` : undefined;
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice(5).trim();
    return id ? `user:${id}` : undefined;
  }
  if (lower.startsWith("rocketchat:")) {
    const id = trimmed.slice(11).trim();
    return id ? `user:${id}` : undefined;
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    return username ? `@${username}` : undefined;
  }
  if (trimmed.startsWith("#")) {
    // Channel name — return undefined so the directory adapter resolves it
    return undefined;
  }
  // Bare 17-char ID → treat as room
  if (RC_ID_RE.test(trimmed)) {
    return `room:${trimmed}`;
  }

  return undefined;
}

/**
 * Normalise an allowlist/allowFrom entry for consistent comparisons.
 * Strips prefixes and lowercases so "rocketchat:abc" and "abc" compare equal.
 */
export function normalizeRocketChatAllowEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^(rocketchat|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

/**
 * Format an allowFrom entry for display in CLI/config output.
 */
export function formatRocketChatAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("@")) {
    const u = trimmed.slice(1).trim();
    return u ? `@${u.toLowerCase()}` : "";
  }
  return trimmed.replace(/^(rocketchat|user):/i, "").toLowerCase();
}

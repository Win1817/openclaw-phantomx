/**
 * secret-input.ts
 *
 * Secret value handling for Rocket.Chat auth tokens and user IDs.
 * Resolves env-var references ({ env: "VAR_NAME" }), file references
 * ({ file: "/path/to/file" }), or plain string values.
 *
 * All resolution is synchronous to be safe for use in config hot-paths.
 */

import { readFileSync } from "node:fs";

export type SecretInput = string | { env: string } | { file: string };

/**
 * Resolve a SecretInput to a plain string at runtime.
 * Returns undefined if the input is absent or the env var / file is empty.
 */
export function resolveSecretInputSync(
  input: SecretInput | undefined | null,
): string | undefined {
  if (!input) return undefined;

  if (typeof input === "string") {
    return input.trim() || undefined;
  }

  if ("env" in input) {
    const val = process.env[input.env];
    return val?.trim() || undefined;
  }

  if ("file" in input) {
    try {
      return readFileSync(input.file, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** Alias — kept for compatibility with callers that use the async name. */
export const normalizeSecretInputString = resolveSecretInputSync;

/**
 * Returns true if the SecretInput is configured (even if the runtime value
 * cannot be resolved without I/O — e.g. an env-var reference is present).
 */
export function hasConfiguredSecretInput(
  input: SecretInput | undefined | null,
): boolean {
  if (!input) return false;
  if (typeof input === "string") return input.trim().length > 0;
  if ("env" in input) return input.env.trim().length > 0;
  if ("file" in input) return input.file.trim().length > 0;
  return false;
}

/** Build a minimal schema descriptor (used by config-schema.ts UI hints). */
export function buildSecretInputSchema(): { _tag: string; description: string } {
  return {
    _tag: "SecretInput",
    description:
      'A plain string token, { env: "ENV_VAR_NAME" } to read from environment, ' +
      'or { file: "/path/to/secret" } to read from a file.',
  };
}

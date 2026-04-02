/**
 * secret-input.ts
 *
 * Secret value handling for Rocket.Chat auth tokens and user IDs.
 * Resolves env-var references ("env:VAR_NAME") or plain string values.
 */

export type SecretInput = string | { env: string } | { file: string };

/**
 * Resolve a SecretInput to a plain string at runtime.
 * Returns undefined if the input is absent or the env var is unset.
 */
export function resolveSecretInput(
  input: SecretInput | undefined | null,
): string | undefined {
  if (!input) return undefined;
  if (typeof input === "string") return input || undefined;
  if ("env" in input) {
    const val = process.env[input.env];
    return val || undefined;
  }
  // file-based secrets: read synchronously (startup only)
  if ("file" in input) {
    try {
      const { readFileSync } = await import("node:fs").catch(() => ({ readFileSync: null })) as never;
      if (readFileSync) {
        return (readFileSync as (p: string, e: string) => string)(input.file, "utf8").trim() || undefined;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Synchronous variant — for use in config resolution hot paths.
 */
export function resolveSecretInputSync(
  input: SecretInput | undefined | null,
): string | undefined {
  if (!input) return undefined;
  if (typeof input === "string") return input || undefined;
  if ("env" in input) {
    const val = process.env[input.env];
    return val || undefined;
  }
  if ("file" in input) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("node:fs");
      return (fs.readFileSync(input.file, "utf8") as string).trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function normalizeSecretInputString(
  input: SecretInput | undefined | null,
): string | undefined {
  return resolveSecretInputSync(input);
}

export function buildSecretInputSchema() {
  // Returns a zod-compatible schema description — actual Zod import
  // comes from the openclaw plugin-sdk at runtime.
  return {
    _tag: "SecretInput",
    description:
      'A plain string token, or { env: "ENV_VAR_NAME" } to read from environment.',
  };
}

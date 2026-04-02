/**
 * rocketchat/probe.ts
 *
 * Connectivity health check for a Rocket.Chat account.
 * Calls /api/v1/me to verify credentials and measure latency.
 */

import type { BaseProbeResult } from "./runtime-api.js";

export type RocketChatProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  username?: string;
  name?: string;
  serverVersion?: string;
};

export async function probeRocketChat(
  serverUrl: string,
  authToken: string,
  userId: string,
  timeoutMs = 4000,
): Promise<RocketChatProbe> {
  const base = serverUrl.replace(/\/$/, "");
  const url = `${base}/api/v1/me`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        "X-Auth-Token": authToken,
        "X-User-Id": userId,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - start;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text || res.statusText, elapsedMs };
    }

    const data = (await res.json()) as {
      success?: boolean;
      username?: string;
      name?: string;
      version?: string;
    };

    if (!data.success) {
      return { ok: false, status: res.status, error: "API returned success=false", elapsedMs };
    }

    return {
      ok: true,
      status: res.status,
      elapsedMs,
      username: data.username,
      name: data.name,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

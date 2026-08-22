/**
 * usage/freebuff.ts — Freebuff usage fetcher.
 *
 * Fetches session/quota info from the Freebuff API.
 * Returns quota information per model for display in the dashboard.
 */

import { type UsageQuota } from "./quota.ts";

interface FreebuffQuotaResponse {
  quota?: Record<string, { limit: number; remaining: number }>;
}

/**
 * Freebuff Usage
 * Fetches quota info from the Freebuff session API.
 * Returns per-model quotas as "credits" for credits-style UI display.
 */
export async function getFreebuffUsage(connectionId: string, apiKey: string) {
  try {
    const response = await fetch("https://www.codebuff.com/api/v1/freebuff/session", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "codebuff/0.1.0 (darwin-arm64)",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown error");
      return { message: `Freebuff session error (${response.status}): ${errText.slice(0, 100)}` };
    }

    const data = (await response.json()) as FreebuffQuotaResponse;
    const quotas: Record<string, UsageQuota> = {};

    if (data.quota) {
      for (const [modelId, quotaInfo] of Object.entries(data.quota)) {
        const modelKey = modelId.replace(/[^a-zA-Z0-9]/g, "_");
        quotas[`quota_${modelKey}`] = {
          used: 0,
          total: quotaInfo.limit,
          remaining: quotaInfo.remaining,
          remainingPercentage:
            quotaInfo.limit > 0
              ? Math.round((quotaInfo.remaining / quotaInfo.limit) * 100)
              : 100,
          resetAt: null,
          unlimited: false,
        };
      }
    }

    const plan = Object.keys(quotas).length > 0 ? "Freebuff Free" : "Freebuff";

    return {
      plan,
      quotas,
      isAvailable: true,
      limitReached: false,
    };
  } catch (error) {
    return { message: `Freebuff usage error: ${(error as Error).message}` };
  }
}

import { randomUUID } from "node:crypto";
import { FREEBUFF_CONFIG } from "../constants/oauth";

/**
 * Freebuff (Codebuff) OAuth Provider — Fingerprint Device Code Flow.
 *
 * NOT OAuth2 standard. Uses a fingerprint-based device flow:
 * 1) POST {baseUrl}/api/auth/cli/code { fingerprintId }
 *    → { fingerprintId, fingerprintHash, loginUrl, expiresAt }
 * 2) User opens loginUrl in browser and signs in
 * 3) GET {baseUrl}/api/auth/cli/status?fingerprintId=..&fingerprintHash=..&expiresAt=..
 *    → { user: { id, email, name, authToken } } once authorized
 *
 * The resulting user.authToken is the Bearer token used against
 * https://www.codebuff.com/api/v1/chat/completions
 */

const LOGIN_HOST = "https://freebuff.com";

interface FreebuffConfig {
  baseUrl?: string;
  loginCodePath?: string;
  loginStatusPath?: string;
  oauthTimeoutMs?: number;
}

interface FreebuffTokenResponse {
  access_token: string;
  id?: string;
  email?: string;
  name?: string;
  fingerprintId?: string;
}

export const freebuff = {
  config: FREEBUFF_CONFIG,
  flowType: "device_code" as const,

  requestDeviceCode: async (config: FreebuffConfig) => {
    const fingerprintId = randomUUID();
    const baseUrl = (config.baseUrl || LOGIN_HOST).replace(/\/$/, "");
    const response = await fetch(
      `${baseUrl}${config.loginCodePath || "/api/auth/cli/code"}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "codebuff-cli/0.0.138",
        },
        body: JSON.stringify({ fingerprintId }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Freebuff login code request failed: ${error}`);
    }

    const data = await response.json();
    const loginUrl = typeof data.loginUrl === "string" ? data.loginUrl : "";
    const authCode = loginUrl.match(/auth_code=([^&]+)/)?.[1] || "";
    const expiresAt = Number(data.expiresAt) || 0;

    const timeoutSec = Math.max(60, Math.floor((config.oauthTimeoutMs || 300000) / 1000));
    const serverMs =
      Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt - Date.now() : timeoutSec * 1000;
    const expiresIn = Math.max(60, Math.min(Math.floor(serverMs / 1000), timeoutSec));

    return {
      // fingerprintId + fingerprintHash + expiresAt travel inside device_code;
      // pollToken decodes them for /api/auth/cli/status.
      device_code: JSON.stringify({
        fingerprintId: data.fingerprintId || fingerprintId,
        fingerprintHash: data.fingerprintHash,
        expiresAt,
      }),
      user_code: authCode || "",
      verification_uri: loginUrl,
      verification_uri_complete: loginUrl,
      expires_in: expiresIn,
      interval: 5,
    };
  },

  pollToken: async (config: FreebuffConfig, deviceCode: string) => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(deviceCode) || {};
    } catch {
      parsed = {};
    }
    const { fingerprintId, fingerprintHash, expiresAt } = parsed as {
      fingerprintId: string;
      fingerprintHash: string;
      expiresAt: number;
    };

    if (!fingerprintId || !fingerprintHash || !expiresAt) {
      return { ok: true, data: { error: "authorization_pending" } };
    }

    const baseUrl = (config.baseUrl || LOGIN_HOST).replace(/\/$/, "");
    const query = new URLSearchParams({
      fingerprintId,
      fingerprintHash,
      expiresAt: String(expiresAt),
    });

    const response = await fetch(
      `${baseUrl}${config.loginStatusPath || "/api/auth/cli/status"}?${query.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "codebuff-cli/0.0.138",
        },
      }
    );

    let data: Record<string, unknown>;
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    const user = data?.user as Record<string, unknown> | undefined;
    if (user?.authToken) {
      return {
        ok: true,
        data: {
          access_token: user.authToken as string,
          ...user,
        },
      };
    }

    return { ok: true, data: { error: "authorization_pending" } };
  },

  mapTokens: (tokens: FreebuffTokenResponse) => ({
    accessToken: tokens.access_token,
    refreshToken: null,
    email: tokens.email || undefined,
    displayName: tokens.name || undefined,
    providerSpecificData: {
      authMethod: "device_code",
      fingerprintId: tokens.fingerprintId || null,
      userId: tokens.id || null,
    },
  }),
};

export default freebuff;

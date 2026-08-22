import { FREEBUFF_CONFIG } from "../constants/oauth";

/**
 * Freebuff (Codebuff) OAuth Provider — Custom Device Code Flow.
 *
 * Freebuff is a free, ad-supported coding assistant by Codebuff. Authentication
 * uses a custom device code flow via freebuff.com (NOT OAuth2 standard).
 *
 * Flow:
 *   1. POST https://freebuff.com/api/auth/cli/code → { code, url }
 *   2. Open loginUrl in browser for user authentication
 *   3. Poll https://freebuff.com/api/auth/cli/status until authenticated
 *   4. Returns { authToken, user } — authToken is used as Bearer token
 *
 * API calls go to https://www.codebuff.com/api/v1/*
 */
type FreebuffConfig = typeof FREEBUFF_CONFIG;

interface FreebuffDeviceCodeResponse {
  code: string;
  url: string;
}

interface FreebuffTokenResponse {
  authToken: string;
  user?: {
    id: string;
    username?: string;
  };
}

interface FreebuffPollResult {
  ok: boolean;
  data: FreebuffTokenResponse | { error?: string };
}

export const freebuff = {
  config: FREEBUFF_CONFIG,
  flowType: "device_code" as const,

  requestDeviceCode: async (_config: FreebuffConfig): Promise<FreebuffDeviceCodeResponse> => {
    const response = await fetch(FREEBUFF_CONFIG.loginCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "Unknown error");
      throw new Error(`Freebuff device code request failed (${response.status}): ${err}`);
    }

    const data = (await response.json()) as FreebuffDeviceCodeResponse;
    if (!data.code || !data.url) {
      throw new Error(`Freebuff device code error: invalid response ${JSON.stringify(data)}`);
    }

    return {
      code: data.code,
      url: data.url,
    };
  },

  pollToken: async (_config: FreebuffConfig, deviceCode: string): Promise<FreebuffPollResult> => {
    const response = await fetch(FREEBUFF_CONFIG.loginStatusUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ code: deviceCode }),
    });

    if (!response.ok) {
      return { ok: false, data: { error: `request_failed_${response.status}` } };
    }

    const data = (await response.json()) as FreebuffTokenResponse | { error?: string };

    // Freebuff returns { authToken } when authenticated, or { error } when pending
    if ("authToken" in data && data.authToken) {
      return {
        ok: true,
        data: {
          authToken: data.authToken,
          user: data.user,
        },
      };
    }

    return { ok: false, data };
  },

  mapTokens: (tokens: FreebuffTokenResponse) => ({
    accessToken: tokens.authToken,
    refreshToken: "",
    expiresIn: 0,
    providerSpecificData: {
      user: tokens.user,
    },
  }),
};

export default freebuff;

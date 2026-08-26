import { randomInt, randomUUID } from "node:crypto";

import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";

/* ------------------------------------------------------------------ */
/*  Model → Agent ID mapping (mirrors CLI's base3-free agents)        */
/* ------------------------------------------------------------------ */
const FREE_ROOT_AGENT_BY_MODEL: Record<string, string> = {
  "deepseek/deepseek-v4-flash": "base3-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base3-free-deepseek",
  "mimo/mimo-v2.5": "base3-free-mimo",
  "minimax/minimax-m3": "base3-free-minimax-m3",
  "openai/gpt-5.6-luna": "base3-free-luna",
};

function rootAgentIdForModel(model: string): string {
  return FREE_ROOT_AGENT_BY_MODEL[model] || "base3-free";
}

/* ------------------------------------------------------------------ */
/*  Freebuff system marker — byte-exact prefix check on server side   */
/* ------------------------------------------------------------------ */
const FREEBUFF_SYSTEM_MARKER = "You are Buffy, the strategic coding assistant.";
const FREEBUFF_ROOT_SYSTEM_OPENINGS = [
  "You are Buffy, the strategic coding assistant.",
  "You are Buffy, the Freebuff Cloud project planner.",
  "You are Buffy, a strategic assistant that orchestrates complex coding tasks through specialized sub-agents.",
];

function injectFreebuffMarker(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body?.messages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(messages) || messages.length === 0) return body;

  const first = messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    const trimmed = (first.content as string).trimStart();
    if (FREEBUFF_ROOT_SYSTEM_OPENINGS.some((opening) => trimmed.startsWith(opening))) {
      return body; // already marked
    }
    return {
      ...body,
      messages: [
        { ...first, content: `${FREEBUFF_SYSTEM_MARKER}\n\n${first.content}` },
        ...messages.slice(1),
      ],
    };
  }
  // No leading system message — insert one with the canonical opening.
  return {
    ...body,
    messages: [{ role: "system", content: FREEBUFF_SYSTEM_MARKER }, ...messages],
  };
}

/* ------------------------------------------------------------------ */
/*  end_turn tool — required by Freebuff agents                        */
/* ------------------------------------------------------------------ */
const END_TURN_TOOL = {
  type: "function",
  function: {
    name: "end_turn",
    description: "Signal the end of the current task.",
    parameters: { type: "object", properties: {} },
  },
};

function injectEndTurnTool(body: Record<string, unknown>): Record<string, unknown> {
  const tools = body?.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools) || tools.length === 0) return body;
  if (tools.some((t) => t?.function?.name === "end_turn")) return body;
  return { ...body, tools: [...tools, END_TURN_TOOL] };
}

/* ------------------------------------------------------------------ */
/*  Session stale codes — re-claim on these HTTP statuses              */
/* ------------------------------------------------------------------ */
const SESSION_STALE_CODES = new Set([428, 409, 410]);

/* ------------------------------------------------------------------ */
/*  Global session cache (mirrors VansRouter's globalThis pattern)     */
/* ------------------------------------------------------------------ */
const SESSION_DEFAULT_TTL_MS = 60 * 60 * 1000;
const MODEL_LOCK_COOLDOWN_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Request semaphore — limit concurrent Freebuff upstream requests    */
/* ------------------------------------------------------------------ */
const MAX_CONCURRENT_REQUESTS = 2;
const MIN_REQUEST_INTERVAL_MS = 1500;
const SEMAPHORE_KEY = "__omnirouteFreebuffSemaphore__";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const semaphore: any = (globalThis as any)[SEMAPHORE_KEY] ??= {
  active: 0,
  queue: [] as Array<() => void>,
  lastRequestTime: 0,
};

async function acquireSemaphore(): Promise<void> {
  if (semaphore.active < MAX_CONCURRENT_REQUESTS) {
    semaphore.active++;
  } else {
    await new Promise<void>((resolve) => {
      semaphore.queue.push(() => {
        semaphore.active++;
        resolve();
      });
    });
  }
  // Enforce minimum interval between requests to avoid burst
  const now = Date.now();
  const elapsed = now - semaphore.lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  semaphore.lastRequestTime = Date.now();
}

function releaseSemaphore(): void {
  semaphore.active--;
  if (semaphore.queue.length > 0) {
    const next = semaphore.queue.shift();
    next?.();
  }
}

function jitterMs(baseMs: number): number {
  // Add 0-30% random jitter to avoid thundering herd
  return baseMs + Math.floor(Math.random() * baseMs * 0.3);
}

const FB_STATE_KEY = "__omnirouteFreebuffState__";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fbState: any = (globalThis as any)[FB_STATE_KEY] ??= {
  sessionCache: new Map<string, { instanceId: string; expiresAt: number }>(),
  inflight: new Map<string, Promise<{ instanceId: string; status: string }>>(),
  modelLockCooldowns: new Map<string, number>(),
};

function sessionCacheKey(token: string, model: string): string {
  return `${token}::${model}`;
}

function generateClientSessionId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 13; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  FreebuffExecutor                                                   */
/* ------------------------------------------------------------------ */
export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", PROVIDERS.freebuff || { format: "openai" });
  }

  override async execute(input: ExecuteInput) {
    /* Acquire semaphore — limits concurrent upstream requests */
    await acquireSemaphore();
    try {
      return await this.executeInternal(input);
    } finally {
      releaseSemaphore();
    }
  }

  private async executeInternal(input: ExecuteInput) {
    const { model, body, stream, credentials, signal } = input;
    const token = credentials?.apiKey || credentials?.accessToken || "";
    const payload =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};

    if (!token) {
      return {
        response: new Response(
          JSON.stringify({
            error: { message: "Freebuff Auth Token required", type: "authentication_error" },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        ),
      };
    }

    const requestedModel =
      typeof model === "string"
        ? model.replace(/^freebuff\//, "")
        : model || "deepseek/deepseek-v4-flash";
    const agentId = rootAgentIdForModel(requestedModel);

    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "codebuff-cli/0.0.138",
    };

    const sessionKey = sessionCacheKey(token, requestedModel);

    /* ---- 1. Ensure session (with caching) ---- */
    let instanceId = "";
    try {
      const cached = fbState.sessionCache.get(sessionKey);
      if (cached && cached.expiresAt > Date.now()) {
        instanceId = cached.instanceId;
      } else {
        fbState.sessionCache.delete(sessionKey);
        const sessionRes = await fetch("https://www.codebuff.com/api/v1/freebuff/session", {
          method: "POST",
          headers: {
            ...authHeaders,
            "x-freebuff-model": requestedModel,
          },
          body: JSON.stringify({}),
          signal,
        });
        const data = (await sessionRes.json()) as {
          instanceId?: string;
          status?: string;
          expiresAt?: string;
        };

        if (sessionRes.ok && data.status === "active") {
          instanceId = data.instanceId || "";
          const parsedExp = Date.parse(data.expiresAt || "");
          fbState.sessionCache.set(sessionKey, {
            instanceId,
            expiresAt: Number.isFinite(parsedExp) ? parsedExp : Date.now() + SESSION_DEFAULT_TTL_MS,
          });
        } else if (!sessionRes.ok) {
          const errText = JSON.stringify(data).slice(0, 200);
          return {
            response: new Response(
              JSON.stringify({
                error: {
                  message: `Freebuff session failed (${sessionRes.status}): ${errText}`,
                  type: "upstream_error",
                },
              }),
              { status: sessionRes.status, headers: { "Content-Type": "application/json" } }
            ),
          };
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        response: new Response(
          JSON.stringify({
            error: { message: `Freebuff session error: ${msg}`, type: "upstream_error" },
          }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        ),
      };
    }

    /* ---- 2. Start agent run ---- */
    let runId = "";
    try {
      const runRes = await fetch("https://www.codebuff.com/api/v1/agent-runs", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          action: "START",
          agentId,
          ancestorRunIds: [],
        }),
        signal,
      });
      if (runRes.ok) {
        const runData = (await runRes.json()) as { runId?: string };
        runId = runData.runId || "";
      }
    } catch {
      // Best-effort — continue without runId
    }

    /* ---- 3. Build chat completion body ---- */
    const incomingMessages: Array<Record<string, unknown>> = Array.isArray(payload.messages)
      ? payload.messages.filter(
          (message): message is Record<string, unknown> =>
            !!message && typeof message === "object" && !Array.isArray(message)
        )
      : [];

    // Inject Buffy marker + end_turn tool
    let bodyWithTools = injectEndTurnTool({
      ...payload,
      messages: incomingMessages,
    });
    bodyWithTools = injectFreebuffMarker(bodyWithTools);

    // Delete reasoning params — Freebuff agents handle reasoning server-side
    delete bodyWithTools.reasoning_effort;
    delete bodyWithTools.reasoning;

    const clientSessionId = generateClientSessionId();
    const existingMetadata =
      payload.codebuff_metadata &&
      typeof payload.codebuff_metadata === "object" &&
      !Array.isArray(payload.codebuff_metadata)
        ? (payload.codebuff_metadata as Record<string, unknown>)
        : {};

    const traceSessionId = randomUUID();

    const upstreamBody = {
      ...bodyWithTools,
      model: requestedModel,
      messages: bodyWithTools.messages,
      stream: stream !== false,
      codebuff_metadata: {
        run_id: runId,
        cost_mode: "free",
        client_id: clientSessionId,
        freebuff_instance_id: instanceId,
        trace_session_id: traceSessionId,
        ...existingMetadata,
      },
      provider: { allow_fallbacks: false },
    };

    const completionHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ai-sdk/openai-compatible/1.0/codebuff",
      Accept: "application/json, text/event-stream",
      ...(instanceId ? { "x-freebuff-instance-id": instanceId } : {}),
      ...(runId ? { "x-codebuff-run-id": runId } : {}),
      "x-codebuff-agent-id": agentId,
    };

    /* ---- 4. Chat Completion (with 503 retry) ---- */
    const completionUrl = "https://www.codebuff.com/api/v1/chat/completions";
    const MAX_503_RETRIES = 3;
    let response: Response | undefined;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_503_RETRIES; attempt++) {
      response = await fetch(completionUrl, {
        method: "POST",
        headers: completionHeaders,
        body: JSON.stringify(upstreamBody),
        signal,
      });

      if (response.status !== 503) break;

      const errBody = await response.clone().text().catch(() => "");
      lastError = errBody;
      const isStructurallyHeavy = errBody.includes("Structurally heavy");
      const baseDelay = isStructurallyHeavy ? 4000 : 2000;
      const delayMs = jitterMs(baseDelay * 2 ** attempt);

      console.log(
        `[FREEBUFF] 503 attempt ${attempt + 1}/${MAX_503_RETRIES}: ${isStructurallyHeavy ? "structurally heavy" : "admission capacity"} — retrying in ${delayMs}ms`
      );

      if (attempt < MAX_503_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    /* ---- 4b. Handle stale session codes (re-claim) ---- */
    if (response && SESSION_STALE_CODES.has(response.status)) {
      const respText = await response.clone().text().catch(() => "");
      const parsed = (() => {
        try {
          return JSON.parse(respText);
        } catch {
          return {};
        }
      })();
      const errCode = parsed?.error || "";

      // Model locked — not reclaimable
      if (errCode === "model_locked") {
        const lockUntil = Date.now() + MODEL_LOCK_COOLDOWN_MS;
        fbState.modelLockCooldowns.set(sessionKey, lockUntil);
        this.finishRunBackground(token, runId, "cancelled");
        return {
          response: new Response(
            JSON.stringify({
              error: {
                message: `Freebuff session is locked to another model. Try again after ${new Date(lockUntil).toLocaleTimeString()}.`,
                type: "upstream_error",
              },
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          ),
        };
      }

      // Re-claim session
      console.log("[FREEBUFF] Session stale (", response.status, ") — re-claiming");
      this.finishRunBackground(token, runId, "cancelled");

      try {
        fbState.sessionCache.delete(sessionKey);
        const sessionRes = await fetch("https://www.codebuff.com/api/v1/freebuff/session", {
          method: "POST",
          headers: {
            ...authHeaders,
            "x-freebuff-model": requestedModel,
          },
          body: JSON.stringify({}),
          signal,
        });
        const data = (await sessionRes.json()) as {
          instanceId?: string;
          status?: string;
          expiresAt?: string;
        };
        if (sessionRes.ok && data.status === "active") {
          instanceId = data.instanceId || "";
          const parsedExp = Date.parse(data.expiresAt || "");
          fbState.sessionCache.set(sessionKey, {
            instanceId,
            expiresAt: Number.isFinite(parsedExp)
              ? parsedExp
              : Date.now() + SESSION_DEFAULT_TTL_MS,
          });
        }
      } catch {
        // Continue with old instanceId
      }

      // New run
      try {
        const runRes = await fetch("https://www.codebuff.com/api/v1/agent-runs", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            action: "START",
            agentId,
            ancestorRunIds: [],
          }),
          signal,
        });
        if (runRes.ok) {
          const runData = (await runRes.json()) as { runId?: string };
          runId = runData.runId || "";
        }
      } catch {
        // Continue
      }

      // Retry chat
      upstreamBody.codebuff_metadata.freebuff_instance_id = instanceId;
      upstreamBody.codebuff_metadata.run_id = runId;
      if (instanceId) {
        completionHeaders["x-freebuff-instance-id"] = instanceId;
      } else {
        delete completionHeaders["x-freebuff-instance-id"];
      }
      if (runId) {
        completionHeaders["x-codebuff-run-id"] = runId;
      } else {
        delete completionHeaders["x-codebuff-run-id"];
      }

      response = await fetch(completionUrl, {
        method: "POST",
        headers: completionHeaders,
        body: JSON.stringify(upstreamBody),
        signal,
      });
    }

    /* ---- 5. Finish agent run (background) ---- */
    if (!response) {
      response = new Response(
        JSON.stringify({ error: { message: "Freebuff: no response from upstream", type: "upstream_error" } }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    this.finishRunBackground(token, runId, response.ok ? "completed" : "failed");

    // Clear model lock on success
    if (response.ok) {
      fbState.modelLockCooldowns.delete(sessionKey);
    }

    return { response };
  }

  private finishRunBackground(token: string, runId: string, status: string) {
    if (!runId) return;
    void fetch("https://www.codebuff.com/api/v1/agent-runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "codebuff-cli/0.0.138",
      },
      body: JSON.stringify({ action: "FINISH", runId, status }),
    }).catch(() => {});
  }
}

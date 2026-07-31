import { type ModelSessionOptions, getAvailableModels } from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { SessionPool, handleChatCompletion } from "./handler.js";

export { SessionPool, handleChatCompletion } from "./handler.js";
export {
  ConversationTurnQueue,
  classifyTurnIntent,
  decideRecovery,
  detectHostOs,
  executionPolicy,
  mutationForcePrompt,
  toolCapabilities,
  type ConversationIdentity,
  type ConversationStateSnapshot,
  type CursorMode,
  type ExecutionPolicy,
  type HostOs,
  type ModelProvider,
  type ProviderEvent,
  type ProviderTurnInput,
  type ToolCallRecord,
  type ToolCapabilities,
  type TurnIntent,
} from "./orchestration.js";
export { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from "./schemas.js";
export {
  sanitizeCursorBody,
  sanitizeSandboxPath,
  shellWriteCommand,
  rewritePowerShellHereStringWrites,
  latestUserAsk,
  isCreateIntent,
  isCursorRequest,
  detectCursorMode,
  cursorCompatEnabled,
  cursorFramingVariant,
  cursorToolsForFraming,
} from "./cursor-compat.js";

// Re-export tool utilities from core
export {
  formatMessages,
  formatToolDefinitions,
  parseToolCalls,
  getMessageContent,
  type Message,
  type ToolDef,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "@m365-copilot/core";

// --- Shared response payloads (reused by the Nitro routes in @m365-copilot/proxy) ---

/** Static body for `GET /health`. */
export const HEALTH_PAYLOAD = { status: "ok" } as const;

const CONTEXT_WINDOW_TOKENS = Number(process.env.M365_CONTEXT_WINDOW) || 1_000_000;
const MAX_OUTPUT_TOKENS = Number(process.env.M365_MAX_OUTPUT_TOKENS) || 1_000_000;

/** Build the OpenAI-compatible `GET /v1/models` payload. */
export function buildModelsPayload() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: getAvailableModels().map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "microsoft",
      context_window: CONTEXT_WINDOW_TOKENS,
      max_context_length: CONTEXT_WINDOW_TOKENS,
      max_input_tokens: CONTEXT_WINDOW_TOKENS,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    })),
  };
}

// --- CORS (permissive, matches the previous Hono `cors()` default) ---

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": process.env.M365_CORS_ORIGIN ?? "null",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function callerAuthorized(req: Request): boolean {
  const configuredKey = process.env.M365_API_KEY?.trim();
  if (!configuredKey && process.env.M365_REQUIRE_API_KEY !== "1") return true;
  const auth = req.headers.get("authorization") ?? "";
  const supplied = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ??
    req.headers.get("x-api-key") ??
    "";
  return !!configuredKey && supplied === configuredKey;
}

/** A minimal Web fetch handler — the same shape Hono exposed via `app.fetch`. */
export interface FetchApp {
  fetch(req: Request): Promise<Response>;
}

/**
 * Create a framework-free fetch handler that serves an OpenAI-compatible API
 * backed by M365 Copilot. Each distinct conversation automatically gets its own
 * M365 session via the SessionPool.
 */
export function createApp(sessionOptions: ModelSessionOptions = {}): FetchApp {
  const pool = new SessionPool(sessionOptions);

  async function fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (method === "GET" && pathname === "/health") {
      return withCors(json(200, HEALTH_PAYLOAD));
    }

    if (method === "GET" && pathname === "/v1/models") {
      return withCors(json(200, buildModelsPayload()));
    }

    if (method === "POST" && pathname === "/v1/chat/completions") {
      if (!callerAuthorized(req)) {
        return withCors(
          json(401, {
            error: {
              message: "Provide the configured M365_API_KEY as a Bearer token or X-API-Key.",
              type: "authentication_error",
            },
          }),
        );
      }
      let body: ReturnType<typeof ChatCompletionRequest.parse>;
      try {
        body = ChatCompletionRequest.parse(await req.json());
      } catch (err: any) {
        return withCors(
          json(400, { error: { message: err.message, type: "invalid_request_error" } }),
        );
      }
      return withCors(
        await handleChatCompletion(body, pool, {
          signal: req.signal,
          clientId:
            req.headers.get("x-conversation-id") ??
            req.headers.get("x-client-conversation-id") ??
            undefined,
          principalId: req.headers.has("authorization")
            ? "authenticated-client"
            : "anonymous",
        }),
      );
    }

    return withCors(
      json(404, { error: { message: "Not found", type: "invalid_request_error" } }),
    );
  }

  return { fetch };
}

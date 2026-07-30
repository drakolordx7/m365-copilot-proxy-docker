import { JwtClaims } from "./schemas.js";

// Model id → M365 `tone` string. Tones are validated server-side.
// Advertised ids match the Copilot UI (July 2026): Auto, Quick response, Think deeper, GPT-5.6/5.5 variants.
const MODEL_TONES: Record<string, string> = {
  // --- Copilot UI (what users see in the picker) ---
  auto: "magic",
  "m365-copilot": "magic",
  quick: "Gpt_Quick",
  "quick-response": "Gpt_Quick",
  "think-deeper": "Gpt_Reasoning",

  // --- GPT-5.6 (preferred model, July 2026+) ---
  "gpt-5.6": "Gpt_5_6_Chat",
  "gpt-5.6-quick": "Gpt_5_6_Chat",
  "gpt-5.6-think-deeper": "Gpt_5_6_Reasoning",

  // --- GPT-5.5 (legacy picker on some tenants) ---
  "gpt-5.5": "Gpt_5_5_Chat",
  "gpt-5.5-quick": "Gpt_5_5_Chat",

  // --- Claude (when shown in picker) ---
  claude: "Claude_Sonnet",
  "claude-sonnet": "Claude_Sonnet",
  "claude-opus": "Claude_Opus",

  // --- Cursor-safe aliases (won't collide with Cursor built-in model names) ---
  "m365-auto": "magic",
  "m365-quick": "Gpt_Quick",
  "m365-think": "Gpt_Reasoning",
  "m365-5.6-think": "Gpt_5_6_Reasoning",
  "m365-5.6-quick": "Gpt_5_6_Chat",
  "m365-5.5-quick": "Gpt_5_5_Chat",

  // --- Legacy aliases (old configs / docs — not advertised) ---
  "gpt-5.5-think-deeper": "Gpt_5_5_Reasoning",
  "gpt-5.4": "Gpt_5_4_Reasoning",
  "gpt-5.4-think-deeper": "Gpt_5_4_Reasoning",
  "gpt-5.4-quick": "Gpt_5_4_Quick",
  "gpt-5.3": "Gpt_5_3_Quick",
  "gpt-5.3-quick": "Gpt_5_3_Quick",
  "gpt-5.3-think-deeper": "Gpt_5_3_Reasoning",
  "gpt-5.2": "Gpt_5_2_Quick",
  "gpt-5.2-quick": "Gpt_5_2_Quick",
  "gpt-5.2-think-deeper": "Gpt_5_2_Reasoning",
  "claude-sonnet-4.5": "Claude_Sonnet",
  "claude-sonnet-think-deeper": "Claude_Sonnet_Reasoning",
};

/** Models listed in GET /v1/models — Cursor-safe ids first (no built-in name collisions). */
const ADVERTISED_MODELS = [
  "m365-think",
  "m365-quick",
  "m365-auto",
  "m365-5.6-think",
  "m365-5.6-quick",
  "m365-5.5-quick",
  "auto",
  "quick",
  "think-deeper",
  "gpt-5.6-think-deeper",
  "gpt-5.6-quick",
  "gpt-5.5-quick",
  "claude-opus",
] as const;

/** Cursor appends -medium/-high when a name matches a built-in; strip before lookup. */
function normalizeModelId(model: string): string {
  return model.replace(/-(medium|high|low|max)$/i, "");
}

export function getToneForModel(model: string): string {
  const normalized = normalizeModelId(model);
  const exact = MODEL_TONES[normalized] ?? MODEL_TONES[model];
  if (exact) return exact;
  if (/^claude/i.test(normalized)) return "Claude_Sonnet";
  if (/^gpt-5\.6/i.test(normalized)) return "Gpt_5_6_Reasoning";
  if (/^m365-/i.test(normalized)) return MODEL_TONES["m365-auto"];
  return MODEL_TONES.auto;
}

export function getAvailableModels(): string[] {
  return [...ADVERTISED_MODELS];
}

export function decodeJwt(token: string) {
  const payload = token.split(".")[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const raw = JSON.parse(Buffer.from(padded, "base64").toString());
  return JwtClaims.parse(raw);
}

export interface CopilotStream {
  [Symbol.asyncIterator](): AsyncIterator<string>;
  fullText: string;
  hasContent: boolean;
  throttle: { current: number; max: number } | null;
  contentOrigin?: string | null;
  messageType?: string | null;
  messageId?: string | null;
  scores?: Record<string, number> | null;
  turnCount?: number | null;
  turnState?: string | null;
  sawAction?: boolean;
}

import { z } from "zod/v4";

// --- OpenAI Request Schemas ---
// Cursor BYOK sends richer / slightly non-standard payloads than strict OpenAI
// (extra tool types, content parts, tool_choice variants). Stay permissive here
// so Agent/Ask requests parse; the handler only uses function tools.

export const ToolCallFunction = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const ToolCall = z.object({
  type: z.string().optional().default("function"),
  id: z.string(),
  function: ToolCallFunction,
}).passthrough();

export const ToolDefinition = z.object({
  type: z.string().optional().default("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.any().optional(),
  }).optional(),
}).passthrough();

export const ChatMessage = z.object({
  // `developer` is OpenAI's reasoning-model role — it replaces `system` for o1/
  // gpt-5-class reasoning models, and clients like Hermes emit it when pointed at
  // a `*-think-deeper` model. Accept it and normalize to `system` so every
  // downstream consumer only ever sees the four canonical roles.
  role: z.enum(["system", "developer", "user", "assistant", "tool"]).transform(
    (r) => (r === "developer" ? "system" : r),
  ),
  content: z.union([
    z.string(),
    z.array(z.object({ type: z.string() }).passthrough()),
  ]).nullable().optional(),
  tool_calls: z.array(ToolCall).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
}).passthrough();

export const ChatCompletionRequest = z.object({
  // Default when the client sends no model. An explicit reasoning tone is a more
  // reliable default than `m365-copilot` (the `magic` auto-router), which is
  // high-variance at turn-1 tool-calling (see docs/hypotheses.md F24 + correction:
  // magic swung 0/2 → 2/2 across probes; explicit tones pin a specific backend).
  model: z.string().optional().default("think-deeper"),
  messages: z.array(ChatMessage).min(1),
  stream: z.boolean().optional().default(false),
  // OpenAI streaming option: include_usage=true → emit a final chunk with `usage`.
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  tools: z.array(ToolDefinition).optional(),
  tool_choice: z.union([
    z.string(),
    z.object({
      type: z.string(),
      function: z.object({ name: z.string() }).partial().optional(),
    }).passthrough(),
  ]).optional(),
}).passthrough();

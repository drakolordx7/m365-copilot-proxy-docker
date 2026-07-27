import { getAvailableModels } from "@m365-copilot/core";

const MODEL_LABELS: Record<string, string> = {
  "m365-copilot": "M365 Copilot (Auto)",
  auto: "M365 Copilot (Auto)",
  quick: "M365 Copilot (Quick)",
  "think-deeper": "M365 Copilot (Think Deeper)",
  claude: "Claude Sonnet (M365)",
  "claude-sonnet": "Claude Sonnet (M365)",
  "claude-sonnet-4.5": "Claude Sonnet 4.5 (M365)",
  "claude-sonnet-think-deeper": "Claude Sonnet Reasoning (M365)",
  "claude-opus": "Claude Opus (M365)",
  "gpt-5.5": "GPT-5.5 Chat",
  "gpt-5.5-quick": "GPT-5.5 Quick",
  "gpt-5.5-think-deeper": "GPT-5.5 Think Deeper (recommended)",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-quick": "GPT-5.4 Quick",
  "gpt-5.4-think-deeper": "GPT-5.4 Think Deeper",
  "gpt-5.3": "GPT-5.3",
  "gpt-5.3-quick": "GPT-5.3 Quick",
  "gpt-5.3-think-deeper": "GPT-5.3 Think Deeper",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.2-quick": "GPT-5.2 Quick",
  "gpt-5.2-think-deeper": "GPT-5.2 Think Deeper",
};

/** OpenAI-compatible model list tuned for Open WebUI auto-discovery. */
export default defineEventHandler(() => {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: getAvailableModels().map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "microsoft",
      name: MODEL_LABELS[id] ?? id,
      context_window: 1_000_000,
      max_context_length: 1_000_000,
      max_input_tokens: 1_000_000,
      max_output_tokens: 1_000_000,
    })),
  };
});

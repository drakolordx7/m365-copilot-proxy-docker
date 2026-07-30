import { getAvailableModels } from "@m365-copilot/core";

const MODEL_LABELS: Record<string, string> = {
  "m365-think": "M365 Think deeper (use in Cursor)",
  "m365-quick": "M365 Quick response (use in Cursor)",
  "m365-auto": "M365 Auto (use in Cursor)",
  "m365-5.6-think": "M365 GPT-5.6 Think deeper (Cursor)",
  "m365-5.6-quick": "M365 GPT-5.6 Quick (Cursor)",
  "m365-5.5-quick": "M365 GPT-5.5 Quick (Cursor)",
  auto: "Auto",
  quick: "Quick response",
  "think-deeper": "Think deeper",
  "gpt-5.6-think-deeper": "GPT-5.6 Think deeper",
  "gpt-5.6-quick": "GPT-5.6 Quick response",
  "gpt-5.5-quick": "GPT-5.5 Quick response",
  "claude-opus": "Claude Opus",
};

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

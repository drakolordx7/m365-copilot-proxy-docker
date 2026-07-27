import { getAvailableModels } from "@m365-copilot/core";

const MODEL_LABELS: Record<string, string> = {
  "gpt-5.5-think-deeper": "GPT-5.5 Think Deeper (recommended)",
  "gpt-5.5-quick": "GPT-5.5 Quick",
  "m365-copilot": "M365 Copilot (Auto)",
};

/** Alias for Open WebUI setups that omit `/v1` from the base URL. */
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
    })),
  };
});

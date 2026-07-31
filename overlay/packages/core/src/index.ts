export {
  getToken,
  getTokenSilent,
  getTokenForScope,
  loginAutomated,
  loadSecrets,
  forceReauth,
  resolveAuthMode,
  effectiveAuthMode,
  getAuthStatus,
  startOAuthLogin,
  completeOAuthLogin,
  loginWithDeviceCode,
  type AuthMode,
} from "./auth.js";

export {
  noteRequestOutcome,
  awaitDegradationBackoff,
  isDegradationBackoff,
  createBackoffController,
  type BackoffController,
  type BackoffOptions,
} from "./auth-recovery.js";

export { getOrCreateAgent } from "./agent.js";

export {
  decodeJwt,
  getToneForModel,
  getAvailableModels,
  type CopilotStream,
} from "./copilot.js";

export {
  CopilotSession,
  type CopilotSessionOptions,
  type NativeActionConfig,
} from "./session.js";

export {
  parseActionConfirmation,
  buildResumeInvokeAction,
  shouldAutoConfirm,
  buildNativeActionPrompt,
  NATIVE_ACTION_INSTRUCTIONS,
  ACTION_ALLOWED_MESSAGE_TYPES,
  ACTION_CONFIRM_MESSAGE_TYPES,
  type ActionConfirmation,
} from "./native-actions.js";

export {
  ModelSession,
  type ModelSessionOptions,
} from "./model.js";

export {
  formatMessages,
  formatToolDefinitions,
  formatToolChoiceInstruction,
  getMessageContent,
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeFakeCopilotAttachment,
  classifyConfabulation,
  looksLikeStalledAgentProse,
  isProseDocument,
  type ConfabCategory,
  type Message,
  type ToolDef,
  type ToolFunction,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "./tools.js";

export { createLogger, trunc, LOG_PATH } from "./log.js";

import {
  ModelSession,
  type ModelSessionOptions,
  createLogger,
  trunc,
  getToneForModel,
  formatMessages,
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeFakeCopilotAttachment,
  isProseDocument,
  getMessageContent,
  noteRequestOutcome,
  awaitDegradationBackoff,
} from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import {
  cursorFramingVariant,
  cursorToolsForFraming,
  detectCursorMode,
  isCursorRequest,
  rewriteBashToCursorTools,
  shouldBootstrapCursor,
  synthesizeCursorBootstrap,
  enforceExplicitCursorTool,
  remainingCreateFilenames,
  extractRequestedFilenames,
  latestUserAsk,
  latestToolResponseFailed,
  isPhaseContinueAsk,
  looksLikePhaseCompleteClaim,
} from "./cursor-compat.js";
import type { z } from "zod/v4";
import { createHash } from "node:crypto";
import {
  ConversationTurnQueue,
  executionPolicy,
  type ConversationIdentity,
  type CursorMode,
  type ToolCallRecord,
} from "./orchestration.js";

const log = createLogger("handler");

/** Keep only short, non-confabulatory status text to show with tool_calls. */
function extractCursorStatusUpdate(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 280) return null;
  if (looksLikeConfabulation(t)) return null;
  if (/^#{1,3}\s|^\*\*[A-Z]|Final Cursor|##\s|I can'?t|cannot access|M365 Copilot|proxy smoke/i.test(t)) {
    return null;
  }
  if (t.split(/\n/).filter((l) => l.trim()).length > 3) return null;
  // Prefer a single leading sentence
  const first = t.split(/\n+/)[0]!.trim();
  return first.length >= 8 && first.length <= 280 ? first : null;
}

// Forcing follow-up sent (in the same conversation) when M365 confabulates an
// inability to act instead of calling a tool. See the confab-retry loop below.
const CONFAB_FORCE_PROMPT =
  "The working directory and the files named in the task ARE present on a real filesystem right now. Do NOT ask me to paste anything, and do NOT say commands return no output — you have not run any command yet. Emit ONE ```bash block this turn: run `ls -la` and `cat` the relevant files. Output only the ```bash block, nothing else.";

const CURSOR_CONFAB_FORCE_PROMPT =
  "You have a real Cursor workspace with working tools. Do NOT claim the filesystem is empty, do NOT invent an isolated Linux container, do NOT say Shell/ReadFile vanished, do NOT mention /mnt/data, and do NOT ask the user to paste the Phase plan, upload a .zip, or reopen in another session. File-not-found on one path does NOT mean no access — emit ONE ```Glob fence with glob_pattern: **/* now (find ARCHITECTURE.md / plan files), then continue Phase work with Shell writes. Optional: one short progress sentence before the fence. No markdown report.";

// Forcing follow-up when the model CLAIMS it did a file change but ran no tool.
const HALLUCINATION_FORCE_PROMPT =
  "You have NOT actually done that — no tool ran this turn, so nothing changed on disk. Do not claim a file was created, replaced, or updated until a <tool_response> confirms it. Emit ONE ```bash block now that performs the change for real (write the file with a `cat > path <<'EOF' … EOF` heredoc), and nothing else.";

const CURSOR_HALLUCINATION_FORCE_PROMPT =
  "You have NOT actually done that — no tool ran this turn, so nothing changed on disk. Emit ONE ```Write or ```StrReplace fence that performs the change for real. Output only the fence, nothing else.";

// When Cursor omits Write/StrReplace (common on BYOK), edits must go through Shell.
function cursorShellWriteForcePrompt(files: string[]): string {
  const base64Rule =
    `Do NOT use PowerShell here-strings (@' '@ or @" "@) — they break with "missing the terminator". ` +
    `Write with base64 only: $p='file'; $b='BASE64'; [IO.File]::WriteAllText($p,[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))); Write-Output "wrote $p". `;
  if (!files.length) {
    return (
      `You have NOT finished writing into the Cursor workspace. /mnt/data and Copilot sandboxes do NOT count. ` +
      `Shell/ReadFile are still available — a parse error or prior turn does NOT mean tools vanished or that only a Linux container remains. ` +
      `Choose clear NEW filenames that match THIS user request (do NOT reuse unrelated leftover names unless asked). ` +
      base64Rule +
      `Emit ONE \`\`\`Shell fence for the next file (relative path, never /mnt/data). ` +
      `Optional: one short progress sentence before the fence. No markdown essay, no download links, no turnNfile cites.`
    );
  }
  const list = files.join(", ");
  const next = files[0];
  return (
    `You have NOT finished writing into the Cursor workspace. /mnt/data and Copilot sandboxes do NOT count. ` +
    `Shell/ReadFile are still available — a parse error or prior turn does NOT mean tools vanished or that only a Linux container remains. ` +
    `Files still needed for THIS request: ${list}. ` +
    base64Rule +
    `Emit ONE \`\`\`Shell fence that creates ${next} (relative path, never /mnt/data). ` +
    `After that tool_response, continue with any remaining files — do NOT stop after one file. ` +
    `Optional: one short progress sentence before the fence. No markdown essay, no download links, no turnNfile cites.`
  );
}

// Copilot "Download ZIP / Teams asyncgw attachment" modality — unreachable from Cursor.
function cursorAttachmentForcePrompt(files: string[]): string {
  if (!files.length) {
    return (
      `STOP. Do NOT offer download links, ZIP archives, Teams/asyncgw URLs, cite attachments, or turnNfile markers. ` +
      `Cursor cannot fetch those. For THIS user request, pick sensible NEW filenames (do not reuse unrelated leftover files). ` +
      `Emit ONE \`\`\`Shell fence that writes the first file with PowerShell Set-Content / WriteAllText (relative path, never /mnt/data). ` +
      `Keep going file-by-file until the request is done. Optional: one short progress sentence before the fence. No markdown, no links.`
    );
  }
  const list = files.join(", ");
  const next = files[0];
  return (
    `STOP. Do NOT offer download links, ZIP archives, Teams/asyncgw URLs, cite attachments, or turnNfile markers. ` +
    `Cursor cannot fetch those. Required workspace files for THIS request: ${list}. ` +
    `Emit ONE \`\`\`Shell fence that writes ${next} with PowerShell Set-Content / WriteAllText (relative path, never /mnt/data). ` +
    `Keep going file-by-file until ALL required files exist, then Read them back. ` +
    `Optional: one short progress sentence before the fence. No markdown, no links, no zip instructions.`
  );
}

function cursorHasWriteTool(tools: ChatBody["tools"]): boolean {
  return !!tools?.some((t) => /^(Write|WriteFile|write_file)$/i.test(t.function?.name ?? ""));
}

// M365 soft-caps output around ~3k tokens (~12k chars) and — critically —
// CONCLUDES EARLY rather than truncating mid-stream, so a too-long answer comes
// back clean-looking but incomplete with no error to detect (docs/hypotheses.md
// F9). We can't see token counts, so we heuristically flag responses at/over the
// observed ceiling with finish_reason:"length" — the standard signal a harness
// uses to ask for a continuation. Tune/disable via env (0 disables).
const OUTPUT_CHAR_CEILING = process.env.M365_OUTPUT_CHAR_CEILING !== undefined
  ? Number(process.env.M365_OUTPUT_CHAR_CEILING)
  : 12_000;

/** "length" when the answer is at/over the empirical output ceiling, else "stop". */
function outputFinishReason(text: string): "stop" | "length" {
  if (OUTPUT_CHAR_CEILING > 0 && text.length >= OUTPUT_CHAR_CEILING) {
    log.info(`Output at ceiling (${text.length} ≥ ${OUTPUT_CHAR_CEILING} chars) — finish_reason=length (likely truncated; harness should continue)`);
    return "length";
  }
  return "stop";
}

function enforceToolChoice(
  parsed: ReturnType<typeof parseToolCalls>,
  choice: ChatBody["tool_choice"],
): ReturnType<typeof parseToolCalls> {
  if (
    !choice ||
    choice === "auto" ||
    choice === "required" ||
    choice === "none" ||
    typeof choice === "string"
  ) {
    return parsed;
  }
  const requested = choice.function?.name;
  if (!requested || !parsed.hasToolCalls) return parsed;
  const matching = parsed.toolCalls.filter(
    (call) => call.function.name === requested,
  );
  if (!matching.length) {
    return { hasToolCalls: false, toolCalls: [], textContent: parsed.textContent };
  }
  return {
    ...parsed,
    toolCalls: matching,
  };
}

function validateToolCalls(
  parsed: ReturnType<typeof parseToolCalls>,
  tools: ChatBody["tools"],
): ReturnType<typeof parseToolCalls> {
  if (!parsed.hasToolCalls || !tools?.length) return parsed;
  const definitions = new Map(
    tools.map((tool) => [tool.function?.name, tool.function]),
  );
  const valid = parsed.toolCalls.filter((call) => {
    const definition = definitions.get(call.function.name);
    if (!definition) {
      log.warn(`Dropping unknown tool call: ${call.function.name}`);
      return false;
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      log.warn(`Dropping invalid JSON arguments for: ${call.function.name}`);
      return false;
    }
    const required = definition.parameters?.required;
    if (Array.isArray(required)) {
      const missing = required.filter((key: unknown) =>
        typeof key === "string" && (args[key] === undefined || args[key] === null),
      );
      if (missing.length) {
        log.warn(`Dropping ${call.function.name}; missing: ${missing.join(",")}`);
        return false;
      }
    }
    return true;
  });
  return valid.length === parsed.toolCalls.length
    ? parsed
    : { ...parsed, hasToolCalls: valid.length > 0, toolCalls: valid };
}

type ChatBody = z.infer<typeof ChatCompletionRequest>;
type ParsedMessage = ChatBody["messages"][number];

// --- Per-conversation state ---

interface ConversationState {
  session: ModelSession;
  sentMessageCount: number;
  lastAccessedAt: number;
  identity: ConversationIdentity;
  queue: ConversationTurnQueue;
  toolCalls: Map<string, ToolCallRecord>;
}

// --- Session pool: maps conversation fingerprint → M365 session ---

const MAX_IDLE_MS = 30 * 60 * 1000; // evict after 30 min idle

export class SessionPool {
  private conversations = new Map<string, ConversationState>();
  private sessionOptions: ModelSessionOptions;

  constructor(sessionOptions: ModelSessionOptions = {}) {
    this.sessionOptions = sessionOptions;
  }

  /**
   * Resolve the conversation state for an incoming request.
   * Fingerprint is the hash of the first user message — same first user message = same conversation.
   */
  resolve(
    messages: ParsedMessage[],
    identity: ConversationIdentity = {
      clientId: "",
      principalId: "anonymous",
    },
  ): ConversationState {
    this.evictStale();

    const fingerprint = this.fingerprint(messages, identity);
    const existing = this.conversations.get(fingerprint);

    if (existing) {
      // Messages shrunk means client restarted this conversation — reset M365 session
      if (messages.length < existing.sentMessageCount) {
        log.info(`Conversation ${fingerprint}: messages shrunk (${messages.length} < ${existing.sentMessageCount}), resetting`);
        existing.session.reset();
        existing.sentMessageCount = 0;
        existing.toolCalls.clear();
      }
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    // New conversation
    log.info(`New conversation ${fingerprint}, ${this.conversations.size} active`);
    const state: ConversationState = {
      session: new ModelSession(this.sessionOptions),
      sentMessageCount: 0,
      lastAccessedAt: Date.now(),
      identity,
      queue: new ConversationTurnQueue(),
      toolCalls: new Map(),
    };
    this.conversations.set(fingerprint, state);
    return state;
  }

  private fingerprint(
    messages: ParsedMessage[],
    identity: ConversationIdentity,
  ): string {
    // Prefer an explicit client conversation id when Cursor/OpenAI clients send one.
    // Otherwise fingerprint the latest real user ASK (not the first preamble message
    // Cursor injects with rules/open-files — that collided unrelated new chats).
    const users = messages.filter(
      (m) =>
        m.role === "user" &&
        !/<tool_response\b/i.test(getMessageContent(m)) &&
        !/\bcall_id\s*=/i.test(getMessageContent(m)),
    );
    const rawAsk = users.length ? getMessageContent(users[users.length - 1]) : "";
    const ask = rawAsk
      .replace(/<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/gi, "")
      .replace(/Recently viewed files?:[\s\S]*?(?=\n\n|\n#|\nUser:|$)/gi, "")
      .replace(/Open files?:[\s\S]*?(?=\n\n|\n#|\nUser:|$)/gi, "")
      .trim()
      .slice(-4000);
    const seed = [
      identity.principalId,
      identity.clientId || "request-transcript",
      ask,
    ].join("\n");
    return createHash("sha256").update(seed).digest("hex").slice(0, 32);
  }

  private evictStale() {
    const now = Date.now();
    for (const [key, state] of this.conversations) {
      if (now - state.lastAccessedAt > MAX_IDLE_MS) {
        log.info(`Evicting idle conversation ${key}`);
        this.conversations.delete(key);
      }
    }
  }

  get size(): number {
    return this.conversations.size;
  }
}

// --- Delta message formatting ---

function formatDeltaMessages(
  messages: ParsedMessage[],
  toolCalls: Map<string, ToolCallRecord>,
): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      // Skip assistant messages — M365 already has them server-side.
      // Echoing them back as a user message confuses M365.
      continue;
    } else if (m.role === "tool") {
      const callId = m.tool_call_id || "?";
      const record = m.tool_call_id ? toolCalls.get(m.tool_call_id) : undefined;
      const name = m.name || record?.name || "unknown";
      const sequence = record ? ` sequence="${record.sequence}"` : "";
      parts.push(`<tool_response tool="${name}" call_id="${callId}"${sequence}>\n${getMessageContent(m)}\n</tool_response>`);
    } else if (m.role === "system") {
      // Skip system messages on follow-up turns
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }
  return parts.join("\n\n");
}

// --- Main handler ---

/**
 * Handle a chat completion request, returning an OpenAI-compatible Response.
 * The SessionPool routes each conversation to its own ModelSession.
 */
export async function handleChatCompletion(
  body: ChatBody,
  pool: SessionPool,
  opts: { signal?: AbortSignal; principalId?: string; clientId?: string } = {},
): Promise<Response> {
  const extension = body as ChatBody & {
    conversation_id?: unknown;
    conversationId?: unknown;
    mode?: unknown;
  };
  const identity: ConversationIdentity = {
    clientId:
      typeof extension.conversation_id === "string"
        ? extension.conversation_id
        : typeof extension.conversationId === "string"
          ? extension.conversationId
          : opts.clientId ?? "",
    principalId:
      typeof opts.principalId === "string"
        ? opts.principalId
        : "anonymous",
  };
  const conv = pool.resolve(body.messages, identity);
  return conv.queue.run(() => handleChatCompletionLocked(body, conv, opts));
}

async function handleChatCompletionLocked(
  body: ChatBody,
  conv: ConversationState,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  const { session } = conv;
  const hasTools = body.tools && body.tools.length > 0 && body.tool_choice !== "none";
  const model = body.model;

  // Claude (Claude_Sonnet tone) tool-calls reliably AGENT-LESS (probe: 4/4 ```bash,
  // 0 disengage) and self-IDs as Claude Sonnet 4.5; the declarative agent would
  // override the tone back to GPT-5 (H8.6) AND add jailbreak-shape signal. GPT-the-
  // chat-model, by contrast, won't tool-call agent-less (0/4) so it still needs the
  // agent. So: attach the tool agent EXCEPT on Claude models — there, stay agent-less
  // to get real Claude doing tools via shell-routing (docs §10 F23). Force the old
  // behavior with M365_FORCE_AGENT=1.
  // Stay agent-less ONLY when the tone is actually a Claude tone — empirically that's
  // the path that tool-calls right now (route-probe 2026-07-07: Claude_Sonnet agent-less
  // 2/2; the magic path 0/2). Derive it from the RESOLVED tone, not the raw model
  // string: getToneForModel now routes any unmapped `claude-*` (e.g. the
  // `claude-opus-4-8[1m]` a Claude Code client sends) to Claude_Sonnet, so this check
  // then keeps that request on the working agent-less path. The old
  // `/claude/i.test(model)` + `magic` fallback split a claude-* string into GPT-tone +
  // agent-suppressed — the confab quadrant we observed. One resolved tone drives both.
  const tone = getToneForModel(model);
  const isClaudeTone = /^Claude_/i.test(tone);
  const useToolAgent = !!hasTools && (process.env.M365_FORCE_AGENT === "1" || !isClaudeTone);
  const requestedMode = (body as ChatBody & { mode?: unknown }).mode;
  const cursorMode = isCursorRequest(body.tools)
    ? requestedMode === "plan" || requestedMode === "ask" || requestedMode === "agent"
      ? requestedMode
      : detectCursorMode(body.messages)
    : null;
  const policy = executionPolicy(cursorMode ?? "agent", cursorMode ? "cursor" : "provider");
  const framing = cursorFramingVariant(body.tools, cursorMode);
  const framingTools = cursorMode
    ? cursorToolsForFraming(body.tools, cursorMode)
    : body.tools;
  if (cursorMode) log.info(`Cursor compat active: mode=${cursorMode} framing=${framing}`);
  if (cursorMode) {
    log.info(
      `Execution policy: owner=${policy.owner} provider_actions=${policy.allowProviderActions} parallel=${policy.allowParallelToolCalls}`,
    );
  }

  // Format message: full prompt on first turn, delta on follow-ups.
  // M365 is stateful — it remembers everything from prior turns,
  // so we only need to send new messages after the first turn.
  const isFirstTurn = session.turnCount === 0;
  const convId = session.conversationId;
  let text: string;
  if (isFirstTurn || conv.sentMessageCount === 0) {
    text = formatMessages(body.messages, framingTools, body.tool_choice, convId, framing);
    log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=full, cid=${convId}`);
  } else {
    const newMessages = body.messages.slice(conv.sentMessageCount);
      for (const message of newMessages) {
        if (message.role !== "assistant" || !message.tool_calls) continue;
        message.tool_calls.forEach((call, sequence) => {
          conv.toolCalls.set(call.id, {
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
            sequence,
          });
        });
      }
      const delta = newMessages.length > 0
        ? formatDeltaMessages(newMessages, conv.toolCalls)
        : "";
    if (delta.length > 0) {
      text = delta;
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, new=${newMessages.length}, turn=${session.turnCount}, mode=delta, cid=${convId}`);
    } else {
      // No meaningful new content to send — nudge M365 to continue.
      text = "Please continue.";
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=retry, cid=${convId}`);
    }
  }

  log.debug("Formatted prompt:", trunc(text, 1000));

  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Buffer the full response, with a couple of quick retries on an empty reply.
  const MAX_RETRIES = 2;
  const SHORT_RETRY_DELAY_MS = 2_000;

  // Captured from the final attempt — surfaced through the OpenAI `usage` block
  // so clients can see M365's conversation-quota % (the closest proxy we have
  // to "context window remaining"). Token counts aren't exposed by M365.
  let lastThrottle: { current: number; max: number } | null = null;
  let lastContentOrigin: string | null | undefined;
  let lastMessageType: string | null | undefined;
  let lastScores: Record<string, number> | null | undefined;
  let lastTurnCount: number | null | undefined;

  // `onDelta` (when provided) forwards each text delta to the caller AS IT ARRIVES,
  // for live incremental streaming. It's safe to forward without ever retracting:
  // runBuffered only retries on an EMPTY attempt (Disengaged, dead-agent, throttle),
  // and an empty attempt emits no deltas — so a forwarded delta always belongs to the
  // one attempt that produced content and is never re-sent by a subsequent retry.
  /** Compact ask + recent tool results for empty/Prompt-Shield recoveries. */
  function compactContinueMessages(): Array<{ role: "user"; content: string }> {
    const ask = latestUserAsk(body.messages);
    const parts: string[] = [];
    if (ask.trim()) parts.push(ask.trim());
    const toolBits: string[] = [];
    for (const m of [...(body.messages ?? [])].reverse()) {
      const c = getMessageContent(m);
      if (!(m.role === "tool" || (m.role === "user" && /<tool_response\b/i.test(c)))) continue;
      const clipped = c.length > 14000 ? `${c.slice(0, 14000)}\n…(truncated)` : c;
      toolBits.push(clipped);
      if (toolBits.length >= 2) break;
    }
    if (toolBits.length) {
      parts.push("Tool results already obtained from the Cursor workspace:\n\n" + toolBits.reverse().join("\n\n"));
    }
    parts.push(
      "Continue from the tool results above. Use Cursor tool fences (Glob / ReadFile / Shell / rg) when more inspection is needed, " +
        "or give a clear Phase 1 assessment vs ARCHITECTURE.md. The workspace is real — do not claim it is empty.",
    );
    return [{ role: "user", content: parts.join("\n\n") }];
  }

  async function runBuffered(
    onDelta?: (delta: string) => void,
  ): Promise<{ fullText: string } | { error: Response }> {
    let agentRefreshed = false;
    let disengageRetried = false;
    let emptySoftenedRetried = false;
    const originalText = text;
    // Self-imposed pacing while the account is degraded (thread-rate throttle). A
    // no-op when healthy; during backoff it sleeps a jittered delay so we stop
    // starting fresh turns into the throttle and let it self-heal (H-R1). This
    // replaced the old auto-reauth, which didn't clear the throttle and raised our
    // detection profile. A single long pi thread never trips the trigger.
    await awaitDegradationBackoff();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let copilotStream;
      try {
        // Only attach the tool-calling agent when the request actually has tools.
        // The agent overrides `tone` (forces GPT-5), so tool-less requests must
        // skip it to reach the model the tone selects (e.g. Claude). See
        // ModelSession.run / docs H8.6.
        copilotStream = await session.run(text, model, opts.signal, useToolAgent);
      } catch (err: any) {
        return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
      }

      let fullText = "";
      try {
        for await (const delta of copilotStream) {
          fullText += delta;
          onDelta?.(delta);
        }
        if (copilotStream.fullText && copilotStream.fullText.length > fullText.length) {
          fullText = copilotStream.fullText;
        }
      } catch (err: any) {
        return { error: jsonResponse(502, { error: { message: err.message, type: "upstream_error" } }) };
      }

      lastThrottle = copilotStream.throttle;
      lastContentOrigin = copilotStream.contentOrigin;
      lastMessageType = copilotStream.messageType;
      lastScores = copilotStream.scores;
      lastTurnCount = copilotStream.turnCount;

      if (copilotStream.hasContent || fullText.length > 0) {
        noteRequestOutcome(false, convId); // clean response → degradation has lifted
        return { fullText };
      }

      // Disengaged is a deliberate safety refusal, NOT a transient empty. Retrying
      // it with "Please continue." just disengages again and burns the 600-msg
      // quota (observed: 5 wasted messages in one turn). Fail fast with a clear
      // signal instead. Commonly fires when a heavy tool prompt is paired with a
      // non-default model/agent (e.g. a Claude tone + the declarative agent).
      if (copilotStream.messageType === "Disengaged") {
        // F22: the default framing's override-shape language occasionally trips Azure
        // Prompt Shields (jailbreak classifier) on benign requests (e.g. "replace X
        // with Y, leave everything else unchanged"). Retry ONCE with the low-override
        // `softened` framing in a FRESH conversation (a Disengaged conversation stays
        // Disengaged). Drops the worst-case disengage ~100%→~4%. Off via
        // M365_NO_DISENGAGE_RETRY.
        if (hasTools && !disengageRetried && !process.env.M365_NO_DISENGAGE_RETRY) {
          disengageRetried = true;
          session.newConversation();
          text = formatMessages(body.messages, body.tools, body.tool_choice, session.conversationId, "softened");
          log.info("Upstream Disengaged — retrying once with 'softened' framing in a fresh conversation (F22)");
          attempt--; // free retry; bounded — disengageRetried flips once
          continue;
        }
        log.info("Upstream Disengaged — failing fast (no retry) to preserve quota");
        return {
          error: jsonResponse(502, {
            error: {
              message: "M365 Copilot disengaged from this request (its safety filter declined to answer). Common causes: too many tools, jailbreak-shaped instructions, or pairing a non-default model with the tool agent. Reduce the toolset or use the default model.",
              type: "disengaged",
            },
          }),
        };
      }

      // Empty response. Only an at-limit throttle warrants treating this as rate
      // limiting; otherwise it's a different failure (content filter, an invalid
      // agent/session, a transient upstream error) where a long escalating
      // backoff is futile and reads as a silent hang. Fail fast after a couple of
      // quick retries instead.
      const t = copilotStream.throttle;
      if (t && t.current >= t.max) {
        return { error: rateLimitResponse(t) };
      }
      if (attempt < MAX_RETRIES) {
        // A dead/deleted agent returns an instant empty reply (throttle: null).
        // Re-resolve the agent once before retrying so a long-lived host
        // self-heals from the deleted-agent trap instead of looping on empties.
        if (!agentRefreshed) {
          agentRefreshed = true;
          const agentChanged = await session.refreshAgent();
          if (agentChanged) {
            // The cached agent was stale/deleted and has been re-resolved.
            // Resend the original prompt to the fresh agent — a bare "continue"
            // would have no context since the dead agent processed nothing.
            log.info("Agent re-resolved after empty reply, resending original prompt");
            text = originalText;
            await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
            continue;
          }
        }
        // Silent empty (no Disengaged type) often means Prompt Shields / heavy
        // cursor framing. Same fix as F22: fresh session + softened framing +
        // compact ask/tool-results. Works mid tool-loop too (after ReadFile).
        if (
          cursorMode &&
          !emptySoftenedRetried &&
          !process.env.M365_NO_EMPTY_SOFTEN_RETRY
        ) {
          emptySoftenedRetried = true;
          session.newConversation();
          // Keep only core Cursor tools — full 18-tool catalogs + heavy framing
          // are what go silent; short softened + core tools still answer.
          const coreTools = (framingTools ?? body.tools)?.filter((t) =>
            /^(Shell|Glob|ReadFile|Read|rg|Grep)$/i.test(t.function?.name ?? ""),
          );
          text = formatMessages(
            compactContinueMessages(),
            coreTools?.length ? coreTools : framingTools,
            undefined,
            session.conversationId,
            "softened",
          );
          log.info(
            "Empty upstream — retrying once with softened framing + core tools + compact continue (F22-empty)",
          );
          attempt--; // free retry; bounded by emptySoftenedRetried
          await new Promise((r) => setTimeout(r, SHORT_RETRY_DELAY_MS));
          continue;
        }
        log.info(`Empty upstream response, quick retry in ${SHORT_RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
        text = "Please continue."; // M365 already has context
      } else {
        // Final empty after retries, and not an at-limit (per-conversation) cap:
        // this is the thread-rate throttle signature (F13). Feed the degradation-
        // backoff policy — once empties span enough distinct conversations it paces
        // subsequent turns so the account can self-heal (H-R1). Never blocks this request.
        noteRequestOutcome(true, convId);
        return { error: emptyResponseResponse(t) };
      }
    }
    noteRequestOutcome(true, convId);
    return { error: emptyResponseResponse(null) };
  }

  // Produce the final turn result as DATA (not a Response), so the same logic
  // renders as either JSON (non-stream) or an early-flushed SSE stream (stream).
  // For streaming we return the SSE stream FIRST and run produce() INSIDE it, so the
  // client gets HTTP 200 + a role chunk + heartbeats immediately instead of waiting
  // out the whole (up to ~160s) M365 turn and risking a read-timeout.
  type Produced =
    | { kind: "error"; resp: Response }
    | { kind: "text"; text: string }
    | {
        kind: "tools";
        toolCalls: ReturnType<typeof parseToolCalls>["toolCalls"];
        /** Optional short Cursor-style status shown alongside tool_calls. */
        content?: string | null;
      };

  // `onDelta` streams text to the client live (non-tool path only — see produce's
  // caller). Tool mode ignores it: the raw text is parsed for tool-call fences and
  // can't be shown verbatim, so it stays fully buffered.
  async function produce(onDelta?: (delta: string) => void): Promise<Produced> {
  // When tools are present, buffer full response to detect tool calls
  if (hasTools) {
    const result = await runBuffered();
    if ("error" in result) {
      // Empty upstream salvage — ONCE only, and only before any tool loop.
      // Re-bootstrapping Read ARCHITECTURE.md after every empty reply created an
      // infinite Cursor loop ("Upstream returned empty; continuing…").
      const everActedForSalvage = (body.messages ?? []).some(
        (m) =>
          (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) ||
          m.role === "tool" ||
          (typeof m.content === "string" && /<tool_response\b/i.test(m.content)),
      );
      if (cursorMode && body.tools?.length && !everActedForSalvage) {
        const salvage = synthesizeCursorBootstrap(body.tools, body.messages, null);
        if (salvage) {
          log.info(
            `Empty/error upstream — one-shot salvage bootstrap ${salvage.function.name}`,
          );
          return {
            kind: "tools",
            toolCalls: [salvage],
            content: "Upstream returned empty; trying one workspace tool call.",
          };
        }
      }
      if (cursorMode && everActedForSalvage) {
        // Last resort after runBuffered's softened retry also failed.
        log.info("Empty/error upstream after tools — stopping (no re-bootstrap loop)");
        return {
          kind: "text",
          text:
            "M365 Copilot returned an empty response after tools already ran (often a content filter on a heavy prompt). " +
            "Start a **new** Agent chat and retry with a shorter ask. If it keeps happening, use model `auto` or `quick` for a turn.",
        };
      }
      return { kind: "error", resp: result.error };
    }
    conv.sentMessageCount = body.messages.length;
    let fullText = result.fullText;

    log.debug("Raw response (tool mode):", trunc(fullText, 1000));
    let parsed = parseToolCalls(fullText, body.tools);
    log.info(`Parse result: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);

    // Salvage stochastic turn-1 confabulation: M365's chat model sometimes claims it
    // "can't access the files / commands return no output" and asks the user to paste
    // them, WITHOUT calling a tool — even though the environment is real (the bench +
    // pi both reproduce this). Re-prompt forcefully in the SAME conversation (one
    // thread, cheap). Disable with M365_NO_CONFAB_RETRY; tune count with M365_CONFAB_RETRIES.
    const maxConfabRetries = process.env.M365_NO_CONFAB_RETRY
      ? 0
      : Number(process.env.M365_CONFAB_RETRIES ?? (cursorMode ? 2 : 1));
    // The model never actually acted if no assistant turn in the history carried a
    // tool call. Used to gate the hallucinated-completion retry (a model that did
    // real work called at least one tool), keeping false positives near zero.
    const everActed = (body.messages ?? []).some(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    const hasWriteTool = cursorHasWriteTool(body.tools);
    const requestedFiles = extractRequestedFilenames(body.messages);
    let remainingFiles = remainingCreateFilenames(body.messages);
    const phaseAsk = isPhaseContinueAsk(latestUserAsk(body.messages));
    for (let attempt = 0; attempt < maxConfabRetries && !parsed.hasToolCalls; attempt++) {
      const fakeAttach = looksLikeFakeCopilotAttachment(parsed.textContent);
      const confab = looksLikeConfabulation(parsed.textContent);
      const toolFailed = latestToolResponseFailed(body.messages);
      const phaseDone = looksLikePhaseCompleteClaim(parsed.textContent);
      // Fake ZIP / /mnt/data "success" claims are always failed delivery — even after
      // a later ReadFile miss on files the model never wrote into the workspace.
      const claimedDone = looksLikeHallucinatedCompletion(parsed.textContent);
      const halluc =
        fakeAttach ||
        (claimedDone &&
          (!everActed ||
            confab ||
            /\/mnt\/data/i.test(parsed.textContent ?? "") ||
            /not reachable|outside the Cursor workspace/i.test(parsed.textContent ?? "")));
      // Only force on real confab / failure / halluc. Do NOT force every turn that
      // merely mentions "phase" — that created a 100+ turn Glob loop after "Phase 1
      // is complete". First phase-continue turn (!everActed) may still Glob once.
      const firstPhaseTurn = phaseAsk && !everActed && !phaseDone;
      if (!confab && !halluc && !fakeAttach && !(cursorMode && (toolFailed || firstPhaseTurn))) break;
      if (phaseDone && !confab && !fakeAttach && !toolFailed) break;
      const kind = fakeAttach
        ? "Fake Copilot attachment"
        : confab
          ? "Confabulation"
          : halluc
            ? "Hallucinated completion"
            : toolFailed
              ? "Tool failure give-up"
              : "Phase-continue without tools";
      log.info(`${kind} detected (no tool call) — forcing retry ${attempt + 1}/${maxConfabRetries}`);
      const need = remainingFiles.length ? remainingFiles : requestedFiles;
      if (cursorMode && (fakeAttach || halluc || /\/mnt\/data/i.test(parsed.textContent ?? ""))) {
        text = hasWriteTool && !fakeAttach
          ? CURSOR_HALLUCINATION_FORCE_PROMPT
          : fakeAttach
            ? cursorAttachmentForcePrompt(need)
            : cursorShellWriteForcePrompt(need);
      } else if (confab || toolFailed || firstPhaseTurn) {
        // First phase turn / File-not-found: Glob the plan; named creates: Shell write.
        text = cursorMode
          ? firstPhaseTurn || toolFailed || !need.length || hasWriteTool
            ? CURSOR_CONFAB_FORCE_PROMPT
            : cursorShellWriteForcePrompt(need)
          : CONFAB_FORCE_PROMPT;
      } else {
        text = cursorMode
          ? (hasWriteTool ? CURSOR_HALLUCINATION_FORCE_PROMPT : cursorShellWriteForcePrompt(need))
          : HALLUCINATION_FORCE_PROMPT;
      }
      const retry = await runBuffered();
      if ("error" in retry) return { kind: "error", resp: retry.error };
      conv.sentMessageCount = body.messages.length;
      fullText = retry.fullText;
      parsed = parseToolCalls(fullText, body.tools);
      log.info(`After forcing retry: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);
    }

    // Multi-file create: after one Shell write succeeds, model often stops with
    // "`hello_widget.py` was written successfully" — force the next missing file.
    remainingFiles = remainingCreateFilenames(body.messages);
    if (
      cursorMode &&
      !parsed.hasToolCalls &&
      remainingFiles.length > 0 &&
      !looksLikePhaseCompleteClaim(parsed.textContent) &&
      !process.env.M365_NO_CONFAB_RETRY
    ) {
      log.info(
        `Incomplete create — still need ${remainingFiles.join(", ")} — forcing next Shell write`,
      );
      text = cursorShellWriteForcePrompt(remainingFiles);
      const retry = await runBuffered();
      if ("error" in retry) return { kind: "error", resp: retry.error };
      conv.sentMessageCount = body.messages.length;
      fullText = retry.fullText;
      parsed = parseToolCalls(fullText, body.tools);
      log.info(
        `After incomplete-create force: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`,
      );
    }

    // Cursor compat: rewrite ```bash idioms → native Read/Grep/Glob/Write, then
    // bootstrap a tool_call if M365 still returned prose (common when agent=none).
    if (cursorMode && body.tools?.length) {
      parsed = rewriteBashToCursorTools(parsed, body.tools, cursorMode, body.messages);
      // Do NOT force ReadFile before create/write intents — that produced the
      // hello_widget regression (prompt said "Then Read … back").
      parsed = enforceExplicitCursorTool(parsed, body.tools, body.messages);
      parsed = rewriteBashToCursorTools(parsed, body.tools, cursorMode, body.messages); // re-normalize args after enforce
      parsed = enforceToolChoice(parsed, body.tool_choice);
      parsed = validateToolCalls(parsed, body.tools);
      if (shouldBootstrapCursor(body.tools, body.messages, parsed, everActed)) {
        const bootstrap = synthesizeCursorBootstrap(body.tools, body.messages, parsed.textContent);
        if (bootstrap) {
          const attach = looksLikeFakeCopilotAttachment(parsed.textContent);
          const hallucLeft = looksLikeHallucinatedCompletion(parsed.textContent);
          const still = remainingCreateFilenames(body.messages);
          return {
            kind: "tools",
            toolCalls: [bootstrap],
            content: attach || hallucLeft || still.length
              ? still.length
                ? `Writing remaining files: ${still.join(", ")}.`
                : "Writing into your workspace with Shell (no /mnt/data, no zip downloads)."
              : null,
          };
        }
      }
    }

    // Last resort: never show unreachable Copilot ZIP links in the chat UI.
    if (
      cursorMode &&
      !parsed.hasToolCalls &&
      looksLikeFakeCopilotAttachment(fullText)
    ) {
      log.info("Stripping fake Copilot attachment prose from final text response");
      fullText =
        "I cannot deliver files as download/ZIP attachments in Cursor — those links are unreachable. " +
        "Retry the same request; I will Write the files directly into your open workspace with tools.";
    }

    // Document guard: for non-Cursor clients, markdown essays full of ```bash
    // fences must not be executed. For Cursor requests, native fences
    // (ReadFile/rg/Shell/Glob/…) are the contract — never discard them as prose
    // even when the model wrapped examples in a diagnostic markdown report.
    if (!cursorMode && isProseDocument(parsed)) {
      log.info(`Response is a prose document (${parsed.toolCalls.length} embedded fences), returning as text instead of executing`);
      parsed = { hasToolCalls: false, toolCalls: [], textContent: fullText };
    } else if (cursorMode && isProseDocument(parsed) && parsed.hasToolCalls) {
      log.info(
        `Cursor: keeping tool call(s) despite prose wrapper — first=${parsed.toolCalls[0]?.function.name}`,
      );
    }

    // Keep a short Cursor-style status sentence with tool_calls; strip long essays.
    let statusContent: string | null = null;
    if (parsed.hasToolCalls && parsed.textContent) {
      const extraText = parsed.textContent.trim();
      if (extraText.length > 0) {
        statusContent = extractCursorStatusUpdate(extraText);
        if (statusContent) {
          log.info(`Keeping short status with tool call (${statusContent.length} chars)`);
        } else {
          log.info(`Mixed output detected (${extraText.length} chars of text alongside ${parsed.toolCalls.length} tool calls), stripping text`);
          log.debug("Stripped text:", trunc(extraText, 500));
        }
        parsed = { ...parsed, textContent: null };
      }
    }

    // Handle "reply" tool calls — convert to plain text
    if (parsed.hasToolCalls) {
      const replyCall = parsed.toolCalls.find(tc => tc.function.name === "reply");
      const realToolCalls = parsed.toolCalls.filter(tc => tc.function.name !== "reply");

      if (replyCall && realToolCalls.length === 0) {
        let replyText: string;
        try {
          const args = JSON.parse(replyCall.function.arguments);
          replyText = args.text || args.message || args.content || fullText;
        } catch {
          replyText = fullText;
        }
        log.info("Reply tool detected, converting to text response");
        return { kind: "text", text: replyText };
      }

      if (realToolCalls.length > 0) {
        parsed.toolCalls = realToolCalls;
      }

      // Enforce one tool call per turn unless explicitly opted out. M365 — the
      // reasoning tones especially — batches its whole plan into a single
      // response. Executing a batch runs later steps on guessed state and lets a
      // premature success claim ride along at the end. Keeping only the first
      // call forces a real step-by-step loop where each call reacts to the
      // previous tool_response. Set M365_ALLOW_MULTI_TOOL to restore batching.
      if (!process.env.M365_ALLOW_MULTI_TOOL && parsed.toolCalls.length > 1) {
        log.info(`One-call-per-turn: keeping ${parsed.toolCalls[0].function.name}, dropping ${parsed.toolCalls.length - 1} batched call(s)`);
        parsed.toolCalls = [parsed.toolCalls[0]];
      }
    }

    if (parsed.hasToolCalls && parsed.toolCalls.length > 0) {
      return { kind: "tools", toolCalls: parsed.toolCalls, content: statusContent };
    }
    return { kind: "text", text: fullText };
  } else {
    // No tools — stream deltas live (onDelta) while buffering for the retry logic.
    const result = await runBuffered(onDelta);
    if ("error" in result) return { kind: "error", resp: result.error };
    conv.sentMessageCount = body.messages.length;
    return { kind: "text", text: result.fullText };
  }
  } // end produce()

  // --- Render: JSON (non-stream) or an early-flushed SSE stream (stream) ---
  const includeUsage = !!body.stream_options?.include_usage;
  const usage = () => buildUsage(lastThrottle, lastContentOrigin, lastMessageType, lastScores, lastTurnCount);

  if (!body.stream) {
    const p = await produce();
    if (p.kind === "error") return p.resp;
    if (p.kind === "tools") {
      return jsonResponse(200, {
        id: completionId, object: "chat.completion", created, model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: p.content ?? null,
            tool_calls: p.toolCalls,
          },
          finish_reason: "tool_calls",
        }],
        usage: usage(),
      });
    }
    return jsonResponse(200, {
      id: completionId, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content: p.text }, finish_reason: outputFinishReason(p.text) }],
      usage: usage(),
    });
  }

  // Streaming: send HTTP 200 + a role chunk + keepalive comments from t=0, then run
  // produce() INSIDE the stream so the client never waits out the whole M365 turn
  // (up to ~160s) before the first byte — avoids client read-timeouts.
  //
  // On the non-tool path we forward each text delta AS IT ARRIVES (`liveDelta`), so
  // `stream:true` is genuinely incremental. Tool mode still buffers: the raw text is
  // parsed for tool-call fences and can't be shown verbatim, so its tool_calls (or a
  // prose fallback) are emitted once at the end.
  return sseResponse(new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const base = { id: completionId, object: "chat.completion.chunk", created, model };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      const hb = setInterval(() => { try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch {} }, 15000);

      // Live token passthrough (non-tool only). Track exactly what we've sent so the
      // final render emits only the not-yet-streamed remainder. session.ts guarantees
      // every forwarded delta extends the answer, so `sent` is always a prefix of the
      // final text — the remainder is a clean tail, never a duplicate.
      let sent = "";
      const liveDelta = hasTools ? undefined : (delta: string) => {
        if (!delta) return;
        sent += delta;
        try { send({ ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] }); } catch {}
      };

      let p: Produced;
      try { p = await produce(liveDelta); }
      catch (err: any) { p = { kind: "error", resp: jsonResponse(502, { error: { message: err?.message ?? "stream error", type: "upstream_error" } }) }; }
      clearInterval(hb);
      try {
        if (p.kind === "error") {
          let message = "upstream error";
          try { message = (JSON.parse(await p.resp.text())?.error?.message) || message; } catch {}
          // HTTP 200 is already committed, so surface the failure as an in-stream error chunk.
          send({ ...base, error: { message, type: "upstream_error" } });
        } else if (p.kind === "tools") {
          if (p.content) {
            send({ ...base, choices: [{ index: 0, delta: { content: p.content }, finish_reason: null }] });
          }
          p.toolCalls.forEach((tc, i) =>
            send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] }));
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], ...(includeUsage ? { usage: usage() } : {}) });
        } else {
          // Emit only what wasn't already streamed live: the whole text if nothing was
          // (tool-mode prose fallback, or a fully-buffered turn), or just the tail when
          // live deltas already covered a prefix. If `sent` somehow isn't a prefix of
          // the final text (a divergent snapshot upstream chose not to stream), fall
          // back to sending nothing more rather than duplicating already-sent bytes.
          const remainder = p.text.startsWith(sent) ? p.text.slice(sent.length) : "";
          if (!p.text.startsWith(sent)) log.info(`Streamed prefix diverged from final text (sent ${sent.length}, final ${p.text.length} chars) — not re-sending to avoid duplication`);
          if (remainder) send({ ...base, choices: [{ index: 0, delta: { content: remainder }, finish_reason: null }] });
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: outputFinishReason(p.text) }], ...(includeUsage ? { usage: usage() } : {}) });
        }
      } catch {
        // client likely disconnected mid-emit — nothing more to do
      } finally {
        try { controller.enqueue(enc.encode("data: [DONE]\n\n")); controller.close(); } catch {}
      }
    },
  }));
}

/**
 * Build the OpenAI-style `usage` block from whatever diagnostic info M365 gave
 * us. Token counts are NOT exposed by M365's WebSocket API (we'd need to count
 * locally with a tokenizer that matches the underlying model — see the doc on
 * token-usage hypotheses). What M365 does send is a **conversation quota**:
 * how many user messages out of the 600-per-conversation cap have been spent.
 *
 * That's a different axis from token-window utilisation, but it's the closest
 * thing we have to "remaining budget", so we surface it as extension fields
 * (`x_m365_*`) alongside the zeroed standard counters. Real OpenAI clients
 * ignore unknown extension fields; curious users can read them.
 */
function buildUsage(
  throttle: { current: number; max: number } | null,
  contentOrigin?: string | null,
  messageType?: string | null,
  scores?: Record<string, number> | null,
  turnCount?: number | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  if (throttle) {
    base.x_m365_conversation_messages = throttle.current;
    base.x_m365_conversation_max = throttle.max;
    base.x_m365_conversation_pct = Math.min(100, Math.round((throttle.current / throttle.max) * 100));
    base.x_m365_conversation_remaining = Math.max(0, throttle.max - throttle.current);
  }
  if (contentOrigin) base.x_m365_content_origin = contentOrigin;
  if (messageType) base.x_m365_message_type = messageType;
  if (typeof turnCount === "number") base.x_m365_turn_count = turnCount;
  // Disengaged-classifier scores. Empirically: clean tool calls sit at
  // ~1e-13 / ~1e-8, jailbreak-shaped prompts climb to ~1e-3 / ~1e-3. The
  // `dea_violation` component is the one that actually correlates with the
  // Disengaged filter firing — surface that explicitly so clients can monitor
  // their proximity to the threshold.
  if (scores) {
    base.x_m365_classifier_scores = scores;
    if (typeof scores.dea_violation === "number") base.x_m365_dea_score = scores.dea_violation;
    if (typeof scores.BotOffense === "number") base.x_m365_offense_score = scores.BotOffense;
  }
  return base;
}

// --- Helpers ---

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

function rateLimitMessage(throttle: { current: number; max: number } | null): string {
  return throttle
    ? `M365 Copilot rate limited (${throttle.current}/${throttle.max} messages used). Please wait and try again.`
    : "M365 Copilot returned an empty response. You may be rate limited. Please wait and try again.";
}

function rateLimitResponse(throttle: { current: number; max: number } | null): Response {
  return jsonResponse(429, { error: { message: rateLimitMessage(throttle), type: "rate_limit_error" } });
}

/** Empty upstream reply that is NOT an at-limit throttle — a distinct failure
 *  (content filter, invalid agent/session, transient error) we surface clearly
 *  instead of hanging on a long retry loop. */
function emptyResponseResponse(throttle: { current: number; max: number } | null): Response {
  const detail = throttle ? ` (throttle ${throttle.current}/${throttle.max})` : "";
  return jsonResponse(502, {
    error: {
      message: `M365 Copilot returned an empty response${detail} — likely a content filter, an invalid agent/session, or a transient upstream error.`,
      type: "upstream_empty_response",
    },
  });
}

// (streaming is emitted inline by the early-flushed SSE renderer in
// handleChatCompletion; the old streamText/streamToolCalls helpers were removed.)

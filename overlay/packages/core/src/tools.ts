import { createLogger } from "./log.js";
import {
  buildSpecMap,
  currentFramingVariant,
  deriveFencedSpec,
  formatFencedToolDefinitions,
  parseFencedToolCalls,
  renderFencedCall,
} from "./fenced.js";

const log = createLogger("tools");

// Tool calls use the **fenced** Markdown format exclusively (see fenced.ts and
// docs/hypotheses.md §9). The old `{"tool":...,"arguments":{}}` JSON format was
// removed — it produced 0/5 on real agentic tasks; fenced + shell-routing produces
// genuine multi-turn loops. We still *parse* a stray JSON tool call as a tolerance
// fallback (M365 occasionally emits one), but we never instruct the model to use it.

// --- Types (standalone, no zod dependency) ---

export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: {
    properties?: Record<string, { type?: string; [k: string]: unknown }>;
    required?: string[];
    [k: string]: unknown;
  };
}

export interface ToolDef {
  type?: string;
  function: ToolFunction;
}

export interface Message {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | undefined;

// --- Tool call format ---

// Fenced Markdown is the format we instruct and primarily parse (see fenced.ts).
// The two regexes below are tolerance-only FALLBACKS: M365 occasionally ignores the
// fenced contract and emits a stray `{"tool":...,"arguments":{...}}` object, or wraps
// it in a legacy ```tool_call fence. We parse those if they show up but never teach
// the model to produce them — the JSON format scored 0/5 and was removed (§9).
const TOOL_CALL_REGEX = /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;
const FENCED_TOOL_CALL_REGEX = /```tool_call\s*\n(\{[\s\S]*?\})\s*\n\s*```/g;

// M365 invents bookkeeping objects ({"confidence": 0.5}) and wraps its answer in
// {"final": "..."} — neither is a real tool call. Strip confidence everywhere;
// drop final when it rides alongside tool calls (it's usually a premature
// success claim), and unwrap it when it stands alone as the response.
const CONFIDENCE_REGEX = /\{\s*"confidence"\s*:\s*-?[0-9.]+\s*\}/g;
const FINAL_OBJECT_REGEX = /\{\s*"final"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;

/** Strip invented confidence/final objects from a no-tool-call response and
 *  unwrap a lone {"final": "..."} answer into bare text. Returns null if empty. */
function cleanLooseText(text: string): string | null {
  let out = text;
  for (const m of out.match(FINAL_OBJECT_REGEX) ?? []) {
    try {
      const value = JSON.parse(m).final;
      if (typeof value === "string") out = out.replace(m, value);
    } catch {
      // leave the literal text in place if it isn't valid JSON
    }
  }
  out = out.replace(CONFIDENCE_REGEX, "").trim();
  return out.length ? out : null;
}

// --- Formatting ---

export function formatToolDefinitions(tools: ToolDef[], variantOverride?: string): string {
  return formatFencedToolDefinitions(tools, variantOverride);
}

export function formatToolChoiceInstruction(toolChoice: ToolChoice): string {
  if (!toolChoice || toolChoice === "auto") return "";
  if (toolChoice === "none") return "\nDo NOT call tools. Text only.";
  if (toolChoice === "required") return "\nYou MUST call at least one tool.";
  if (typeof toolChoice === "object" && toolChoice.function) {
    return `\nYou MUST call "${toolChoice.function.name}".`;
  }
  return "";
}

export function getMessageContent(msg: Message): string {
  if (msg.content === null || msg.content === undefined) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .map((p) => {
      if (p.text) return p.text;
      // M365's text endpoint cannot consume OpenAI image/audio parts. Preserve
      // their presence explicitly instead of silently changing the prompt.
      return `[unsupported content part: ${p.type}]`;
    })
    .join("");
}

/** A short one-line description of what a tool call did, for labelling its result
 *  (e.g. the shell command, or the file path). Newlines collapsed, truncated. */
function toolCallSummary(rawArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
  } catch {
    return "";
  }
  const primary =
    args.command ?? args.cmd ?? args.script ?? args.path ?? args.file ??
    args.filename ?? args.query ?? Object.values(args).find((v) => typeof v === "string");
  if (typeof primary !== "string") return "";
  return primary.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 100);
}

/**
 * Inject a synthetic `reply(text)` tool that the model calls instead of
 * answering in prose. Wired by the handler (which converts `reply` back to a
 * plain assistant message), so it's invisible to the client. Off by default —
 * set `M365_INJECT_REPLY_TOOL=1` to enable.
 *
 * Why this matters: M365 mostly disobeys "only emit JSON" when the right
 * answer is text. Routing text through a `reply()` call makes EVERY turn a
 * tool call, which is a much cleaner contract for the model to follow.
 *
 * Tradeoff: adds 1 tool to the prompt, which nudges the Disengaged-filter
 * threshold a tiny bit. Safe with lean toolsets (<= ~10 tools).
 */
function maybeInjectReplyTool(tools: ToolDef[]): ToolDef[] {
  const enabled = process.env.M365_INJECT_REPLY_TOOL || currentFramingVariant() === "reply_tool";
  if (!enabled) return tools;
  if (tools.some((t) => t.function.name === "reply")) return tools;
  const replyTool: ToolDef = {
    type: "function",
    function: {
      name: "reply",
      description:
        "Send a plain-text answer to the user. Use this whenever you would otherwise reply in prose.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The text to send" } },
        required: ["text"],
      },
    },
  };
  return [replyTool, ...tools];
}

export function formatMessages(
  messages: Message[],
  tools?: ToolDef[],
  toolChoice?: ToolChoice,
  conversationId?: string,
  framingVariant?: string,
): string {
  const parts: string[] = [];

  if (conversationId) {
    parts.push(`<conversation_id>${conversationId}</conversation_id>`);
  }

  const effectiveTools = tools ? maybeInjectReplyTool(tools) : tools;
  const specMap = effectiveTools ? buildSpecMap(effectiveTools) : null;
  if (effectiveTools && effectiveTools.length > 0 && toolChoice !== "none") {
    parts.push(`<system>\n${formatToolDefinitions(effectiveTools, framingVariant)}${formatToolChoiceInstruction(toolChoice)}\n</system>`);
  }

  // Correlate each tool result back to the call that produced it, so the model
  // sees WHICH command's output it's reading (e.g. `bash: ls -la`). Without this
  // the result is labelled "unknown" and the model misreads it — observed: it ran
  // `ls`, saw `README.md`, and concluded the *file* was empty (docs §9 F15-adjacent).
  const callMeta = new Map<string, { name: string; summary: string }>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) callMeta.set(tc.id, { name: tc.function.name, summary: toolCallSummary(tc.function.arguments) });
      }
    }
  }

  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls.map((tc) => {
        const rawArgs = tc.function.arguments;
        let argsObj: Record<string, unknown> = {};
        try {
          argsObj = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
        } catch {
          // fall through with empty args; better than crashing the transcript
        }
        // Prefer the request's tool schema; otherwise synthesize one from the
        // recorded argument keys so a tool no longer in scope still renders.
        const spec = specMap?.get(tc.function.name) ?? deriveFencedSpec({
          type: "function",
          function: {
            name: tc.function.name,
            parameters: {
              properties: Object.fromEntries(
                Object.keys(argsObj).map((k) => [k, { type: "string" }]),
              ),
            },
          },
        });
        return renderFencedCall(spec, argsObj);
      }).join("\n");
      const content = getMessageContent(m);
      parts.push(`<assistant>${content ? "\n" + content : ""}\n${calls}\n</assistant>`);
    } else if (m.role === "tool") {
      const meta = m.tool_call_id ? callMeta.get(m.tool_call_id) : undefined;
      const name = m.name || meta?.name || "tool";
      // Show the command/args that produced this output so the model reads it in
      // context (a directory listing vs file contents vs a command's stdout).
      const cmdAttr = meta?.summary ? ` command="${meta.summary}"` : "";
      parts.push(`<tool_response tool="${name}"${cmdAttr}>\n${getMessageContent(m)}\n</tool_response>`);
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }

  return parts.join("\n\n");
}

// --- Parsing ---

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ParseResult {
  hasToolCalls: boolean;
  toolCalls: ParsedToolCall[];
  textContent: string | null;
}

/**
 * Confabulation is classified into a few categories (not an ever-growing phrase
 * list). Categories drive one recovery policy in the orchestration layer.
 */
export type ConfabCategory =
  | "access_denial"
  | "fake_delivery"
  | "tools_vanished"
  | "sandbox_myth"
  | "empty_workspace"
  | null;

const ACCESS_DENIAL: RegExp[] = [
  /(?:unable|not able|can.?t|cannot)\s+(?:to\s+)?(?:access|inspect|list|read|run|execute|retrieve|fetch|locate|see|open)/i,
  /don.?t\s+have\s+access/i,
  /no\s+(?:longer\s+have|access\s+to)/i,
  /lost\s+(?:access|my\s+access|the\s+ability)/i,
  /(?:can.?t|cannot|not\s+able\s+to|unable\s+to)\s+(?:directly\s+)?(?:edit|modify|write\s+to|change|save|create|open)\s+(?:the\s+|any\s+|to\s+)?files?/i,
  /paste\s+(?:the\s+)?(?:contents?|files?|code|them)/i,
  /provide\s+(?:the\s+)?(?:contents?|files?)/i,
  /don.?t currently have (?:the )?(?:project )?files?\s+available/i,
  /(?:can.?t|cannot)\s+(?:truthfully\s+)?inspect\s+(?:the\s+)?(?:actual\s+)?(?:codebase|repo|project)/i,
  /(?:no|not)\s+(?:have\s+)?access to your (?:Windows |local )?project path/i,
  /not currently exposed/i,
  /exposed to (?:my|the|your)\s+(?:file\s+)?tools/i,
  /(?:workspace|repository|project|codebase|folder)\s+(?:is|are|was|were)\s+not\s+accessible/i,
  /(?:is|are)\s+not\s+accessible\s+in\s+this\s+session/i,
  /file lookup failed/i,
  /(?:please\s+)?(?:re)?attach\s+(?:or\s+expose\s+)?(?:the\s+)?(?:project|repo|repository|files?)/i,
  /(?:please\s+)?upload\s+(?:the\s+)?(?:project|repo|repository|codebase|files?).{0,60}\.zip/i,
  /upload\s+(?:the\s+)?project\s+as\s+a/i,
  /attach\s+(?:the\s+)?repository\s+files/i,
  /only\s+the\s+pasted\b.{0,40}\bis\s+available/i,
  /outside the Cursor workspace/i,
  /not reachable/i,
  /cannot truthfully claim/i,
  /(?:will\s+not|won'?t)\s+(?:fabricate|invent)\b/i,
  /I\s+will\s+not\s+fabricate\b/i,
  /cannot\s+continue\s+workspace-native/i,
  /workspace-native\s+(?:reads?|edits?|tools?)/i,
  /exposed\s+tool\s+interface/i,
  /currently\s+exposed\s+tool\s+interface/i,
];

const SANDBOX_MYTH: RegExp[] = [
  /\/mnt\/data/i,
  /exposed to this runtime/i,
  /workspace path shown in the prompt/i,
  /common\s+mount\s+variants/i,
  /isolated\s+Linux\s+container/i,
  /currently available execution environment/i,
  /created outside the Cursor workspace/i,
];

const TOOLS_VANISHED: RegExp[] = [
  /(?:restart|start\s+over|begin\s+again|re-?run)\s+(?:the\s+|this\s+)?(?:task|session|conversation|work)\s+in\s+(?:a\s+)?/i,
  /(?:in|use|switch\s+to|need)\s+(?:a\s+)?(?:different|another|proper|coding-?enabled|tool-?enabled|shell-?enabled)\s+(?:session|environment|conversation|mode)/i,
  /(?:tool|editor|shell|command|file-?editing)s?[^.\n]{0,40}\b(?:not\s+available|unavailable|aren.?t\s+available|isn.?t\s+available|are\s+not\s+accessible)/i,
  /(?:environment|shell|tool)\s+(?:isn.?t|is not|aren.?t|are not|appears? to be)\s+(?:return|provid|respond|work|access)/i,
  /no longer exposes/i,
  /session no longer/i,
  /this session no longer/i,
  /cannot\s+emit\s+or\s+execute/i,
  /cannot\s+emit\b.{0,40}\b(?:shell|tool)/i,
  /(?:can.?t|cannot|won'?t|will\s+not)\s+(?:emit|execute)\s+(?:a\s+)?[`']?(?:Glob|ReadFile|Shell)/i,
  /does\s+not\s+expose\s+Cursor/i,
  /workspace-editing\s+tools/i,
];

const EMPTY_WORKSPACE: RegExp[] = [
  /return(?:ing|s|ed)?\s+no\s+(?:output|results?|content)/i,
  /no\s+(?:output|results?|content|data)\s+(?:was\s+|were\s+)?(?:return|provid|present)/i,
  /no\s+files?\s+(?:in|found|present|visible)/i,
  /(?:file|directory|folder|it)\s+(?:appears?|seems?|looks?)\s+(?:to\s+be\s+)?empty/i,
  /nothing\s+to\s+(?:simplify|fix|do|change|show|read)/i,
  /(?:tool|command|it)\s+returned\s+(?:no|empty|nothing)/i,
  /filesystem\s+is\s+empty/i,
  /available\s+filesystem\s+is\s+empty/i,
];

const FAKE_DELIVERY: RegExp[] = [
  /asyncgw\.teams\.microsoft\.com/i,
  /us-prod\.asyncgw\./i,
  /downloadable\s+attachment/i,
  /packaged\s+as\s+a\s+downloadable/i,
  /\[Download[^\]]*\]\s*\(\s*https?:\/\/[^)]+\.zip/i,
  /\[Download[^\]]*\]\s*\([^)]*cite[^)]*\)/i,
  /Extract\s+(?:the\s+)?(?:ZIP|zip|archive)\b/i,
  /turn\d+file\d+/i,
];

/** Kept for tests / callers that still inspect the combined list shape. */
const CONFABULATION_PATTERNS: RegExp[] = [
  ...ACCESS_DENIAL,
  ...SANDBOX_MYTH,
  ...TOOLS_VANISHED,
  ...EMPTY_WORKSPACE,
  ...FAKE_DELIVERY,
];

// Past-tense claims of having performed a file mutation (no tool ran).
const HALLUCINATED_COMPLETION_PATTERNS: RegExp[] = [
  /\bI(?:'ve|\s+have|\s+just|\s+now)?\s+(?:created|wrote|written|replaced|updated|saved|applied|added|overwrote|modified|generated|implemented|rewrote|built|packaged)\b/i,
  /\b(?:Built|Created|Generated|Packaged)\b[^.\n]{0,80}\b(?:widget|app|script|project|tool|desktop|pipeline|component)\b/i,
  /\b(?:the\s+)?(?:file|readme|script|config|change|version|content)\s+(?:has|have|is|was|were)\s+(?:been\s+)?(?:created|replaced|updated|saved|written|applied|added|modified|overwritten)\b/i,
  /\bhere'?s\s+(?:the\s+)?(?:updated|new|simplified|replaced|final)\s+(?:file|readme|version|content)\b/i,
  /\b(?:created|wrote|written|generated|saved|added|produced|implemented|overwrote|built|packaged)\b[^.\n]{0,60}\b[\w-]{2,}\.[a-z]{1,4}\b/i,
  /\b(?:created|wrote|written|generated|built|packaged|saved)\b[\s\S]{0,200}\b[\w-]{2,}\.[a-z]{1,4}\b/i,
  /\b(?:created|wrote|written|built|generated)\b[\s\S]{0,120}\bread back\b/i,
  /\bread back\b[\s\S]{0,80}\b(?:both\s+)?files?\b/i,
  /\b(?:executed|ran|invoked|launched|compiled)\b[^.\n]{0,40}\b(?:it|them|this|the\s+(?:script|program|file|code|command|tests?)|python3?|node|\S{2,}\.[a-z]{1,4})\b/i,
  /\[Download[^\]]*\]\s*\(/i,
  /asyncgw\.teams\.microsoft\.com/i,
  /Extract\s+(?:the\s+)?(?:ZIP|zip|archive)\b/i,
];

function anyMatch(patterns: RegExp[], t: string): boolean {
  return patterns.some((re) => re.test(t));
}

/** Copilot "delivers" a Teams/asyncgw ZIP instead of a real Cursor Write. */
export function looksLikeFakeCopilotAttachment(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 12) return false;
  return anyMatch(FAKE_DELIVERY, t);
}

/** Classify give-up prose into one recovery category. */
export function classifyConfabulation(text: string | null): ConfabCategory {
  if (!text) return null;
  const t = text.trim();
  if (t.length < 12) return null;
  if (anyMatch(FAKE_DELIVERY, t)) return "fake_delivery";
  if (anyMatch(SANDBOX_MYTH, t)) return "sandbox_myth";
  if (anyMatch(TOOLS_VANISHED, t)) return "tools_vanished";
  if (anyMatch(EMPTY_WORKSPACE, t)) return "empty_workspace";
  if (anyMatch(ACCESS_DENIAL, t)) return "access_denial";
  return null;
}

/**
 * Does this no-tool-call response CLAIM a file mutation it may not have performed?
 * The handler only acts on this when NO tool call ran in the whole conversation.
 */
export function looksLikeHallucinatedCompletion(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 8) return false;
  if (looksLikeFakeCopilotAttachment(t)) return true;
  return HALLUCINATED_COMPLETION_PATTERNS.some((re) => re.test(t));
}

export function looksLikeConfabulation(text: string | null): boolean {
  return classifyConfabulation(text) != null;
}

// Keep the symbol referenced so packaging/tests that grep for it stay honest.
void CONFABULATION_PATTERNS;

/**
 * Did the model write a DOCUMENT (prose with embedded code fences) rather than
 * issue tool calls? The shell-routing parser greedily turns every ```bash block
 * into a tool call, so a model answering "here's a simplified README" — whose
 * markdown is full of ```bash / ```json examples — would get its own answer
 * executed as shell. Catch that: a real agentic turn is ONE action with little
 * prose; a document is multiple fences surrounded by substantial prose.
 *
 * Chosen empirically (scripts guard-experiment, README-about-bash fixture):
 * ≥2 fences AND (≥120 chars of surrounding prose OR ≥4 fences). A SINGLE action
 * is never reclassified regardless of prose, so the coding loop is untouched.
 */
export function isProseDocument(parsed: ParseResult): boolean {
  if (!parsed.hasToolCalls || parsed.toolCalls.length < 2) return false;
  const prose = parsed.textContent ? parsed.textContent.trim() : "";
  // Distinguish a coding-agent ACTION turn from a written DOCUMENT.
  //   ACTION  (execute it): a short preamble + a couple command fences, e.g. Claude's
  //           "I'll inspect the files first.\n```bash ls```\n```bash cat```" — common,
  //           must NOT be reclassified or we eat real tool calls (docs §10 F23).
  //   DOCUMENT (return as text): the model ANSWERING with markdown full of fences
  //           (F15: "here's a simplified README") — it carries document signatures:
  //           markdown headers, lots of prose, or many fences.
  // Flag only documents. (Old heuristic was prose≥120, which ate Claude's preambles.)
  const hasMarkdownHeaders = /^#{1,6}\s/m.test(prose);
  return parsed.toolCalls.length >= 4 || hasMarkdownHeaders || prose.length >= 300;
}

export function parseToolCalls(text: string, tools?: ToolDef[]): ParseResult {
  // Fenced is the format: parse ```toolname blocks first. Needs the tool schemas
  // to map header/body args. The JSON parse below is only a tolerance fallback for
  // when M365 ignores the contract and emits a `{"tool":...}` object anyway.
  if (tools && tools.length > 0) {
    const { calls, leftover } = parseFencedToolCalls(text, buildSpecMap(tools));
    if (calls.length > 0) {
      return { hasToolCalls: true, toolCalls: calls, textContent: cleanLooseText(leftover) };
    }
  }

  const toolCalls: ParsedToolCall[] = [];

  // Tolerance fallback: a stray JSON tool call {"tool": "...", "arguments": {...}}
  const jsonRegex = new RegExp(TOOL_CALL_REGEX.source, "g");
  let match: RegExpExecArray | null;

  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      const name = parsed.tool;
      if (name) {
        toolCalls.push({
          id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "function",
          function: {
            name,
            arguments: typeof parsed.arguments === "string"
              ? parsed.arguments
              : JSON.stringify(parsed.arguments ?? {}),
          },
        });
      }
    } catch {
      log.error("Failed to parse tool call JSON:", match[0]);
    }
  }

  // Fallback: try legacy fenced format
  if (toolCalls.length === 0) {
    const fencedRegex = new RegExp(FENCED_TOOL_CALL_REGEX.source, "g");
    while ((match = fencedRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        const name = parsed.tool || parsed.name;
        if (name) {
          toolCalls.push({
            id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: {
              name,
              arguments: typeof parsed.arguments === "string"
                ? parsed.arguments
                : JSON.stringify(parsed.arguments ?? {}),
            },
          });
        }
      } catch {
        log.error("Failed to parse fenced tool call JSON:", match[1]);
      }
    }
  }

  if (toolCalls.length === 0) {
    return { hasToolCalls: false, toolCalls: [], textContent: cleanLooseText(text) };
  }

  // Strip matched tool calls from text to get remaining content.
  // M365 is a markdown model and often wraps the JSON in a ```json / ```tool_call
  // fence even when told not to; remove the now-empty fence markers it leaves
  // behind so they aren't mistaken for real assistant prose. Also drop the
  // invented confidence/final objects so a premature "✅ SUCCESS" never reaches
  // the client and a junk-only leftover isn't flagged as mixed output.
  let remaining = text
    .replace(jsonRegex, "")
    .replace(new RegExp(FENCED_TOOL_CALL_REGEX.source, "g"), "")
    .replace(CONFIDENCE_REGEX, "")
    .replace(FINAL_OBJECT_REGEX, "")
    .replace(/```(?:json|tool_call)?\s*```/g, "") // empty fence pair
    .replace(/```(?:json|tool_call)?/g, "") // dangling opening/closing fence
    .trim();

  return {
    hasToolCalls: true,
    toolCalls,
    textContent: remaining || null,
  };
}

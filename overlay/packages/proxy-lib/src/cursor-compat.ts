/**
 * Cursor BYOK compatibility layer.
 *
 * Detects Cursor-shaped toolsets and translates M365 fenced/bash output into
 * Cursor's native OpenAI tool_calls (Read/Grep/Glob/Write/StrReplace/Shell/…).
 * Non-Cursor clients never enter this path.
 *
 * Kill switch: M365_CURSOR_COMPAT=0
 */
import {
  createLogger,
  getMessageContent,
  looksLikeConfabulation,
  type ToolDef,
  type Message,
} from "@m365-copilot/core";

const log = createLogger("cursor-compat");

export type CursorMode = "ask" | "plan" | "agent";

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ParseLike {
  hasToolCalls: boolean;
  toolCalls: ParsedToolCall[];
  textContent: string | null;
}

export function cursorCompatEnabled(): boolean {
  return process.env.M365_CURSOR_COMPAT !== "0";
}

export function isCursorRequest(tools?: ToolDef[] | null): boolean {
  if (!cursorCompatEnabled() || !tools?.length) return false;
  const names = tools.map((t) => t.function.name.toLowerCase());
  const hasShell = names.some((n) =>
    /^(shell|bash|run_terminal_cmd|run_command|execute_command)$/.test(n),
  );
  const hasFs = names.some((n) =>
    /^(read|grep|glob|write|streplace|delete|edit_file|write_file|read_file|grep_search|file_search)$/.test(n),
  );
  return hasShell && hasFs;
}

export function detectCursorMode(messages: Message[]): CursorMode {
  const blob = messages.map((m) => getMessageContent(m)).join("\n");
  if (/Plan mode is active/i.test(blob)) return "plan";
  if (/Ask mode is active/i.test(blob)) return "ask";
  return "agent";
}

function toolByName(tools: ToolDef[], re: RegExp): ToolDef | undefined {
  return tools.find((t) => re.test(t.function.name));
}

function buildArgs(tool: ToolDef, preferred: Record<string, unknown>): string {
  const props = tool.function.parameters?.properties ?? {};
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(preferred)) {
    if (props[k] !== undefined || Object.keys(props).length === 0) args[k] = v;
  }
  if (Object.keys(args).length === 0) {
    const req = tool.function.parameters?.required?.[0] ?? Object.keys(props)[0];
    if (req) args[req] = Object.values(preferred)[0];
  }
  return JSON.stringify(args);
}

function makeCall(tool: ToolDef, preferred: Record<string, unknown>): ParsedToolCall {
  return {
    id: `call_cursor_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    type: "function",
    function: {
      name: tool.function.name,
      arguments: buildArgs(tool, preferred),
    },
  };
}

/** Strip non-function tools; optionally force tool_choice for Agent/Plan/explore. */
export function sanitizeCursorBody(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  if (!Array.isArray(raw.tools)) return raw;

  const before = raw.tools.length;
  raw.tools = raw.tools
    .filter((t: any) => t?.function?.name)
    .map((t: any) => ({
      type: "function",
      function: {
        name: String(t.function.name),
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));

  if (raw.tools.length === 0) {
    delete raw.tools;
    delete raw.tool_choice;
    return raw;
  }

  if (before !== raw.tools.length) {
    log.info(`stripped ${before - raw.tools.length} non-function tool(s); kept ${raw.tools.length}`);
  }

  if (!isCursorRequest(raw.tools)) return raw;

  const mode = detectCursorMode(raw.messages ?? []);
  const names = raw.tools.map((t: any) => t.function.name);
  log.info(`mode=${mode} tools=${names.join(",")}`);

  const blob = JSON.stringify(raw.messages ?? []);
  if (
    (!raw.tool_choice || raw.tool_choice === "auto") &&
    (mode === "plan" || mode === "agent") &&
    /\b(list|scan|review|explore|read|inspect|codebase|workspace|implement|fix|files?|project|repo|plan)\b/i.test(blob)
  ) {
    raw.tool_choice = "required";
  }

  return raw;
}

/** Framing variant for formatMessages — Cursor only; Plan/Ask use readonly variants. */
export function cursorFramingVariant(
  tools?: ToolDef[] | null,
  mode?: CursorMode | null,
): string | undefined {
  if (!isCursorRequest(tools)) return undefined;
  if (mode === "plan") return "cursor_plan";
  if (mode === "ask") return "cursor_ask";
  return "cursor";
}

/** Readonly subset for Plan/Ask framing — Write/StrReplace/Delete hidden from the prompt. */
export function cursorToolsForFraming(tools: ToolDef[] | undefined, mode: CursorMode): ToolDef[] | undefined {
  if (!tools?.length) return tools;
  if (mode === "agent") return tools;
  return tools.filter((t) => !/^(Write|StrReplace|Delete|EditNotebook)$/i.test(t.function.name));
}

/**
 * Rewrite Shell/bash tool calls into native Cursor tools when the command is a
 * clear read/list/grep/write idiom. Mutating rewrites are Agent-only.
 */
export function rewriteBashToCursorTools(
  parsed: ParseLike,
  tools: ToolDef[],
  mode: CursorMode,
): ParseLike {
  if (!parsed.hasToolCalls || !parsed.toolCalls.length) return parsed;

  const out: ParsedToolCall[] = [];
  let changed = false;

  for (const tc of parsed.toolCalls) {
    const isShell = /^(Shell|bash|sh|run_terminal_cmd|run_command)$/i.test(tc.function.name);
    if (!isShell) {
      // Drop mutating native tools in Plan/Ask if model emitted them somehow
      if (mode !== "agent" && /^(Write|StrReplace|Delete|EditNotebook)$/i.test(tc.function.name)) {
        log.info(`dropping mutating ${tc.function.name} in ${mode} mode`);
        changed = true;
        continue;
      }
      out.push(tc);
      continue;
    }

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      out.push(tc);
      continue;
    }
    const cmd = String(args.command ?? args.cmd ?? args.script ?? "").trim();
    const rewritten = mapShellCommand(cmd, tools, mode);
    if (rewritten) {
      log.info(`rewrite bash→${rewritten.function.name}: ${cmd.slice(0, 80)}`);
      out.push(rewritten);
      changed = true;
    } else if (mode !== "agent") {
      // Plan/Ask: don't pass mutating/unknown shell through
      const readonly = /^(ls|dir|Get-ChildItem|cat|type|Get-Content|rg|grep|find|head|tail|wc|file|pwd|echo)\b/i.test(cmd)
        || /Select-String/i.test(cmd);
      if (!readonly) {
        log.info(`dropping non-readonly Shell in ${mode}: ${cmd.slice(0, 80)}`);
        changed = true;
        continue;
      }
      out.push(tc);
    } else {
      out.push(tc);
    }
  }

  if (!changed) return parsed;
  if (!out.length) {
    return { hasToolCalls: false, toolCalls: [], textContent: parsed.textContent };
  }
  return { hasToolCalls: true, toolCalls: out.slice(0, 1), textContent: null };
}

function mapShellCommand(
  cmd: string,
  tools: ToolDef[],
  mode: CursorMode,
): ParsedToolCall | null {
  if (!cmd) return null;
  const read = toolByName(tools, /^Read$/i);
  const grep = toolByName(tools, /^Grep$/i);
  const glob = toolByName(tools, /^Glob$/i);
  const write = toolByName(tools, /^Write$/i);
  const strReplace = toolByName(tools, /^StrReplace$/i);

  // cat / type / Get-Content → Read
  let m =
    cmd.match(/^(?:cat|type)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i) ||
    cmd.match(/^Get-Content\s+(?:-Path\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i);
  if (m && read) {
    return makeCall(read, { path: m[1] || m[2] || m[3] });
  }

  // rg / grep → Grep
  m = cmd.match(/^(?:rg|grep)\s+(?:-[a-zA-Z]+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(?:"([^"]+)"|'([^']+)'|(\S+)))?\s*$/i);
  if (m && grep) {
    const pattern = m[1] || m[2] || m[3];
    const path = m[4] || m[5] || m[6];
    const preferred: Record<string, unknown> = { pattern };
    if (path) preferred.path = path;
    return makeCall(grep, preferred);
  }

  // ls / Get-ChildItem / find / rg --files → Glob
  if (
    /^(?:ls|dir|Get-ChildItem|find)\b/i.test(cmd) ||
    /^rg\s+--files\b/i.test(cmd)
  ) {
    if (glob) return makeCall(glob, { glob_pattern: "**/*" });
  }

  // Heredoc write: cat > path <<'EOF' ... → Write (agent only)
  m = cmd.match(/^cat\s+>\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*<<['"]?EOF['"]?\s*\n([\s\S]*?)\nEOF\s*$/i);
  if (m && write && mode === "agent") {
    return makeCall(write, { path: m[1] || m[2] || m[3], contents: m[4] });
  }

  // Set-Content → Write (agent only)
  m = cmd.match(/^Set-Content\s+(?:-Path\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:-Value\s+)?(?:"([\s\S]*)"|'([\s\S]*)')\s*$/i);
  if (m && write && mode === "agent") {
    return makeCall(write, { path: m[1] || m[2] || m[3], contents: m[4] || m[5] || "" });
  }

  // sed -i 's/old/new/' path → StrReplace (agent only; basic delimiter forms)
  m = cmd.match(/^sed\s+-i\s+(?:''\s+)?['"]s\/([^/]+)\/([^/]*)\/g?['"]\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i);
  if (m && strReplace && mode === "agent") {
    return makeCall(strReplace, {
      path: m[3] || m[4] || m[5],
      old_string: m[1],
      new_string: m[2],
    });
  }

  return null;
}

export function shouldBootstrapCursor(
  tools: ToolDef[] | undefined,
  messages: Message[],
  parsed: ParseLike,
  everActed: boolean,
): boolean {
  if (everActed || parsed.hasToolCalls || !tools?.length || !isCursorRequest(tools)) return false;
  if (looksLikeConfabulation(parsed.textContent)) return true;
  const mode = detectCursorMode(messages);
  if (mode === "plan" || mode === "ask") return true;
  const userText = [...messages].reverse().find((m) => m.role === "user");
  const q = userText ? getMessageContent(userText) : "";
  return /\b(list|scan|review|explore|read|inspect|open|show|find|search|codebase|project|repo|workspace|files?|director(?:y|ies)|folder|plan|implement|fix|bug|error|refactor|edit|change|update|create|write)\b/i.test(q);
}

export function synthesizeCursorBootstrap(
  tools: ToolDef[],
  messages: Message[],
  prose: string | null,
): ParsedToolCall | null {
  if (!isCursorRequest(tools)) return null;

  const mode = detectCursorMode(messages);
  const blob = messages.map((m) => getMessageContent(m)).join("\n") + "\n" + (prose ?? "");
  const windows = /[A-Za-z]:\\/.test(blob) || /Windows project path/i.test(blob);

  const glob = toolByName(tools, /^Glob$/i);
  const grep = toolByName(tools, /^Grep$/i);
  const read = toolByName(tools, /^Read$/i);
  const shell = toolByName(tools, /^(Shell|bash|run_terminal_cmd|run_command)$/i);

  // Intent from latest user message
  const userText = [...messages].reverse().find((m) => m.role === "user");
  const q = userText ? getMessageContent(userText) : "";

  const readPath =
    q.match(/\b(?:read|open|show|cat)\s+[`"']?([^\s`"']+\.[A-Za-z0-9]+)[`"']?/i)?.[1] ||
    q.match(/\b([A-Za-z0-9_./-]+\.(?:json|md|ts|tsx|js|jsx|py|go|rs|yml|yaml|toml))\b/)?.[1];

  if (readPath && read) {
    log.info(`bootstrap Read path=${readPath} mode=${mode}`);
    return makeCall(read, { path: readPath });
  }

  const grepPat = q.match(/\b(?:find|search|grep|look for)\s+[`"']([^`"']+)[`"']/i)?.[1];
  if (grepPat && grep) {
    log.info(`bootstrap Grep pattern=${grepPat} mode=${mode}`);
    return makeCall(grep, { pattern: grepPat });
  }

  if (mode === "plan" || mode === "ask") {
    if (glob) {
      log.info(`bootstrap Glob mode=${mode}`);
      return makeCall(glob, { glob_pattern: "**/*" });
    }
    if (grep) {
      return makeCall(grep, { pattern: ".", glob: "*.{json,md,ts,tsx,js,jsx,py}" });
    }
    if (read) return makeCall(read, { path: "package.json" });
    return null;
  }

  // Agent
  if (glob && /\b(list|scan|review|explore|files?|project|repo|codebase)\b/i.test(q + blob)) {
    log.info(`bootstrap Glob mode=agent`);
    return makeCall(glob, { glob_pattern: "**/*" });
  }
  if (shell) {
    log.info(`bootstrap Shell mode=agent windows=${windows}`);
    return makeCall(shell, {
      command: windows ? "Get-ChildItem -Force" : "ls -la",
      description: "List workspace files so the agent can inspect the project",
    });
  }
  if (glob) return makeCall(glob, { glob_pattern: "**/*" });
  if (read) return makeCall(read, { path: "package.json" });
  return null;
}

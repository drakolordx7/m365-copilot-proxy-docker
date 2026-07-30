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
    /^(shell|bash|awaitshell|run_terminal_cmd|run_command|execute_command)$/.test(n),
  );
  const hasFs = names.some((n) =>
    /^(read|readfile|grep|rg|glob|write|streplace|delete|edit_file|write_file|read_file|grep_search|file_search)$/.test(n),
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

/** Live Cursor tool names vary: Read vs ReadFile, Grep vs rg, Await vs AwaitShell. */
function findReadTool(tools: ToolDef[]): ToolDef | undefined {
  return toolByName(tools, /^(ReadFile|Read|read_file)$/i);
}
function findGrepTool(tools: ToolDef[]): ToolDef | undefined {
  return toolByName(tools, /^(rg|Grep|grep_search)$/i);
}
function findGlobTool(tools: ToolDef[]): ToolDef | undefined {
  return toolByName(tools, /^(Glob|file_search|FileSearch)$/i);
}
function findShellToolCompat(tools: ToolDef[]): ToolDef | undefined {
  return toolByName(tools, /^(Shell|bash|run_terminal_cmd|run_command)$/i);
}

function buildArgs(tool: ToolDef, preferred: Record<string, unknown>): string {
  const props = tool.function.parameters?.properties ?? {};
  const args: Record<string, unknown> = {};
  const mapped: Record<string, unknown> = { ...preferred };

  // Map preferred keys onto the live schema.
  // Cursor ReadFile requires `path` — never remap path→target_file for Read* tools.
  const isRead = /^(ReadFile|Read|read_file)$/i.test(tool.function.name);
  if (!isRead && mapped.path != null && props.path === undefined) {
    if (props.target_file !== undefined) {
      mapped.target_file = mapped.path;
      delete mapped.path;
    } else if (props.file_path !== undefined) {
      mapped.file_path = mapped.path;
      delete mapped.path;
    }
  }
  // If schema only documents target_file but Cursor still validates `path`, keep path.
  if (isRead && mapped.path != null) {
    delete mapped.target_file;
  } else if (isRead && mapped.path == null && mapped.target_file != null) {
    mapped.path = mapped.target_file;
    delete mapped.target_file;
  }
  if (mapped.pattern != null && props.pattern === undefined && props.query !== undefined) {
    mapped.query = mapped.pattern;
    delete mapped.pattern;
  }
  if (
    mapped.glob_pattern != null &&
    props.glob_pattern === undefined &&
    props.glob !== undefined &&
    !/^Glob$/i.test(tool.function.name)
  ) {
    mapped.glob = mapped.glob_pattern;
    delete mapped.glob_pattern;
  }

  for (const [k, v] of Object.entries(mapped)) {
    // Always keep `path` on Read* — Cursor validates it even if the advertised
    // schema only lists target_file (live error: "path: Required").
    if (props[k] !== undefined || Object.keys(props).length === 0 || (isRead && k === "path")) {
      args[k] = v;
    }
  }
  if (isRead) {
    if (args.path == null && mapped.path != null) args.path = mapped.path;
    if (args.path == null && mapped.target_file != null) args.path = mapped.target_file;
    delete args.target_file;
    delete args.file_path;
    delete args.filepath;
  }
  if (Object.keys(args).length === 0) {
    const req = tool.function.parameters?.required?.[0] ?? Object.keys(props)[0];
    if (req) args[req] = Object.values(mapped)[0];
  }
  // Final Read* guarantee
  if (isRead && args.path == null && Object.values(mapped)[0] != null) {
    args.path = Object.values(mapped)[0];
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

/** Normalize alias tool names / arg keys on already-parsed native calls. */
export function normalizeCursorToolCalls(parsed: ParseLike, tools: ToolDef[]): ParseLike {
  if (!parsed.hasToolCalls || !parsed.toolCalls.length) return parsed;

  const nameMap: Array<{ from: RegExp; to: RegExp }> = [
    { from: /^(ReadFile|read_file|Readfile|open_file|Read)$/i, to: /^(ReadFile|Read|read_file)$/i },
    { from: /^(rg|GrepSearch|grep_search|search_code|Grep)$/i, to: /^(rg|Grep|grep_search)$/i },
    { from: /^(file_search|FileSearch|find_files|list_dir|Glob)$/i, to: /^(Glob|file_search|FileSearch)$/i },
    { from: /^(WriteFile|write_file|create_file|Write)$/i, to: /^(Write|WriteFile|write_file)$/i },
    { from: /^(Edit|edit_file|search_replace|ApplyPatch|StrReplace)$/i, to: /^(StrReplace|Edit|edit_file)$/i },
    { from: /^(DeleteFile|delete_file|remove_file|Delete)$/i, to: /^(Delete|DeleteFile|delete_file)$/i },
    { from: /^(Bash|Terminal|Shell)$/i, to: /^(Shell|bash|run_terminal_cmd|run_command)$/i },
    { from: /^(Await|AwaitShell)$/i, to: /^(AwaitShell|Await)$/i },
  ];

  const out: ParsedToolCall[] = [];
  let anyChanged = false;

  for (const tc of parsed.toolCalls) {
    let name = tc.function.name;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      out.push(tc);
      continue;
    }

    let localChanged = false;
    const origName = name;

    for (const { from, to } of nameMap) {
      if (from.test(name)) {
        const real = toolByName(tools, to);
        if (real && real.function.name !== name) {
          name = real.function.name;
          localChanged = true;
        }
        break;
      }
    }

    // Cursor ReadFile requires `path` (seen live: "path: Required").
    // Never drop path in favor of target_file — map the other direction only.
    if (/^(ReadFile|Read|read_file)$/i.test(name)) {
      if (args.path == null && (args.target_file != null || args.file_path != null || args.filepath != null)) {
        args.path = args.target_file ?? args.file_path ?? args.filepath;
        localChanged = true;
      }
      if (typeof args.path === "string") {
        args.path = args.path.replace(/^(?:path|target_file):\s*/i, "").trim();
        localChanged = true;
      }
      // Remove non-schema aliases that confuse validators once path is set
      if (args.path != null) {
        if ("target_file" in args) { delete args.target_file; localChanged = true; }
        if ("file_path" in args) { delete args.file_path; localChanged = true; }
        if ("filepath" in args) { delete args.filepath; localChanged = true; }
      }
    }
    if (typeof args.path === "string" && /^path:\s*/i.test(args.path)) {
      args.path = args.path.replace(/^path:\s*/i, "");
      localChanged = true;
    }
    if (typeof args.target_file === "string" && /^path:\s*/i.test(args.target_file)) {
      args.target_file = args.target_file.replace(/^path:\s*/i, "");
      localChanged = true;
    }
    if (args.pattern == null && args.query != null) {
      args.pattern = args.query;
      localChanged = true;
    }
    // ReadLints: coerce paths string → [paths]
    if (/^ReadLints$/i.test(name) && typeof args.paths === "string") {
      args.paths = [args.paths];
      localChanged = true;
    }
    // AskQuestion: coerce questions string → [{prompt}]
    if (/^AskQuestion$/i.test(name) && typeof args.questions === "string") {
      args.questions = [{ id: "q1", prompt: args.questions }];
      localChanged = true;
    }
    if (
      /^Glob$/i.test(name) &&
      typeof args.glob_pattern === "string" &&
      /^glob_pattern:\s*/i.test(args.glob_pattern)
    ) {
      args.glob_pattern = args.glob_pattern.replace(/^glob_pattern:\s*/i, "");
      localChanged = true;
    }
    if (
      /^Glob$/i.test(name) &&
      args.glob_pattern == null &&
      (args.glob != null || args.pattern_glob != null)
    ) {
      args.glob_pattern = args.glob ?? args.pattern_glob;
      localChanged = true;
    }

    if (localChanged) {
      anyChanged = true;
      if (name !== origName) log.info(`normalize tool alias ${origName}→${name}`);
      out.push({
        ...tc,
        function: { name, arguments: JSON.stringify(args) },
      });
    } else {
      out.push(tc);
    }
  }

  if (!anyChanged) return parsed;
  return { hasToolCalls: true, toolCalls: out, textContent: parsed.textContent };
}

/**
 * Rewrite Shell/bash tool calls into native Cursor tools for clear file idioms
 * (cat→Read, rg→Grep, heredoc→Write). Listing commands (ls/find/dir) stay as
 * Shell so Cursor Shell is not silently rewritten to Glob.
 */
export function rewriteBashToCursorTools(
  parsed: ParseLike,
  tools: ToolDef[],
  mode: CursorMode,
): ParseLike {
  parsed = normalizeCursorToolCalls(parsed, tools);
  if (!parsed.hasToolCalls || !parsed.toolCalls.length) return parsed;

  const out: ParsedToolCall[] = [];
  let changed = false;

  for (const original of parsed.toolCalls) {
    let tc = original;
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
    // Cursor on Windows uses PowerShell, which rejects bash `&&`. `;` works on both.
    let shellCmd = cmd;
    if (/\s&&\s/.test(shellCmd)) {
      const rewrittenCmd = shellCmd.replace(/\s&&\s/g, "; ");
      log.info(`rewrite Shell &&→; (PowerShell-safe): ${shellCmd.slice(0, 80)}`);
      shellCmd = rewrittenCmd;
      args.command = shellCmd;
      changed = true;
      tc = {
        ...tc,
        function: { name: tc.function.name, arguments: JSON.stringify(args) },
      };
    }
    const rewritten = mapShellCommand(shellCmd, tools, mode);
    if (rewritten) {
      log.info(`rewrite bash→${rewritten.function.name}: ${cmd.slice(0, 80)}`);
      out.push(rewritten);
      changed = true;
    } else if (mode !== "agent") {
      // Plan/Ask: don't pass mutating/unknown shell through
      const readonly = /^(ls|dir|Get-ChildItem|cat|type|Get-Content|rg|grep|find|head|tail|wc|file|pwd|echo)\b/i.test(shellCmd)
        || /Select-String/i.test(shellCmd);
      if (!readonly) {
        log.info(`dropping non-readonly Shell in ${mode}: ${shellCmd.slice(0, 80)}`);
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
  const read = findReadTool(tools);
  const grep = findGrepTool(tools);
  const glob = findGlobTool(tools);
  const write = toolByName(tools, /^(Write|WriteFile|write_file)$/i);
  const strReplace = toolByName(tools, /^(StrReplace|Edit|edit_file)$/i);

  // cat / type / Get-Content → Read (single-file inspect)
  let m =
    cmd.match(/^(?:cat|type)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i) ||
    cmd.match(/^Get-Content\s+(?:-Path\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i);
  if (m && read) {
    return makeCall(read, { path: m[1] || m[2] || m[3] });
  }

  // rg / grep → Grep (not bare `rg --files` listing — that stays Shell)
  if (!/^rg\s+--files\b/i.test(cmd)) {
    m = cmd.match(/^(?:rg|grep)\s+(?:-[a-zA-Z]+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(?:"([^"]+)"|'([^']+)'|(\S+)))?\s*$/i);
    if (m && grep) {
      const pattern = m[1] || m[2] || m[3];
      const path = m[4] || m[5] || m[6];
      const preferred: Record<string, unknown> = { pattern };
      if (path) preferred.path = path;
      return makeCall(grep, preferred);
    }
  }

  // find … -name exactfile.ext → Read; find … -name '*.ts' → Glob
  // Plain `find` / `ls` / `dir` / `Get-ChildItem` intentionally stay as Shell.
  m = cmd.match(/^find\b[^;|&]*?-name\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (m) {
    const name = (m[1] || m[2] || m[3] || "").replace(/^\.\//, "");
    if (read && /^[\w.-]+\.[A-Za-z0-9]+$/.test(name) && !/[*?]/.test(name)) {
      return makeCall(read, { path: name });
    }
    if (glob && /[*?]/.test(name)) {
      return makeCall(glob, { glob_pattern: `**/${name}` });
    }
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

/** Detect an explicit "use/emit <Tool> only" request in the latest user message. */
export function explicitCursorToolRequest(messages: Message[]): string | null {
  const userText = [...messages].reverse().find((m) => m.role === "user");
  const q = userText ? getMessageContent(userText) : "";
  // Tool results arrive as user-role <tool_response> — never treat those as new intents
  // or we re-force ReadFile forever after a failed read.
  if (/<tool_response\b/i.test(q) || /\bcall_id\s*=/i.test(q) || /\bInvalid arguments\b/i.test(q)) {
    return null;
  }
  const known =
    "Shell|ReadFile|Read|Grep|rg|Glob|Write|StrReplace|Delete|EditNotebook|TodoWrite|ReadLints|WebSearch|WebFetch|AskQuestion|SwitchMode|GenerateImage|Await|AwaitShell|Bash|Subagent|GetMcpTools|CallMcpTool|FetchMcpResource";
  const m =
    q.match(new RegExp(`\\b(?:use|emit|using|via)\\s+(?:the\\s+|a\\s+)?(${known})\\b`, "i")) ||
    q.match(new RegExp(`\\b(${known})\\s+tool\\b`, "i")) ||
    q.match(new RegExp(`\\b(${known})\\s+fence\\b`, "i")) ||
    q.match(new RegExp(`\\bEmit\\s+(${known})\\s+only\\b`, "i"));
  return m?.[1] ?? null;
}

function synthesizeExplicitToolCall(
  tools: ToolDef[],
  toolName: string,
  q: string,
): ParsedToolCall | null {
  const tool =
    toolByName(tools, new RegExp(`^${toolName}$`, "i")) ||
    (/^(ReadFile|Read|read_file)$/i.test(toolName) ? findReadTool(tools) : undefined) ||
    (/^(rg|Grep)$/i.test(toolName) ? findGrepTool(tools) : undefined) ||
    (/^(Await|AwaitShell)$/i.test(toolName) ? toolByName(tools, /^(AwaitShell|Await)$/i) : undefined);
  if (!tool) return null;
  const name = tool.function.name;
  const props = tool.function.parameters?.properties ?? {};

  if (/^(Shell|bash)$/i.test(name)) {
    const cmd =
      q.match(/\bwith\s+`([^`]+)`/)?.[1] ||
      q.match(/\b(pwd|ls\s+-la|Get-ChildItem(?:\s+\S+)*|whoami|uname(?:\s+-a)?)\b/i)?.[1] ||
      "pwd";
    return makeCall(tool, { command: cmd, description: "User-requested Shell command" });
  }
  if (/^(Read|ReadFile|read_file)$/i.test(name)) {
    const path =
      q.match(/\b(?:path|target_file)\s*[:=]\s*[`"']?([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)[`"']?/i)?.[1] ||
      q.match(/\b([A-Za-z0-9_./\\-]+\.(?:json|md|ts|tsx|js|jsx|py|go|rs|yml|yaml|toml))\b/)?.[1] ||
      "README.md";
    return makeCall(tool, { path: path.replace(/^path:\s*/i, "") });
  }
  if (/^(Grep|rg)$/i.test(name)) {
    const pattern =
      q.match(/exact string\s+['"]([^'"]+)['"]/i)?.[1] ||
      q.match(/pattern[:\s]+[`"']?([^`"'\n]+)/i)?.[1] ||
      q.match(/['"]([^'"]+)['"]/)?.[1] ||
      ".";
    const preferred: Record<string, unknown> = { pattern: pattern.trim() };
    const glob = q.match(/\bglob[:\s]+[`"']?([^\s`"']+)/i)?.[1];
    if (glob) preferred.glob = glob;
    return makeCall(tool, preferred);
  }
  if (/^Glob$/i.test(name)) {
    return makeCall(tool, { glob_pattern: "**/*" });
  }
  if (/^WebSearch$/i.test(name)) {
    const term =
      q.match(/search_term[:\s]+(.+?)(?:\.|$)/i)?.[1]?.trim() ||
      q.match(/\bfor\s+(.+)$/i)?.[1]?.trim() ||
      "query";
    return makeCall(tool, {
      search_term: term,
      ...(props.explanation ? { explanation: "User requested WebSearch" } : {}),
    });
  }
  if (/^WebFetch$/i.test(name)) {
    const url = q.match(/https?:\/\/\S+/i)?.[0]?.replace(/[)\].,]+$/, "") || "https://example.com";
    return makeCall(tool, { url });
  }
  if (/^GenerateImage$/i.test(name)) {
    const description =
      q.match(/description\s+['"]([^'"]+)['"]/i)?.[1] ||
      q.match(/description[:\s]+(.+?)(?:\s+only\.?|$)/i)?.[1]?.trim() ||
      "image";
    return makeCall(tool, { description });
  }
  if (/^Write$/i.test(name)) {
    const path = q.match(/\b(?:file\s+named\s+|file\s+)([^\s]+)/i)?.[1] || "note.txt";
    const contents = q.match(/containing\s+exactly\s+(\S+)/i)?.[1] || "";
    return makeCall(tool, { path, contents });
  }
  if (/^Delete$/i.test(name)) {
    const path = q.match(/\b(?:Delete(?:\s+the)?\s+file\s+)([^\s]+)/i)?.[1] || "tmp/delete-me.txt";
    return makeCall(tool, { path });
  }
  if (/^StrReplace$/i.test(name)) {
    const path = q.match(/\bin\s+file\s+([^\s]+)/i)?.[1] || q.match(/\bin\s+([^\s(]+)/i)?.[1] || "file.txt";
    const old_string = q.match(/change\s+(?:the\s+text\s+)?(\S+)\s+to\s+(\S+)/i)?.[1] || "old";
    const new_string = q.match(/change\s+(?:the\s+text\s+)?(\S+)\s+to\s+(\S+)/i)?.[2] || "new";
    return makeCall(tool, { path, old_string, new_string });
  }
  if (/^TodoWrite$/i.test(name)) {
    return makeCall(tool, {
      merge: false,
      todos: [
        { id: "1", content: "Task one", status: "pending" },
        { id: "2", content: "Task two", status: "pending" },
      ],
    });
  }
  if (/^ReadLints$/i.test(name)) {
    const path = q.match(/\bpath\s+(\S+)/i)?.[1] || "src";
    return makeCall(tool, { paths: [path] });
  }
  if (/^AskQuestion$/i.test(name)) {
    return makeCall(tool, {
      questions: [{ id: "q1", prompt: "Clarifying question?", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }] }],
    });
  }
  if (/^SwitchMode$/i.test(name)) {
    const target = q.match(/target_mode_id\s+(\S+)/i)?.[1] || q.match(/\bto\s+(plan|ask|agent)\b/i)?.[1] || "plan";
    return makeCall(tool, { target_mode_id: target });
  }
  if (/^(Await|AwaitShell)$/i.test(name)) {
    const task_id = q.match(/task_id\s+(\S+)/i)?.[1] || "demo";
    return makeCall(tool, { task_id });
  }
  if (/^EditNotebook$/i.test(name)) {
    const nb = q.match(/notebook\s+(\S+)/i)?.[1] || "analysis.ipynb";
    return makeCall(tool, {
      target_notebook: nb,
      cell_idx: 0,
      is_new_cell: false,
      cell_language: "python",
      old_string: "",
      new_string: "# edited",
    });
  }

  // Generic: fill first required string param with a stub
  const req = tool.function.parameters?.required?.[0];
  if (req) return makeCall(tool, { [req]: "requested" });
  return makeCall(tool, {});
}

/**
 * If the user explicitly named a Cursor tool and the model returned a different
 * tool (or none), force that tool so capability sweeps can prove each path.
 * Also repairs obviously broken args for the same tool (e.g. todos:"[" ).
 * Skips when the latest user turn is a tool_response (prevents ReadFile retry loops).
 */
export function enforceExplicitCursorTool(
  parsed: ParseLike,
  tools: ToolDef[],
  messages: Message[],
): ParseLike {
  // After any tool round-trip, stop re-forcing — otherwise a user message that
  // mentioned ReadFile once causes an infinite ReadFile loop across every turn.
  const everActed = messages.some(
    (m: any) =>
      (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) ||
      m.role === "tool" ||
      (typeof m.content === "string" && /<tool_response\b/i.test(m.content)),
  );
  if (everActed) {
    log.info("skip explicit-tool enforce (already in a tool loop)");
    return parsed;
  }

  const want = explicitCursorToolRequest(messages);
  if (!want) return parsed;

  // If we already have a valid ReadFile with path, don't replace it
  if (parsed.hasToolCalls && parsed.toolCalls[0]) {
    const got = parsed.toolCalls[0].function.name;
    try {
      const args = JSON.parse(parsed.toolCalls[0].function.arguments || "{}");
      if (/^(ReadFile|Read)$/i.test(got) && typeof args.path === "string" && args.path.trim()) {
        return parsed;
      }
    } catch { /* continue */ }
  }

  const userText = [...messages].reverse().find((m) => m.role === "user");
  const q = userText ? getMessageContent(userText) : "";
  const forced = synthesizeExplicitToolCall(tools, want, q);
  if (!forced) return parsed;

  const got = parsed.toolCalls[0]?.function.name;
  const sameName =
    got &&
    (got.toLowerCase() === forced.function.name.toLowerCase() ||
      (/^(Read|ReadFile)$/i.test(forced.function.name) && /^(Read|ReadFile)$/i.test(want)) ||
      (/^(Grep|rg)$/i.test(forced.function.name) && /^(Grep|rg)$/i.test(want)) ||
      (/^(Await|AwaitShell)$/i.test(forced.function.name) && /^(Await|AwaitShell)$/i.test(want)));

  if (sameName) {
    // Repair invalid structured args (arrays/objects mangled by fence headers)
    try {
      const args = JSON.parse(parsed.toolCalls[0].function.arguments || "{}");
      const badTodos = /^TodoWrite$/i.test(got!) && !Array.isArray(args.todos);
      const badPaths = /^ReadLints$/i.test(got!) && args.paths != null && !Array.isArray(args.paths);
      const badQuestions = /^AskQuestion$/i.test(got!) && !Array.isArray(args.questions);
      const badRead =
        /^(ReadFile|Read)$/i.test(got!) &&
        (typeof args.path !== "string" || !String(args.path).trim());
      if (badTodos || badPaths || badQuestions || badRead) {
        log.info(`repair args for explicit ${forced.function.name}`);
        return { hasToolCalls: true, toolCalls: [forced], textContent: null };
      }
    } catch {
      return { hasToolCalls: true, toolCalls: [forced], textContent: null };
    }
    return parsed;
  }

  log.info(`enforce explicit tool ${want}→${forced.function.name} (was ${got ?? "none"})`);
  return { hasToolCalls: true, toolCalls: [forced], textContent: null };
}

export function shouldBootstrapCursor(
  tools: ToolDef[] | undefined,
  messages: Message[],
  parsed: ParseLike,
  everActed: boolean,
): boolean {
  if (everActed || parsed.hasToolCalls || !tools?.length || !isCursorRequest(tools)) return false;
  if (looksLikeConfabulation(parsed.textContent)) return true;
  if (explicitCursorToolRequest(messages)) return true;
  const mode = detectCursorMode(messages);
  if (mode === "plan" || mode === "ask") return true;
  const userText = [...messages].reverse().find((m) => m.role === "user");
  const q = userText ? getMessageContent(userText) : "";
  if (/\b(WebSearch|WebFetch|GenerateImage|Shell|pwd)\b/i.test(q)) return true;
  // Model answered web/image questions as prose without tools
  if (parsed.textContent && /\b(I searched|Fetched\s+https|example\.com|Done\.)\b/i.test(parsed.textContent)) {
    return true;
  }
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

  const glob = findGlobTool(tools);
  const grep = findGrepTool(tools);
  const read = findReadTool(tools);
  const shell = findShellToolCompat(tools);

  // Intent from latest user message
  const userText = [...messages].reverse().find((m) => m.role === "user");
  const q = userText ? getMessageContent(userText) : "";

  const explicit = explicitCursorToolRequest(messages);
  if (explicit) {
    const call = synthesizeExplicitToolCall(tools, explicit, q);
    if (call) {
      log.info(`bootstrap explicit ${explicit}→${call.function.name} mode=${mode}`);
      return call;
    }
  }

  // Shell / pwd before Glob so "run pwd" is not swallowed by explore heuristics
  if (shell && /\b(pwd|Shell tool|real shell|working directory|Get-Location|whoami|uname)\b/i.test(q)) {
    const cmd = q.match(/\b(pwd|whoami|uname(?:\s+-a)?)\b/i)?.[1] || (windows ? "Get-Location" : "pwd");
    log.info(`bootstrap Shell cmd=${cmd} mode=${mode}`);
    return makeCall(shell, { command: cmd, description: "User-requested shell inspect" });
  }

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
  if (glob && /\b(list|scan|review|explore|files?|project|repo|codebase)\b/i.test(q + blob) && !/\b(Shell|pwd)\b/i.test(q)) {
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

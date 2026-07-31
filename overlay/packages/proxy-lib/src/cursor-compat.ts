/**
 * Cursor BYOK compatibility layer.
 *
 * Detects Cursor-shaped toolsets and translates M365 fenced/bash output into
 * Cursor's native OpenAI tool_calls (Read/Grep/Glob/Write/StrReplace/Shell/…).
 * Non-Cursor clients never enter this path.
 *
 * Design:
 * - Capability-aware: never force Write when Cursor omitted it — use Shell.
 * - Structural rewrites > myth regexes (/mnt/data → relative, here-strings → base64).
 * - Intent from latest user ask (Cursor open-file noise stripped).
 *
 * Kill switch: M365_CURSOR_COMPAT=0
 */
import {
  createLogger,
  getMessageContent,
  looksLikeConfabulation,
  looksLikePartialAccessConfab,
  looksLikeStalledAgentProse,
  type ToolDef,
  type Message,
} from "@m365-copilot/core";
import { detectHostOs, type HostOs } from "./orchestration.js";

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
  return tools.filter((t) => !/^(Write|WriteFile|StrReplace|ApplyPatch|Delete|EditNotebook)$/i.test(t.function.name));
}

/** Best-effort workspace root from Cursor message history (Windows or Unix). */
export function extractWorkspaceRoot(messages?: Message[] | null): string | null {
  if (!messages?.length) return null;
  const blob = messages.map((m) => getMessageContent(m)).join("\n");
  const candidates: string[] = [];
  const winRe = /[A-Za-z]:\\(?:[^\\/<>"|?\n*]+\\)*[^\\/<>"|?\n*]*/g;
  const unixRe = /(?:^|[\s`"'(=])(\/(?:Users|home|workspace|Volumes|mnt)\/[^\s`"')\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = winRe.exec(blob))) candidates.push(m[0].replace(/[.,;:]+$/, ""));
  while ((m = unixRe.exec(blob))) candidates.push(m[1].replace(/[.,;:]+$/, ""));
  if (!candidates.length) return null;

  const isCursorInternal = (p: string) =>
    /\.cursor[/\\]projects[/\\]/i.test(p) ||
    /[/\\]agent-tools(?:[/\\]|$)/i.test(p) ||
    /[/\\]AppData[/\\]Local[/\\]Temp[/\\]/i.test(p);

  const toRoot = (p: string): string => {
    const leaf = p.split(/[/\\]/).pop() || "";
    const isFile = /\.[A-Za-z0-9]{1,8}$/.test(leaf);
    let dir = isFile ? p.replace(/[/\\][^/\\]+$/, "") : p;
    // Strip nested project dirs so …\project\src\pkg → …\project
    dir = dir.replace(
      /[/\\](?:src|tests?|lib|packages?|apps?|dist|build|node_modules|overlay|scripts)(?:[/\\].*)?$/i,
      "",
    );
    return dir;
  };

  const scored = candidates
    .map(toRoot)
    .filter((p) => p.length >= 8 && !isCursorInternal(p));
  if (!scored.length) return null;
  scored.sort((a, b) => b.length - a.length);
  const preferred = scored.find((p) =>
    /\\(?:Desktop|Documents|Projects|dev|code)\\|\/(?:Desktop|Documents|Projects|workspace)\//i.test(p),
  );
  return preferred ?? scored[0];
}

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

export function joinWorkspacePath(root: string, rel: string): string {
  const clean = rel.replace(/^\.[/\\]/, "").replace(/^[\\/]+/, "");
  if (!clean) return root;
  const sep = root.includes("\\") || /^[A-Za-z]:/.test(root) ? "\\" : "/";
  const base = root.replace(/[/\\]+$/, "");
  const parts = clean.split(/[/\\]+/).filter(Boolean);
  return [base, ...parts].join(sep);
}

function absolutizePath(path: string, root: string | null): string {
  const p = path.trim();
  if (!p || isAbsolutePath(p) || !root) return p;
  return joinWorkspacePath(root, p);
}

/** Parse ReadLints `paths` whether array, JSON string, or bracket-junk relative path. */
export function normalizeReadLintsPaths(paths: unknown): string[] {
  const cleanOne = (raw: string): string => {
    let s = raw.trim();
    // Strip accidental JSON-array wrapping left as a literal path
    if (/^\[.*\]$/.test(s)) {
      const inner = s.slice(1, -1).trim();
      const q = inner.match(/^"(.*)"$/) || inner.match(/^'(.*)'$/);
      s = (q ? q[1] : inner).trim();
    }
    s = s.replace(/^["']|["']$/g, "").trim();
    // Normalize slash direction for Windows-ish relative paths
    return s;
  };

  const fromLooseJson = (s: string): string[] | null => {
    const t = s.trim();
    if (!(t.startsWith("[") && t.endsWith("]"))) return null;
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map((x) => cleanOne(String(x)));
    } catch {
      try {
        const parsed = JSON.parse(t.replace(/\\/g, "\\\\"));
        if (Array.isArray(parsed)) return parsed.map((x) => cleanOne(String(x)));
      } catch {
        const quoted = [...t.slice(1, -1).matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
        if (quoted.length) return quoted.map(cleanOne);
        const inner = t.slice(1, -1).trim();
        if (inner) return [cleanOne(inner)];
      }
    }
    return null;
  };

  if (Array.isArray(paths)) {
    return paths.flatMap((p) => {
      if (typeof p !== "string") return [];
      const loose = fromLooseJson(p);
      if (loose) return loose;
      const c = cleanOne(p);
      return c ? [c] : [];
    });
  }
  if (typeof paths === "string") {
    const loose = fromLooseJson(paths);
    if (loose) return loose;
    const c = cleanOne(paths);
    return c ? [c] : [];
  }
  return [];
}

/** PowerShell object pipelines often produce blank Cursor stdout — force stringification. */
export function hardenPowerShellStdout(cmd: string): string {
  const c = cmd.trim();
  if (!c) return c;
  if (/\|\s*Out-String\b/i.test(c)) return c;
  if (/\|\s*ConvertTo-(?:Json|Csv|Html|Xml)\b/i.test(c)) return c;
  if (/\|\s*Format-(?:List|Table|Wide|Custom)\b/i.test(c)) return c;
  // Mutations / redirects — don't wrap
  if (/[>]{1,2}|\|\s*Out-File\b|\bSet-Content\b|\bAdd-Content\b|\bNew-Item\b|\bRemove-Item\b|\bMove-Item\b|\bCopy-Item\b|\btee\b/i.test(c)) {
    return c;
  }
  // Inspect / discovery cmdlets that return PSObjects
  if (
    /^(?:Get-(?:Location|ChildItem|Item|Content|Process|Service|Command|Help|Date|Host)|pwd|ls|dir|whoami|hostname|echo|Write-Output)\b/i.test(c) ||
    /^(?:Get-Location|Get-ChildItem|pwd)\b/i.test(c)
  ) {
    return `(${c}) | Out-String -Width 4096`;
  }
  return c;
}

function isReadonlyShellCommand(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  // Plan/Ask must not rely on prompt wording to protect the workspace. Reject
  // redirects, mutation cmdlets, and compound commands containing them.
  if (
    /(?:^|[;&|])\s*(?:Set|Add|New|Remove|Move|Copy|Rename|Clear|Out-File|Export-)(?:-\w+)?\b/i.test(c) ||
    /(?:^|[;&|])\s*(?:del|erase|rm|mv|cp|touch|mkdir|rmdir)\b/i.test(c) ||
    /(?:>>?|<<)\s*/.test(c) ||
    /\|\s*(?:Set-Content|Out-File|Add-Content|Tee-Object)\b/i.test(c)
  ) {
    return false;
  }
  return /^(?:ls|dir|Get-(?:ChildItem|Content|Location|Item|Process|Service|Command|Help|Date|Host)|cat|type|pwd|whoami|hostname|echo|Write-Output|rg|grep|find|head|tail|wc|file|Select-String|Out-String)\b/i.test(c);
}

function psSingleQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Strip Copilot sandbox roots so Shell/Write land in the real Cursor workspace. */
export function sanitizeSandboxPath(path: string): string {
  let p = String(path ?? "").trim();
  if (!p) return p;
  p = p.replace(/^\/mnt\/data\//i, "");
  p = p.replace(/^\/mnt\/data$/i, ".");
  p = p.replace(/^\/tmp\/(?:mnt\/)?data\//i, "");
  p = p.replace(/^\/home\/(?:ubuntu|user)\/(?:workspace|project)\//i, "");
  // Absolute sandbox leftovers → relative leaf path
  if (/^\/(?:mnt|tmp|var\/tmp)\//i.test(p)) {
    const leaf = p.split("/").filter(Boolean).slice(-2).join("/");
    return leaf || "file.txt";
  }
  return p;
}

function hostOsFromMessages(messages?: Message[] | null): HostOs {
  if (!messages?.length) return "unknown";
  return detectHostOs(messages.map((m) => getMessageContent(m)).join("\n"));
}

/** Reliable file write via Shell when Cursor omits the Write tool. */
export function shellWriteCommand(
  path: string,
  contents: string,
  os: HostOs = "windows",
): string {
  const clean = sanitizeSandboxPath(path);
  const b64 = Buffer.from(contents, "utf8").toString("base64");
  if (os === "posix") {
    return (
      `python3 -c "import base64,pathlib; p=pathlib.Path(${JSON.stringify(clean)}); ` +
      `p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(base64.b64decode(${JSON.stringify(b64)}))" ` +
      `&& echo "wrote ${clean}"`
    );
  }
  // Windows (and unknown — Cursor BYOK hosts are usually Windows PowerShell)
  return (
    `$p=${psSingleQuote(clean)}; $b=${psSingleQuote(b64)}; ` +
    `$dir=Split-Path -Parent $p; if($dir){ New-Item -ItemType Directory -Force -Path $dir | Out-Null }; ` +
    `[IO.File]::WriteAllText($p,[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))); ` +
    `Write-Output \"wrote $p ($($b.Length) b64)\"`
  );
}

/**
 * Convert fragile Set-Content … -Value @'…'@ here-strings to base64 WriteAllText.
 * PowerShell here-strings break when models omit the closing '@ line.
 */
export function rewritePowerShellHereStringWrites(cmd: string): string | null {
  if (!/\bSet-Content\b/i.test(cmd) || !/-Value\s+@['"]/i.test(cmd)) return null;

  const starts: number[] = [];
  const startRe = /\bSet-Content\b/gi;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(cmd)) !== null) starts.push(m.index);
  if (!starts.length) return null;

  const out: string[] = [];
  let cursor = 0;
  let rewrote = false;

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : cmd.length;
    if (from > cursor) out.push(cmd.slice(cursor, from));

    const segment = cmd.slice(from, to);
    const pathM =
      segment.match(/-Path\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i) ||
      segment.match(/^Set-Content\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
    const valueM = segment.match(/-Value\s+@(['"])\r?\n([\s\S]*)/i);

    if (!pathM || !valueM) {
      out.push(segment);
      cursor = to;
      continue;
    }

    const path = sanitizeSandboxPath((pathM[1] || pathM[2] || pathM[3] || "").trim());
    const quote = valueM[1];
    let body = valueM[2] ?? "";
    const term = new RegExp(`\\r?\\n${quote === "'" ? "'" : '"'}@\\s*$`);
    if (term.test(body)) {
      body = body.replace(term, "");
    } else {
      body = body.replace(new RegExp(`\\r?\\n?${quote === "'" ? "'" : '"'}@\\s*$`), "");
      log.info(`salvage incomplete PowerShell here-string → base64 write: ${path.slice(0, 80)}`);
    }

    if (!path) {
      out.push(segment);
      cursor = to;
      continue;
    }

    out.push(shellWriteCommand(path, body, "windows"));
    rewrote = true;
    cursor = to;
  }

  if (!rewrote) return null;
  if (cursor < cmd.length) out.push(cmd.slice(cursor));
  const joined = out.join("").replace(/\s*;\s*;/g, "; ").trim();
  log.info(`rewrite Set-Content here-string(s) → base64 WriteAllText (${starts.length} segment(s))`);
  return joined;
}

function shellEditCommand(
  path: string,
  oldS: string,
  newS: string,
  os: HostOs,
): string {
  const clean = sanitizeSandboxPath(path);
  if (os === "posix") {
    return (
      `python3 -c "from pathlib import Path; p=Path(${JSON.stringify(clean)}); ` +
      `c=p.read_text(encoding='utf-8'); old=${JSON.stringify(oldS)}; new=${JSON.stringify(newS)}; ` +
      `assert old in c, 'SEARCH text not found'; p.write_text(c.replace(old,new,1), encoding='utf-8'); print(f'updated {p}')"`
    );
  }
  return (
    `$p=${psSingleQuote(clean)}; $c=Get-Content -Raw -Path $p; ` +
    `$old=${psSingleQuote(oldS)}; $new=${psSingleQuote(newS)}; ` +
    `if($c -notlike '*'+$old+'*'){ Write-Error 'SEARCH text not found'; exit 1 }; ` +
    `$c=$c.Replace($old,$new); Set-Content -Path $p -Value $c -Encoding utf8 -NoNewline; ` +
    `Write-Output \"updated $p\"`
  );
}

/** When Cursor omits Write/StrReplace from the toolset, map edits onto Shell. */
export function rewriteMissingEditToolsToShell(
  parsed: ParseLike,
  tools: ToolDef[],
  mode: CursorMode,
  messages?: Message[] | null,
): ParseLike {
  if (mode !== "agent") return parsed;
  const shell = findShellToolCompat(tools);
  if (!shell) return parsed;
  const hasWrite = !!toolByName(tools, /^(Write|WriteFile|write_file)$/i);
  const hasEdit = !!toolByName(tools, /^(StrReplace|ApplyPatch|Edit|edit_file)$/i);
  if (hasWrite && hasEdit) return parsed;
  const os = hostOsFromMessages(messages);

  const out: ParsedToolCall[] = [];
  let changed = false;

  for (const tc of parsed.toolCalls ?? []) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      out.push(tc);
      continue;
    }
    const name = tc.function.name;

    if (!hasWrite && /^(Write|WriteFile|write_file)$/i.test(name)) {
      const path = sanitizeSandboxPath(
        String(args.path ?? args.target_file ?? args.file_path ?? "file.txt"),
      );
      const contents = String(args.contents ?? args.content ?? "");
      const cmd = shellWriteCommand(path, contents, os);
      log.info(`rewrite missing Write→Shell: ${path.slice(0, 80)} os=${os}`);
      out.push(makeCall(shell, { command: cmd, description: `Write ${path} via Shell (Write tool unavailable)` }));
      changed = true;
      continue;
    }

    if (!hasEdit && /^(StrReplace|ApplyPatch|Edit|edit_file)$/i.test(name)) {
      const path = sanitizeSandboxPath(
        String(args.path ?? args.target_file ?? args.file_path ?? "file.txt"),
      );
      const oldS = String(args.old_string ?? args.old_str ?? args.search ?? "");
      const newS = String(args.new_string ?? args.new_str ?? args.replace ?? "");
      const cmd = shellEditCommand(path, oldS, newS, os);
      log.info(`rewrite missing StrReplace→Shell: ${path.slice(0, 80)} os=${os}`);
      out.push(makeCall(shell, { command: cmd, description: `StrReplace ${path} via Shell (edit tool unavailable)` }));
      changed = true;
      continue;
    }

    out.push(tc);
  }

  // Salvage Write/StrReplace fences left in prose when those tools are not advertised
  if (!parsed.hasToolCalls || !out.length) {
    const text = parsed.textContent ?? "";
    if (!hasWrite) {
      const wm = text.match(/```(?:Write|WriteFile)\s*\r?\n([\s\S]*?)```/i);
      if (wm) {
        const body = wm[1]!;
        const path = sanitizeSandboxPath(
          body.match(/^path:\s*(.+)$/im)?.[1]?.trim() ||
            body.match(/^target_file:\s*(.+)$/im)?.[1]?.trim() ||
            "file.txt",
        );
        const afterHeader = body.replace(/^(?:path|target_file|contents|content):.*$/gim, "").replace(/^\s*\n/, "");
        const contents = afterHeader.trimEnd();
        const cmd = shellWriteCommand(path, contents, os);
        log.info(`salvage Write fence→Shell: ${path.slice(0, 80)}`);
        return {
          hasToolCalls: true,
          toolCalls: [makeCall(shell, { command: cmd, description: `Write ${path} via Shell` })],
          textContent: null,
        };
      }
    }
    if (!hasEdit) {
      const sm = text.match(/```(?:StrReplace|ApplyPatch|Edit)\s*\r?\n([\s\S]*?)```/i);
      if (sm) {
        const body = sm[1]!;
        const path = sanitizeSandboxPath(
          body.match(/^path:\s*(.+)$/im)?.[1]?.trim() ||
            body.match(/^target_file:\s*(.+)$/im)?.[1]?.trim() ||
            "file.txt",
        );
        const sr = body.match(/<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={5,}\s*\r?\n([\s\S]*?)\r?\n>{5,}\s*REPLACE/);
        if (sr) {
          const cmd = shellEditCommand(path, sr[1]!, sr[2]!, os);
          log.info(`salvage StrReplace fence→Shell: ${path.slice(0, 80)}`);
          return {
            hasToolCalls: true,
            toolCalls: [makeCall(shell, { command: cmd, description: `StrReplace ${path} via Shell` })],
            textContent: null,
          };
        }
      }
    }
  }

  if (!changed) return parsed;
  return { hasToolCalls: out.length > 0, toolCalls: out.slice(0, 1), textContent: null };
}

/** Strip Cursor-injected context so open/recent files are not mistaken for the ask. */
export function stripCursorContextNoise(text: string): string {
  return text
    .replace(/<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/gi, "\n")
    .replace(/<agent_transcripts>[\s\S]*?<\/agent_transcripts>/gi, "\n")
    .replace(/<agent_skills>[\s\S]*?<\/agent_skills>/gi, "\n")
    .replace(/<mcp_file_system>[\s\S]*?<\/mcp_file_system>/gi, "\n")
    .replace(/<manually_attached_skills>[\s\S]*?<\/manually_attached_skills>/gi, "\n")
    .replace(/Recently viewed files?:[\s\S]*?(?=\n\n|\n#|\nUser:|$)/gi, "\n")
    .replace(/Open files?:[\s\S]*?(?=\n\n|\n#|\nUser:|$)/gi, "\n")
    .replace(/Files that are currently open[\s\S]*?(?=\n\n|\n#|\nUser:|$)/gi, "\n");
}

/** Latest real user ask (not tool_response), with Cursor context noise removed. */
export function latestUserAsk(messages: Message[]): string {
  const users = messages.filter(
    (m) =>
      m.role === "user" &&
      !/<tool_response\b/i.test(getMessageContent(m)) &&
      !/\bcall_id\s*=/i.test(getMessageContent(m)),
  );
  if (!users.length) return "";
  return stripCursorContextNoise(getMessageContent(users[users.length - 1]!));
}

/** True when the latest ask is create/write oriented (not ambient open-file noise). */
export function isCreateIntent(ask: string): boolean {
  const q = ask.trim();
  if (!q) return false;
  return (
    /\b(?:create|write|scaffold|generate|implement|add|build|make)\b/i.test(q) &&
    (/\b[\w.-]+\.[A-Za-z0-9]+\b/.test(q) ||
      /\b(?:file|script|module|component|app|project)\b/i.test(q))
  );
}

/** Normalize alias tool names / arg keys on already-parsed native calls. */
export function normalizeCursorToolCalls(
  parsed: ParseLike,
  tools: ToolDef[],
  messages?: Message[] | null,
): ParseLike {
  if (!parsed.hasToolCalls || !parsed.toolCalls.length) return parsed;

  const workspaceRoot = extractWorkspaceRoot(messages);

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
        const cleaned = sanitizeSandboxPath(args.path.replace(/^(?:path|target_file):\s*/i, "").trim());
        if (cleaned !== args.path) {
          args.path = cleaned;
          localChanged = true;
        }
      }
      // Remove non-schema aliases that confuse validators once path is set
      if (args.path != null) {
        if ("target_file" in args) { delete args.target_file; localChanged = true; }
        if ("file_path" in args) { delete args.file_path; localChanged = true; }
        if ("filepath" in args) { delete args.filepath; localChanged = true; }
      }
    }
    // Write/StrReplace/Delete: never leave /mnt/data sandbox paths
    if (/^(Write|WriteFile|write_file|StrReplace|ApplyPatch|Edit|Delete|DeleteFile)$/i.test(name)) {
      for (const key of ["path", "target_file", "file_path", "filepath"] as const) {
        if (typeof args[key] === "string") {
          const cleaned = sanitizeSandboxPath(String(args[key]));
          if (cleaned !== args[key]) {
            args[key] = cleaned;
            localChanged = true;
          }
        }
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
    // ReadLints: coerce paths to a real string[], then absolutize relative entries
    if (/^ReadLints$/i.test(name)) {
      const normalized = normalizeReadLintsPaths(args.paths);
      if (normalized.length) {
        const next = workspaceRoot
          ? normalized.map((p) => absolutizePath(p, workspaceRoot))
          : normalized;
        if (JSON.stringify(next) !== JSON.stringify(args.paths)) {
          args.paths = next;
          localChanged = true;
          log.info(`ReadLints paths → ${String(next[0] ?? "").slice(0, 160)}`);
        }
      } else if (typeof args.paths === "string") {
        args.paths = [args.paths];
        localChanged = true;
      }
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
  messages?: Message[] | null,
): ParseLike {
  parsed = normalizeCursorToolCalls(parsed, tools, messages);
  parsed = rewriteMissingEditToolsToShell(parsed, tools, mode, messages);
  if (!parsed.hasToolCalls || !parsed.toolCalls.length) return parsed;

  const os = hostOsFromMessages(messages);
  const windowsLikely = os === "windows" || os === "unknown";

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
    let shellCmd = cmd.replace(/^(?:command|cmd|script)\s*:\s*/i, "").trim();
    if (shellCmd !== cmd) {
      log.info(`strip Shell command: label → ${shellCmd.slice(0, 80)}`);
      changed = true;
    }
    // Rewrite /mnt/data/... probes into relative workspace paths
    if (/\/mnt\/data/i.test(shellCmd)) {
      const rewrittenPath = shellCmd
        .replace(/\/mnt\/data\/+/gi, "")
        .replace(/\/mnt\/data/gi, ".");
      log.info(`rewrite Shell /mnt/data → workspace-relative: ${shellCmd.slice(0, 80)}`);
      shellCmd = rewrittenPath;
      changed = true;
    }
    if (windowsLikely && /\s&&\s/.test(shellCmd)) {
      const rewrittenCmd = shellCmd.replace(/\s&&\s/g, "; ");
      log.info(`rewrite Shell &&→; (PowerShell-safe): ${shellCmd.slice(0, 80)}`);
      shellCmd = rewrittenCmd;
      changed = true;
    }
    // Fragile PowerShell here-string writes → base64 WriteAllText
    const hereRewritten = rewritePowerShellHereStringWrites(shellCmd);
    if (hereRewritten) {
      shellCmd = hereRewritten;
      changed = true;
    }
    // Force string stdout for common PowerShell object pipelines (blank-capture fix)
    if (windowsLikely || /^(?:Get-|pwd|ls|dir|whoami|hostname|echo|Write-Output)\b/i.test(shellCmd)) {
      const hardened = hardenPowerShellStdout(shellCmd);
      if (hardened !== shellCmd) {
        log.info(`rewrite Shell Out-String: ${shellCmd.slice(0, 80)}`);
        shellCmd = hardened;
        changed = true;
      }
    }
    if (shellCmd !== cmd) {
      args.command = shellCmd;
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
      const readonly = isReadonlyShellCommand(shellCmd);
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
  const q = latestUserAsk(messages);
  // Tool results arrive as user-role <tool_response> — never treat those as new intents
  // or we re-force ReadFile forever after a failed read.
  if (!q || /\bInvalid arguments\b/i.test(q)) {
    return null;
  }
  // Broad explore / review prompts must NOT match ambient "Read tool" / "ReadFile"
  // wording that Cursor injects into user context — that caused Plan mode to force
  // a blind ReadFile (→ File not found) instead of Glob.
  if (
    /\b(review|fix plan|full.?spectrum|explore|audit|prepare a (?:fix )?plan|scan the (?:project|repo|codebase))\b/i.test(
      q,
    ) &&
    !/\b(?:use|emit|using|via)\s+(?:the\s+|a\s+)?(?:ReadFile|Read|Glob|Shell|rg|Grep)\b/i.test(q) &&
    !/\bEmit\s+(?:ReadFile|Read|Glob|Shell)\s+only\b/i.test(q)
  ) {
    return null;
  }
  // Prefer longer names first so ReadFile wins over Read, AwaitShell over Await, etc.
  const known =
    "ReadFile|ReadLints|AwaitShell|EditNotebook|TodoWrite|StrReplace|WebSearch|WebFetch|AskQuestion|SwitchMode|GenerateImage|GetMcpTools|CallMcpTool|FetchMcpResource|Subagent|Shell|Read|Grep|Glob|Write|Delete|Await|Bash|rg";
  // Strong forms only. Avoid bare `\bRead\s+tool\b` — Cursor Plan/Ask instructions
  // often mention "Read tool" / "ReadFile" as ambient catalog text and must not
  // force a blind README.md read on a real review request.
  const m =
    q.match(new RegExp(`\\b(?:use|emit|using|via)\\s+(?:the\\s+|a\\s+)?(${known})\\b`, "i")) ||
    q.match(new RegExp(`\\b(${known})\\s+fence\\b`, "i")) ||
    q.match(new RegExp(`\\bEmit\\s+(${known})\\s+only\\b`, "i"));
  if (m?.[1]) return m[1];
  // "X tool" is only an explicit probe when the user message is short (capability sweep).
  const toolOnly = q.match(new RegExp(`\\b(${known})\\s+tool\\b`, "i"));
  if (toolOnly && q.trim().length <= 160 && !/\b(review|explore|audit|plan for|fix plan)\b/i.test(q)) {
    return toolOnly[1];
  }
  return null;
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

  const q = latestUserAsk(messages);

  // Create/write intents: never force Read before discovery — that caused
  // File-not-found loops and "no write permission" give-ups.
  if (isCreateIntent(q) && /^(Read|ReadFile)$/i.test(want)) {
    log.info("skip explicit Read enforce (create/write intent takes priority)");
    return parsed;
  }
  // Cursor BYOK often omits Write — don't force a missing Write tool.
  if (/^Write$/i.test(want) && !toolByName(tools, /^(Write|WriteFile|write_file)$/i)) {
    log.info("skip explicit Write enforce (Write tool not in Cursor toolset — use Shell)");
    return parsed;
  }

  // Never force a blind ReadFile/README.md without a concrete path.
  if (
    /^(Read|ReadFile)$/i.test(want) &&
    !/\b(?:path|target_file)\s*[:=]/i.test(q) &&
    !/\b[A-Za-z0-9_./\\-]+\.(?:json|md|ts|tsx|js|jsx|py|go|rs|yml|yaml|toml)\b/.test(q)
  ) {
    log.info(`skip explicit-tool enforce ${want} (no concrete path — Glob instead)`);
    return parsed;
  }

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

/** True when the latest user turn is a failed Cursor tool_response (e.g. File not found). */
export function latestToolResponseFailed(messages: Message[]): boolean {
  const last = [...messages].reverse().find((m) => {
    const c = getMessageContent(m);
    return m.role === "tool" || (m.role === "user" && /<tool_response\b/i.test(c));
  });
  if (!last) return false;
  const c = getMessageContent(last);
  return (
    /Error:\s*File not found/i.test(c) ||
    /File not found/i.test(c) ||
    /no such file/i.test(c) ||
    /cannot find path/i.test(c) ||
    /does not exist/i.test(c) ||
    /Invalid arguments/i.test(c)
  );
}

/** True if a Glob tool already ran in this conversation (avoid re-Glob loops). */
export function globAlreadyRan(messages: Message[]): boolean {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => /^(Glob|file_search|FileSearch)$/i.test(tc.function.name)),
  );
}

/** Collect paths already read successfully in this conversation. */
function pathsAlreadyRead(messages: Message[]): Set<string> {
  const read = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!/^(ReadFile|Read|read_file)$/i.test(tc.function.name)) continue;
        try {
          const args = JSON.parse(tc.function.arguments || "{}");
          const p = sanitizeSandboxPath(String(args.path || args.target_file || ""));
          if (p) read.add(p.toLowerCase());
        } catch {
          /* ignore malformed args */
        }
      }
    }
    const c = getMessageContent(m);
    if (!(m.role === "tool" || (m.role === "user" && /<tool_response\b/i.test(c)))) continue;
    if (!/tool="(?:ReadFile|Read|read_file)"/i.test(c)) continue;
    if (/Error:\s*File not found|no such file|does not exist/i.test(c)) continue;
    const header = c.match(/\bpath[=:]\s*([^\s<>"']+)/i)?.[1];
    if (header) read.add(sanitizeSandboxPath(header).toLowerCase());
  }
  return read;
}

/** True if ReadFile/Read already ran (optionally for a specific path). */
export function readAlreadyRan(messages: Message[], pathHint?: string): boolean {
  const read = pathsAlreadyRead(messages);
  if (!pathHint) return read.size > 0;
  const hint = sanitizeSandboxPath(pathHint).toLowerCase();
  return [...read].some(
    (p) => p === hint || p.endsWith(`/${hint}`) || hint.endsWith(`/${p}`) || p.endsWith(hint),
  );
}

/** Next source file to read after architecture.md — skip paths already read. */
const PHASE_ONE_READ_CANDIDATES = [
  "backend/main.py",
  "main.py",
  "test_phase.py",
  "tests/test_phase.py",
  "src/main.py",
  "app/main.py",
  "package.json",
  "README.md",
  "requirements.txt",
  "pyproject.toml",
  "docker-compose.yml",
];

export function nextExploreReadPath(messages: Message[], skipPath?: string | null): string | null {
  const read = pathsAlreadyRead(messages);
  const skip = skipPath ? sanitizeSandboxPath(skipPath).toLowerCase() : null;
  for (const candidate of PHASE_ONE_READ_CANDIDATES) {
    const norm = candidate.toLowerCase();
    if (skip && (norm === skip || norm.endsWith(`/${skip}`))) continue;
    if ([...read].some((p) => p === norm || p.endsWith(`/${norm}`))) continue;
    return candidate;
  }
  return null;
}

/** Pull a concrete doc path from the latest user ask (e.g. architecture.md). */
export function requestedDocPath(messages: Message[]): string | null {
  const q = latestUserAsk(messages);
  const m =
    q.match(/\b([A-Za-z0-9_./\\-]*architecture\.md)\b/i) ||
    q.match(/\b(?:read|open|assess|verify|audit)\s+[`"']?([^\s`"']+\.[A-Za-z0-9]+)[`"']?/i) ||
    q.match(/\b([A-Za-z0-9_./\\-]+\.(?:md|ts|tsx|json|py))\b/i);
  return m?.[1] ? sanitizeSandboxPath(m[1]) : null;
}

export function shouldBootstrapCursor(
  tools: ToolDef[] | undefined,
  messages: Message[],
  parsed: ParseLike,
  everActed: boolean,
): boolean {
  if (parsed.hasToolCalls || !tools?.length || !isCursorRequest(tools)) return false;

  const stalled =
    looksLikeConfabulation(parsed.textContent) ||
    looksLikeStalledAgentProse(parsed.textContent) ||
    looksLikePartialAccessConfab(parsed.textContent);

  // After a failed ReadFile, recover with Glob even if a tool already ran.
  const recover =
    latestToolResponseFailed(messages) && looksLikeConfabulation(parsed.textContent);

  // Mid-loop: Glob succeeded but M365 confabbed or returned status-only prose —
  // must bootstrap the next real tool (Read architecture.md), not die as text.
  if (everActed) {
    if (recover || stalled) return true;
    return false;
  }

  if (stalled) return true;
  if (recover) return true;
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

  const q = latestUserAsk(messages);
  const create = isCreateIntent(q);
  const confab = looksLikeConfabulation(prose);
  const partialAccess = looksLikePartialAccessConfab(prose);
  const doc = requestedDocPath(messages) ?? "architecture.md";

  // After Glob + confab/stall: read the doc the user named — never re-Glob.
  // After Read architecture.md + partial-access confab: read the next source file.
  if (confab || partialAccess || latestToolResponseFailed(messages) || looksLikeStalledAgentProse(prose)) {
    if (globAlreadyRan(messages)) {
      const archRead =
        readAlreadyRan(messages, doc) ||
        readAlreadyRan(messages, "architecture.md") ||
        readAlreadyRan(messages);
      if (archRead && (partialAccess || confab) && read) {
        const next = nextExploreReadPath(messages, doc);
        if (next) {
          log.info(`bootstrap Read ${next} after architecture+partial-access confab`);
          return makeCall(read, { path: next });
        }
        if (grep) {
          log.info("bootstrap Grep source scan after architecture+partial-access confab");
          return makeCall(grep, {
            pattern: "Phase 1|def main|class |import ",
            glob: "**/*.{py,ts,tsx,js,json,md}",
          });
        }
      }
      if (doc && read && !archRead) {
        log.info(`bootstrap Read ${doc} after Glob+confab/stall`);
        return makeCall(read, { path: doc });
      }
      if (grep && /phase|architecture|requirement|Code7/i.test(q + (prose ?? ""))) {
        log.info("bootstrap Grep Phase/architecture after Glob+confab");
        return makeCall(grep, { pattern: "Phase 1|architecture|Code7", glob: "**/*.{md,ts,tsx,js,py,json}" });
      }
      if (read && doc) {
        return makeCall(read, { path: doc });
      }
    }
    if (
      glob &&
      !globAlreadyRan(messages) &&
      (mode === "plan" || mode === "ask" || !create || /review|explore|audit|plan|project|repo|codebase/i.test(q + (prose ?? "")))
    ) {
      log.info(`bootstrap Glob recovery mode=${mode} after failure/confab`);
      return makeCall(glob, { glob_pattern: "**/*" });
    }
    if (doc && read) {
      log.info(`bootstrap Read ${doc} on confab (no prior Glob)`);
      return makeCall(read, { path: doc });
    }
    if (partialAccess && read && readAlreadyRan(messages)) {
      const next = nextExploreReadPath(messages, doc);
      if (next) {
        log.info(`bootstrap Read ${next} after partial-access confab`);
        return makeCall(read, { path: next });
      }
    }
  }

  // Legacy path kept for non-confab first-turn bootstraps
  if (
    glob &&
    latestToolResponseFailed(messages) &&
    (mode === "plan" || mode === "ask" || !create || /review|explore|audit|plan|project|repo|codebase/i.test(q + (prose ?? "")))
  ) {
    if (!globAlreadyRan(messages)) {
      log.info(`bootstrap Glob recovery mode=${mode} after failure`);
      return makeCall(glob, { glob_pattern: "**/*" });
    }
  }

  const explicit = explicitCursorToolRequest(messages);
  if (explicit) {
    // Don't bootstrap a blind Read without a concrete path — Glob first.
    // Also skip forcing Write when the toolset omitted it (Shell salvage handles that).
    if (
      /^(Read|ReadFile)$/i.test(explicit) &&
      !/\b(?:path|target_file)\s*[:=]/i.test(q) &&
      !/\b[A-Za-z0-9_./\\-]+\.(?:json|md|ts|tsx|js|jsx|py|go|rs|yml|yaml|toml)\b/.test(q)
    ) {
      if (glob) {
        log.info(`bootstrap Glob instead of blind ${explicit} mode=${mode}`);
        return makeCall(glob, { glob_pattern: "**/*" });
      }
    }
    if (/^Write$/i.test(explicit) && !toolByName(tools, /^(Write|WriteFile|write_file)$/i)) {
      // Leave to force-prompt / model; don't invent file contents here.
      log.info("bootstrap skip missing Write — model must emit Shell write");
    } else {
      const call = synthesizeExplicitToolCall(tools, explicit, q);
      if (call) {
        log.info(`bootstrap explicit ${explicit}→${call.function.name} mode=${mode}`);
        return call;
      }
    }
  }

  // Shell / pwd before Glob so "run pwd" is not swallowed by explore heuristics
  if (shell && /\b(pwd|Shell tool|real shell|working directory|Get-Location|whoami|uname)\b/i.test(q)) {
    const raw = q.match(/\b(pwd|whoami|uname(?:\s+-a)?)\b/i)?.[1] || (windows ? "Get-Location" : "pwd");
    const cmd = windows ? hardenPowerShellStdout(raw === "pwd" ? "Get-Location" : raw) : raw;
    log.info(`bootstrap Shell cmd=${cmd} mode=${mode}`);
    return makeCall(shell, { command: cmd, description: "User-requested shell inspect" });
  }

  // Create intents: discover first (Glob/Shell list). Do not invent file bodies.
  if (create && mode === "agent") {
    if (glob) {
      log.info("bootstrap Glob mode=agent create-intent");
      return makeCall(glob, { glob_pattern: "**/*" });
    }
    if (shell) {
      return makeCall(shell, {
        command: windows ? hardenPowerShellStdout("Get-ChildItem -Force") : "ls -la",
        description: "List workspace before creating files",
      });
    }
  }

  const readPath =
    !create
      ? q.match(/\b(?:read|open|show|cat)\s+[`"']?([^\s`"']+\.[A-Za-z0-9]+)[`"']?/i)?.[1] ||
        q.match(/\b([A-Za-z0-9_./-]+\.(?:json|md|ts|tsx|js|jsx|py|go|rs|yml|yaml|toml))\b/)?.[1]
      : undefined;

  if (readPath && read) {
    log.info(`bootstrap Read path=${sanitizeSandboxPath(readPath)} mode=${mode}`);
    return makeCall(read, { path: sanitizeSandboxPath(readPath) });
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

  // Agent explore
  if (glob && /\b(list|scan|review|explore|files?|project|repo|codebase)\b/i.test(q + blob) && !/\b(Shell|pwd)\b/i.test(q)) {
    log.info(`bootstrap Glob mode=agent`);
    return makeCall(glob, { glob_pattern: "**/*" });
  }
  if (shell) {
    log.info(`bootstrap Shell mode=agent windows=${windows}`);
    return makeCall(shell, {
      command: windows ? hardenPowerShellStdout("Get-ChildItem -Force") : "ls -la",
      description: "List workspace files so the agent can inspect the project",
    });
  }
  if (glob) return makeCall(glob, { glob_pattern: "**/*" });
  if (read) return makeCall(read, { path: "package.json" });
  return null;
}

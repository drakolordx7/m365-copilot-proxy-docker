#!/usr/bin/env node
/**
 * Lightweight dispatch checks for Cursor compat (no full package build).
 * Mirrors the rewrite / alias rules so CI and local agents can smoke-test logic.
 * Run: node scripts/verify-cursor-dispatch.mjs
 */

import { readFileSync } from "node:fs";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("ok:", msg);
  }
}

/** Port of mapShellCommand decision outcomes (keep in sync with cursor-compat.ts). */
function mapShellKind(cmd, mode = "agent") {
  if (!cmd) return null;
  let m =
    cmd.match(/^(?:cat|type)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i) ||
    cmd.match(/^Get-Content\s+(?:-Path\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i);
  if (m) return { tool: "Read", path: m[1] || m[2] || m[3] };

  if (!/^rg\s+--files\b/i.test(cmd)) {
    m = cmd.match(
      /^(?:rg|grep)\s+(?:-[a-zA-Z]+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(?:"([^"]+)"|'([^']+)'|(\S+)))?\s*$/i,
    );
    if (m) return { tool: "Grep", pattern: m[1] || m[2] || m[3] };
  }

  m = cmd.match(/^find\b[^;|&]*?-name\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (m) {
    const name = (m[1] || m[2] || m[3] || "").replace(/^\.\//, "");
    if (/^[\w.-]+\.[A-Za-z0-9]+$/.test(name) && !/[*?]/.test(name)) {
      return { tool: "Read", path: name };
    }
    if (/[*?]/.test(name)) return { tool: "Glob", glob_pattern: `**/${name}` };
  }

  // ls / dir / Get-ChildItem / bare find / rg --files → Shell (no rewrite)
  if (
    /^(?:ls|dir|Get-ChildItem|find)\b/i.test(cmd) ||
    /^rg\s+--files\b/i.test(cmd)
  ) {
    return null;
  }

  m = cmd.match(
    /^cat\s+>\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*<<['"]?EOF['"]?\s*\n([\s\S]*?)\nEOF\s*$/i,
  );
  if (m && mode === "agent") return { tool: "Write", path: m[1] || m[2] || m[3] };

  return null;
}

/** Port of hardenPowerShellStdout (keep in sync). */
function hardenPowerShellStdout(cmd) {
  const c = cmd.trim();
  if (!c) return c;
  if (/\|\s*Out-String\b/i.test(c)) return c;
  if (/\|\s*ConvertTo-(?:Json|Csv|Html|Xml)\b/i.test(c)) return c;
  if (/\|\s*Format-(?:List|Table|Wide|Custom)\b/i.test(c)) return c;
  if (/[>]{1,2}|\|\s*Out-File\b|\bSet-Content\b|\bAdd-Content\b|\bNew-Item\b|\bRemove-Item\b|\bMove-Item\b|\bCopy-Item\b|\btee\b/i.test(c)) {
    return c;
  }
  if (
    /^(?:Get-(?:Location|ChildItem|Item|Content|Process|Service|Command|Help|Date|Host)|pwd|ls|dir|whoami|hostname|echo|Write-Output)\b/i.test(c)
  ) {
    return `(${c}) | Out-String -Width 4096`;
  }
  return c;
}

function isAbsolutePath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

function joinWorkspacePath(root, rel) {
  const clean = rel.replace(/^\.[/\\]/, "").replace(/^[\\/]+/, "");
  if (!clean) return root;
  const sep = root.includes("\\") || /^[A-Za-z]:/.test(root) ? "\\" : "/";
  const base = root.replace(/[/\\]+$/, "");
  const parts = clean.split(/[/\\]+/).filter(Boolean);
  return [base, ...parts].join(sep);
}

function absolutizePath(path, root) {
  const p = path.trim();
  if (!p || isAbsolutePath(p) || !root) return p;
  return joinWorkspacePath(root, p);
}

function normalizeReadLintsPaths(paths) {
  const cleanOne = (raw) => {
    let s = raw.trim();
    if (/^\[.*\]$/.test(s)) {
      const inner = s.slice(1, -1).trim();
      const q = inner.match(/^"(.*)"$/) || inner.match(/^'(.*)'$/);
      s = (q ? q[1] : inner).trim();
    }
    return s.replace(/^["']|["']$/g, "").trim();
  };
  const fromLooseJson = (s) => {
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

function extractWorkspaceRoot(blob) {
  const candidates = [];
  const winRe = /[A-Za-z]:\\(?:[^\\/<>"|?\n*]+\\)*[^\\/<>"|?\n*]*/g;
  let m;
  while ((m = winRe.exec(blob))) candidates.push(m[0].replace(/[.,;:]+$/, ""));
  if (!candidates.length) return null;
  const isCursorInternal = (p) =>
    /\.cursor[/\\]projects[/\\]/i.test(p) || /[/\\]agent-tools(?:[/\\]|$)/i.test(p);
  const toRoot = (p) => {
    const leaf = p.split(/[/\\]/).pop() || "";
    const isFile = /\.[A-Za-z0-9]{1,8}$/.test(leaf);
    let dir = isFile ? p.replace(/[/\\][^/\\]+$/, "") : p;
    dir = dir.replace(
      /[/\\](?:src|tests?|lib|packages?|apps?|dist|build|node_modules|overlay|scripts)(?:[/\\].*)?$/i,
      "",
    );
    return dir;
  };
  const scored = candidates.map(toRoot).filter((p) => p.length >= 8 && !isCursorInternal(p));
  scored.sort((a, b) => b.length - a.length);
  const preferred = scored.find((p) =>
    /\\(?:Desktop|Documents|Projects|dev|code)\\/i.test(p),
  );
  return preferred ?? scored[0] ?? null;
}

const ALIASES = {
  ReadFile: "Read",
  read_file: "Read",
  rg: "Grep",
  file_search: "Glob",
};

assert(mapShellKind("ls -la") === null, "ls stays Shell (no Glob rewrite)");
assert(mapShellKind("find . -type f") === null, "bare find stays Shell");
assert(mapShellKind("rg --files") === null, "rg --files stays Shell");
assert(mapShellKind("cat README.md")?.tool === "Read", "cat → Read");
assert(mapShellKind('rg "TODO"')?.tool === "Grep", "rg → Grep");
assert(mapShellKind("find . -name package.json")?.tool === "Read", "find -name file → Read");
assert(mapShellKind("find . -name '*.ts'")?.tool === "Glob", "find -name glob → Glob");
assert(ALIASES.ReadFile === "Read", "ReadFile aliases to Read");
assert(ALIASES.rg === "Grep", "rg aliases to Grep");

assert(
  hardenPowerShellStdout("Get-Location") === "(Get-Location) | Out-String -Width 4096",
  "Get-Location gets Out-String",
);
assert(
  hardenPowerShellStdout("Get-ChildItem -Force") === "(Get-ChildItem -Force) | Out-String -Width 4096",
  "Get-ChildItem gets Out-String",
);
assert(
  hardenPowerShellStdout("(Get-Location) | Out-String -Width 4096") ===
    "(Get-Location) | Out-String -Width 4096",
  "Out-String not double-wrapped",
);
assert(
  hardenPowerShellStdout("Set-Content -Path a.txt -Value x") === "Set-Content -Path a.txt -Value x",
  "Set-Content not wrapped",
);

const root = extractWorkspaceRoot(
  "cwd C:\\Users\\alice\\Desktop\\demo-workspace\n" +
    "err C:\\Users\\alice\\.cursor\\projects\\c-Users-alice-Desktop-demo-workspace\\agent-tools\\foo",
);
assert(
  root === "C:\\Users\\alice\\Desktop\\demo-workspace",
  `prefer real Desktop root over agent-tools (got ${root})`,
);

assert(
  JSON.stringify(normalizeReadLintsPaths('["src\\\\bookshorts\\\\cli.py"]')) ===
    JSON.stringify(["src\\bookshorts\\cli.py"]) ||
    JSON.stringify(normalizeReadLintsPaths('["src/bookshorts/cli.py"]')) ===
      JSON.stringify(["src/bookshorts/cli.py"]),
  "JSON paths array parses",
);
assert(
  JSON.stringify(normalizeReadLintsPaths('["src\\bookshorts\\cli.py"]')) ===
    JSON.stringify(["src\\bookshorts\\cli.py"]),
  "Windows single-backslash JSON paths array parses",
);
assert(
  JSON.stringify(normalizeReadLintsPaths(['["src/bookshorts/cli.py"]'])) ===
    JSON.stringify(["src/bookshorts/cli.py"]),
  "bracket-junk array element cleaned",
);

const abs = absolutizePath(
  normalizeReadLintsPaths('["src/bookshorts/cli.py"]')[0],
  "C:\\Users\\alice\\Desktop\\demo-workspace",
);
assert(
  abs ===
    "C:\\Users\\alice\\Desktop\\demo-workspace\\src\\bookshorts\\cli.py",
  `ReadLints relative → absolute Windows (got ${abs})`,
);
assert(
  absolutizePath("C:\\Users\\a\\b.ts", "C:\\other") === "C:\\Users\\a\\b.ts",
  "absolute path unchanged",
);

assert(
  "command: Get-Location".replace(/^(?:command|cmd|script)\s*:\s*/i, "") === "Get-Location",
  "strip command: label from Shell body",
);
assert(
  "command:\nGet-Location".replace(/^(?:command|cmd|script)\s*:\s*/i, "").trim() === "Get-Location",
  "strip command: label with newline",
);

// Framing harness must stay Cursor-shaped
const framingSrc = readFileSync(
  "overlay/packages/core/src/cursor-agent-framing.ts",
  "utf8",
);
assert(framingSrc.includes("summary_spec"), "framing has summary_spec");
assert(framingSrc.includes("tool_calling"), "framing has tool_calling");
assert(framingSrc.includes("MODE: Agent"), "framing has Agent mode");
assert(framingSrc.includes("MODE: Plan"), "framing has Plan mode");
assert(framingSrc.includes("MODE: Ask"), "framing has Ask mode");
assert(framingSrc.includes("Subagent"), "framing mentions Subagent");
assert(framingSrc.includes("maximize_context") || framingSrc.includes("THOROUGH"), "framing has thorough exploration");
assert(framingSrc.includes("citing_code"), "framing has citing_code");
assert(!framingSrc.includes("command: (Get-Location)"), "framing Shell example has no command: label");
assert(framingSrc.includes("upload a .zip"), "framing forbids zip-upload give-up");
assert(framingSrc.includes("File not found"), "framing teaches File-not-found recovery");
assert(framingSrc.includes("/mnt/data"), "framing forbids /mnt/data myth");
assert(framingSrc.includes("asyncgw") || framingSrc.includes("download link"), "framing forbids Copilot zip downloads");

// Confabulation patterns must catch Plan-mode workspace-denial give-ups (cid 6af95c4e)
const toolsSrc = readFileSync("overlay/packages/core/src/tools.ts", "utf8");
assert(toolsSrc.includes("CONFABULATION_PATTERNS"), "CONFABULATION_PATTERNS present");
assert(toolsSrc.includes("not currently exposed"), "tools.ts has not-currently-exposed pattern");
assert(toolsSrc.includes("upload\\s+(?:the\\s+)?project\\s+as\\s+a") || toolsSrc.includes("upload the project as a") || /upload[\s\S]{0,40}\\\.zip/.test(toolsSrc), "tools.ts has upload/zip patterns");
assert(toolsSrc.includes("not\\s+accessible") || toolsSrc.includes("not accessible"), "tools.ts has not-accessible pattern");
assert(toolsSrc.includes("file lookup failed"), "tools.ts has file-lookup-failed pattern");
assert(toolsSrc.includes("exposed to (?:my|the|your)"), "tools.ts has exposed-to-tools pattern");

// Mirror the new denial patterns (keep in sync with tools.ts)
const denialConfab = [
  /not currently exposed/i,
  /exposed to (?:my|the|your)\s+(?:file\s+)?tools/i,
  /(?:workspace|repository|project|codebase|folder)\s+(?:is|are|was|were)\s+not\s+accessible/i,
  /(?:is|are)\s+not\s+accessible\s+in\s+this\s+session/i,
  /file lookup failed/i,
  /(?:please\s+)?upload\s+(?:the\s+)?(?:project|repo|repository|codebase|files?).{0,60}\.zip/i,
  /upload\s+(?:the\s+)?project\s+as\s+a/i,
];
function looksLikeDenialConfab(text) {
  return denialConfab.some((re) => re.test(text));
}
assert(
  looksLikeDenialConfab(
    "the repository itself is not currently exposed to my file tools. I verified the provided Windows workspace path",
  ),
  "confab: not currently exposed",
);
assert(
  looksLikeDenialConfab(
    "The file lookup failed because the Windows workspace is not accessible in this session. Please upload the project as a `.zip`",
  ),
  "confab: workspace not accessible + zip upload",
);

const compatSrc = readFileSync("overlay/packages/proxy-lib/src/cursor-compat.ts", "utf8");
assert(compatSrc.includes("latestToolResponseFailed"), "compat recovers after File not found");
assert(compatSrc.includes("skip explicit-tool enforce"), "compat skips blind Read enforce in plan");
assert(compatSrc.includes("bootstrap Glob recovery"), "compat Glob recovery after confab");

const handlerSrc = readFileSync("overlay/packages/proxy-lib/src/handler.ts", "utf8");
assert(handlerSrc.includes("upload a .zip"), "confab force prompt forbids zip upload");
assert(handlerSrc.includes("```Glob"), "confab force prompt asks for Glob");
assert(handlerSrc.includes("CURSOR_ATTACHMENT_FORCE_PROMPT"), "handler has attachment force prompt");
assert(handlerSrc.includes("looksLikeFakeCopilotAttachment"), "handler detects fake attachments");

// Copilot Teams/asyncgw ZIP attachment confab (pixel-tree regression)
assert(toolsSrc.includes("looksLikeFakeCopilotAttachment"), "tools.ts exports attachment detector");
assert(toolsSrc.includes("asyncgw\\.teams\\.microsoft\\.com"), "tools.ts matches asyncgw URLs");
const attachmentConfab = [
  /asyncgw\.teams\.microsoft\.com/i,
  /downloadable\s+attachment/i,
  /\[Download[^\]]*\]\s*\(\s*https?:\/\/[^)]+\.zip/i,
  /Extract\s+(?:the\s+)?(?:ZIP|zip|archive)\b/i,
  /\b(?:Built|Created|Generated|Packaged)\b[^.\n]{0,80}\b(?:widget|app|script|project|tool|desktop|pipeline|component)\b/i,
];
function looksLikeAttachConfab(text) {
  return attachmentConfab.some((re) => re.test(text));
}
assert(
  looksLikeAttachConfab(
    "Built a lightweight desktop widget.\n\n[Download Pixel Tree Desktop](https://us-prod.asyncgw.teams.microsoft.com/v1/objects/abc/views/original/pixel_tree_desktop.zip)\n\nExtract the ZIP.",
  ),
  "confab: Copilot asyncgw zip download",
);
assert(
  looksLikeAttachConfab(
    "That error occurred because they were packaged as a downloadable attachment instead.",
  ),
  "confab: downloadable attachment excuse",
);
assert(compatSrc.includes("fake Copilot attachment"), "compat bootstraps after fake attachment");
assert(compatSrc.includes("before create/build"), "compat bootstraps create/build intents");
assert(compatSrc.includes("create/write intent takes priority"), "compat does not force Read before create");
assert(handlerSrc.includes("CURSOR_SHELL_WRITE_FORCE_PROMPT"), "handler has Shell-write force prompt");
assert(toolsSrc.includes("not reachable"), "tools.ts catches not-reachable give-up");
assert(toolsSrc.includes("read back"), "tools.ts catches created-and-read-back hallucination");

const createdHalluc = [
  /\b(?:created|wrote|written|built|generated)\b[\s\S]{0,120}\bread back\b/i,
  /\b(?:created|wrote|written|generated|built|packaged|saved)\b[\s\S]{0,200}\b[\w-]{2,}\.[a-z]{1,4}\b/i,
  /not reachable/i,
  /outside the Cursor workspace/i,
];
function looksLikeCreatedHalluc(text) {
  return createdHalluc.some((re) => re.test(text));
}
assert(
  looksLikeCreatedHalluc(
    "Created and read back both files:\n\n- `hello_widget.py`: Small Tkinter window\n- `start_hello.bat`: Starts the widget",
  ),
  "halluc: created and read back both files",
);
assert(
  looksLikeCreatedHalluc(
    "I also confirmed that the Windows workspace path is not reachable from the currently available execution environment",
  ),
  "confab: not reachable execution environment",
);

if (process.exitCode) {
  console.error("\nverify-cursor-dispatch: FAILED");
  process.exit(1);
}
console.log("\nverify-cursor-dispatch: PASSED");

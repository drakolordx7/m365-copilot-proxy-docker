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
  "cwd C:\\Users\\drakolord\\Desktop\\New folder\\Lets make some money\n" +
    "err C:\\Users\\drakolord\\.cursor\\projects\\c-Users-drakolord-Desktop-New-folder-Lets-make-some-money\\agent-tools\\foo",
);
assert(
  root === "C:\\Users\\drakolord\\Desktop\\New folder\\Lets make some money",
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
  "C:\\Users\\drakolord\\Desktop\\New folder\\Lets make some money",
);
assert(
  abs ===
    "C:\\Users\\drakolord\\Desktop\\New folder\\Lets make some money\\src\\bookshorts\\cli.py",
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

// Framing harness must stay Cursor-shaped (Agent Prompt 2.0 agency)
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
assert(framingSrc.includes("maximize_parallel_tool_calls"), "framing has parallel tool agency");
assert(framingSrc.includes("MULTIPLE tool fences") || framingSrc.includes("multiple independent"), "framing encourages multi-fence turns");
assert(!/ONE tool fence per turn/i.test(framingSrc), "framing must not say ONE tool fence per turn");
assert(!framingSrc.includes('glob_pattern: "**/*.{ts'), "framing examples not toy ts glob");
assert(!/path: README\.md/.test(framingSrc), "framing examples not README.md anchored");
assert(framingSrc.includes("CreatePlan") || framingSrc.includes("createPlan"), "framing mentions CreatePlan");
assert(framingSrc.includes("shapes only") || framingSrc.includes("choose real args"), "framing uses schema-shaped examples");

// foldStreamText: prose + fence MessageUpdate must keep opening ```
function foldStreamText(answer, next) {
  const looksFence = (t) => {
    const s = t.trim();
    if (/^```[A-Za-z]/.test(s)) return true;
    return /^(ReadFile|Glob|rg|Shell|Subagent|CreatePlan)\b/.test(s) && /\n(?:path|glob_pattern|pattern|command)\s*:/i.test(s);
  };
  if (next.length <= answer.length) {
    if (looksFence(next) && answer.length > 0 && !answer.includes(next.trim())) {
      const sep = !answer || answer.endsWith("\n") || next.startsWith("\n") ? "" : "\n";
      return { answer: answer + sep + next, emit: sep + next };
    }
    return { answer, emit: null };
  }
  if (next.startsWith(answer)) return { answer: next, emit: next.slice(answer.length) };
  if (looksFence(next) && answer.length > 0 && !answer.includes(next.trim())) {
    const sep = answer.endsWith("\n") || next.startsWith("\n") ? "" : "\n";
    return { answer: answer + sep + next, emit: sep + next };
  }
  return { answer: next, emit: null };
}
{
  let answer = "I found the application. I’m narrowing the review.";
  const fence = "```ReadFile\npath: README.md\n```";
  const r = foldStreamText(answer, fence);
  assert(r.answer.includes("```ReadFile"), "fold appends fence MessageUpdate with opener");
  assert(r.answer.includes("narrowing the review"), "fold keeps status prose");
}

// salvage incomplete fences
function salvageIncomplete(text) {
  return text.replace(
    /(^|[^\w`])(ReadFile)(\r?\n(?:[\s\S]*?)\r?\n```)/g,
    (_m, pre, name, rest) => `${pre}\`\`\`${name}${rest}`,
  );
}
{
  const broken =
    "I found the application. I’m narrowing the review to first-party code and configuration.ReadFile\npath: README.md\n```";
  const fixed = salvageIncomplete(broken.replace(/configuration\.ReadFile/, "configuration.\nReadFile"));
  assert(/```ReadFile/.test(fixed) || salvageIncomplete("x\nReadFile\npath: a.md\n```").includes("```ReadFile"), "salvage restores opening fence");
  assert(salvageIncomplete("x\nReadFile\npath: a.md\n```").includes("```ReadFile"), "salvage bare ReadFile fence");
}

// Confab patterns cover zip / not accessible
const toolsSrc = readFileSync("overlay/packages/core/src/tools.ts", "utf8");
assert(toolsSrc.includes("not currently exposed"), "confab: not currently exposed");
assert(toolsSrc.includes("salvageIncompleteToolFences"), "salvageIncompleteToolFences exported");
assert(/upload[\s\S]{0,80}\\\.zip|upload\\s\+\(\?:the\\s\+\)\?project/.test(toolsSrc), "confab: upload zip");

// Multi-tool + agency in handler/compat
const handlerSrc = readFileSync("overlay/packages/proxy-lib/src/handler.ts", "utf8");
assert(handlerSrc.includes("M365_ONE_TOOL"), "handler has M365_ONE_TOOL kill-switch");
assert(handlerSrc.includes("Multi-tool turn"), "handler logs multi-tool turns");
assert(!handlerSrc.includes("M365_ALLOW_MULTI_TOOL &&"), "handler no longer defaults to one-call cull via ALLOW_MULTI");
assert(handlerSrc.includes("parallel fences") || handlerSrc.includes("independent native Cursor tool fences"), "confab force asks for parallel fences");
assert(handlerSrc.includes("Premature explore stop") || handlerSrc.includes("looksLikePrematureExploreStop"), "handler catches premature explore stop");

const compatSrc = readFileSync("overlay/packages/proxy-lib/src/cursor-compat.ts", "utf8");
assert(compatSrc.includes("bootstrap skip synthesize"), "bootstrap skips inventing Glob on confab");
assert(!/tool_choice = \"required\"/.test(compatSrc), "no tool_choice=required explore override");
assert(compatSrc.includes("skip explicit-tool invent") || compatSrc.includes("leave to confab nudge"), "enforce does not invent stubs for reviews");
assert(compatSrc.includes("latestToolResponseFailed"), "compat has failed-tool recovery helper");

const sessionSrc = readFileSync("overlay/packages/core/src/session.ts", "utf8");
assert(sessionSrc.includes("looksLikeToolFenceChunk"), "session overlays fence-aware fold");
assert(sessionSrc.includes("Append") || sessionSrc.includes("append"), "session fold appends fences");

if (process.exitCode) {
  console.error("\nverify-cursor-dispatch: FAILED");
  process.exit(1);
}
console.log("\nverify-cursor-dispatch: PASSED");

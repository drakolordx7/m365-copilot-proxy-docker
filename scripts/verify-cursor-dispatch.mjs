#!/usr/bin/env node
/**
 * Lightweight dispatch checks for Cursor compat (no full package build).
 * Mirrors the rewrite / alias / recovery rules so CI and local agents can smoke-test.
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

function sanitizeSandboxPath(path) {
  let p = String(path ?? "").trim();
  if (!p) return p;
  p = p.replace(/^\/mnt\/data\//i, "");
  p = p.replace(/^\/mnt\/data$/i, ".");
  p = p.replace(/^\/tmp\/(?:mnt\/)?data\//i, "");
  p = p.replace(/^\/home\/(?:ubuntu|user)\/(?:workspace|project)\//i, "");
  if (/^\/(?:mnt|tmp|var\/tmp)\//i.test(p)) {
    const leaf = p.split("/").filter(Boolean).slice(-2).join("/");
    return leaf || "file.txt";
  }
  return p;
}

function shellWriteCommand(path, contents, os = "windows") {
  const clean = sanitizeSandboxPath(path);
  const b64 = Buffer.from(contents, "utf8").toString("base64");
  if (os === "posix") {
    return (
      `python3 -c "import base64,pathlib; p=pathlib.Path(${JSON.stringify(clean)}); ` +
      `p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(base64.b64decode(${JSON.stringify(b64)}))" ` +
      `&& echo "wrote ${clean}"`
    );
  }
  return (
    `$p='${clean.replace(/'/g, "''")}'; $b='${b64}'; ` +
    `[IO.File]::WriteAllText($p,[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))); ` +
    `Write-Output \"wrote $p`
  );
}

function rewritePowerShellHereStringWrites(cmd) {
  if (!/\bSet-Content\b/i.test(cmd) || !/-Value\s+@['"]/i.test(cmd)) return null;
  const pathM =
    cmd.match(/-Path\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i) ||
    cmd.match(/^Set-Content\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const valueM = cmd.match(/-Value\s+@(['"])\r?\n([\s\S]*)/i);
  if (!pathM || !valueM) return null;
  const path = sanitizeSandboxPath((pathM[1] || pathM[2] || pathM[3] || "").trim());
  let body = valueM[2] ?? "";
  const quote = valueM[1];
  const term = new RegExp(`\\r?\\n${quote === "'" ? "'" : '"'}@\\s*$`);
  if (term.test(body)) body = body.replace(term, "");
  else body = body.replace(new RegExp(`\\r?\\n?${quote === "'" ? "'" : '"'}@\\s*$`), "");
  return shellWriteCommand(path, body, "windows");
}

function isPrematureWriteVerdict(text) {
  if (!text?.trim()) return false;
  return /^\s*PASS\.?\s*$/i.test(text.trim());
}

function isExplicitWriteTask(ask) {
  const q = ask.trim();
  if (!q) return false;
  if (/\bwrite\s+test\s+only\b/i.test(q)) return true;
  if (/\bStep\s+\d+[.:]\s*(?:Create|Write|Append)\b/i.test(q)) return true;
  if (
    /\b(?:create|write|append|save)\b/i.test(q) &&
    /(?:`|\s|^)(\.?[\w.-]+\.[A-Za-z0-9]{1,8})(?:`|\s|$)/i.test(q)
  ) {
    return true;
  }
  return (
    /\b(?:create|write|scaffold|generate|implement|add|build|make)\b/i.test(q) &&
    (/(?:`|\s|^)(\.?[\w.-]+\.[A-Za-z0-9]+)(?:`|\s|$)/.test(q) ||
      /\b(?:file|script|module|component|app|project)\b/i.test(q))
  );
}

function isCreateIntent(ask) {
  return isExplicitWriteTask(ask);
}

function classifyTurnIntent(ask, mode = "agent") {
  const q = ask.trim();
  if (!q) return mode === "agent" ? "explore" : "answer";
  if (isExplicitWriteTask(q) && !/\b(?:assess|verify|audit|evaluate|phase\s*\d|architecture)\b/i.test(q)) {
    return "create";
  }
  if (
    /\b(?:edit|fix|update|change|refactor|replace|patch|modify|append)\b/i.test(q) &&
    !/\b(?:assess|verify|audit|evaluate|phase\s*\d|architecture)\b/i.test(q)
  ) {
    return "edit";
  }
  if (
    /\b(?:assess|verify|audit|evaluate|re-?evaluate|phase\s*\d|architecture|quality|security|compliance|list|scan|review|explore|inspect|search|grep|find|plan|read|open|show)\b/i.test(q) ||
    (/(?:`|\s|^)(\.?[\w./\\-]+\.(?:md|ts|tsx|py|json))(?:`|\s|$)/i.test(q) &&
      !/\b(?:create|write|append|save)\b/i.test(q))
  ) {
    return "explore";
  }
  return mode === "plan" || mode === "ask" ? "explore" : "answer";
}

function requiresExploreFirst(ask) {
  const q = ask.trim();
  if (!q || isExplicitWriteTask(q)) return false;
  if (/\b(?:assess|verify|audit|evaluate|re-?evaluate|architecture|phase\s*\d|codebase|repo|project|implement|fix|refactor|review|inspect|explore|quality|security|compliance)\b/i.test(q)) {
    return true;
  }
  return (
    /(?:`|\s|^)(\.?[\w./\\-]+\.(?:md|ts|tsx|py|json|ya?ml))(?:`|\s|$)/i.test(q) &&
    !/\b(?:create|write|append|save)\b/i.test(q)
  );
}

function isNonsenseShellCommand(command) {
  const c = command.trim();
  if (!c || c.length < 3) return true;
  if (/^\$p\s*=/.test(c) && /,\s*\d+\+/.test(c)) return true;
  if (/\bwrote\s+[\w.-]+\.txt\b/i.test(c) && c.length < 160) return true;
  return false;
}

function stripCursorContextNoise(text) {
  return text
    .replace(/<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/gi, "\n")
    .replace(/Recently viewed files?:[\s\S]*?(?=\n\n|\n#|\nUser:|$)/gi, "\n");
}

function toolCapabilities(toolNames, os = "unknown") {
  const names = toolNames.map((n) => n.toLowerCase());
  const has = (re) => names.some((n) => re.test(n));
  return {
    hasWrite: has(/^(write|writefile|write_file)$/),
    hasEdit: has(/^(streplace|applypatch|edit|edit_file)$/),
    hasShell: has(/^(shell|bash)$/),
    hasGlob: has(/^(glob|file_search)$/),
    hasRead: has(/^(read|readfile)$/),
    os,
  };
}

function mutationForcePrompt(caps) {
  if (caps.hasWrite) {
    return "Emit ONE ```Write or ```StrReplace fence";
  }
  return "Write/StrReplace are not in this toolset. Emit ONE ```Shell fence";
}

function decideRecovery({ confab, claimedMutation, caps, hasToolCalls }) {
  if (hasToolCalls) return { kind: "none" };
  if (confab === "fake_delivery" || claimedMutation) {
    return { kind: "force", prompt: mutationForcePrompt(caps) };
  }
  if (confab) {
    return {
      kind: "force",
      prompt: caps.hasGlob
        ? "emit ONE ```Glob with glob_pattern: **/*"
        : "emit ONE listing Shell",
    };
  }
  return { kind: "none" };
}

// --- Basic shell rewrite ---
assert(mapShellKind("ls -la") === null, "ls stays Shell (no Glob rewrite)");
assert(mapShellKind("find . -type f") === null, "bare find stays Shell");
assert(mapShellKind("rg --files") === null, "rg --files stays Shell");
assert(mapShellKind("cat README.md")?.tool === "Read", "cat → Read");
assert(mapShellKind('rg "TODO"')?.tool === "Grep", "rg → Grep");
assert(mapShellKind("find . -name package.json")?.tool === "Read", "find -name file → Read");
assert(mapShellKind("find . -name '*.ts'")?.tool === "Glob", "find -name glob → Glob");

assert(
  hardenPowerShellStdout("Get-Location") === "(Get-Location) | Out-String -Width 4096",
  "Get-Location gets Out-String",
);
assert(
  hardenPowerShellStdout("Set-Content -Path a.txt -Value x") === "Set-Content -Path a.txt -Value x",
  "Set-Content not wrapped",
);

// --- Path sanitize / OS writes ---
assert(sanitizeSandboxPath("/mnt/data/hello.py") === "hello.py", "strip /mnt/data/");
assert(sanitizeSandboxPath("/mnt/data") === ".", "strip bare /mnt/data");
assert(sanitizeSandboxPath("src/app.ts") === "src/app.ts", "relative path unchanged");

const winWrite = shellWriteCommand("/mnt/data/note.txt", "hi", "windows");
assert(winWrite.includes("WriteAllText"), "windows write uses WriteAllText");
assert(winWrite.includes("note.txt"), "windows write uses sanitized path");
assert(!winWrite.includes("/mnt/data"), "windows write has no /mnt/data");

const posixWrite = shellWriteCommand("/mnt/data/note.txt", "hi", "posix");
assert(posixWrite.includes("python3"), "posix write uses python3");
assert(posixWrite.includes("note.txt"), "posix write uses sanitized path");

const here = rewritePowerShellHereStringWrites(
  "Set-Content -Path hello.py -Value @'\nprint('hi')\n'@",
);
assert(!!here && here.includes("WriteAllText"), "here-string → base64 WriteAllText");
assert(here.includes("hello.py"), "here-string rewrite keeps path");

// --- Intent / recovery policy ---
assert(isCreateIntent("create hello_widget.py and start_hello.bat"), "create intent detects filenames");
assert(!isCreateIntent("review the whole repo and propose a plan"), "explore is not create");
assert(
  classifyTurnIntent(
    "Assess architecture.md and verify all pertaining instructions to phase 1 are completed in full. Project Name: Code7",
  ) === "explore",
  "assess architecture.md → explore intent",
);
assert(
  requiresExploreFirst("Assess architecture.md and verify phase 1 for Code7"),
  "assess task requires explore first",
);
const writeSmokeAsk =
  "Write test only. Step 1: Create `.proxy-smoke-test.md` with exactly these lines. Step 2: ReadFile verify. Step 3: PASS or FAIL only.";
assert(isExplicitWriteTask(writeSmokeAsk), "explicit write task: proxy smoke test");
assert(!requiresExploreFirst(writeSmokeAsk), "write smoke test skips explore-first");
assert(isPrematureWriteVerdict("PASS"), "detect bare PASS verdict");
assert(!isPrematureWriteVerdict("Created and verified"), "PASS detector ignores mutation claims");
assert(
  extractMentionedFilePaths("Create `.proxy-smoke-test.md` in workspace")[0] === ".proxy-smoke-test.md",
  "extractMentionedFilePaths preserves dotfile",
);
assert(isNonsenseShellCommand("$p='Code7.txt', 4+"), "nonsense shell: Code7.txt junk");
assert(isNonsenseShellCommand("wrote Code7.txt"), "nonsense shell: trivial wrote txt");
assert(!isNonsenseShellCommand("Get-ChildItem -Force"), "readonly shell is not nonsense");
assert(
  stripCursorContextNoise(
    "<open_and_recently_viewed_files>\nhello_widget.py\n</open_and_recently_viewed_files>\n\nbuild a pixel tree",
  ).includes("pixel tree"),
  "strip open-files noise",
);
assert(
  !stripCursorContextNoise(
    "<open_and_recently_viewed_files>\nhello_widget.py\n</open_and_recently_viewed_files>\n\nbuild a pixel tree",
  ).includes("hello_widget"),
  "open-files names removed from ask",
);

const noWrite = toolCapabilities(["Shell", "ReadFile", "Glob", "rg"], "windows");
assert(!noWrite.hasWrite, "Cursor toolset often omits Write");
const force = decideRecovery({
  confab: null,
  claimedMutation: true,
  caps: noWrite,
  hasToolCalls: false,
});
assert(force.kind === "force", "claimed mutation forces retry");
assert(force.prompt.includes("Shell"), "force prompt uses Shell when Write missing");
assert(!force.prompt.includes("```Write"), "force prompt does not ask for missing Write");

const globForce = decideRecovery({
  confab: "access_denial",
  claimedMutation: false,
  caps: noWrite,
  hasToolCalls: false,
});
assert(globForce.prompt.includes("Glob"), "access denial forces Glob");

// --- Confab categories (mirror tools.ts) ---
const ACCESS_DENIAL = [
  /not currently exposed/i,
  /exposed to (?:my|the|your)\s+(?:file\s+)?tools/i,
  /(?:workspace|repository|project|codebase|folder)\s+(?:is|are|was|were)\s+not\s+accessible/i,
  /(?:is|are)\s+not\s+accessible\s+in\s+this\s+session/i,
  /file lookup failed/i,
  /(?:please\s+)?upload\s+(?:the\s+)?(?:project|repo|repository|codebase|files?).{0,60}\.zip/i,
  /upload\s+(?:the\s+)?project\s+as\s+a/i,
  /workspace-native\s+(?:reads?|edits?|tools?)/i,
  /exposed\s+tool\s+interface/i,
  /(?:will\s+not|won'?t)\s+(?:fabricate|invent)\b/i,
  /(?:workspace|file index).{0,80}cannot read or modify/i,
  /execution environment available in this chat/i,
  /visible to Cursor['']s file index/i,
  /no readable copy of the repository/i,
  /cannot safely (?:modify|edit|test|verify)/i,
  /cannot safely complete or claim/i,
  /(?:actual )?Cursor workspace is not mounted/i,
  /workspace is not mounted/i,
  /from this interface/i,
  /remaining source files still need/i,
  /need(?:s)? inspection, especially/i,
];
const PARTIAL_ACCESS = [
  /architecture\.md only/i,
  /no readable copy of the repository/i,
  /cannot safely modify or test the repository/i,
  /speculative replacement/i,
  /workspace operations attached/i,
  /Phase 1 cannot be marked complete/i,
];
const ACCESS_GIVE_UP = [
  /cannot safely complete or claim/i,
  /Cursor workspace is not mounted/i,
  /from this interface/i,
  /remaining source files still need/i,
  /need(?:s)? inspection, especially/i,
];
function looksLikePartialAccessConfab(text) {
  if (!text || text.trim().length < 80) return false;
  const t = text.trim();
  if (PARTIAL_ACCESS.some((re) => re.test(t))) return true;
  return ACCESS_DENIAL.some((re) => re.test(t)) && /architecture\.md/i.test(t);
}
function extractMentionedFilePaths(text) {
  if (!text) return [];
  const paths = [];
  const seen = new Set();
  const push = (raw) => {
    let p = raw.trim().replace(/^[`"'[\]()]+|[`"'[\])]+$/g, "");
    p = p.replace(/^\.(?:\/|\\)/, "").replace(/^[\\/]+/, "");
    if (p.length < 3) return;
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    paths.push(p);
  };
  for (const m of text.matchAll(/`([^`\n]+)`/g)) push(m[1]);
  for (const m of text.matchAll(/\b((?:[\w.-]+\/)+[\w.-]+\.\w+)\b/g)) push(m[1]);
  for (const m of text.matchAll(/(?:\s|^)(\.[\w.-]+\.[A-Za-z0-9]{1,8})\b/g)) push(m[1]);
  return paths;
}
function looksLikeAccessGiveUpProse(text) {
  if (!text || text.trim().length < 40) return false;
  const t = text.trim();
  if (looksLikePartialAccessConfab(t)) return true;
  if (ACCESS_GIVE_UP.some((re) => re.test(t))) return true;
  const mentioned = extractMentionedFilePaths(t);
  if (mentioned.length > 0 && t.length >= 60) {
    return /\b(?:however|cannot|not mounted|need(?:s)? inspection|remaining|from this interface)\b/i.test(t);
  }
  return false;
}
const SANDBOX_MYTH = [/\/mnt\/data/i, /isolated\s+Linux\s+container/i];
const FAKE_DELIVERY = [/asyncgw\.teams\.microsoft\.com/i, /downloadable\s+attachment/i];

function classify(text) {
  if (FAKE_DELIVERY.some((re) => re.test(text))) return "fake_delivery";
  if (SANDBOX_MYTH.some((re) => re.test(text))) return "sandbox_myth";
  if (ACCESS_DENIAL.some((re) => re.test(text))) return "access_denial";
  return null;
}

assert(
  classify(
    "the repository itself is not currently exposed to my file tools. I verified the provided Windows workspace path",
  ) === "access_denial",
  "confab: not currently exposed",
);
assert(
  classify(
    "The file lookup failed because the Windows workspace is not accessible in this session. Please upload the project as a `.zip`",
  ) === "access_denial",
  "confab: workspace not accessible + zip upload",
);
assert(
  classify("I cannot continue workspace-native edits from the currently exposed tool interface; I will not fabricate unread files.") ===
    "access_denial",
  "confab: workspace-native / will not fabricate",
);
assert(classify("wrote to /mnt/data/out.py") === "sandbox_myth", "confab: /mnt/data myth");
assert(
  classify("The workspace is visible to Cursor's file index, but the execution environment available in this chat still cannot read or modify those files") ===
    "access_denial",
  "confab: file index + cannot read or modify",
);
assert(
  classify(
    "Phase 1 cannot be marked complete. The accessible environment contains no readable copy of the repository other than architecture.md. I cannot safely modify or test the repository.",
  ) === "access_denial",
  "confab: partial-access Phase 1 blocked report",
);
assert(
  looksLikePartialAccessConfab(
    "Current result: no source edits or smoke tests. The accessible environment contains no readable copy of the repository other than a file named architecture.md. Applying speculative replacement files would risk overwriting the existing implementation. Needs Cursor workspace operations attached to C:\\Users\\drakolord\\Desktop\\New folder\\Test.",
  ),
  "partial-access confab after architecture read",
);
assert(
  looksLikeAccessGiveUpProse(
    "However, I cannot safely complete or claim the requested edits from this interface because the actual Cursor workspace is not mounted here. The remaining source files still need inspection, especially:\n\n- `frontend/app/page.tsx`",
  ),
  "access give-up: workspace not mounted + named path",
);
assert(
  extractMentionedFilePaths(
    "need inspection, especially:\n\n- `frontend/app/page.tsx`\n- backend/main.py",
  ).includes("frontend/app/page.tsx"),
  "extract paths from give-up prose",
);
assert(
  classify(
    "However, I cannot safely complete or claim the requested edits from this interface because the actual Cursor workspace is not mounted here.",
  ) === "access_denial",
  "confab: workspace not mounted",
);

const HALLUCINATED = [
  /\bCreated and verified\b/i,
  /\ball\s+(?:\d+\s+)?expected lines\b/i,
  /\bverified\s+[`"']?[\w./-]+\.(?:md|txt)\b/i,
];
function looksLikeHallucinatedCompletion(text) {
  if (!text || text.trim().length < 8) return false;
  return HALLUCINATED.some((re) => re.test(text.trim()));
}
assert(
  looksLikeHallucinatedCompletion(
    "Created and verified .proxy-smoke-test.md with all six expected lines, including write-ok, edit-ok, and multi-turn-ok.",
  ),
  "hallucination: created and verified without tool",
);
assert(
  extractMentionedFilePaths("Created and verified .proxy-smoke-test.md with all six expected lines.").some(
    (p) => p.includes("proxy-smoke-test.md"),
  ),
  "extract dotfile path from claim",
);

function looksLikeStalledAgentProse(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 320) return false;
  return /\blocating the project files now\b/i.test(t);
}
assert(looksLikeStalledAgentProse("I'm locating the project files now."), "stall: locating prose");

function globAlreadyRan(messages) {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => /^(Glob|file_search)$/i.test(tc.function.name)),
  );
}
assert(
  globAlreadyRan([{ role: "assistant", tool_calls: [{ function: { name: "Glob" } }] }]),
  "globAlreadyRan detects prior Glob",
);

const compatSrc = readFileSync("overlay/packages/proxy-lib/src/cursor-compat.ts", "utf8");
const framingSrc = readFileSync("overlay/packages/core/src/cursor-agent-framing.ts", "utf8");
const toolsSrc = readFileSync("overlay/packages/core/src/tools.ts", "utf8");
const handlerSrc = readFileSync("overlay/packages/proxy-lib/src/handler.ts", "utf8");
const orchSrc = readFileSync("overlay/packages/proxy-lib/src/orchestration.ts", "utf8");

assert(compatSrc.includes("globAlreadyRan"), "compat tracks prior Glob");
assert(compatSrc.includes("readAlreadyRan"), "compat tracks prior Read");
assert(compatSrc.includes("explorationAlreadyRan"), "compat tracks any exploration tool");
assert(compatSrc.includes("enforceExploreFirstPolicy"), "compat has explore-first tool gate");
assert(compatSrc.includes("isNonsenseShellCommand"), "compat detects nonsense shell");
assert(compatSrc.includes("mutationConfirmedForClaim"), "compat confirms mutations in-thread");
assert(compatSrc.includes("isUnconfirmedMutationClaim"), "compat detects unconfirmed claims");
assert(compatSrc.includes("synthesizeClaimedMutationBootstrap"), "compat bootstraps real writes");
assert(handlerSrc.includes("Last-chance mutation bootstrap"), "handler bootstraps claimed writes");
assert(toolsSrc.includes("Created and verified"), "tools detects verified-without-tool claims");
assert(compatSrc.includes("nextUnreadExplorePath"), "compat discovers next unread path dynamically");
assert(compatSrc.includes("extractMentionedFilePaths"), "compat extracts paths from give-up prose");
assert(compatSrc.includes("requestedDocPath"), "compat extracts requested doc path");
assert(compatSrc.includes("bootstrap Read"), "compat Read bootstrap after give-up");
assert(compatSrc.includes("access give-up"), "compat logs access give-up recovery");
assert(compatSrc.includes("looksLikeAccessGiveUpProse"), "compat detects access give-up");
assert(compatSrc.includes("looksLikeStalledAgentProse"), "compat detects stall prose");
assert(framingSrc.includes("not mounted"), "framing rejects workspace-not-mounted stop");
assert(framingSrc.includes("summary_spec"), "framing has summary_spec");
assert(framingSrc.includes("tool_calling"), "framing has tool_calling");
assert(framingSrc.includes("MODE: Agent"), "framing has Agent mode");
assert(framingSrc.includes("MODE: Plan"), "framing has Plan mode");
assert(framingSrc.includes("MODE: Ask"), "framing has Ask mode");
assert(framingSrc.includes("Write/StrReplace are NOT in this toolset"), "framing documents missing Write");
assert(framingSrc.includes("WriteAllText") || framingSrc.includes("base64"), "framing Shell write recipe is base64");
assert(framingSrc.includes("/mnt/data"), "framing forbids /mnt/data myth");
assert(framingSrc.includes("upload a .zip"), "framing forbids zip-upload give-up");

assert(toolsSrc.includes("classifyConfabulation"), "tools.ts has classifyConfabulation");
assert(toolsSrc.includes("looksLikeAccessGiveUpProse"), "tools.ts has access give-up detector");
assert(toolsSrc.includes("extractMentionedFilePaths"), "tools.ts extracts mentioned paths");
assert(toolsSrc.includes("looksLikePartialAccessConfab"), "tools.ts has partial-access confab detector");
assert(toolsSrc.includes("looksLikeFakeCopilotAttachment"), "tools.ts has fake attachment detector");
assert(toolsSrc.includes("not currently exposed"), "tools.ts has not-currently-exposed pattern");
assert(toolsSrc.includes("workspace-native"), "tools.ts has workspace-native category");

assert(
  classify("Download here: https://us-prod.asyncgw.teams.microsoft.com/v1/turn1file0.zip") ===
    "fake_delivery",
  "confab: fake Copilot attachment",
);

assert(compatSrc.includes("rewritePowerShellHereStringWrites"), "compat rewrites PS here-strings");
assert(compatSrc.includes("sanitizeSandboxPath"), "compat sanitizes sandbox paths");
assert(compatSrc.includes("shellWriteCommand"), "compat has OS-aware shellWriteCommand");
assert(compatSrc.includes("latestUserAsk"), "compat uses latestUserAsk");
assert(compatSrc.includes("isCreateIntent"), "compat has create-intent guard");
assert(compatSrc.includes("skip explicit Write enforce"), "compat skips missing Write enforce");
assert(compatSrc.includes("latestToolResponseFailed"), "compat recovers after File not found");
assert(orchSrc.includes("decideRecovery"), "orchestration owns recovery policy");
assert(orchSrc.includes("mutationForcePrompt"), "orchestration has capability-aware mutation prompt");
assert(orchSrc.includes("toolCapabilities"), "orchestration has toolCapabilities");
assert(handlerSrc.includes("decideRecovery"), "handler uses decideRecovery");
assert(handlerSrc.includes("classifyConfabulation"), "handler classifies confab");
assert(handlerSrc.includes("explorationAlreadyRan"), "handler skips force after exploration");
assert(handlerSrc.includes("looksLikeAccessGiveUpProse"), "handler detects access give-up");
assert(handlerSrc.includes("Last-chance bootstrap"), "handler last-chance bootstrap");
assert(orchSrc.includes("requiresExploreFirst"), "orchestration requires explore first");
assert(orchSrc.includes("isExplicitWriteTask"), "orchestration detects explicit write tasks");
assert(orchSrc.includes("assess"), "orchestration classifies assess intent");
assert(compatSrc.includes("isStructuredShellWrite"), "compat allows structured Shell writes");
assert(handlerSrc.includes("Last-chance write bootstrap"), "handler recovers PASS/FAIL on write task");
assert(compatSrc.includes("isPrematureWriteVerdict"), "compat detects premature PASS");
assert(compatSrc.includes("writeTaskTargetsPending"), "compat tracks pending write targets");
assert(compatSrc.includes("bootstrap Shell write for explicit write task"), "compat bootstraps write not Glob");
assert(handlerSrc.includes("enforceExploreFirstPolicy"), "handler enforces explore-first gate");
assert(toolsSrc.includes("keep dotfile names"), "tools.ts preserves dotfile paths");
assert(framingSrc.includes("assess/verify"), "framing mandates read before write on assess");
assert(handlerSrc.includes("latestUserAsk"), "handler fingerprints latest ask");
assert(!handlerSrc.includes("CURSOR_HALLUCINATION_FORCE_PROMPT"), "handler dropped hardcoded Write force");

if (process.exitCode) {
  console.error("\nverify-cursor-dispatch: FAILED");
  process.exit(1);
}
console.log("\nverify-cursor-dispatch: OK");

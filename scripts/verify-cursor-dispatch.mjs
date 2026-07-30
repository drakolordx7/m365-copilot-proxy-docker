#!/usr/bin/env node
/**
 * Lightweight dispatch checks for Cursor compat (no full package build).
 * Mirrors the rewrite / alias rules so CI and local agents can smoke-test logic.
 * Run: node scripts/verify-cursor-dispatch.mjs
 */

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

function extractWorkspaceRoot(blob) {
  const candidates = [];
  const winRe = /[A-Za-z]:\\(?:[^\\/<>"|?\n*]+\\)*[^\\/<>"|?\n*]*/g;
  let m;
  while ((m = winRe.exec(blob))) candidates.push(m[0].replace(/[.,;:]+$/, ""));
  if (!candidates.length) return null;
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
  const scored = candidates.map(toRoot).filter((p) => p.length >= 8);
  scored.sort((a, b) => b.length - a.length);
  const preferred = scored.find((p) =>
    /\\(?:Desktop|Documents|Projects|dev|code)\\/i.test(p),
  );
  return preferred ?? scored[0];
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
  "workspace at C:\\Users\\drakolord\\Desktop\\New folder\\Lets make some money\\src\\bookshorts\\cli.py",
);
assert(
  root === "C:\\Users\\drakolord\\Desktop\\New folder\\Lets make some money",
  `workspace root from file path (got ${root})`,
);
assert(
  absolutizePath("src\\bookshorts\\cli.py", "C:\\Users\\drakolord\\Desktop\\New folder\\Lets make some money") ===
    "C:\\Users\\drakolord\\Desktop\\New folder\\Lets make some money\\src\\bookshorts\\cli.py",
  "ReadLints relative → absolute Windows",
);
assert(
  absolutizePath("C:\\Users\\a\\b.ts", "C:\\other") === "C:\\Users\\a\\b.ts",
  "absolute path unchanged",
);

if (process.exitCode) {
  console.error("\nverify-cursor-dispatch: FAILED");
  process.exit(1);
}
console.log("\nverify-cursor-dispatch: PASSED");

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

if (process.exitCode) {
  console.error("\nverify-cursor-dispatch: FAILED");
  process.exit(1);
}
console.log("\nverify-cursor-dispatch: PASSED");

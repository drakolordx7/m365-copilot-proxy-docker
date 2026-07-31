/**
 * Provider-neutral Cursor/OpenAI orchestration boundary.
 *
 * M365 is a provider behind this boundary. Cursor owns tool execution,
 * conversation identity, and turn scheduling. Recovery/intent decisions live
 * here so handler/cursor-compat do not grow competing hard-coded loops.
 */

export type CursorMode = "ask" | "plan" | "agent";

export type TurnIntent = "explore" | "create" | "edit" | "recover" | "answer";

export type ConfabCategory =
  | "access_denial"
  | "fake_delivery"
  | "tools_vanished"
  | "sandbox_myth"
  | "empty_workspace"
  | null;

export type HostOs = "windows" | "posix" | "unknown";

export interface ConversationIdentity {
  /** Stable client-provided identifier when the client supplies one. */
  clientId: string;
  /** Authenticated caller namespace, when the deployment provides one. */
  principalId: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
  sequence: number;
}

export interface ConversationStateSnapshot {
  key: string;
  identity: ConversationIdentity;
  mode: CursorMode;
  revision: number;
  toolCalls: readonly ToolCallRecord[];
}

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "status"; text: string }
  | { type: "tool_call_batch"; calls: readonly ToolCallRecord[] }
  | { type: "done"; reason: "stop" | "tool_calls" | "length" }
  | { type: "error"; error: Error };

export interface ProviderTurnInput {
  conversationId: string;
  mode: CursorMode;
  messages: readonly unknown[];
  tools: readonly unknown[];
  signal?: AbortSignal;
}

/** Provider contract; M365-specific transport must stay behind this interface. */
export interface ModelProvider {
  startTurn(input: ProviderTurnInput): AsyncIterable<ProviderEvent>;
  cancel?(turnId: string): Promise<void>;
  reset?(conversationId: string): Promise<void>;
}

export interface ExecutionPolicy {
  /** Cursor executes advertised tools locally; the provider never executes them. */
  owner: "cursor" | "provider";
  mode: CursorMode;
  allowMutations: boolean;
  allowProviderActions: boolean;
  allowParallelToolCalls: boolean;
}

export interface ToolCapabilities {
  hasWrite: boolean;
  hasEdit: boolean;
  hasShell: boolean;
  hasGlob: boolean;
  hasRead: boolean;
  os: HostOs;
}

export type RecoveryAction =
  | { kind: "force"; reason: ConfabCategory | "claimed_mutation"; prompt: string }
  | { kind: "bootstrap"; preferred: "glob" | "shell_list" | "shell_write" }
  | { kind: "none" };

export function executionPolicy(
  mode: CursorMode,
  client: "cursor" | "provider" = "cursor",
): ExecutionPolicy {
  const cursorOwned = client === "cursor";
  return {
    owner: client,
    mode,
    allowMutations: mode === "agent",
    allowProviderActions: !cursorOwned,
    allowParallelToolCalls: cursorOwned,
  };
}

/** Infer host OS from workspace paths / Cursor context in the prompt blob. */
export function detectHostOs(blob: string): HostOs {
  if (/[A-Za-z]:\\/.test(blob) || /\bWindows\b|\bPowerShell\b|\bGet-Location\b/i.test(blob)) {
    return "windows";
  }
  if (
    /(?:^|[\s`"'(=])(\/(?:Users|home|workspace|Volumes)\/)/.test(blob) ||
    /\b(?:macOS|Darwin|linux|ubuntu)\b/i.test(blob)
  ) {
    return "posix";
  }
  return "unknown";
}

export function toolCapabilities(
  toolNames: readonly string[],
  hostOs: HostOs = "unknown",
): ToolCapabilities {
  const names = toolNames.map((n) => n.toLowerCase());
  const has = (re: RegExp) => names.some((n) => re.test(n));
  return {
    hasWrite: has(/^(write|writefile|write_file)$/),
    hasEdit: has(/^(streplace|applypatch|edit|edit_file)$/),
    hasShell: has(/^(shell|bash|run_terminal_cmd|run_command|awaitshell|await)$/),
    hasGlob: has(/^(glob|file_search|filesearch)$/),
    hasRead: has(/^(read|readfile|read_file)$/),
    os: hostOs,
  };
}

/** Coarse intent from the latest user ask (Cursor noise already stripped by caller). */
export function classifyTurnIntent(ask: string, mode: CursorMode): TurnIntent {
  const q = ask.trim();
  if (!q) return mode === "agent" ? "explore" : "answer";

  if (
    /\b(?:create|write|scaffold|generate|implement|add|build|make)\b/i.test(q) &&
    (/\b[\w.-]+\.[A-Za-z0-9]+\b/.test(q) ||
      /\b(?:file|script|module|component|app|project)\b/i.test(q)) &&
    !/\b(?:assess|verify|audit|evaluate|phase\s*\d|architecture)\b/i.test(q)
  ) {
    return "create";
  }
  if (
    /\b(?:edit|fix|update|change|refactor|replace|patch|modify)\b/i.test(q) &&
    !/\b(?:assess|verify|audit|evaluate|phase\s*\d|architecture)\b/i.test(q)
  ) {
    return "edit";
  }
  if (
    /\b(?:assess|verify|audit|evaluate|re-?evaluate|phase\s*\d|architecture|quality|security|compliance|list|scan|review|explore|inspect|search|grep|find|plan|read|open|show)\b/i.test(
      q,
    ) ||
    /\b[\w./-]+\.(?:md|ts|tsx|py|json)\b/i.test(q)
  ) {
    return "explore";
  }
  return mode === "plan" || mode === "ask" ? "explore" : "answer";
}

/** Task must inspect the real workspace (Glob/Read) before writes or junk shell. */
export function requiresExploreFirst(ask: string): boolean {
  const q = ask.trim();
  if (!q) return false;
  if (/\b(?:assess|verify|audit|evaluate|re-?evaluate|architecture|phase\s*\d|codebase|repo|project|implement|fix|refactor|review|inspect|explore|quality|security|compliance)\b/i.test(q)) {
    return true;
  }
  return /\b[\w./\\-]+\.(?:md|ts|tsx|py|json|ya?ml)\b/i.test(q);
}

/**
 * Single recovery decision for a Cursor turn.
 * Prefer structural rewrites + one force prompt over stacked retry loops.
 */
export function decideRecovery(opts: {
  mode: CursorMode;
  caps: ToolCapabilities;
  intent: TurnIntent;
  confab: ConfabCategory;
  claimedMutation: boolean;
  everActed: boolean;
  hasToolCalls: boolean;
  toolFailed: boolean;
  docPath?: string | null;
}): RecoveryAction {
  if (opts.hasToolCalls) return { kind: "none" };

  if (opts.confab === "fake_delivery" || opts.claimedMutation) {
    return {
      kind: "force",
      reason: opts.confab === "fake_delivery" ? "fake_delivery" : "claimed_mutation",
      prompt: mutationForcePrompt(opts.caps),
    };
  }

  if (
    opts.confab === "access_denial" ||
    opts.confab === "sandbox_myth" ||
    opts.confab === "tools_vanished" ||
    opts.confab === "empty_workspace"
  ) {
    // After tools already ran, prefer Glob once (discover) over inventing writes.
    if (opts.everActed || opts.toolFailed || opts.intent === "explore" || opts.mode !== "agent") {
      return {
        kind: "force",
        reason: opts.confab,
        prompt: exploreForcePrompt(opts.caps, opts.docPath),
      };
    }
    if (opts.intent === "create" || opts.intent === "edit") {
      return {
        kind: "force",
        reason: opts.confab,
        prompt: mutationForcePrompt(opts.caps),
      };
    }
    return {
      kind: "force",
      reason: opts.confab,
      prompt: exploreForcePrompt(opts.caps, opts.docPath),
    };
  }

  if (opts.claimedMutation && !opts.everActed) {
    return {
      kind: "force",
      reason: "claimed_mutation",
      prompt: mutationForcePrompt(opts.caps),
    };
  }

  return { kind: "none" };
}

export function exploreForcePrompt(caps: ToolCapabilities, docPath?: string | null): string {
  const glob = caps.hasGlob ? "```Glob with glob_pattern: **/*" : "a listing Shell command";
  const readTarget = docPath && caps.hasRead ? `\`\`\`ReadFile with path: ${docPath}` : caps.hasRead ? "```ReadFile with a concrete relative path" : "";
  const read = readTarget || (caps.hasRead ? "```ReadFile with a concrete relative path" : "");
  const first = readTarget || (caps.hasGlob ? glob : read);
  return (
    "You have a real Cursor workspace with working tools. Cursor executes ReadFile/Glob/Shell on the user's machine — the workspace IS mounted when tools return file content. " +
    "Do NOT write placeholder .txt files, do NOT emit malformed Shell, and do NOT skip reading the real project files. " +
    "Do NOT claim the workspace is inaccessible, not mounted, or unavailable from this interface. " +
    "Do NOT mention /mnt/data, and do NOT ask the user to upload a .zip or paste files. " +
    `Your NEXT action must inspect the repo — emit ONE ${first}${readTarget ? "" : read ? ` or ${glob}` : ""} now. ` +
    "If you named files that still need inspection, ReadFile the first one next — do not stop with a report. " +
    "Optional: one short progress sentence before the fence. No markdown report."
  );
}

export function mutationForcePrompt(caps: ToolCapabilities): string {
  if (caps.hasWrite) {
    return (
      "You have NOT actually done that — no tool ran this turn, so nothing changed on disk. " +
      "Emit ONE ```Write or ```StrReplace fence that performs the change for real. " +
      "Use a relative workspace path (never /mnt/data). Output only the fence."
    );
  }
  const recipe =
    caps.os === "posix"
      ? "Use a python3 one-liner or printf/heredoc to write UTF-8 bytes to a relative path."
      : "Use PowerShell [IO.File]::WriteAllText with base64-decoded UTF-8. " +
        "Do NOT use Set-Content @'...'@ here-strings (they break).";
  return (
    "You have NOT actually done that — no tool ran this turn, so nothing changed on disk. " +
    "Write/StrReplace are not in this toolset. Emit ONE ```Shell fence that writes the file locally. " +
    `${recipe} Never write to /mnt/data — use a relative workspace path. Output only the fence.`
  );
}

/** A small FIFO actor used to serialize one provider conversation. */
export class ConversationTurnQueue {
  private tail: Promise<void> = Promise.resolve();
  private revision = 0;

  get currentRevision(): number {
    return this.revision;
  }

  async run<T>(operation: (revision: number) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const revision = ++this.revision;
    try {
      return await operation(revision);
    } finally {
      release();
    }
  }
}

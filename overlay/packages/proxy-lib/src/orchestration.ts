/**
 * Provider-neutral state used by the Cursor/OpenAI orchestration boundary.
 *
 * M365 is a provider behind this boundary; it must not own Cursor's tool
 * execution, conversation identity, or turn scheduling.
 */

export type CursorMode = "ask" | "plan" | "agent";

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


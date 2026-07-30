import { ChatCompletionRequest, handleChatCompletion } from "@m365-copilot/proxy-lib";
import { pool } from "../../../server-pool";

/** Cursor sends non-OpenAI tool entries (custom/MCP/etc). Keep only function tools. */
function sanitizeCursorBody(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  if (Array.isArray(raw.tools)) {
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
    } else if (before !== raw.tools.length) {
      console.log(`[m365-proxy] stripped ${before - raw.tools.length} non-function tool(s); kept ${raw.tools.length}`);
    }
  }
  // Cursor often sends gpt-5.5-medium / gpt-5.4-high — leave as-is; tone mapper strips suffixes.
  return raw;
}

export default defineEventHandler(async (event) => {
  let body: ReturnType<typeof ChatCompletionRequest.parse>;
  try {
    const raw = sanitizeCursorBody(await readBody(event));
    body = ChatCompletionRequest.parse(raw);
  } catch (err: any) {
    console.error(`[m365-proxy] invalid_request: ${err.message}`);
    return new Response(
      JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  console.log(`[m365-proxy] chat model=${body.model} tools=${body.tools?.length ?? 0} stream=${body.stream}`);

  const ac = new AbortController();
  const req = event.node?.req;
  const res = event.node?.res;
  if (req && res) {
    let finished = false;
    res.once("finish", () => { finished = true; });
    const maybeAbort = () => { if (!finished && !res.writableEnded) ac.abort(); };
    req.once("close", maybeAbort);
    res.once("close", maybeAbort);
  }

  return handleChatCompletion(body, pool, { signal: ac.signal });
});

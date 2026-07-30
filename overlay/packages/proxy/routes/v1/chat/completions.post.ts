import { ChatCompletionRequest, handleChatCompletion, sanitizeCursorBody } from "@m365-copilot/proxy-lib";
import { pool } from "../../../server-pool";

export default defineEventHandler(async (event) => {
  let body: ReturnType<typeof ChatCompletionRequest.parse>;
  try {
    // sanitizeCursorBody is a no-op for non-Cursor toolsets (keeps default clients intact).
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

  const conversationId =
    req?.headers["x-conversation-id"] ||
    req?.headers["x-client-conversation-id"];
  return handleChatCompletion(body, pool, {
    signal: ac.signal,
    clientId: typeof conversationId === "string" ? conversationId : undefined,
    principalId: Array.isArray(req?.headers.authorization)
      ? req?.headers.authorization[0]
      : req?.headers.authorization
        ? "authenticated-client"
        : "anonymous",
  });
});

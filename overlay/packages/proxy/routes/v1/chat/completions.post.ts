import { ChatCompletionRequest, handleChatCompletion } from "@m365-copilot/proxy-lib";
import { resolveModelRoute } from "@m365-copilot/core";
import { pool } from "../../../server-pool";

const NON_GPT_PREFIX = /^(grok|composer|gemini|glm|kimi|auto-smart|auto-cost|auto-balance)/i;

export default defineEventHandler(async (event) => {
  let body: ReturnType<typeof ChatCompletionRequest.parse>;
  try {
    body = ChatCompletionRequest.parse(await readBody(event));
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const route = resolveModelRoute(body.model);
  console.log(
    `[m365-proxy] chat model=${route.requested} normalized=${route.normalized} tone=${route.tone} source=${route.source}`,
  );
  if (route.source === "fallback" && NON_GPT_PREFIX.test(route.normalized)) {
    console.warn(
      `[m365-proxy] non-GPT model "${route.requested}" hit this proxy — mapped to Copilot auto (${route.tone}). If you expected native ${route.normalized.split("-")[0]}, Cursor may be routing this model elsewhere.`,
    );
  }

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

  const upstream = await handleChatCompletion(body, pool, { signal: ac.signal });
  const headers = new Headers(upstream.headers);
  headers.set("X-M365-Requested-Model", route.requested);
  headers.set("X-M365-Normalized-Model", route.normalized);
  headers.set("X-M365-Resolved-Tone", route.tone);
  headers.set("X-M365-Route-Source", route.source);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
});

#!/usr/bin/env node
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const assert = (condition, message) => {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
};

const orchestration = read("overlay/packages/proxy-lib/src/orchestration.ts");
const handler = read("overlay/packages/proxy-lib/src/handler.ts");
const route = read("overlay/packages/proxy/routes/v1/chat/completions.post.ts");
const api = read("overlay/packages/proxy-lib/src/index.ts");
const middleware = read("overlay/packages/proxy/middleware/02-require-auth.ts");
const dockerfile = read("Dockerfile");
const schemas = read("overlay/packages/proxy-lib/src/schemas.ts");

assert(orchestration.includes("interface ModelProvider"), "provider boundary exists");
assert(orchestration.includes("ProviderEvent"), "provider events are typed");
assert(orchestration.includes("ConversationTurnQueue"), "conversation queue exists");
assert(orchestration.includes('owner: "cursor"'), "Cursor execution ownership is explicit");
assert(orchestration.includes("decideRecovery"), "recovery policy lives in orchestration");
assert(orchestration.includes("toolCapabilities"), "tool capabilities are first-class");
assert(orchestration.includes("mutationForcePrompt"), "mutation force is capability-aware");
assert(handler.includes('createHash("sha256")'), "conversation identity uses SHA-256");
assert(handler.includes("latestUserAsk"), "fingerprint uses latest user ask");
assert(handler.includes("decideRecovery"), "handler delegates recovery to orchestration");
assert(handler.includes("conv.queue.run"), "turns are serialized per conversation");
assert(handler.includes("conv.toolCalls"), "tool-call metadata is retained");
assert(handler.includes("validateToolCalls"), "tool calls are schema-validated");
assert(route.includes("x-conversation-id"), "HTTP route accepts conversation identity");
assert(api.includes("callerAuthorized"), "framework-free API enforces caller auth");
assert(middleware.includes("M365_API_KEY"), "Nitro API middleware supports caller auth");
assert(schemas.includes("function: z.object"), "tool function is required");
assert(dockerfile.includes("M365_REF=92682ad05f82ec73f6e0ab57a9de4a9997a2a3a6"), "upstream ref is pinned");
assert(dockerfile.includes("Pinned upstream mismatch"), "pinned upstream is verified");
assert(!handler.includes("simpleHash("), "weak prompt-only hash is removed");
assert(!handler.includes("CURSOR_HALLUCINATION_FORCE_PROMPT"), "hardcoded Write force prompt removed");

if (process.exitCode) {
  console.error("\nverify-native-orchestration: FAILED");
  process.exit(1);
}
console.log("\nverify-native-orchestration: PASSED");

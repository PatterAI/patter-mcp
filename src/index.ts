/**
 * Patter MCP Server — mcp-use transport
 *
 * Uses MCPServer from mcp-use/server for session management, transport,
 * and the built-in inspector UI. Claude Code connects with:
 *
 *   claude mcp add --transport http patter-mcp http://localhost:3000/mcp
 */

import { MCPServer, oauthAuth0Provider } from "mcp-use/server";

import { PatterServer } from "./patter-server.js";
import { makeCallHandler, makeCallSchema, type MakeCallInput } from "./tools/make-call.js";
import { callThirdPartyHandler, callThirdPartySchema, type CallThirdPartyInput } from "./tools/call-third-party.js";
import { getCallsHandler } from "./tools/get-calls.js";
import { getTranscriptHandler, getTranscriptSchema, type GetTranscriptInput } from "./tools/get-transcript.js";
import { validatePhoneNumber } from "./phone-validation.js";
import { checkRateLimit, recordCallStart } from "./rate-limiter.js";

const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3000", 10);
const PATTER_PORT = parseInt(process.env.PATTER_PORT ?? "8000", 10);

function log(msg: string): void {
  process.stderr.write(`[patter-mcp] ${msg}\n`);
}

/** Build a uniform MCP error response from a plain message string. */
function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Extract the userId from the MCP request context, guarding against empty
 * strings that could slip through as "authenticated" user identifiers.
 * Returns `undefined` when auth is disabled or the userId is blank.
 */
function extractUserId(ctx: { auth?: { user: { userId: string } } }): string | undefined {
  const raw = ctx.auth?.user.userId;
  return raw?.trim() || undefined;
}

// ---------------------------------------------------------------------------
// Shared Patter server instance
// ---------------------------------------------------------------------------

const patter: PatterServer = (() => {
  try {
    return new PatterServer();
  } catch (err) {
    log(`Failed to initialize Patter: ${err instanceof Error ? err.message : String(err)}`);
    log("Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, OPENAI_API_KEY");
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
// MCP server with mcp-use
// ---------------------------------------------------------------------------

// OAuth is optional: when AUTH0_DOMAIN + AUTH0_AUDIENCE are set, all /mcp
// endpoints require a valid Bearer token. When absent the server runs in
// unauthenticated mode so local dev works without any auth configuration.
const oauthConfig =
  process.env.AUTH0_DOMAIN && process.env.AUTH0_AUDIENCE
    ? oauthAuth0Provider({
        domain: process.env.AUTH0_DOMAIN,
        audience: process.env.AUTH0_AUDIENCE,
      })
    : undefined;

const server = new MCPServer({
  name: "patter-mcp",
  version: "0.2.0",
  ...(oauthConfig !== undefined ? { oauth: oauthConfig } : {}),
});

// -- make_call
server.tool(
  {
    name: "make_call",
    description:
      "Place an outbound phone call with an AI voice agent. The agent speaks " +
      "using the system prompt and can read files, run commands, and search " +
      "code during the call. Returns immediately with a call ID.",
    schema: makeCallSchema,
  },
  async (args: MakeCallInput, ctx) => {
    const userId = extractUserId(ctx);

    const phoneResult = validatePhoneNumber(args.to);
    if (!phoneResult.valid) {
      return errorResponse(phoneResult.error);
    }

    const rateResult = checkRateLimit(userId);
    if (!rateResult.allowed) {
      return errorResponse(rateResult.reason ?? "Rate limit exceeded.");
    }

    recordCallStart(userId);

    // Replace raw input with the validated E.164 number
    const validatedArgs: MakeCallInput = { ...args, to: phoneResult.e164 };
    return makeCallHandler(validatedArgs, patter, userId);
  },
);

// -- call_third_party
server.tool(
  {
    name: "call_third_party",
    description:
      "Call a third party (restaurant, business, person) with a specific task. " +
      "An autonomous AI agent handles the conversation. Waits for the call to " +
      "complete and returns the full transcript.",
    schema: callThirdPartySchema,
  },
  async (args: CallThirdPartyInput, ctx) => {
    const userId = extractUserId(ctx);

    const phoneResult = validatePhoneNumber(args.to);
    if (!phoneResult.valid) {
      return errorResponse(phoneResult.error);
    }

    const rateResult = checkRateLimit(userId);
    if (!rateResult.allowed) {
      return errorResponse(rateResult.reason ?? "Rate limit exceeded.");
    }

    recordCallStart(userId);

    // Replace raw input with the validated E.164 number
    const validatedArgs: CallThirdPartyInput = { ...args, to: phoneResult.e164 };
    return callThirdPartyHandler(validatedArgs, patter, userId);
  },
);

// -- get_calls
server.tool(
  {
    name: "get_calls",
    description: "List all recent calls with their status, duration, cost, and turn count.",
  },
  async (_args, ctx) => {
    const userId = extractUserId(ctx);
    return getCallsHandler(patter, userId);
  },
);

// -- get_transcript
server.tool(
  {
    name: "get_transcript",
    description: "Get the full conversation transcript of a completed call.",
    schema: getTranscriptSchema,
  },
  async (args: GetTranscriptInput, ctx) => {
    const userId = extractUserId(ctx);
    return getTranscriptHandler(args, patter, userId);
  },
);

// ---------------------------------------------------------------------------
// Custom HTTP routes via Hono app
// ---------------------------------------------------------------------------

// Health check
server.app.get("/health", (c) =>
  c.json({
    status: "ok",
    mode: "mcp",
    phone: patter.phoneNumber,
    serverRunning: patter.isServerRunning,
    activeSessions: server.sessions.size,
  }),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Start Patter inbound server in background
  const defaultPrompt =
    "You are a helpful AI assistant accessible by phone. " +
    "You can read files, run commands, and search code when asked. " +
    "Be concise and clear — this is a phone conversation.";

  await patter.startServer(
    process.env.AGENT_SYSTEM_PROMPT ?? defaultPrompt,
    process.env.AGENT_FIRST_MESSAGE ?? "Hello! I'm your AI assistant. How can I help?",
    process.env.AGENT_VOICE ?? "nova",
    PATTER_PORT,
  );

  // Start MCP HTTP server (inspector auto-available at /inspector)
  await server.listen(MCP_PORT);

  log(`
██████╗  █████╗ ████████╗████████╗███████╗██████╗
██╔══██╗██╔══██╗╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗
██████╔╝███████║   ██║      ██║   █████╗  ██████╔╝
██╔═══╝ ██╔══██║   ██║      ██║   ██╔══╝  ██╔══██╗
██║     ██║  ██║   ██║      ██║   ███████╗██║  ██║
╚═╝     ╚═╝  ╚═╝   ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝

Patter MCP Server
`);
  log(`MCP endpoint:  http://localhost:${MCP_PORT}/mcp`);
  log(`Inspector:     http://localhost:${MCP_PORT}/inspector`);
  log(`Patter server: http://localhost:${PATTER_PORT}/`);
  log(`Phone number:  ${patter.phoneNumber}`);
  log(`Health check:  http://localhost:${MCP_PORT}/health`);
  log(``);
  log(`Connect Claude Code:`);
  log(`  claude mcp add --transport http patter-mcp http://localhost:${MCP_PORT}/mcp`);
  log(``);
  log(`Tools: make_call, call_third_party, get_calls, get_transcript`);
  log(`Voice tools (during calls): read_file, run_command, search_code`);
  log(`Auth: ${oauthConfig ? `Auth0 (${process.env.AUTH0_DOMAIN})` : "disabled (no AUTH0_DOMAIN)"}`);
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});

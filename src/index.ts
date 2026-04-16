/**
 * Patter MCP Server — mcp-use transport
 *
 * Uses MCPServer from mcp-use/server for session management, transport,
 * and the built-in inspector UI. Claude Code connects with:
 *
 *   claude mcp add --transport http patter-mcp http://localhost:3000/mcp
 */

import { MCPServer } from "mcp-use/server";

import { PatterServer } from "./patter-server.js";
import { makeCallHandler, makeCallSchema, type MakeCallInput } from "./tools/make-call.js";
import { callThirdPartyHandler, callThirdPartySchema, type CallThirdPartyInput } from "./tools/call-third-party.js";
import { getCallsHandler } from "./tools/get-calls.js";
import { getTranscriptHandler, getTranscriptSchema, type GetTranscriptInput } from "./tools/get-transcript.js";

const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3000", 10);
const PATTER_PORT = parseInt(process.env.PATTER_PORT ?? "8000", 10);

function log(msg: string): void {
  process.stderr.write(`[patter-mcp] ${msg}\n`);
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

const server = new MCPServer({
  name: "patter-mcp",
  version: "0.2.0",
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
  async (args: MakeCallInput) => makeCallHandler(args, patter),
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
  async (args: CallThirdPartyInput) => callThirdPartyHandler(args, patter),
);

// -- get_calls
server.tool(
  {
    name: "get_calls",
    description: "List all recent calls with their status, duration, cost, and turn count.",
  },
  async () => getCallsHandler(patter),
);

// -- get_transcript
server.tool(
  {
    name: "get_transcript",
    description: "Get the full conversation transcript of a completed call.",
    schema: getTranscriptSchema,
  },
  async (args: GetTranscriptInput) => getTranscriptHandler(args, patter),
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
    totalCalls: patter.calls.size,
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
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});

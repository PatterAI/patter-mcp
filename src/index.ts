/**
 * Patter MCP Server — Streamable HTTP transport
 *
 * Always-online Express server that exposes MCP tools for voice calling
 * via the Streamable HTTP transport. Claude Code connects with:
 *
 *   claude mcp add --transport http patter-mcp http://localhost:3000/mcp
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { PatterServer } from "./patter-server.js";
import { makeCallSchema, makeCallHandler } from "./tools/make-call.js";
import { callThirdPartySchema, callThirdPartyHandler } from "./tools/call-third-party.js";
import { getCallsHandler } from "./tools/get-calls.js";
import { getTranscriptSchema, getTranscriptHandler } from "./tools/get-transcript.js";

const MCP_PORT = parseInt(process.env.MCP_PORT || "3000", 10);
const PATTER_PORT = parseInt(process.env.PATTER_PORT || "8000", 10);

function log(msg: string): void {
  process.stderr.write(`[patter-mcp] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Shared Patter server instance
// ---------------------------------------------------------------------------

let patter: PatterServer;
try {
  patter = new PatterServer();
} catch (err) {
  log(`Failed to initialize Patter: ${err instanceof Error ? err.message : String(err)}`);
  log("Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, OPENAI_API_KEY");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// MCP server factory — creates a new McpServer with all tools registered
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "patter-mcp",
    version: "0.1.0",
  });

  // -- make_call
  server.tool(
    "make_call",
    "Place an outbound phone call with an AI voice agent. The agent speaks " +
      "using the system prompt and can read files, run commands, and search " +
      "code during the call. Returns immediately with a call ID.",
    makeCallSchema,
    async (args) => makeCallHandler(args, patter),
  );

  // -- call_third_party
  server.tool(
    "call_third_party",
    "Call a third party (restaurant, business, person) with a specific task. " +
      "An autonomous AI agent handles the conversation. Waits for the call to " +
      "complete and returns the full transcript.",
    callThirdPartySchema,
    async (args) => callThirdPartyHandler(args, patter),
  );

  // -- get_calls
  server.tool(
    "get_calls",
    "List all recent calls with their status, duration, cost, and turn count.",
    {},
    async () => getCallsHandler(patter),
  );

  // -- get_transcript
  server.tool(
    "get_transcript",
    "Get the full conversation transcript of a completed call.",
    getTranscriptSchema,
    async (args) => getTranscriptHandler(args, patter),
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express + Streamable HTTP transport
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Session tracking
const sessions = new Map<
  string,
  { transport: StreamableHTTPServerTransport; server: McpServer }
>();

// POST /mcp — Client sends JSON-RPC messages
app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // New session: InitializeRequest without session ID
  if (!sessionId) {
    const body = req.body;
    if (isInitializeRequest(body)) {
      const newSessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionId: newSessionId,
        onsessioninitialized: (sid: string) => {
          log(`MCP session initialized: ${sid}`);
        },
      });
      const server = createMcpServer();

      sessions.set(newSessionId, { transport, server });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.status(400).json({ error: "Missing Mcp-Session-Id header" });
    return;
  }

  // Existing session
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await session.transport.handleRequest(req, res, req.body);
});

// GET /mcp — SSE stream for server-initiated messages
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: "Missing Mcp-Session-Id header" });
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await session.transport.handleRequest(req, res);
});

// DELETE /mcp — Close session
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      await session.transport.handleRequest(req, res);
      sessions.delete(sessionId);
      log(`MCP session closed: ${sessionId}`);
      return;
    }
  }
  res.status(200).end();
});

// Test endpoint: simulate a call completing (for development/testing)
app.post("/test/simulate-call-end", (req, res) => {
  const { callId, transcript } = req.body as {
    callId?: string;
    transcript?: Array<{ role: string; text: string }>;
  };
  if (!callId) {
    res.status(400).json({ error: "callId required" });
    return;
  }
  patter.simulateCallEnd(callId, transcript);
  const record = patter.calls.get(callId);
  res.json({ ok: true, call: record });
});

// Health check
app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    mode: "mcp",
    phone: patter.phoneNumber,
    serverRunning: patter.isServerRunning,
    activeSessions: sessions.size,
    totalCalls: patter.calls.size,
  });
});

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
    process.env.AGENT_SYSTEM_PROMPT || defaultPrompt,
    process.env.AGENT_FIRST_MESSAGE || "Hello! I'm your AI assistant. How can I help?",
    process.env.AGENT_VOICE || "nova",
    PATTER_PORT,
  );

  // Start MCP HTTP server
  app.listen(MCP_PORT, "0.0.0.0", () => {
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
    log(`Patter server: http://localhost:${PATTER_PORT}/`);
    log(`Phone number:  ${patter.phoneNumber}`);
    log(`Health check:  http://localhost:${MCP_PORT}/health`);
    log(``);
    log(`Connect Claude Code:`);
    log(`  claude mcp add --transport http patter-mcp http://localhost:${MCP_PORT}/mcp`);
    log(``);
    log(`Tools: make_call, call_third_party, get_calls, get_transcript`);
    log(`Voice tools (during calls): read_file, run_command, search_code`);
  });
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});

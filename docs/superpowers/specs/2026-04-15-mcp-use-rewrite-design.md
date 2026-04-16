# Patter MCP: mcp-use Rewrite for Claude.ai + ChatGPT Remote Integration

**Date:** 2026-04-15
**Status:** Approved
**Targets:** A (Claude Code/Desktop local), B (Claude.ai Connectors), C (ChatGPT Developer Mode)

---

## Problem

Patter MCP currently runs localhost-only with no authentication, no rate limiting, and an in-memory call store. It works for target A (Claude Code CLI / Desktop) but cannot serve as a remote MCP connector for Claude.ai (B) or ChatGPT Developer Mode (C) because:

1. No public HTTPS endpoint
2. No OAuth — anyone who reaches the port can spend Twilio/OpenAI/ElevenLabs credits
3. The `claude_code` voice tool uses `process.cwd()` — on a remote server, that's the server filesystem, not the caller's machine
4. No rate limits or cost caps on a tool that places phone calls
5. Phone number input is `z.string()` with no E.164 validation
6. In-memory `Map<string, CallRecord>` — lost on restart
7. No tests (project requires 80% coverage)

## Solution

Rewrite the MCP server layer from `@modelcontextprotocol/sdk` + Express to `mcp-use/server`, which provides:

- Built-in OAuth 2.0 adapters (Auth0, WorkOS)
- MCP Apps (interactive React widgets rendering inside Claude/ChatGPT)
- Manufact Cloud deployment (GitHub push-to-deploy, public HTTPS, observability)
- Built-in Inspector for development/testing

Additionally, replace the local `claude-bridge.ts` with E2B sandboxed execution so the `claude_code` voice tool works in remote deployments.

## Architecture

```
+-----------------------------------------------------+
|                  mcp-use MCPServer                   |
|              (Hono-based, replaces Express)          |
|                                                      |
|  OAuth 2.0 (Auth0 adapter)                          |
|  +-- /authorize, /token, /.well-known/*             |
|  +-- context.auth -> userId, email, roles           |
|                                                      |
|  Tools (same 4, new registration API)               |
|  +-- make_call        -> PatterServer.makeCall()    |
|  +-- call_third_party -> PatterServer.callThirdParty|
|  +-- get_calls        -> per-user call history      |
|  +-- get_transcript   -> per-user scoped            |
|                                                      |
|  MCP App (React widget, auto-discovered)            |
|  +-- resources/call-dashboard.tsx                   |
|      live calls, transcript viewer, cost tracker    |
|                                                      |
|  Voice Tools (during calls)                         |
|  +-- claude_code -> E2B sandbox per call            |
|      isolated filesystem, Agent SDK inside          |
|                                                      |
|  Safety Layer                                       |
|  +-- per-user: 10 calls/day, 5min max, 2 concurrent|
|  +-- E.164 phone validation (libphonenumber-js)     |
|  +-- optional phone allowlist per user              |
|  +-- global budget cap                              |
|                                                      |
|  Persistence (SQLite/Turso)                         |
|  +-- call records, per-user history, rate counters  |
+-----------------------------------------------------+
         |                              |
         v                              v
   Manufact Cloud                  Claude.ai / ChatGPT
   (deploy, observe)               (connector install)
```

## Branch + Worktree Strategy

All work happens on feature branches off a `dev` integration branch. Each branch gets its own git worktree for parallel development. `dev` merges into `main` when the full rewrite is stable.

```
main (untouched, current shipping code)
 |
 +-- dev (integration branch)
      |
      +-- feat/mcp-use-core    <- foundation: rewrite server + 4 tools
      +-- feat/oauth           <- Auth0 OAuth 2.0 via mcp-use adapter
      +-- feat/mcp-app         <- call dashboard React widget
      +-- feat/sandbox         <- E2B sandboxed claude_code
      +-- feat/safety          <- rate limits, cost caps, phone validation
      +-- feat/persistence     <- SQLite/Turso for call records
      +-- feat/tests           <- test suite (unit + integration)
```

### Dependency DAG

```
feat/mcp-use-core (must land first)
  +-- feat/oauth         -+
  +-- feat/mcp-app        | all parallelizable after core
  +-- feat/sandbox        |
  +-- feat/persistence   -+
          |
          +-- feat/safety (needs oauth + persistence)
                |
                +-- feat/tests (incremental, final pass after all merge)
```

## Branch Specifications

### feat/mcp-use-core

**Goal:** Replace `@modelcontextprotocol/sdk` + Express with `mcp-use/server`.

**Changes:**
- Rewrite `src/index.ts`: replace Express app + StreamableHTTPServerTransport + session tracking with `MCPServer` from `mcp-use/server`
- Port 4 tool registrations to `server.tool()` API with Zod schemas
- Remove Express session Map (mcp-use handles transport internally)
- Keep `patter-server.ts` unchanged (Patter SDK wrapper)
- Keep `voice-tools.ts` interface unchanged
- Keep health check as a Hono route via `server.get()`
- Remove test simulation endpoint (replaced by proper tests later)
- Update `package.json`: remove `@modelcontextprotocol/sdk`, `express`, `@types/express`; add `mcp-use`

**New `src/index.ts` shape:**
```typescript
import { MCPServer, text } from "mcp-use/server";
import { z } from "zod";
import { PatterServer } from "./patter-server.js";

const server = new MCPServer({
  name: "patter-mcp",
  version: "0.2.0",
});

server.tool({
  name: "make_call",
  description: "Place an outbound phone call...",
  schema: z.object({
    to: z.string(),
    systemPrompt: z.string(),
    firstMessage: z.string().optional(),
    voice: z.string().optional(),
    machineDetection: z.boolean().optional(),
    voicemailMessage: z.string().optional(),
  }),
}, async (args) => {
  const callId = await patter.makeCall(args.to, args.systemPrompt, ...);
  return text(`Call initiated to ${args.to}.\nCall ID: ${callId}\n...`);
});

// ... other tools

server.get("/health", (c) => c.json({ status: "ok", ... }));
await server.listen(MCP_PORT);
```

**Acceptance criteria:**
- Server starts with `npm run dev`
- Inspector available at `http://localhost:3000/inspector`
- All 4 tools callable from Claude Code CLI
- Health endpoint works
- No Express dependency remaining

### feat/oauth

**Goal:** Gate all MCP endpoints behind Auth0 OAuth 2.0.

**Changes:**
- Add Auth0 OAuth adapter configuration to MCPServer
- All `/mcp/*` endpoints require `Authorization: Bearer [token]`
- `context.auth` available in all tool handlers with `userId`, `email`
- Scope `get_calls` and `get_transcript` to authenticated user only
- Add `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` to `.env.example`
- When auth env vars are absent, server runs unauthenticated (preserves local dev / target A)

**Auth config shape:**
```typescript
const server = new MCPServer({
  name: "patter-mcp",
  version: "0.2.0",
  auth: process.env.AUTH0_DOMAIN ? {
    provider: "auth0",
    domain: process.env.AUTH0_DOMAIN,
    clientId: process.env.AUTH0_CLIENT_ID,
    clientSecret: process.env.AUTH0_CLIENT_SECRET,
  } : undefined,
});
```

**Acceptance criteria:**
- Unauthenticated requests to `/mcp` return 401 when auth is configured
- Valid bearer token grants access to all tools
- `context.auth.userId` is available in tool handlers
- `get_calls` returns only the authenticated user's calls
- Local dev (no auth env vars) still works without auth

### feat/mcp-app

**Goal:** Interactive call dashboard widget rendering inside Claude/ChatGPT.

**Changes:**
- Add `resources/call-dashboard.tsx` — React widget auto-discovered by mcp-use
- Dashboard shows: active calls (status, duration, to/from), completed calls list, transcript viewer per call, per-call cost breakdown
- Widget uses `useWidget` hook from `mcp-use/react`
- Widget communicates with server via MCP resource queries

**Acceptance criteria:**
- Widget renders in mcp-use Inspector
- Widget shows call list and transcript for selected call
- Widget auto-refreshes for active calls

### feat/sandbox

**Goal:** Replace local `claude-bridge.ts` with E2B sandboxed execution.

**Changes:**
- Rewrite `claude-bridge.ts` to use E2B's `claude` sandbox template
- Each call creates a new E2B sandbox
- Agent SDK runs inside the sandbox with full tool access (Read, Write, Edit, Bash, Glob, Grep)
- Sandbox destroyed when call ends (`endCallSession`)
- Add `E2B_API_KEY` to `.env.example`
- When `E2B_API_KEY` is absent, fall back to local execution (preserves target A)

**New `claude-bridge.ts` shape:**
```typescript
import { Sandbox } from "e2b";

const callSandboxes = new Map<string, Sandbox>();

export async function executeClaudeCode(
  command: string,
  callId: string,
): Promise<string> {
  let sandbox = callSandboxes.get(callId);
  if (!sandbox) {
    sandbox = await Sandbox.create("claude", {
      apiKey: process.env.E2B_API_KEY,
    });
    callSandboxes.set(callId, sandbox);
  }
  // Execute command in sandbox via Agent SDK
  const result = await sandbox.commands.run(`claude -p "${command}"`);
  return result.stdout || "Done. No text output.";
}

export async function endCallSession(callId: string): Promise<void> {
  const sandbox = callSandboxes.get(callId);
  if (sandbox) {
    await sandbox.kill();
    callSandboxes.delete(callId);
  }
}
```

**Acceptance criteria:**
- Each call gets an isolated sandbox
- Claude Code commands execute inside sandbox, not on host
- Sandbox is destroyed when call ends
- Falls back to local execution when E2B key is absent

### feat/safety

**Goal:** Rate limiting, cost caps, phone validation, allowlists.

**Changes:**
- Add rate limiter keyed on `context.auth.userId`:
  - 10 calls/day per user (configurable via `RATE_LIMIT_DAILY`)
  - 5 minute max call duration (configurable via `MAX_CALL_DURATION_SECONDS`)
  - 2 concurrent calls per user (configurable via `MAX_CONCURRENT_CALLS`)
- Add global hourly budget cap (configurable via `HOURLY_BUDGET_CAP_USD`)
- Add E.164 phone validation on all `to` fields using `libphonenumber-js`
- Add optional per-user phone allowlist (stored in persistence layer)
- Rate limit counters stored in persistence layer

**Acceptance criteria:**
- 11th call in a day returns error with clear message
- Call exceeding 5 minutes is terminated
- Invalid phone numbers rejected before call is placed
- Budget cap halts new calls when reached

### feat/persistence

**Goal:** Replace in-memory `Map<string, CallRecord>` with SQLite.

**Changes:**
- Add `src/db.ts` with SQLite connection (better-sqlite3 for local, Turso client for remote)
- Schema: `calls` table (callId, userId, to, from, direction, status, startedAt, endedAt, duration, transcript JSON, metrics JSON)
- Schema: `rate_limits` table (userId, date, callCount, activeCallIds)
- Migrate `PatterServer.calls` from Map to DB queries
- Call records survive restarts
- `get_calls` queries scoped by userId

**Acceptance criteria:**
- Call records persist across server restarts
- Queries scoped by user
- Graceful fallback to in-memory if DB init fails (preserves target A simplicity)

### feat/tests

**Goal:** 80%+ test coverage with Vitest.

**Changes:**
- Add `vitest` + `vitest/config`
- Unit tests: tool schemas, phone validation, rate limit logic, transcript formatting
- Integration tests: auth flow (mock Auth0), tool handlers with mock PatterServer
- Mock Patter SDK for CI (no real Twilio in tests)
- Add `test` script to `package.json`

**Acceptance criteria:**
- `npm test` runs all tests
- Coverage >= 80%
- Tests pass in CI without API keys

## Technology Decisions

| Decision | Choice | Rationale |
|---|---|---|
| OAuth provider | Auth0 | Free tier generous, simple setup, mcp-use has adapter |
| Sandbox | E2B | Pre-built `claude` template with Agent SDK, per-call lifecycle, no long-running VMs |
| Database | SQLite (better-sqlite3) / Turso | Zero infra local, Turso for remote, single-file DB |
| Test runner | Vitest | ESM-native (project uses `"type": "module"`), fast, zero config with TS |
| Phone validation | libphonenumber-js | Google's libphonenumber ported to JS, E.164 validation + formatting |

## What Stays Unchanged

- `patter-server.ts` — Patter SDK wrapper, call lifecycle, agent creation
- `voice-tools.ts` — VoiceTool interface shape (handler implementation changes in sandbox branch)
- Twilio + Deepgram + ElevenLabs pipeline configuration
- `.env.example` structure (additive only — new vars for Auth0, E2B, Turso)
- Local development workflow for target A (all new features degrade gracefully when env vars are absent)

## Deployment

### Local (Target A)
```bash
npm run dev    # same as today
```

### Manufact Cloud (Targets B + C)
```bash
npm run build
npm run deploy   # Manufact CLI, GitHub push-to-deploy
```

Manufact provides: public HTTPS URL, custom domain, observability dashboard, branch deployments.

### Claude.ai Connector Install (Target B)
1. Deploy to Manufact Cloud
2. User goes to Settings > Connectors > Add
3. Enters Manufact HTTPS URL
4. OAuth flow redirects to Auth0 login
5. Tools appear in conversation

### ChatGPT Developer Mode (Target C)
1. Same deployment as above
2. User adds MCP connector in ChatGPT settings
3. OAuth flow redirects to Auth0 login
4. Tools + MCP App widget available in chat

## Environment Variables (Final)

| Variable | Required | Branch | Description |
|---|---|---|---|
| `TWILIO_ACCOUNT_SID` | Yes | existing | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes | existing | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Yes | existing | Your Twilio phone number (E.164) |
| `OPENAI_API_KEY` | Yes | existing | OpenAI API key |
| `DEEPGRAM_API_KEY` | Yes | existing | Deepgram STT key |
| `ELEVENLABS_API_KEY` | Yes | existing | ElevenLabs TTS key |
| `MCP_PORT` | No | existing | MCP server port (default: 3000) |
| `PATTER_PORT` | No | existing | Patter server port (default: 8000) |
| `AUTH0_DOMAIN` | Remote only | feat/oauth | Auth0 domain |
| `AUTH0_CLIENT_ID` | Remote only | feat/oauth | Auth0 client ID |
| `AUTH0_CLIENT_SECRET` | Remote only | feat/oauth | Auth0 client secret |
| `E2B_API_KEY` | Remote only | feat/sandbox | E2B API key |
| `TURSO_URL` | Remote only | feat/persistence | Turso database URL |
| `TURSO_AUTH_TOKEN` | Remote only | feat/persistence | Turso auth token |
| `RATE_LIMIT_DAILY` | No | feat/safety | Max calls per user per day (default: 10) |
| `MAX_CALL_DURATION_SECONDS` | No | feat/safety | Max call duration (default: 300) |
| `MAX_CONCURRENT_CALLS` | No | feat/safety | Max concurrent calls per user (default: 2) |
| `HOURLY_BUDGET_CAP_USD` | No | feat/safety | Global hourly spending cap |

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/github-banner.png" />
    <source media="(prefers-color-scheme: light)" srcset="./docs/github-banner.png" />
    <img src="./docs/github-banner.png" alt="Patter MCP" width="100%" />
  </picture>
</p>

<h1 align="center">Patter MCP</h1>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/typescript-5.0%2B-3178c6?logo=typescript&logoColor=white" alt="TypeScript 5+" />
  <img src="https://img.shields.io/badge/MCP-Streamable%20HTTP-black?logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyIi8+PC9zdmc+" alt="MCP" /></a>
  <a href="https://github.com/PatterAI/Patter"><img src="https://img.shields.io/badge/Patter%20SDK-0.4.0-orange" alt="Patter SDK" /></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> •
  <a href="#features">Features</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#configuration">Configuration</a>
</p>

---

An MCP server that gives your AI agent a phone number. Answer calls, dial out, edit code, call APIs, book meetings — all over voice.

Built on the [Patter](https://github.com/PatterAI/Patter) Voice AI SDK. Claude Code connects via Streamable HTTP and gets access to voice calling tools. During calls, the AI agent can read files, run commands, and search code in real time.

## Quickstart

### 1. Clone and install

```bash
git clone https://github.com/PatterAI/patter-mcp
cd patter-mcp
npm install
cp .env.example .env   # fill in your API keys
```

### 2. Start the server

```bash
npm run dev    # development
# or
npm run build && npm start   # production
```

### 3. Connect Claude Code

```bash
claude mcp add --transport http patter-mcp http://localhost:3000/mcp
```

### 4. Use it

Ask Claude:

> "Call +15551234567 and ask them about their order status"

> "Call this restaurant and ask if there's a table for 2 tonight"

> "Show me the transcript from the last call"

## Features

### MCP Tools

| Tool | Description |
|---|---|
| `make_call` | Place an outbound call with an AI voice agent |
| `call_third_party` | Call a third party with an autonomous task (e.g. restaurant reservation) |
| `get_calls` | List all calls with status, duration, and cost |
| `get_transcript` | Get the full conversation transcript of a call |

### Claude Code Integration (used by the AI agent during calls)

During a phone call, the voice agent has access to a full Claude Code session via the [Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview). This means the agent can:

- Read, write, and edit files
- Run shell commands and tests
- Search codebases with Glob and Grep
- Create git commits
- Install dependencies
- Anything Claude Code can do interactively

## How It Works

<table>
<tr>
<th align="center">Claude Code</th>
<th align="center"></th>
<th align="center">Patter MCP</th>
<th align="center"></th>
<th align="center">Phone Calls</th>
</tr>
<tr>
<td align="center">
  <strong>You</strong><br><sub>Claude Code / Desktop</sub><br><br>
  <code>make_call</code><br>
  <code>call_third_party</code><br>
  <code>get_transcript</code>
</td>
<td align="center">→</td>
<td align="center">
  <strong>MCP Server</strong><br>
  <em>Streamable HTTP :3000</em><br><br>
  <strong>Patter SDK</strong><br>
  <em>Twilio + STT/TTS :8000</em><br><br>
  <strong>Claude Code</strong><br>
  <em>Agent SDK (in-call)</em>
</td>
<td align="center">→</td>
<td align="center">
  <strong>Outbound</strong><br><sub>Call users & third parties</sub><br><br>
  <strong>Inbound</strong><br><sub>Answer on your number</sub>
</td>
</tr>
</table>

### Example: Claude Code calls the user

```
1. Claude Code needs approval for a plan
2. → make_call({ to: "+39...", systemPrompt: "Describe the plan..." })
3. Phone rings, user answers
4. AI agent: "Hi, I have a plan for the auth refactor..."
5. User: "Show me the current auth.ts file"
6. → claude_code({ task: "read src/auth.ts" })  [Claude Code Agent SDK]
7. AI agent: "The file has 45 lines, it uses JWT tokens..."
8. User: "Fix the token expiration bug"
9. → claude_code({ task: "fix the token expiration bug in auth.ts" })
10. AI agent: "Done. I updated line 23 to use a 24h expiration..."
11. User: "Run the tests"
12. → claude_code({ task: "run the tests" })
13. AI agent: "All 42 tests passing."
14. Call ends → transcript returned to Claude Code
```

### Example: Call a restaurant

```
1. User: "Call the restaurant and ask if there's a table for 2 at 8pm"
2. → call_third_party({ to: "+39...", task: "ask for a table for 2 at 8pm" })
3. AI agent calls restaurant autonomously
4. Agent: "Buonasera, c'è un tavolo per due stasera alle 20?"
5. Restaurant: "Sì, abbiamo disponibilità"
6. → transcript returned to Claude Code
7. Claude: "The restaurant confirmed a table for 2 at 8pm tonight."
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Yes | Your Twilio phone number (E.164) |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `DEEPGRAM_API_KEY` | Yes | Deepgram STT key (for voice tools) |
| `ELEVENLABS_API_KEY` | Yes | ElevenLabs TTS key (for voice tools) |
| `MCP_PORT` | No | MCP server port (default: 3000) |
| `PATTER_PORT` | No | Patter server port (default: 8000) |
| `AGENT_SYSTEM_PROMPT` | No | Default system prompt for inbound calls |
| `AGENT_VOICE` | No | Default TTS voice (default: nova) |

```bash
cp .env.example .env
# Edit .env with your API keys
```

### Lifecycle modes

The embedded Patter server (HTTP + cloudflared tunnel) is expensive to boot. By default it starts **lazily** on the first tool call, so MCP sessions that never place a call pay zero startup cost. Four modes are supported:

| Mode | Trigger | When to use |
|---|---|---|
| **Lazy** (default) | No env var set | Local dev, Claude Code sessions where calls are occasional |
| **Eager** | `PATTER_EAGER=1` | CI smoke tests, demos where the first call must be instant |
| **Stable tunnel** | `PATTER_TUNNEL_HOSTNAME=patter.example.com` | Long-running deployments — named cloudflared tunnel, stable webhook URL across restarts |
| **Production webhook** | `WEBHOOK_URL=https://your.api/webhook` | Hosted deployments behind your own ingress, no tunnel |

#### Lazy (default)

```bash
npm start
# MCP server up immediately; Patter HTTP/tunnel boots on first make_call.
```

The first `make_call` (or any other tool) triggers a one-time boot. Concurrent tool calls during boot coalesce on a single in-flight promise — no double-boot. If boot fails (e.g. tunnel handshake error), the next tool call retries cleanly.

#### Eager

```bash
PATTER_EAGER=1 npm start
```

Boots the Patter server during MCP startup. Same behaviour as `patter-mcp` ≤ 0.2.x. Use when you need the first call to be instant or you want startup errors to surface immediately (rather than at first tool call).

#### Stable tunnel (named cloudflared)

```bash
PATTER_TUNNEL_HOSTNAME=patter.your-domain.com npm start
```

Patter uses a **named** cloudflared tunnel with a stable hostname instead of the default quick tunnel (which generates a fresh `*.trycloudflare.com` URL on every restart). Required when you've configured a Twilio/Telnyx webhook to point at a fixed URL.

Prerequisites: a cloudflared tunnel created with `cloudflared tunnel create patter` and the corresponding DNS CNAME pointing to `<tunnel-id>.cfargotunnel.com`.

#### Production webhook (no tunnel)

```bash
WEBHOOK_URL=https://your-domain.com/webhook npm start
```

Skip cloudflared entirely. Use when the MCP server is deployed behind your own ingress (nginx, Caddy, k8s ingress, Fly.io, Railway, etc.) and the carrier webhook can reach it directly. The Patter SDK will not attempt to start a tunnel — it just listens on `PATTER_PORT` and trusts the URL you provided.

#### Health check

`/health` exposes the current lifecycle state:

```json
{
  "status": "ok",
  "mode": "mcp",
  "phone": "+15551234567",
  "serverRunning": false,   // ← true after first tool call (lazy mode)
  "activeSessions": 1
}
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "patter-mcp": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Development

```bash
npm run dev          # Run with tsx (auto-restart)
npm run build        # Build for production
npm start            # Run built version
```

## Distribution

`patter-mcp` is distributed as a **GitHub repository**, not an npm
package. The recommended install path is `git clone && npm install &&
npm start` — pair it with the [Claude Code / Hermes / OpenClaw / Cursor
HTTP-transport config block](#claude-desktop) shown above.

Why not `npx -y getpatter-mcp` like other MCP servers?

1. **HTTP transport, not stdio.** patter-mcp uses
   [`mcp-use/server`](https://github.com/mcp-use/mcp-use) over HTTP, so
   clients connect by URL. They never need to `npx`-launch the server
   as a subprocess. The `npx -y` install path is required only for
   stdio servers.

2. **Native dependencies are slow.** `better-sqlite3` (compiled via
   `node-gyp`) and `cloudflared` (postinstall binary download) push
   the cold-start of `npx -y` into the 30s+ range — a poor first
   impression for an MCP server. `git clone && npm install` does the
   same work once, up-front, with no surprise.

3. **Supply-chain blast radius.** Recent npm supply-chain attacks
   (Shai-Hulud, Sep 2025; mini-Shai-Hulud, May 2026) explicitly
   targeted MCP-adjacent packages. GitHub-only distribution keeps the
   trust boundary on the repo + Cloudflare/Twilio carrier
   credentials, not on a freshly-downloaded npm tarball.

The package is structurally ready for npm publish (has `bin` entry,
shebang, and `files` array) — if the broader Patter community asks
for `npx -y` later, we can flip it on without a refactor.

## Contributing

Pull requests are welcome. Please open an issue before submitting large changes.

## License

MIT — see [LICENSE](./LICENSE).

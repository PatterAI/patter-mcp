<p align="center">
  <img src="./docs/github-banner.png" alt="Patter MCP" width="100%" />
</p>

An MCP server that gives your AI agent a phone number. Answer calls, dial out, edit code, call APIs, book meetings — all over voice.

Built on the [Patter](https://github.com/PatterAI/Patter) Voice AI SDK. Claude Code connects via Streamable HTTP and gets access to voice calling tools. During calls, the AI agent can read files, run commands, and search code in real time.

## Tools

### MCP Tools (used by Claude Code)

| Tool | Description |
|---|---|
| `make_call` | Place an outbound call with an AI voice agent |
| `call_third_party` | Call a third party with an autonomous task (e.g. restaurant reservation) |
| `get_calls` | List all calls with status, duration, and cost |
| `get_transcript` | Get the full conversation transcript of a call |

### Voice Tools (used by the AI agent during calls)

| Tool | Description |
|---|---|
| `read_file` | Read a file from the filesystem |
| `run_command` | Execute a shell command (30s timeout) |
| `search_code` | Search for a pattern in code files |

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/PatterAI/patter-mcp
cd patter-mcp
npm install
cp .env.example .env   # fill in your API keys
```

### 2. Start the server

```bash
npm run dev    # development with hot reload
# or
npm run build && npm start   # production
```

You'll see:
```
Patter MCP Server

MCP endpoint:  http://localhost:3000/mcp
Patter server: http://localhost:8000/
Phone number:  +16592214527
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

People can also call your Twilio number — the AI agent answers and can read files, run commands, and search code during the conversation.

## How It Works

```
Claude Code
  |
  | Streamable HTTP (POST /mcp)
  v
patter-mcp (Express, port 3000) ← always online
  |
  ├── MCP tools: make_call, call_third_party, get_calls, get_transcript
  |
  ├── Patter SDK (port 8000) ← Twilio webhooks + Cloudflare tunnel
  |     Pipeline mode: Deepgram STT → LLM → ElevenLabs TTS
  |     Voice tools: read_file, run_command, search_code
  |
  └── Phone calls (in/out via Twilio)
```

### Example: Claude Code calls the user

```
1. Claude Code needs approval for a plan
2. → tool_call: make_call({ to: "+39...", systemPrompt: "Describe the plan..." })
3. Phone rings, user answers
4. AI agent: "Hi, I have a plan for the authentication refactor..."
5. User: "Show me the current auth.ts file"
6. → voice tool: read_file({ path: "src/auth.ts" })  [executes in <100ms]
7. AI agent: "The file has 45 lines. It uses JWT tokens with..."
8. User: "Ok, proceed with the implementation"
9. Call ends → transcript returned to Claude Code
10. Claude Code reads transcript and implements
```

### Example: Call a restaurant

```
1. User: "Call +39055123456 and ask if there's a table for 2 at 8pm"
2. → tool_call: call_third_party({ to: "+39...", task: "ask for a table for 2 at 8pm" })
3. AI agent calls restaurant autonomously
4. Agent: "Buonasera, c'e' un tavolo per due stasera alle 20?"
5. Restaurant: "Si, abbiamo disponibilita'"
6. Call ends → full transcript returned to Claude Code
7. Claude: "The restaurant confirmed a table for 2 at 8pm tonight."
```

## Environment Variables

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

## Development

```bash
npm run dev          # Run with tsx (auto-restart)
npm run build        # Build for production
npm start            # Run built version
```

## License

MIT — see [LICENSE](./LICENSE).

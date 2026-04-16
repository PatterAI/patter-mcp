/**
 * Claude Code bridge — programmatic access to Claude Code via the Agent SDK
 * or an E2B sandbox depending on configuration.
 *
 * During a phone call, the voice agent can dispatch tasks to Claude Code.
 * Results are returned as text for the voice agent to speak.
 *
 * Modes:
 *   - E2B mode: when E2B_API_KEY is set, each call gets its own sandbox
 *     using the "claude" template. Claude Code CLI runs inside the sandbox.
 *   - Local mode: falls back to @anthropic-ai/claude-agent-sdk directly.
 */

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";
import { Sandbox } from "e2b";
import type { CommandResult } from "e2b";

function log(msg: string): void {
  process.stderr.write(`[claude-bridge] ${msg}\n`);
}

// ── Types ──────────────────────────────────────────────────────────────────

interface LocalSessionHandle {
  readonly kind: "local";
  readonly sessionId: string;
  readonly cwd: string;
}

interface E2BSandboxHandle {
  readonly kind: "e2b";
  readonly sandbox: Sandbox;
}

type CallHandle = LocalSessionHandle | E2BSandboxHandle;

// ── State ──────────────────────────────────────────────────────────────────

// Active handle per call — allows multi-turn within the same phone call
const callHandles = new Map<string, CallHandle>();

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Escape a string for safe inclusion inside a single-quoted shell argument.
 * Closes the single-quote, appends an escaped quote, then reopens single-quote.
 */
function escapeShellArg(input: string): string {
  return input.replace(/'/g, "'\\''");
}

function truncateForVoice(text: string): string {
  const MAX_CHARS = 3000;
  if (text.length <= MAX_CHARS) {
    return text;
  }
  return text.slice(0, MAX_CHARS) + "\n... [truncated for voice]";
}

// ── E2B mode ───────────────────────────────────────────────────────────────

async function getOrCreateSandbox(callId: string): Promise<Sandbox> {
  const existing = callHandles.get(callId);
  if (existing?.kind === "e2b") {
    return existing.sandbox;
  }

  log(`Creating E2B sandbox for call: ${callId}`);
  const sandbox = await Sandbox.create("claude", {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 10 * 60 * 1000, // 10 minutes max per sandbox
  });

  const handle: E2BSandboxHandle = { kind: "e2b", sandbox };
  callHandles.set(callId, handle);
  log(`E2B sandbox created: ${sandbox.sandboxId}`);
  return sandbox;
}

async function executeInE2B(command: string, callId: string): Promise<string> {
  const sandbox = await getOrCreateSandbox(callId);
  const escaped = escapeShellArg(command);
  const cliCommand = `claude --dangerously-skip-permissions -p '${escaped}'`;

  log(`Running in E2B sandbox ${sandbox.sandboxId}: ${command.slice(0, 80)}`);

  let result: CommandResult;
  try {
    result = await sandbox.commands.run(cliCommand, { timeoutMs: 5 * 60 * 1000 });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`E2B command error: ${errMsg}`);
    return `Claude Code error: ${errMsg}`;
  }

  const output = result.stdout || result.stderr || "Done. No text output.";
  log(`E2B result: ${output.length} chars (exit: ${result.exitCode})`);
  return truncateForVoice(output);
}

// ── Local mode (Agent SDK) ─────────────────────────────────────────────────

async function executeLocally(
  command: string,
  callId: string,
  cwd?: string,
): Promise<string> {
  const workDir = cwd ?? process.cwd();
  const existing = callHandles.get(callId);

  log(`Executing locally: "${command.slice(0, 80)}${command.length > 80 ? "..." : ""}" (call: ${callId})`);

  let resultText = "";

  if (existing?.kind === "local") {
    log(`Resuming session ${existing.sessionId}`);
    await using session = unstable_v2_resumeSession(existing.sessionId, {
      model: "sonnet",
      permissionMode: "acceptEdits",
    });

    await session.send(command);
    for await (const msg of session.stream()) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text") {
            resultText += block.text;
          }
        }
      }
    }
  } else {
    log(`Creating new local session in ${workDir}`);
    await using session = unstable_v2_createSession({
      model: "sonnet",
      permissionMode: "acceptEdits",
      allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    });

    const sessionId = (session as unknown as { sessionId?: string }).sessionId;
    if (sessionId) {
      const handle: LocalSessionHandle = { kind: "local", sessionId, cwd: workDir };
      callHandles.set(callId, handle);
      log(`Local session created: ${sessionId}`);
    }

    await session.send(command);
    for await (const msg of session.stream()) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text") {
            resultText += block.text;
          }
        }
      }
    }
  }

  log(`Local result: ${resultText.length} chars`);
  return truncateForVoice(resultText) || "Done. No text output.";
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Execute a Claude Code command and return the text result.
 *
 * Routes to E2B sandboxed execution when E2B_API_KEY is set, otherwise
 * falls back to the local Agent SDK. Within a call, the same sandbox or
 * session is reused to support multi-turn interactions.
 */
export async function executeClaudeCode(
  command: string,
  callId: string,
  cwd?: string,
): Promise<string> {
  try {
    if (process.env.E2B_API_KEY) {
      return await executeInE2B(command, callId);
    }
    return await executeLocally(command, callId, cwd);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error: ${errMsg}`);
    return `Claude Code error: ${errMsg}`;
  }
}

/**
 * Clean up all resources when a call ends.
 * In E2B mode this kills the sandbox; in local mode it removes the session reference.
 */
export async function endCallSession(callId: string): Promise<void> {
  const handle = callHandles.get(callId);
  callHandles.delete(callId);

  if (handle?.kind === "e2b") {
    log(`Killing E2B sandbox for call: ${callId}`);
    try {
      await handle.sandbox.kill();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Warning: failed to kill sandbox: ${errMsg}`);
    }
  }
}

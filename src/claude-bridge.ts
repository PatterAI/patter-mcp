/**
 * Claude Code bridge — programmatic access to Claude Code via the Agent SDK.
 *
 * During a phone call, the voice agent can dispatch tasks to Claude Code.
 * Claude Code has full access to all its tools: Read, Write, Edit, Bash,
 * Glob, Grep, etc. Results are returned as text for the voice agent to speak.
 */

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";

function log(msg: string): void {
  process.stderr.write(`[claude-bridge] ${msg}\n`);
}

interface SessionHandle {
  sessionId: string;
  cwd: string;
}

// Active session per call — allows multi-turn within the same phone call
const callSessions = new Map<string, SessionHandle>();

/**
 * Execute a Claude Code command and return the text result.
 *
 * If a session already exists for this callId, it resumes the conversation.
 * Otherwise, it creates a new session. This allows multi-turn interactions
 * during a single phone call (e.g. "read the file" → "now fix the bug").
 */
export async function executeClaudeCode(
  command: string,
  callId: string,
  cwd?: string,
): Promise<string> {
  const workDir = cwd || process.cwd();
  const existing = callSessions.get(callId);

  log(`Executing: "${command.slice(0, 80)}${command.length > 80 ? "..." : ""}" (call: ${callId})`);

  try {
    let resultText = "";

    if (existing) {
      // Resume existing session for this call
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
      // Create new session
      log(`Creating new session in ${workDir}`);
      await using session = unstable_v2_createSession({
        model: "sonnet",
        permissionMode: "acceptEdits",
        cwd: workDir,
        allowedTools: [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
        ],
      });

      // Capture session ID from init
      const sessionId = (session as unknown as { sessionId?: string }).sessionId;
      if (sessionId) {
        callSessions.set(callId, { sessionId, cwd: workDir });
        log(`Session created: ${sessionId}`);
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

    // Truncate for voice (LLM will summarize anyway)
    if (resultText.length > 3000) {
      resultText = resultText.slice(0, 3000) + "\n... [truncated for voice]";
    }

    log(`Result: ${resultText.length} chars`);
    return resultText || "Done. No text output.";
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error: ${errMsg}`);
    return `Claude Code error: ${errMsg}`;
  }
}

/** Clean up session when a call ends. */
export function endCallSession(callId: string): void {
  callSessions.delete(callId);
}

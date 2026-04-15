/**
 * Voice tools — Patter tool handlers that execute DURING a phone call.
 *
 * The main tool is `claude_code` which dispatches to a real Claude Code
 * session via the Agent SDK. Claude Code has full access to Read, Write,
 * Edit, Bash, Glob, Grep — everything the interactive CLI can do.
 */

import { executeClaudeCode } from "./claude-bridge.js";

export interface VoiceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    context: Record<string, unknown>,
  ) => Promise<string>;
}

export const claudeCodeTool: VoiceTool = {
  name: "claude_code",
  description:
    "Execute a task using Claude Code. Claude Code can read files, write code, " +
    "edit files, run shell commands, search codebases, create commits, run tests, " +
    "and more. Use this for any coding or file operation the caller asks for.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "The task to execute (e.g. 'read src/auth.ts', 'fix the bug in login', " +
          "'run the tests', 'search for getUserById usage')",
      },
    },
    required: ["task"],
  },
  handler: async (args, context) => {
    const callId = (context.call_id as string) || "unknown";
    const result = await executeClaudeCode(args.task as string, callId);
    return JSON.stringify({ result });
  },
};

export const allVoiceTools: VoiceTool[] = [claudeCodeTool];

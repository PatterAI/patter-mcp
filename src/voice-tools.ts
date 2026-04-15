/**
 * Voice tools — Patter tool handlers that execute DURING a phone call.
 *
 * These are NOT MCP tools. They are registered as Patter agent tools with
 * local handlers. When the LLM decides to use one during a conversation,
 * the handler runs in-process and the result is spoken back to the caller.
 */

import fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface VoiceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    context: Record<string, unknown>
  ) => Promise<string>;
}

export const readFileTool: VoiceTool = {
  name: "read_file",
  description:
    "Read a file from the project filesystem. Use when the caller asks to see code, check a file, or review an implementation.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute or relative to working directory)",
      },
    },
    required: ["path"],
  },
  handler: async (args) => {
    try {
      const content = await fs.readFile(args.path as string, "utf-8");
      const lines = content.split("\n").length;
      const truncated =
        content.length > 2000
          ? content.slice(0, 2000) + "\n... [truncated, file has " + lines + " lines]"
          : content;
      return JSON.stringify({ path: args.path, lines, content: truncated });
    } catch (e) {
      return JSON.stringify({
        error: `Cannot read file: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
};

export const runCommandTool: VoiceTool = {
  name: "run_command",
  description:
    "Execute a shell command. Use when asked to run tests, check git status, list files, or perform any terminal operation.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
    },
    required: ["command"],
  },
  handler: async (args) => {
    try {
      const { stdout, stderr } = await execAsync(args.command as string, {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const out = (stdout || "").slice(0, 1000);
      const err = (stderr || "").slice(0, 500);
      return JSON.stringify({ stdout: out, stderr: err || undefined });
    } catch (e) {
      return JSON.stringify({
        error: `Command failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
};

export const searchCodeTool: VoiceTool = {
  name: "search_code",
  description:
    "Search for a pattern in code files using grep. Use when asked to find where something is defined or used.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search pattern (supports regex)",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: current directory)",
      },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const searchPath = (args.path as string) || ".";
    const query = (args.query as string).replace(/"/g, '\\"');
    try {
      const { stdout } = await execAsync(
        `grep -rn "${query}" ${searchPath} --include="*.ts" --include="*.py" --include="*.js" --include="*.tsx" --include="*.jsx" | head -10`,
        { timeout: 10_000 }
      );
      return JSON.stringify({
        matches: stdout || "No matches found",
      });
    } catch {
      return JSON.stringify({ matches: "No matches found" });
    }
  },
};

export const allVoiceTools: VoiceTool[] = [
  readFileTool,
  runCommandTool,
  searchCodeTool,
];

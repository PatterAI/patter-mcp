import { z } from "zod";
import type { PatterServer } from "../patter-server.js";

export const makeCallSchema = {
  to: z.string().describe("Phone number to call in E.164 format (e.g. +15551234567)"),
  systemPrompt: z.string().describe("Instructions for the AI voice agent on the call"),
  firstMessage: z.string().optional().describe("Opening message when the callee answers"),
  voice: z.string().optional().describe("TTS voice name (e.g. alloy, nova, shimmer)"),
  machineDetection: z.boolean().optional().describe("Enable answering machine detection"),
  voicemailMessage: z.string().optional().describe("Message to leave on voicemail"),
};

export async function makeCallHandler(
  args: {
    to: string;
    systemPrompt: string;
    firstMessage?: string;
    voice?: string;
    machineDetection?: boolean;
    voicemailMessage?: string;
  },
  patter: PatterServer,
) {
  try {
    const callId = await patter.makeCall(
      args.to,
      args.systemPrompt,
      args.firstMessage,
      args.voice,
      args.machineDetection,
      args.voicemailMessage,
    );

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Call initiated to ${args.to}.\n\n` +
            `Call ID: ${callId}\n` +
            `Status: ringing\n\n` +
            `The AI agent will speak using the system prompt you provided.\n` +
            `During the call, the agent can read files, run commands, and search code.\n\n` +
            `Use get_calls to check status. Use get_transcript when the call completes.`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to place call: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

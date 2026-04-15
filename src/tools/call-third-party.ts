import { z } from "zod";
import type { PatterServer, CallRecord } from "../patter-server.js";

export const callThirdPartySchema = {
  to: z.string().describe("Phone number to call in E.164 format"),
  task: z.string().describe("What the AI agent should accomplish on the call (e.g. 'ask if there is a table for 2 tonight at 8pm')"),
  voice: z.string().optional().describe("TTS voice name"),
};

function formatTranscript(transcript: Array<{ role: string; text: string }>): string {
  if (!transcript.length) return "(no transcript)";
  return transcript.map((t) => `[${t.role}] ${t.text}`).join("\n");
}

export async function callThirdPartyHandler(
  args: { to: string; task: string; voice?: string },
  patter: PatterServer,
) {
  try {
    const record: CallRecord = await patter.callThirdParty(
      args.to,
      args.task,
      args.voice,
    );

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Call to ${args.to} completed.\n\n` +
            `Duration: ${record.duration || 0}s\n` +
            `Status: ${record.status}\n\n` +
            `Transcript:\n${formatTranscript(record.transcript)}`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Third-party call failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

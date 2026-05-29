import { z } from "zod";
import type { PatterServer, MakeCallOptions, CallRecord } from "../patter-server.js";

export const makeCallSchema = z.object({
  to: z.string().describe("Phone number to call in E.164 format (e.g. +15551234567)"),
  systemPrompt: z.string().describe("Instructions for the AI voice agent on the call"),
  firstMessage: z.string().optional().describe("Opening message when the callee answers"),
  voice: z.string().optional().describe("TTS voice name (e.g. alloy, nova, shimmer)"),
  machineDetection: z.boolean().optional().describe("Enable answering machine detection"),
  voicemailMessage: z.string().optional().describe("Message to leave on voicemail"),
});

export type MakeCallInput = z.infer<typeof makeCallSchema>;

function formatTranscript(transcript: Array<{ role: string; text: string }>): string {
  if (!transcript.length) return "(no transcript)";
  return transcript.map((t) => `[${t.role}] ${t.text}`).join("\n");
}

export async function makeCallHandler(
  args: MakeCallInput,
  patter: PatterServer,
  userId?: string,
) {
  try {
    const callOptions: MakeCallOptions = {
      to: args.to,
      systemPrompt: args.systemPrompt,
      firstMessage: args.firstMessage,
      voice: args.voice,
      machineDetection: args.machineDetection,
      voicemailMessage: args.voicemailMessage,
      userId,
    };
    // makeCall blocks until the call reaches a terminal state (the SDK's
    // call({ wait: true }) primitive) and returns the mapped CallRecord.
    const record: CallRecord = await patter.makeCall(callOptions);

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Call to ${args.to} ${record.status === "completed" ? "completed" : "ended"}.\n\n` +
            `Call ID: ${record.callId}\n` +
            `Outcome: ${record.outcome ?? "unknown"}\n` +
            `Status: ${record.status}\n` +
            `Duration: ${record.duration ?? 0}s\n\n` +
            `Transcript:\n${formatTranscript(record.transcript)}\n\n` +
            `Use get_transcript with Call ID ${record.callId} for the full record.`,
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

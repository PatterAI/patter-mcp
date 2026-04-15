import { z } from "zod";
import type { PatterServer } from "../patter-server.js";

export const getTranscriptSchema = {
  callId: z.string().describe("The call ID returned by make_call or shown in get_calls"),
};

export async function getTranscriptHandler(
  args: { callId: string },
  patter: PatterServer,
) {
  const call = patter.calls.get(args.callId);

  if (!call) {
    return {
      content: [
        { type: "text" as const, text: `Call ${args.callId} not found.` },
      ],
      isError: true,
    };
  }

  if (call.status !== "completed" && call.status !== "failed") {
    return {
      content: [
        {
          type: "text" as const,
          text: `Call ${args.callId} is still ${call.status}. Transcript available after the call ends.`,
        },
      ],
    };
  }

  if (call.transcript.length === 0) {
    return {
      content: [
        { type: "text" as const, text: `Call ${args.callId} has no transcript.` },
      ],
    };
  }

  const lines = call.transcript.map((t) => `[${t.role}] ${t.text}`);
  const header =
    `Call: ${call.callId}\n` +
    `Direction: ${call.direction}\n` +
    `${call.direction === "outbound" ? `To: ${call.to}` : `From: ${call.from}`}\n` +
    `Duration: ${call.duration || 0}s\n` +
    `Turns: ${call.transcript.length}\n` +
    `---\n`;

  return {
    content: [{ type: "text" as const, text: header + lines.join("\n") }],
  };
}

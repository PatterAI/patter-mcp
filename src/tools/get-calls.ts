import type { PatterServer } from "../patter-server.js";

export async function getCallsHandler(patter: PatterServer, userId?: string) {
  const calls = patter.getCallsForUser(userId);

  if (calls.size === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No calls yet. Use make_call to place a call.",
        },
      ],
    };
  }

  const lines: string[] = [];
  for (const [, call] of calls) {
    const dir = call.direction === "outbound" ? "OUT" : " IN";
    const dur = call.duration
      ? `${call.duration}s`
      : call.status === "in-progress"
        ? `${Math.round((Date.now() - call.startedAt) / 1000)}s (ongoing)`
        : "-";
    const cost =
      call.metrics &&
      (call.metrics as Record<string, Record<string, number>>).cost
        ? `$${((call.metrics as Record<string, Record<string, number>>).cost.total || 0).toFixed(4)}`
        : "-";
    const turns = call.transcript.length;

    lines.push(
      `${dir} | ${call.status.padEnd(12)} | ${call.callId}\n` +
        `     ${call.direction === "outbound" ? `To: ${call.to}` : `From: ${call.from}`} | Duration: ${dur} | Cost: ${cost} | Turns: ${turns}`
    );
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n\n") }],
  };
}

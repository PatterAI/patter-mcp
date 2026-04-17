import { describe, it, expect, vi } from "vitest";
import { getTranscriptHandler } from "./get-transcript.js";
import type { PatterServer, CallRecord } from "../patter-server.js";

// ---------------------------------------------------------------------------
// Minimal mock PatterServer
// ---------------------------------------------------------------------------

function makeMockPatter(call?: CallRecord): PatterServer {
  return {
    getCallForUser: vi.fn((_callId: string, _userId?: string) => call),
    getCallsForUser: vi.fn(() => new Map()),
    makeCall: vi.fn(),
    callThirdParty: vi.fn(),
    waitForCallEnd: vi.fn(),
    startServer: vi.fn(),
    simulateCallEnd: vi.fn(),
    calls: new Map(),
    phoneNumber: "+15550000000",
    isServerRunning: false,
  } as unknown as PatterServer;
}

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call_transcript_test",
    direction: "outbound",
    status: "completed",
    startedAt: Date.now() - 120_000,
    endedAt: Date.now(),
    duration: 120,
    transcript: [],
    to: "+15551234567",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getTranscriptHandler", () => {
  it("returns an error result when the call is not found", async () => {
    // Arrange
    const patter = makeMockPatter(undefined);

    // Act
    const result = await getTranscriptHandler({ callId: "call_missing" }, patter, "user-1");

    // Assert
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("call_missing");
    expect(result.content[0].text).toContain("not found");
  });

  it("returns in-progress message when call is still active", async () => {
    const call = makeCall({ status: "in-progress", transcript: [] });
    const patter = makeMockPatter(call);

    const result = await getTranscriptHandler({ callId: call.callId }, patter);

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("in-progress");
    expect(result.content[0].text).toContain("Transcript available after");
  });

  it("returns ringing message when call is still ringing", async () => {
    const call = makeCall({ status: "ringing", transcript: [] });
    const patter = makeMockPatter(call);

    const result = await getTranscriptHandler({ callId: call.callId }, patter);

    expect(result.content[0].text).toContain("ringing");
  });

  it("returns no-transcript message for a completed call with empty transcript", async () => {
    const call = makeCall({ status: "completed", transcript: [] });
    const patter = makeMockPatter(call);

    const result = await getTranscriptHandler({ callId: call.callId }, patter);

    expect(result.content[0].text).toContain("no transcript");
  });

  it("returns formatted transcript for a completed call with turns", async () => {
    // Arrange
    const call = makeCall({
      status: "completed",
      transcript: [
        { role: "assistant", text: "Hello, how can I help?" },
        { role: "user", text: "I have a question." },
        { role: "assistant", text: "Of course!" },
      ],
    });
    const patter = makeMockPatter(call);

    // Act
    const result = await getTranscriptHandler({ callId: call.callId }, patter);

    // Assert
    const text = result.content[0].text;
    expect(text).toContain("[assistant] Hello, how can I help?");
    expect(text).toContain("[user] I have a question.");
    expect(text).toContain("[assistant] Of course!");
  });

  it("includes call metadata header in the transcript output", async () => {
    const call = makeCall({
      status: "completed",
      direction: "outbound",
      to: "+15559998888",
      duration: 75,
      transcript: [{ role: "user", text: "hi" }],
    });
    const patter = makeMockPatter(call);

    const result = await getTranscriptHandler({ callId: call.callId }, patter);
    const text = result.content[0].text;

    expect(text).toContain(`Call: ${call.callId}`);
    expect(text).toContain("Direction: outbound");
    expect(text).toContain("To: +15559998888");
    expect(text).toContain("Duration: 75s");
    expect(text).toContain("Turns: 1");
    expect(text).toContain("---");
  });

  it("uses 'From:' label for inbound calls in the header", async () => {
    const call = makeCall({
      direction: "inbound",
      from: "+15554443333",
      to: undefined,
      status: "completed",
      transcript: [{ role: "user", text: "hi" }],
    });
    const patter = makeMockPatter(call);

    const result = await getTranscriptHandler({ callId: call.callId }, patter);
    expect(result.content[0].text).toContain("From: +15554443333");
  });

  it("handles a failed call with transcript", async () => {
    const call = makeCall({
      status: "failed",
      transcript: [{ role: "assistant", text: "Attempting to connect..." }],
    });
    const patter = makeMockPatter(call);

    const result = await getTranscriptHandler({ callId: call.callId }, patter);
    expect(result.content[0].text).toContain("[assistant] Attempting to connect...");
  });

  it("passes userId to getCallForUser for ownership enforcement", async () => {
    const call = makeCall({ status: "completed", transcript: [{ role: "user", text: "test" }] });
    const patter = makeMockPatter(call);

    await getTranscriptHandler({ callId: call.callId }, patter, "user-owner");

    expect(patter.getCallForUser).toHaveBeenCalledWith(call.callId, "user-owner");
  });
});

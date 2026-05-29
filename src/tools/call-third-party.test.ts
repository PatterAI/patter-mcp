import { describe, it, expect, vi } from "vitest";
import { callThirdPartyHandler } from "./call-third-party.js";
import type { PatterServer, CallRecord } from "../patter-server.js";

// ---------------------------------------------------------------------------
// Minimal mock PatterServer
// ---------------------------------------------------------------------------

function makeCompletedRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call_third_party_test",
    direction: "outbound",
    status: "completed",
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    duration: 45,
    to: "+15551234567",
    transcript: [
      { role: "assistant", text: "Hello, I'm calling to ask about availability." },
      { role: "user", text: "Yes, we have a table for 2 at 8pm." },
    ],
    metrics: {
      cost: { stt: 0.001, tts: 0.002, llm: 0.005, telephony: 0.01, total: 0.018 },
    },
    ...overrides,
  };
}

function makeMockPatter(callThirdPartyImpl: (to: string, task: string, voice?: string, userId?: string) => Promise<CallRecord>): PatterServer {
  return {
    callThirdParty: vi.fn(callThirdPartyImpl),
    getCallsForUser: vi.fn(() => new Map()),
    getCallForUser: vi.fn(),
    makeCall: vi.fn(),
    startServer: vi.fn(),
    simulateCallEnd: vi.fn(),
    disconnect: vi.fn(),
    calls: new Map(),
    phoneNumber: "+15550000000",
    isServerRunning: false,
  } as unknown as PatterServer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callThirdPartyHandler", () => {
  it("returns success content with transcript when call completes", async () => {
    // Arrange
    const record = makeCompletedRecord();
    const patter = makeMockPatter(() => Promise.resolve(record));

    // Act
    const result = await callThirdPartyHandler(
      { to: "+15551234567", task: "Ask about a table for 2 at 8pm" },
      patter,
      "user-1",
    );

    // Assert
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("+15551234567");
    expect(result.content[0].text).toContain("completed");
  });

  it("includes the transcript in the success output", async () => {
    const record = makeCompletedRecord();
    const patter = makeMockPatter(() => Promise.resolve(record));

    const result = await callThirdPartyHandler(
      { to: "+15551234567", task: "ask about availability" },
      patter,
    );

    const text = result.content[0].text;
    expect(text).toContain("[assistant] Hello, I'm calling to ask about availability.");
    expect(text).toContain("[user] Yes, we have a table for 2 at 8pm.");
  });

  it("shows '(no transcript)' when transcript is empty", async () => {
    const record = makeCompletedRecord({ transcript: [] });
    const patter = makeMockPatter(() => Promise.resolve(record));

    const result = await callThirdPartyHandler(
      { to: "+15551234567", task: "quick check" },
      patter,
    );

    expect(result.content[0].text).toContain("(no transcript)");
  });

  it("includes duration in the output", async () => {
    const record = makeCompletedRecord({ duration: 45 });
    const patter = makeMockPatter(() => Promise.resolve(record));

    const result = await callThirdPartyHandler(
      { to: "+15551234567", task: "check hours" },
      patter,
    );

    expect(result.content[0].text).toContain("Duration: 45s");
  });

  it("passes arguments correctly to patter.callThirdParty", async () => {
    const record = makeCompletedRecord();
    const patter = makeMockPatter(() => Promise.resolve(record));

    await callThirdPartyHandler(
      { to: "+15559998888", task: "Book a reservation", voice: "nova" },
      patter,
      "user-xyz",
    );

    expect(patter.callThirdParty).toHaveBeenCalledWith(
      "+15559998888",
      "Book a reservation",
      "nova",
      "user-xyz",
    );
  });

  it("passes undefined voice when not specified", async () => {
    const record = makeCompletedRecord();
    const patter = makeMockPatter(() => Promise.resolve(record));

    await callThirdPartyHandler(
      { to: "+15559998888", task: "Ask a question" },
      patter,
    );

    expect(patter.callThirdParty).toHaveBeenCalledWith(
      "+15559998888",
      "Ask a question",
      undefined,
      undefined,
    );
  });

  it("returns an error result when callThirdParty throws", async () => {
    // Arrange
    const patter = makeMockPatter(() => Promise.reject(new Error("Call timed out")));

    // Act
    const result = await callThirdPartyHandler(
      { to: "+15551234567", task: "check availability" },
      patter,
    );

    // Assert
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Third-party call failed");
    expect(result.content[0].text).toContain("Call timed out");
  });

  it("handles non-Error thrown values gracefully", async () => {
    const patter = makeMockPatter(() => Promise.reject("network error"));

    const result = await callThirdPartyHandler(
      { to: "+15551234567", task: "test" },
      patter,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("network error");
  });

  it("handles a failed call status in the record", async () => {
    const record = makeCompletedRecord({ status: "failed" });
    const patter = makeMockPatter(() => Promise.resolve(record));

    const result = await callThirdPartyHandler(
      { to: "+15551234567", task: "quick test" },
      patter,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("failed");
  });
});

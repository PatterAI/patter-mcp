import { describe, it, expect, vi } from "vitest";
import { getCallsHandler } from "./get-calls.js";
import type { PatterServer, CallRecord } from "../patter-server.js";

// ---------------------------------------------------------------------------
// Minimal mock PatterServer
// ---------------------------------------------------------------------------

function makeMockPatter(calls: Map<string, CallRecord>): PatterServer {
  return {
    getCallsForUser: vi.fn((_userId?: string) => calls as ReadonlyMap<string, CallRecord>),
    getCallForUser: vi.fn(),
    makeCall: vi.fn(),
    callThirdParty: vi.fn(),
    startServer: vi.fn(),
    simulateCallEnd: vi.fn(),
    disconnect: vi.fn(),
    calls: new Map(),
    phoneNumber: "+15550000000",
    isServerRunning: false,
  } as unknown as PatterServer;
}

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call_test_" + Math.random().toString(36).slice(2),
    direction: "outbound",
    status: "completed",
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    duration: 60,
    transcript: [],
    to: "+15551234567",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCallsHandler", () => {
  it("returns a no-calls message when the map is empty", async () => {
    // Arrange
    const patter = makeMockPatter(new Map());

    // Act
    const result = await getCallsHandler(patter, "user-1");

    // Assert
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("No calls yet");
    expect(result.content[0].text).toContain("make_call");
  });

  it("lists a single outbound call with its details", async () => {
    // Arrange
    const call = makeCall({ callId: "call_abc", to: "+15559999999", duration: 90 });
    const patter = makeMockPatter(new Map([["call_abc", call]]));

    // Act
    const result = await getCallsHandler(patter, "user-1");

    // Assert
    expect(result.content[0].text).toContain("call_abc");
    expect(result.content[0].text).toContain("+15559999999");
    expect(result.content[0].text).toContain("90s");
  });

  it("includes direction label 'OUT' for outbound calls", async () => {
    const call = makeCall({ direction: "outbound" });
    const patter = makeMockPatter(new Map([[call.callId, call]]));

    const result = await getCallsHandler(patter);

    expect(result.content[0].text).toContain("OUT");
  });

  it("includes direction label ' IN' for inbound calls", async () => {
    const call = makeCall({ direction: "inbound", from: "+15557777777", to: undefined });
    const patter = makeMockPatter(new Map([[call.callId, call]]));

    const result = await getCallsHandler(patter);

    expect(result.content[0].text).toContain(" IN");
    expect(result.content[0].text).toContain("+15557777777");
  });

  it("shows '(ongoing)' label for in-progress calls without duration", async () => {
    const call = makeCall({ status: "in-progress", duration: undefined, endedAt: undefined });
    const patter = makeMockPatter(new Map([[call.callId, call]]));

    const result = await getCallsHandler(patter);

    expect(result.content[0].text).toContain("ongoing");
  });

  it("shows '-' for calls with no duration and no in-progress status", async () => {
    const call = makeCall({ status: "failed", duration: undefined, endedAt: undefined });
    const patter = makeMockPatter(new Map([[call.callId, call]]));

    const result = await getCallsHandler(patter);

    expect(result.content[0].text).toContain("| Duration: -");
  });

  it("formats cost from metrics when present", async () => {
    const call = makeCall({
      metrics: { cost: { stt: 0.001, tts: 0.002, llm: 0.005, telephony: 0.01, total: 0.018 } },
    });
    const patter = makeMockPatter(new Map([[call.callId, call]]));

    const result = await getCallsHandler(patter);

    expect(result.content[0].text).toContain("$0.0180");
  });

  it("shows '-' for cost when no metrics", async () => {
    const call = makeCall({ metrics: undefined });
    const patter = makeMockPatter(new Map([[call.callId, call]]));

    const result = await getCallsHandler(patter);

    expect(result.content[0].text).toContain("Cost: -");
  });

  it("includes turn count in output", async () => {
    const call = makeCall({
      transcript: [
        { role: "assistant", text: "Hello" },
        { role: "user", text: "Hi" },
      ],
    });
    const patter = makeMockPatter(new Map([[call.callId, call]]));

    const result = await getCallsHandler(patter);

    expect(result.content[0].text).toContain("Turns: 2");
  });

  it("renders multiple calls separated by blank lines", async () => {
    const c1 = makeCall({ callId: "call_multi_1" });
    const c2 = makeCall({ callId: "call_multi_2" });
    const patter = makeMockPatter(new Map([["call_multi_1", c1], ["call_multi_2", c2]]));

    const result = await getCallsHandler(patter);

    expect(result.content[0].text).toContain("call_multi_1");
    expect(result.content[0].text).toContain("call_multi_2");
  });
});

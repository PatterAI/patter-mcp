/**
 * PatterServer tests.
 *
 * These exercise the REAL outbound lifecycle code (makeCall → call({wait:true})
 * → recordFromResult → persist) and only mock the outermost boundaries the
 * authentic-tests rule allows: the getpatter SDK (the paid carrier WebSocket),
 * the SQLite layer, and the Claude bridge (E2B sandbox). The CallResult →
 * CallRecord mapping under test is real code, not a stub.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CallResult } from "getpatter";

// ---------------------------------------------------------------------------
// Mock the getpatter SDK — the carrier/WS boundary. `call` is the seam we
// drive in each test; everything inward (the mapping, the record) is real.
// ---------------------------------------------------------------------------
vi.mock("getpatter", () => {
  class MockPatter {
    agent = vi.fn(() => ({ systemPrompt: "agent" }));
    call = vi.fn();
    serve = vi.fn(() => Promise.resolve());
    disconnect = vi.fn(() => Promise.resolve());
  }
  // Carriers / providers / tools are constructed but never invoked here.
  class Stub {
    constructor(..._args: unknown[]) {}
  }
  return {
    Patter: MockPatter,
    Twilio: Stub,
    DeepgramSTT: Stub,
    ElevenLabsTTS: Stub,
    Tool: Stub,
  };
});

// SQLite boundary — force in-memory fallback so persist() writes only to the
// in-process cache and reads come back from it.
vi.mock("./db.js", () => ({
  initDb: vi.fn(),
  upsertCall: vi.fn(),
  getCall: vi.fn(),
  getCallsByUser: vi.fn(() => []),
  isDbAvailable: vi.fn(() => false),
}));

// Claude bridge boundary (E2B sandbox / Agent SDK session).
vi.mock("./claude-bridge.js", () => ({
  endCallSession: vi.fn(() => Promise.resolve()),
}));

import { PatterServer } from "./patter-server.js";
import { endCallSession } from "./claude-bridge.js";

const mockEndCallSession = vi.mocked(endCallSession);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a realistic CallResult as the SDK would return from call({wait:true}). */
function makeCallResult(overrides: Partial<CallResult> = {}): CallResult {
  return {
    callId: "CA0000000000000000000000000000a001",
    outcome: "answered",
    status: "completed",
    durationSeconds: 47,
    transcript: [
      { role: "assistant", text: "Hi, this is an automated call." },
      { role: "user", text: "Sure, go ahead." },
    ],
    cost: { stt: 0.001, tts: 0.002, llm: 0.005, telephony: 0.01, total: 0.018 },
    metrics: {
      call_id: "CA0000000000000000000000000000a001",
      duration_seconds: 47,
      turns: [],
      cost: { stt: 0.001, tts: 0.002, llm: 0.005, telephony: 0.01, total: 0.018 },
    },
    ...overrides,
  } as unknown as CallResult;
}

/** Construct a PatterServer with a `call` mock we can drive per-test. */
function makeServer(): { server: PatterServer; call: ReturnType<typeof vi.fn> } {
  const server = new PatterServer();
  // The mocked Patter instance lives on the private `phone` field.
  const call = (server as unknown as { phone: { call: ReturnType<typeof vi.fn> } })
    .phone.call;
  return { server, call };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_PHONE_NUMBER = "+15555550100";
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeCall — maps CallResult into a CallRecord", () => {
  it("places the call with wait:true and maps an answered result", async () => {
    const { server, call } = makeServer();
    call.mockResolvedValue(makeCallResult());

    const record = await server.makeCall({
      to: "+15551234567",
      systemPrompt: "Be helpful",
      machineDetection: true,
      voicemailMessage: "Please call back.",
      userId: "user-1",
    });

    // The carrier seam was invoked with wait:true and the outbound options.
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551234567",
        machineDetection: true,
        voicemailMessage: "Please call back.",
        wait: true,
      }),
    );

    // The mapping is the real code under test.
    expect(record.callId).toBe("CA0000000000000000000000000000a001");
    expect(record.direction).toBe("outbound");
    expect(record.status).toBe("completed");
    expect(record.outcome).toBe("answered");
    expect(record.duration).toBe(47);
    expect(record.to).toBe("+15551234567");
    expect(record.userId).toBe("user-1");
    expect(record.transcript).toEqual([
      { role: "assistant", text: "Hi, this is an automated call." },
      { role: "user", text: "Sure, go ahead." },
    ]);
    // cost is surfaced inside metrics.cost (CallMetrics shape) for get_calls.
    expect((record.metrics as { cost: { total: number } }).cost.total).toBe(0.018);
  });

  it("maps a voicemail outcome to a completed record", async () => {
    const { server, call } = makeServer();
    call.mockResolvedValue(makeCallResult({ outcome: "voicemail" }));

    const record = await server.makeCall({
      to: "+15551234567",
      systemPrompt: "Leave a message",
    });

    expect(record.outcome).toBe("voicemail");
    expect(record.status).toBe("completed");
  });

  it("maps a no_answer outcome to a failed record with no cost", async () => {
    const { server, call } = makeServer();
    call.mockResolvedValue(
      makeCallResult({
        outcome: "no_answer",
        status: "no-answer",
        durationSeconds: 0,
        transcript: [],
        cost: null,
        metrics: null,
      }),
    );

    const record = await server.makeCall({
      to: "+15551234567",
      systemPrompt: "Be helpful",
    });

    expect(record.outcome).toBe("no_answer");
    expect(record.status).toBe("failed");
    expect(record.duration).toBe(0);
    expect(record.transcript).toEqual([]);
    expect(record.metrics).toBeUndefined();
  });

  it("persists the record so it is retrievable afterwards", async () => {
    const { server, call } = makeServer();
    call.mockResolvedValue(makeCallResult({ callId: "CA0000000000000000000000000000b002" }));

    await server.makeCall({ to: "+15551234567", systemPrompt: "x", userId: "owner-1" });

    const fetched = server.getCallForUser("CA0000000000000000000000000000b002", "owner-1");
    expect(fetched).toBeDefined();
    expect(fetched!.outcome).toBe("answered");
  });

  it("tears down the bridge session for the real carrier call id", async () => {
    const { server, call } = makeServer();
    call.mockResolvedValue(makeCallResult({ callId: "CA0000000000000000000000000000c003" }));

    await server.makeCall({ to: "+15551234567", systemPrompt: "x" });

    expect(mockEndCallSession).toHaveBeenCalledWith("CA0000000000000000000000000000c003");
  });

  it("propagates a carrier error and releases the concurrent slot", async () => {
    const { server, call } = makeServer();
    call.mockRejectedValue(new Error("carrier rejected dial"));

    await expect(
      server.makeCall({ to: "+15551234567", systemPrompt: "x", userId: "user-err" }),
    ).rejects.toThrow("carrier rejected dial");

    // A second call for the same user must still be allowed — the finally
    // block decremented the in-memory concurrent counter.
    call.mockResolvedValue(makeCallResult());
    await expect(
      server.makeCall({ to: "+15551234567", systemPrompt: "x", userId: "user-err" }),
    ).resolves.toBeDefined();
  });
});

describe("callThirdParty — delegates to makeCall", () => {
  it("returns the mapped CallRecord with a task-oriented prompt", async () => {
    const { server, call } = makeServer();
    call.mockResolvedValue(makeCallResult());

    const record = await server.callThirdParty(
      "+15551234567",
      "ask if there is a table for 2 at 8pm",
      "nova",
      "user-3p",
    );

    expect(record.outcome).toBe("answered");
    expect(record.direction).toBe("outbound");
    // The agent was built with the task embedded in the system prompt.
    const agentMock = (server as unknown as { phone: { agent: ReturnType<typeof vi.fn> } })
      .phone.agent;
    expect(agentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining("ask if there is a table for 2 at 8pm"),
      }),
    );
  });
});

describe("disconnect — tears the SDK down", () => {
  it("calls phone.disconnect() and clears the running flag", async () => {
    const { server } = makeServer();
    const disconnect = (server as unknown as { phone: { disconnect: ReturnType<typeof vi.fn> } })
      .phone.disconnect;

    await server.disconnect();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(server.isServerRunning).toBe(false);
  });
});

describe("inbound lifecycle — only inbound events create records", () => {
  it("creates a record for an inbound call and ignores outbound start events", async () => {
    const { server } = makeServer();
    const handlers = server as unknown as {
      handleCallStart: (d: Record<string, unknown>) => Promise<void>;
    };

    await handlers.handleCallStart({
      call_id: "CA0000000000000000000000000000d004",
      direction: "inbound",
      caller: "+15557654321",
      callee: "+15555550100",
    });
    await handlers.handleCallStart({
      call_id: "CA0000000000000000000000000000e005",
      direction: "outbound",
      caller: "+15555550100",
      callee: "+15551112222",
    });

    expect(server.getCallForUser("CA0000000000000000000000000000d004")?.direction).toBe(
      "inbound",
    );
    // The outbound start event must NOT have created a record — makeCall owns it.
    expect(server.getCallForUser("CA0000000000000000000000000000e005")).toBeUndefined();
  });

  it("finalises an inbound call from the call-end payload's metrics", async () => {
    const { server } = makeServer();
    const handlers = server as unknown as {
      handleCallStart: (d: Record<string, unknown>) => Promise<void>;
      handleCallEnd: (d: Record<string, unknown>) => Promise<void>;
    };

    await handlers.handleCallStart({
      call_id: "CA0000000000000000000000000000f006",
      direction: "inbound",
      caller: "+15557654321",
      callee: "+15555550100",
    });
    await handlers.handleCallEnd({
      call_id: "CA0000000000000000000000000000f006",
      transcript: [{ role: "user", text: "hello?" }],
      metrics: { duration_seconds: 33, cost: { total: 0.01 } },
    });

    const record = server.getCallForUser("CA0000000000000000000000000000f006");
    expect(record?.status).toBe("completed");
    expect(record?.duration).toBe(33);
    expect(record?.transcript).toEqual([{ role: "user", text: "hello?" }]);
  });
});

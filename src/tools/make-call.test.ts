import { describe, it, expect, vi } from "vitest";
import { makeCallHandler } from "./make-call.js";
import type { PatterServer } from "../patter-server.js";

// ---------------------------------------------------------------------------
// Minimal mock PatterServer
// ---------------------------------------------------------------------------

function makeMockPatter(makeCallImpl: () => Promise<string>): PatterServer {
  return {
    makeCall: vi.fn(makeCallImpl),
    getCallsForUser: vi.fn(() => new Map()),
    getCallForUser: vi.fn(),
    callThirdParty: vi.fn(),
    waitForCallEnd: vi.fn(),
    startServer: vi.fn(),
    simulateCallEnd: vi.fn(),
    calls: new Map(),
    phoneNumber: "+15550000000",
    isServerRunning: false,
  } as unknown as PatterServer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeCallHandler", () => {
  it("returns success content with callId when patter.makeCall resolves", async () => {
    // Arrange
    const patter = makeMockPatter(() => Promise.resolve("call_abc_123"));

    // Act
    const result = await makeCallHandler(
      { to: "+15551234567", systemPrompt: "Be helpful" },
      patter,
      "user-1",
    );

    // Assert
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("call_abc_123");
    expect(result.content[0].text).toContain("+15551234567");
    expect(result.content[0].text).toContain("ringing");
  });

  it("passes all options to patter.makeCall", async () => {
    const patter = makeMockPatter(() => Promise.resolve("call_options"));

    await makeCallHandler(
      {
        to: "+15559999999",
        systemPrompt: "Greet the caller",
        firstMessage: "Hi there!",
        voice: "alloy",
        machineDetection: true,
        voicemailMessage: "Please call back.",
      },
      patter,
      "user-42",
    );

    expect(patter.makeCall).toHaveBeenCalledWith({
      to: "+15559999999",
      systemPrompt: "Greet the caller",
      firstMessage: "Hi there!",
      voice: "alloy",
      machineDetection: true,
      voicemailMessage: "Please call back.",
      userId: "user-42",
    });
  });

  it("includes get_calls and get_transcript hints in the success message", async () => {
    const patter = makeMockPatter(() => Promise.resolve("call_hints_test"));

    const result = await makeCallHandler(
      { to: "+15551112222", systemPrompt: "Help" },
      patter,
    );

    expect(result.content[0].text).toContain("get_calls");
    expect(result.content[0].text).toContain("get_transcript");
  });

  it("returns an error result when patter.makeCall throws", async () => {
    // Arrange
    const patter = makeMockPatter(() => Promise.reject(new Error("Twilio unavailable")));

    // Act
    const result = await makeCallHandler(
      { to: "+15551234567", systemPrompt: "Be helpful" },
      patter,
      "user-1",
    );

    // Assert
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to place call");
    expect(result.content[0].text).toContain("Twilio unavailable");
  });

  it("handles non-Error thrown values gracefully", async () => {
    const patter = makeMockPatter(() => Promise.reject("string error"));

    const result = await makeCallHandler(
      { to: "+15551234567", systemPrompt: "Help" },
      patter,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("string error");
  });

  it("works without a userId (unauthenticated mode)", async () => {
    const patter = makeMockPatter(() => Promise.resolve("call_no_auth"));

    const result = await makeCallHandler(
      { to: "+15550001111", systemPrompt: "Hello" },
      patter,
    );

    expect(result.isError).toBeUndefined();
    expect(patter.makeCall).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined }),
    );
  });
});

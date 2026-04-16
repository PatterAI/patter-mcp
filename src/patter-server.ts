/**
 * Patter SDK wrapper — manages the embedded server, outbound calls,
 * and call record tracking.
 *
 * Persistence strategy:
 *   - Every status change is written to SQLite via upsertCall().
 *   - An in-memory Map acts as a write-through cache so that
 *     waitForCallEnd() can poll active calls without hitting the DB.
 *   - get_calls and get_transcript read from the DB (which includes
 *     calls from previous runs). When the DB is unavailable the Map
 *     is used directly as a fallback.
 */

import { Patter } from "getpatter";
import { allVoiceTools } from "./voice-tools.js";
import { endCallSession } from "./claude-bridge.js";
import {
  initDb,
  upsertCall,
  getCall,
  getCallsByUser,
  getAllCalls,
  dbAvailable,
} from "./db.js";

export interface CallRecord {
  callId: string;
  to?: string;
  from?: string;
  direction: "outbound" | "inbound";
  status: "ringing" | "in-progress" | "completed" | "failed";
  startedAt: number;
  endedAt?: number;
  duration?: number;
  transcript: Array<{ role: string; text: string }>;
  metrics?: Record<string, unknown>;
  /** Owner of the call. Populated when auth is enabled. */
  userId?: string;
}

export interface MakeCallOptions {
  to: string;
  systemPrompt: string;
  firstMessage?: string;
  voice?: string;
  machineDetection?: boolean;
  voicemailMessage?: string;
  userId?: string;
}

function log(msg: string): void {
  process.stderr.write(`[patter-mcp] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Immutable helpers
// ---------------------------------------------------------------------------

/** Return a new CallRecord with the given fields merged in (never mutates). */
function mergeRecord(
  base: CallRecord,
  patch: Partial<CallRecord>,
): CallRecord {
  return { ...base, ...patch };
}

export class PatterServer {
  private phone: Patter;
  private serverRunning = false;

  /**
   * Write-through cache for active calls.
   * Used by waitForCallEnd() to poll without hitting the DB on every tick.
   * Completed / failed calls remain here for the process lifetime as a
   * fast-path fallback when the DB is unavailable.
   */
  readonly calls = new Map<string, CallRecord>();

  constructor() {
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const phoneNumber = process.env.TWILIO_PHONE_NUMBER;
    const openaiKey = process.env.OPENAI_API_KEY;
    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    const elevenlabsKey = process.env.ELEVENLABS_API_KEY;

    if (!twilioSid || !twilioToken || !phoneNumber) {
      throw new Error(
        "Missing required env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER"
      );
    }

    this.phone = new Patter({
      mode: "local",
      openaiKey,
      twilioSid,
      twilioToken,
      phoneNumber,
      webhookUrl: process.env.WEBHOOK_URL || "localhost",
      deepgramKey,
      elevenlabsKey,
    } as Record<string, unknown>);

    // Initialise SQLite — errors are caught internally and set dbAvailable=false
    initDb();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Persist a record to both the in-memory cache and the DB (if available).
   * Always returns the same record unchanged — callers should replace their
   * local reference with what they pass in (immutability contract).
   */
  private persist(record: CallRecord): CallRecord {
    this.calls.set(record.callId, record);
    upsertCall(record);
    return record;
  }

  /** Create a Patter agent with voice tools attached. */
  private createAgent(
    systemPrompt: string,
    firstMessage?: string,
    voice?: string,
  ) {
    return this.phone.agent({
      systemPrompt,
      voice: voice || "nova",
      firstMessage: firstMessage || "Hello!",
      provider: "pipeline",
      stt: Patter.deepgram({ apiKey: process.env.DEEPGRAM_API_KEY! }),
      tts: Patter.elevenlabs({
        apiKey: process.env.ELEVENLABS_API_KEY!,
        voice: voice || "nova",
      }),
      tools: allVoiceTools.map((t) =>
        Patter.tool({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          handler: t.handler,
        })
      ),
    } as Record<string, unknown>);
  }

  // -------------------------------------------------------------------------
  // Public server management
  // -------------------------------------------------------------------------

  /**
   * Start the inbound call server in background.
   *
   * Note: inbound calls intentionally have no userId — they originate from
   * Twilio, not from an authenticated MCP client, so there is no Auth0
   * identity to associate with them.
   */
  async startServer(
    systemPrompt: string,
    firstMessage?: string,
    voice?: string,
    port = 8000,
  ): Promise<void> {
    if (this.serverRunning) return;

    const agent = this.createAgent(systemPrompt, firstMessage, voice);

    this.phone
      .serve({
        agent,
        port,
        dashboard: true,
        onCallStart: async (data: Record<string, unknown>) => {
          const callId =
            (data.call_id as string) ||
            `inbound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

          const record: CallRecord = {
            callId,
            from: data.caller as string,
            to: data.callee as string,
            direction: "inbound",
            status: "in-progress",
            startedAt: Date.now(),
            transcript: [],
          };

          this.persist(record);
          log(`Inbound call ${callId} from ${data.caller}`);
        },
        onCallEnd: async (data: Record<string, unknown>) => {
          const callId = data.call_id as string;
          const existing = this.calls.get(callId);
          if (!existing) return;

          const updated = mergeRecord(existing, {
            status: "completed",
            endedAt: Date.now(),
            duration: (data.duration as number) || 0,
            transcript:
              (data.transcript as Array<{ role: string; text: string }>) || [],
            metrics: (data.metrics as Record<string, unknown>) || {},
          });

          this.persist(updated);
          endCallSession(callId);
          log(`Inbound call ${callId} ended`);
        },
      } as Record<string, unknown>)
      .catch((err: Error) => {
        log(`Patter server error: ${err.message}`);
        this.serverRunning = false;
      });

    this.serverRunning = true;
    log(`Patter server started on port ${port}`);
  }

  // -------------------------------------------------------------------------
  // Outbound calls
  // -------------------------------------------------------------------------

  /** Place an outbound call. Returns the call ID immediately. */
  async makeCall(options: MakeCallOptions): Promise<string> {
    const {
      to,
      systemPrompt,
      firstMessage,
      voice,
      machineDetection,
      voicemailMessage,
      userId,
    } = options;

    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const initial: CallRecord = {
      callId,
      to,
      direction: "outbound",
      status: "ringing",
      startedAt: Date.now(),
      transcript: [],
      userId,
    };

    this.persist(initial);

    const agent = this.createAgent(systemPrompt, firstMessage, voice);

    this.phone
      .call({
        to,
        agent,
        machineDetection,
        voicemailMessage,
        onCallStart: async (data: Record<string, unknown>) => {
          const existing = this.calls.get(callId);
          if (!existing) return;

          const updated = mergeRecord(existing, {
            status: "in-progress",
            from: data.caller as string,
          });

          this.persist(updated);
          log(`Call ${callId} connected`);
        },
        onCallEnd: async (data: Record<string, unknown>) => {
          const existing = this.calls.get(callId);
          if (!existing) return;

          const updated = mergeRecord(existing, {
            status: "completed",
            endedAt: Date.now(),
            duration: (data.duration as number) || 0,
            transcript:
              (data.transcript as Array<{ role: string; text: string }>) || [],
            metrics: (data.metrics as Record<string, unknown>) || {},
          });

          this.persist(updated);
          endCallSession(callId);
          log(`Call ${callId} ended — ${updated.duration}s`);
        },
      } as Record<string, unknown>)
      .catch((err: Error) => {
        const existing = this.calls.get(callId);
        if (!existing) return;

        const failed = mergeRecord(existing, {
          status: "failed",
          endedAt: Date.now(),
        });

        this.persist(failed);
        log(`Call ${callId} failed: ${err.message}`);
      });

    return callId;
  }

  // -------------------------------------------------------------------------
  // Query methods — prefer DB, fall back to in-memory Map
  // -------------------------------------------------------------------------

  /**
   * Return all calls, optionally filtered to those owned by `userId`.
   * Reads from the DB when available so records survive restarts.
   * Falls back to the in-memory Map when the DB is unavailable.
   */
  getCallsForUser(userId?: string): ReadonlyMap<string, CallRecord> {
    if (dbAvailable) {
      const records = getCallsByUser(userId);
      const result = new Map<string, CallRecord>();
      for (const r of records) {
        result.set(r.callId, r);
      }
      return result;
    }

    // Fallback: filter the in-memory Map
    if (userId === undefined) return this.calls;
    const filtered = new Map<string, CallRecord>();
    for (const [id, record] of this.calls) {
      if (record.userId === userId) {
        filtered.set(id, record);
      }
    }
    return filtered;
  }

  /**
   * Return a single call record, enforcing ownership when `userId` is provided.
   * Reads from the DB when available so records survive restarts.
   * Falls back to the in-memory Map when the DB is unavailable.
   */
  getCallForUser(callId: string, userId?: string): CallRecord | undefined {
    let record: CallRecord | undefined;

    if (dbAvailable) {
      record = getCall(callId);
    } else {
      record = this.calls.get(callId);
    }

    if (!record) return undefined;
    if (userId !== undefined && record.userId !== userId) return undefined;
    return record;
  }

  // -------------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------------

  /** Simulate a call completing (for testing without real Twilio). */
  simulateCallEnd(callId: string, transcript?: Array<{ role: string; text: string }>): void {
    const existing = this.calls.get(callId);
    if (!existing) return;

    const completed = mergeRecord(existing, {
      status: "completed",
      endedAt: Date.now(),
      duration: Math.round((Date.now() - existing.startedAt) / 1000),
      transcript: transcript ?? [
        { role: "assistant", text: "Hello, how can I help?" },
        { role: "user", text: "This is a test call." },
        { role: "assistant", text: "Got it, test call completed successfully." },
      ],
      metrics: {
        cost: { stt: 0.001, tts: 0.002, llm: 0.005, telephony: 0.01, total: 0.018 },
        latency_avg: { stt_ms: 90, llm_ms: 250, tts_ms: 70, total_ms: 410 },
      },
    });

    this.persist(completed);
    log(`Call ${callId} simulated complete`);
  }

  // -------------------------------------------------------------------------
  // Autonomous third-party call
  // -------------------------------------------------------------------------

  /** Call a third party autonomously and wait for the call to complete. */
  async callThirdParty(
    to: string,
    task: string,
    voice?: string,
    userId?: string,
  ): Promise<CallRecord> {
    const systemPrompt =
      `You are making a phone call on behalf of someone. Your task: ${task}\n\n` +
      `Be polite, concise, and focused on the task. When the task is complete ` +
      `or you have the information needed, thank them and end the call.`;

    const callId = await this.makeCall({ to, systemPrompt, voice, userId });
    return this.waitForCallEnd(callId, 300_000);
  }

  /** Wait for a call to complete (polling against the in-memory cache). */
  async waitForCallEnd(
    callId: string,
    timeoutMs: number,
  ): Promise<CallRecord> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Poll the in-memory cache — it is always current for active calls
      const record = this.calls.get(callId);
      if (!record) throw new Error(`Call ${callId} not found`);
      if (record.status === "completed" || record.status === "failed") {
        return record;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Call ${callId} timed out after ${timeoutMs / 1000}s`);
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get phoneNumber(): string {
    return process.env.TWILIO_PHONE_NUMBER || "unknown";
  }

  get isServerRunning(): boolean {
    return this.serverRunning;
  }
}

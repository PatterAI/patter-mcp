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
 *
 * SDK contract (getpatter >= 0.6.2):
 *   - Carrier classes (`Twilio`, `Telnyx`) replace the v0.4.x credential
 *     fields on the `Patter` constructor.
 *   - STT/TTS providers are class instances (`new DeepgramSTT(...)`),
 *     not the legacy `Patter.deepgram(...)` static factory.
 *   - `phone.call({...})` accepts ONLY the outbound options
 *     (`to`, `agent`, `machineDetection`, `voicemailMessage`, `ringTimeout`,
 *     `onMachineDetection`, `variables`). It does NOT accept per-call
 *     `onCallStart` / `onCallEnd` callbacks — those are wired ONCE on
 *     `phone.serve({...})` and fire for every call, inbound and outbound.
 *     Per-call dispatch is done by matching `data.call_id` against the
 *     records we pre-populated in `makeCall()`.
 */

import {
  Patter,
  Twilio,
  DeepgramSTT,
  ElevenLabsTTS,
  Tool,
} from "getpatter";
import { allVoiceTools } from "./voice-tools.js";
import { endCallSession } from "./claude-bridge.js";
import {
  initDb,
  upsertCall,
  getCall,
  getCallsByUser,
  isDbAvailable,
} from "./db.js";
import {
  MAX_CALL_DURATION_SECONDS,
  decrementConcurrent,
} from "./rate-limiter.js";

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

  /**
   * Per-call duration-enforcement timers. Indexed by callId so the unified
   * `onCallEnd` server-side handler can cancel the right timer when a call
   * completes normally. In v0.4.x these lived inline in `phone.call()`'s
   * callback closure; v0.6.2 moves the callbacks to the server scope, so
   * the timers must be tracked here too.
   */
  private readonly durationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const phoneNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!twilioSid || !twilioToken || !phoneNumber) {
      throw new Error(
        "Missing required env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER"
      );
    }

    // Provider keys (OPENAI_API_KEY, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY)
    // are read from env directly by each provider class (DeepgramSTT,
    // ElevenLabsTTS, OpenAIRealtime, ...) in v0.6.x — they are no longer
    // passed on the Patter constructor.
    this.phone = new Patter({
      carrier: new Twilio({ accountSid: twilioSid, authToken: twilioToken }),
      phoneNumber,
      webhookUrl: process.env.WEBHOOK_URL || "localhost",
    });

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

  private clearDurationTimer(callId: string): void {
    const timer = this.durationTimers.get(callId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.durationTimers.delete(callId);
    }
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
      // No `engine` argument → pipeline mode (STT → LLM → TTS).
      stt: new DeepgramSTT({ apiKey: process.env.DEEPGRAM_API_KEY }),
      tts: new ElevenLabsTTS({
        apiKey: process.env.ELEVENLABS_API_KEY,
        voiceId: voice || "nova",
      }),
      tools: allVoiceTools.map((t) =>
        new Tool({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          handler: t.handler,
        }),
      ),
    });
  }

  // -------------------------------------------------------------------------
  // Unified call lifecycle handlers (server-wide in v0.6.2)
  // -------------------------------------------------------------------------

  /**
   * Fires for every call start — inbound OR outbound.
   *
   * Inbound: `data.call_id` is one we've never seen, so create the record
   * from scratch using `data.caller` / `data.callee`.
   *
   * Outbound: `data.call_id` matches a record `makeCall()` pre-populated
   * with status `"ringing"`. Promote it to `"in-progress"` and start the
   * duration timer.
   */
  private readonly handleCallStart = async (
    data: Record<string, unknown>,
  ): Promise<void> => {
    const carrierId = data.call_id as string | undefined;
    if (!carrierId) return;

    const existing = this.calls.get(carrierId);
    if (existing) {
      // OUTBOUND — record already exists from makeCall().
      const updated = mergeRecord(existing, {
        status: "in-progress",
        from: (data.caller as string) || existing.from,
      });
      this.persist(updated);
      log(`Call ${carrierId} connected`);

      // Arm the maximum-duration guard. Cleared on normal call end.
      const timer = setTimeout(() => {
        log(
          `WARNING: Call ${carrierId} exceeded maximum duration ` +
            `(${MAX_CALL_DURATION_SECONDS}s) — marking completed and ending ` +
            `agent session — carrier connection may continue.`,
        );
        decrementConcurrent(updated.userId);

        const current = this.calls.get(carrierId);
        if (current && current.status === "in-progress") {
          const terminated = mergeRecord(current, {
            status: "completed",
            endedAt: Date.now(),
            duration: MAX_CALL_DURATION_SECONDS,
          });
          this.persist(terminated);
          // Fire-and-forget: setTimeout cannot await; endCallSession has
          // internal error handling.
          void endCallSession(carrierId);
        }
        this.durationTimers.delete(carrierId);
      }, MAX_CALL_DURATION_SECONDS * 1000);
      this.durationTimers.set(carrierId, timer);
      return;
    }

    // INBOUND — first time we see this call_id, create a fresh record.
    const record: CallRecord = {
      callId: carrierId,
      from: data.caller as string,
      to: data.callee as string,
      direction: "inbound",
      status: "in-progress",
      startedAt: Date.now(),
      transcript: [],
    };
    this.persist(record);
    log(`Inbound call ${carrierId} from ${data.caller}`);
  };

  /**
   * Fires for every call end — inbound OR outbound. Both paths converge
   * to the same finalisation logic: clear the duration timer, decrement
   * concurrent count for the owner (outbound only), update the record,
   * close the Claude agent session.
   */
  private readonly handleCallEnd = async (
    data: Record<string, unknown>,
  ): Promise<void> => {
    const carrierId = data.call_id as string | undefined;
    if (!carrierId) return;

    this.clearDurationTimer(carrierId);

    const existing = this.calls.get(carrierId);
    if (!existing) return;

    // Outbound calls register a userId for rate-limit accounting. Inbound
    // calls have no userId.
    if (existing.direction === "outbound") {
      decrementConcurrent(existing.userId);
    }

    const updated = mergeRecord(existing, {
      status: "completed",
      endedAt: Date.now(),
      duration: (data.duration as number) || 0,
      transcript:
        (data.transcript as Array<{ role: string; text: string }>) || [],
      metrics: (data.metrics as Record<string, unknown>) || {},
    });
    this.persist(updated);
    await endCallSession(carrierId);
    log(`${existing.direction} call ${carrierId} ended — ${updated.duration}s`);
  };

  // -------------------------------------------------------------------------
  // Public server management
  // -------------------------------------------------------------------------

  /**
   * Start the inbound call server in background.
   *
   * The same `onCallStart` / `onCallEnd` handlers registered here also
   * receive outbound-call events placed by `makeCall()` — that's how
   * v0.6.2 wires the lifecycle (server-wide, not per-call).
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
        onCallStart: this.handleCallStart,
        onCallEnd: this.handleCallEnd,
      })
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

  /**
   * Place an outbound call. Pre-populates the record so the unified
   * server-wide `onCallStart` / `onCallEnd` handlers can promote it
   * through its lifecycle when Patter callbacks fire.
   *
   * Returns the carrier-issued call ID. We use this same string as the
   * record key — `phone.call()` resolves with the carrier call SID
   * which matches `data.call_id` in subsequent callbacks.
   */
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

    const agent = this.createAgent(systemPrompt, firstMessage, voice);

    // Provisional local ID — replaced with the carrier SID once we get
    // the first onCallStart callback. We index timers and records by
    // carrier SID, so this provisional record is keyed under it once
    // the carrier reports back. Until then waitForCallEnd polls the
    // local ID; we patch it up by aliasing both keys after start.
    const provisionalId = `pending_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const initial: CallRecord = {
      callId: provisionalId,
      to,
      direction: "outbound",
      status: "ringing",
      startedAt: Date.now(),
      transcript: [],
      userId,
    };
    this.persist(initial);

    try {
      // v0.6.2 LocalCallOptions: { to, agent, machineDetection?,
      //   onMachineDetection?, voicemailMessage?, ringTimeout?, variables? }
      await this.phone.call({
        to,
        agent,
        machineDetection,
        voicemailMessage,
      });
    } catch (err) {
      // The call failed before connecting — finalise locally.
      const message = err instanceof Error ? err.message : String(err);
      const existing = this.calls.get(provisionalId);
      if (existing) {
        const failed = mergeRecord(existing, {
          status: "failed",
          endedAt: Date.now(),
        });
        this.persist(failed);
      }
      decrementConcurrent(userId);
      log(`Call ${provisionalId} failed: ${message}`);
    }

    return provisionalId;
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
    if (isDbAvailable()) {
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

    if (isDbAvailable()) {
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
    return this.waitForCallEnd(callId, MAX_CALL_DURATION_SECONDS * 1000 + 10_000);
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

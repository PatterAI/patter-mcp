/**
 * Patter SDK wrapper — manages the embedded server, outbound calls,
 * and call record tracking.
 *
 * Persistence strategy:
 *   - Every status change is written to SQLite via upsertCall().
 *   - An in-memory Map acts as a write-through cache used by the inbound
 *     lifecycle handlers and as a fallback when the DB is unavailable.
 *   - get_calls and get_transcript read from the DB (which includes
 *     calls from previous runs). When the DB is unavailable the Map
 *     is used directly as a fallback.
 *
 * SDK contract (getpatter >= 0.6.3):
 *   - Carrier classes (`Twilio`, `Telnyx`) replace the legacy credential
 *     fields on the `Patter` constructor.
 *   - STT/TTS providers are class instances (`new DeepgramSTT(...)`),
 *     not a static factory.
 *   - OUTBOUND: `phone.call({ to, agent, ..., wait: true })` blocks until
 *     the call reaches a terminal state and resolves to a {@link CallResult}
 *     — `outcome` (answered / voicemail / no_answer / busy / failed) plus
 *     duration, transcript, and cost, all derived from real carrier signals.
 *     This requires an active server (`serve()` must have been called first),
 *     which the lazy `getPatter()` boot guarantees before any tool runs.
 *     `makeCall()` maps that result straight to a {@link CallRecord} — there
 *     is no provisional id and no polling.
 *   - INBOUND: there is no initiator to await, so the server-wide
 *     `onCallStart` / `onCallEnd` callbacks wired on `phone.serve({...})`
 *     create and finalise inbound records. Those callbacks fire for every
 *     call (inbound AND outbound), so they filter on `direction` and ignore
 *     outbound events — `makeCall()` owns the outbound lifecycle.
 */

import {
  Patter,
  Twilio,
  DeepgramSTT,
  ElevenLabsTTS,
  Tool,
  type CallResult,
  type CallOutcome,
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
  incrementConcurrent,
  decrementConcurrent,
} from "./rate-limiter.js";

export interface CallRecord {
  callId: string;
  to?: string;
  from?: string;
  direction: "outbound" | "inbound";
  status: "ringing" | "in-progress" | "completed" | "failed";
  /**
   * Carrier-agnostic terminal outcome for outbound calls, lifted verbatim
   * from the SDK {@link CallResult}. Undefined for inbound calls and for
   * outbound calls still in flight.
   */
  outcome?: CallOutcome;
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
   * Write-through cache for call records. Populated by the inbound lifecycle
   * handlers and by `makeCall()` when an outbound call completes. Records
   * remain here for the process lifetime as a fast-path fallback when the DB
   * is unavailable.
   */
  readonly calls = new Map<string, CallRecord>();

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
  // Inbound call lifecycle handlers (server-wide on phone.serve)
  // -------------------------------------------------------------------------
  //
  // These callbacks fire for EVERY call, inbound and outbound, but outbound
  // calls are owned end-to-end by makeCall() via call({ wait: true }). So
  // both handlers filter on `direction` and ignore outbound events — there
  // is nothing for them to do (no record to promote, no timer to manage).

  /**
   * Fires for every call start. Only inbound calls are handled here: they
   * have no initiator, so we create the record from `data.caller` /
   * `data.callee`. Outbound starts are ignored — makeCall() owns them.
   */
  private readonly handleCallStart = async (
    data: Record<string, unknown>,
  ): Promise<void> => {
    const carrierId = data.call_id as string | undefined;
    if (!carrierId) return;
    if (data.direction !== "inbound") return;
    if (this.calls.has(carrierId)) return; // ignore duplicate start events

    const record: CallRecord = {
      callId: carrierId,
      from: data.caller as string | undefined,
      to: data.callee as string | undefined,
      direction: "inbound",
      status: "in-progress",
      startedAt: Date.now(),
      transcript: [],
    };
    this.persist(record);
    log(`inbound call ${carrierId} from ${data.caller}`);
  };

  /**
   * Fires for every call end. The SDK's call-end payload carries no
   * `direction`, so we look the record up in the cache and only finalise it
   * when it is an inbound call we created in handleCallStart. Outbound calls
   * are finalised by makeCall() from the CallResult, so they are ignored:
   * their record either isn't in the cache yet or carries direction
   * "outbound". Duration comes from `metrics.duration_seconds` (the SDK's
   * call-end payload has no top-level `duration`).
   */
  private readonly handleCallEnd = async (
    data: Record<string, unknown>,
  ): Promise<void> => {
    const carrierId = data.call_id as string | undefined;
    if (!carrierId) return;

    const existing = this.calls.get(carrierId);
    if (!existing || existing.direction !== "inbound") return;

    const metrics =
      (data.metrics as Record<string, unknown> | undefined) ?? undefined;
    const duration =
      typeof metrics?.duration_seconds === "number"
        ? metrics.duration_seconds
        : 0;

    const updated = mergeRecord(existing, {
      status: "completed",
      endedAt: Date.now(),
      duration,
      transcript:
        (data.transcript as Array<{ role: string; text: string }>) || [],
      metrics: metrics ?? {},
    });
    this.persist(updated);
    await endCallSession(carrierId);
    log(`inbound call ${carrierId} ended — ${updated.duration}s`);
  };

  // -------------------------------------------------------------------------
  // Public server management
  // -------------------------------------------------------------------------

  /**
   * Start the embedded Patter server in the background.
   *
   * Registers the server-wide `onCallStart` / `onCallEnd` handlers. They fire
   * for every call but only act on inbound ones; outbound calls are driven by
   * `makeCall()` via `call({ wait: true })`. An active server is also what
   * lets `call({ wait: true })` resolve — its terminal signals (carrier
   * status callback, AMD, media-stream end) arrive on this server's webhooks.
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
   * Map a completed-call {@link CallResult} into a {@link CallRecord}.
   *
   * `answered` / `voicemail` are successful terminal states → `completed`.
   * `no_answer` / `busy` / `failed` never reached the media stream → `failed`.
   * `cost` lives inside `metrics.cost` (CallMetrics shape) so existing
   * readers (get_calls, the dashboard, sumHourlyCostUsd) keep working.
   */
  private recordFromResult(
    result: CallResult,
    to: string,
    startedAt: number,
    userId?: string,
  ): CallRecord {
    const status: CallRecord["status"] =
      result.outcome === "answered" || result.outcome === "voicemail"
        ? "completed"
        : "failed";

    const metrics: Record<string, unknown> | undefined = result.metrics
      ? { ...result.metrics }
      : result.cost
        ? { cost: result.cost }
        : undefined;

    return {
      callId: result.callId,
      to,
      direction: "outbound",
      status,
      outcome: result.outcome,
      startedAt,
      endedAt: Date.now(),
      duration: result.durationSeconds,
      transcript: result.transcript.map((t) => ({ role: t.role, text: t.text })),
      metrics,
      userId,
    };
  }

  /**
   * Place an outbound call and block until it reaches a terminal state.
   *
   * `call({ wait: true })` resolves with the carrier-derived
   * {@link CallResult} when the call hangs up (timeout-bounded by the SDK).
   * We map that straight into a {@link CallRecord} — there is no provisional
   * id and no polling: the carrier call SID, outcome, duration, transcript,
   * and cost all come back in the result. Requires an active server, which
   * the lazy `getPatter()` boot guarantees before any tool call runs.
   *
   * Concurrent-call accounting is in-memory and bounded to this method's
   * lifetime (increment on entry, decrement in `finally`) — the wait:true
   * model leaves no in-progress DB row to count, and an in-memory counter is
   * the right home for ephemeral "calls live right now" state.
   */
  async makeCall(options: MakeCallOptions): Promise<CallRecord> {
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
    const startedAt = Date.now();
    incrementConcurrent(userId);

    try {
      const result = await this.phone.call({
        to,
        agent,
        machineDetection,
        voicemailMessage,
        wait: true,
      });

      // wait:true always resolves to a CallResult; `void` only happens with
      // wait:false. Treat a missing result as a failure rather than persist
      // a half-formed record.
      if (!result) {
        throw new Error(
          "call({ wait: true }) resolved without a CallResult — is the server running?",
        );
      }

      const record = this.recordFromResult(result, to, startedAt, userId);
      this.persist(record);
      // Tear down any Claude bridge session opened by voice tools during the
      // call (best-effort; no-op when none was created).
      await endCallSession(record.callId);
      log(
        `outbound call ${record.callId} ended — outcome=${record.outcome} ` +
          `status=${record.status} ${record.duration}s`,
      );
      return record;
    } finally {
      decrementConcurrent(userId);
    }
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
      outcome: existing.direction === "outbound" ? "answered" : existing.outcome,
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

  /**
   * Call a third party autonomously and wait for the call to complete.
   *
   * Thin wrapper over {@link makeCall} — `call({ wait: true })` already
   * blocks until the call hangs up and returns the full {@link CallRecord}
   * (outcome, duration, transcript, cost). The only difference from a plain
   * make_call is the task-oriented system prompt.
   */
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

    return this.makeCall({ to, systemPrompt, voice, userId });
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Tear the embedded Patter server down: stop the HTTP server, close the
   * cloudflared tunnel, drop any pending completion awaiters, and clear
   * prewarm/TTS work. Safe to call multiple times and even when the server
   * never started (idempotent in the SDK). Wired to SIGTERM / SIGINT.
   */
  async disconnect(): Promise<void> {
    await this.phone.disconnect();
    this.serverRunning = false;
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

/**
 * Patter SDK wrapper — manages the embedded server, outbound calls,
 * and call record tracking.
 */

import { Patter } from "getpatter";
import { allVoiceTools } from "./voice-tools.js";

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
}

function log(msg: string): void {
  process.stderr.write(`[patter-mcp] ${msg}\n`);
}

export class PatterServer {
  private phone: Patter;
  private serverRunning = false;
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

  /** Start the inbound call server in background. */
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
          this.calls.set(callId, {
            callId,
            from: data.caller as string,
            to: data.callee as string,
            direction: "inbound",
            status: "in-progress",
            startedAt: Date.now(),
            transcript: [],
          });
          log(`Inbound call ${callId} from ${data.caller}`);
        },
        onCallEnd: async (data: Record<string, unknown>) => {
          const callId = data.call_id as string;
          const record = this.calls.get(callId);
          if (record) {
            record.status = "completed";
            record.endedAt = Date.now();
            record.duration = (data.duration as number) || 0;
            record.transcript =
              (data.transcript as Array<{ role: string; text: string }>) || [];
            record.metrics =
              (data.metrics as Record<string, unknown>) || {};
          }
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

  /** Place an outbound call. Returns the call ID immediately. */
  async makeCall(
    to: string,
    systemPrompt: string,
    firstMessage?: string,
    voice?: string,
    machineDetection?: boolean,
    voicemailMessage?: string,
  ): Promise<string> {
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.calls.set(callId, {
      callId,
      to,
      direction: "outbound",
      status: "ringing",
      startedAt: Date.now(),
      transcript: [],
    });

    const agent = this.createAgent(systemPrompt, firstMessage, voice);

    this.phone
      .call({
        to,
        agent,
        machineDetection,
        voicemailMessage,
        onCallStart: async (data: Record<string, unknown>) => {
          const record = this.calls.get(callId);
          if (record) {
            record.status = "in-progress";
            record.from = data.caller as string;
          }
          log(`Call ${callId} connected`);
        },
        onCallEnd: async (data: Record<string, unknown>) => {
          const record = this.calls.get(callId);
          if (record) {
            record.status = "completed";
            record.endedAt = Date.now();
            record.duration = (data.duration as number) || 0;
            record.transcript =
              (data.transcript as Array<{ role: string; text: string }>) || [];
            record.metrics =
              (data.metrics as Record<string, unknown>) || {};
          }
          log(`Call ${callId} ended — ${record?.duration}s`);
        },
      } as Record<string, unknown>)
      .catch((err: Error) => {
        const record = this.calls.get(callId);
        if (record) {
          record.status = "failed";
          record.endedAt = Date.now();
        }
        log(`Call ${callId} failed: ${err.message}`);
      });

    return callId;
  }

  /** Simulate a call completing (for testing without real Twilio). */
  simulateCallEnd(callId: string, transcript?: Array<{ role: string; text: string }>): void {
    const record = this.calls.get(callId);
    if (!record) return;
    record.status = "completed";
    record.endedAt = Date.now();
    record.duration = Math.round((Date.now() - record.startedAt) / 1000);
    record.transcript = transcript || [
      { role: "assistant", text: "Hello, how can I help?" },
      { role: "user", text: "This is a test call." },
      { role: "assistant", text: "Got it, test call completed successfully." },
    ];
    record.metrics = {
      cost: { stt: 0.001, tts: 0.002, llm: 0.005, telephony: 0.01, total: 0.018 },
      latency_avg: { stt_ms: 90, llm_ms: 250, tts_ms: 70, total_ms: 410 },
    };
    log(`Call ${callId} simulated complete`);
  }

  /** Call a third party autonomously and wait for the call to complete. */
  async callThirdParty(
    to: string,
    task: string,
    voice?: string,
  ): Promise<CallRecord> {
    const systemPrompt =
      `You are making a phone call on behalf of someone. Your task: ${task}\n\n` +
      `Be polite, concise, and focused on the task. When the task is complete ` +
      `or you have the information needed, thank them and end the call.`;

    const callId = await this.makeCall(to, systemPrompt, undefined, voice);
    return this.waitForCallEnd(callId, 300_000);
  }

  /** Wait for a call to complete (polling). */
  async waitForCallEnd(
    callId: string,
    timeoutMs: number,
  ): Promise<CallRecord> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const record = this.calls.get(callId);
      if (!record) throw new Error(`Call ${callId} not found`);
      if (record.status === "completed" || record.status === "failed") {
        return record;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Call ${callId} timed out after ${timeoutMs / 1000}s`);
  }

  get phoneNumber(): string {
    return process.env.TWILIO_PHONE_NUMBER || "unknown";
  }

  get isServerRunning(): boolean {
    return this.serverRunning;
  }
}

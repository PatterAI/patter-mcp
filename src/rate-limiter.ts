/**
 * Rate limiting and budget enforcement for outbound calls.
 *
 * All limits are enforced only when a `userId` is present (authenticated
 * mode). Unauthenticated / local-dev mode is always allowed through.
 *
 * Configuration via environment variables (all optional):
 *   RATE_LIMIT_DAILY=10          — max outbound calls per user per calendar day
 *   MAX_CONCURRENT_CALLS=2       — max simultaneous active calls per user
 *   HOURLY_BUDGET_CAP_USD=       — global hourly spend cap in USD (optional)
 */

import {
  isDbAvailable,
  countDailyCallsByUser,
  sumHourlyCostUsd,
} from "./db.js";

// ---------------------------------------------------------------------------
// Config validation helpers
// ---------------------------------------------------------------------------

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid config: ${name}="${raw}" must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveFloat(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid config: ${name}="${raw}" must be a non-negative number`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RATE_LIMIT_DAILY = parsePositiveInt(process.env.RATE_LIMIT_DAILY, 10, "RATE_LIMIT_DAILY");
const MAX_CONCURRENT_CALLS = parsePositiveInt(process.env.MAX_CONCURRENT_CALLS, 2, "MAX_CONCURRENT_CALLS");
const HOURLY_BUDGET_CAP_USD = parsePositiveFloat(process.env.HOURLY_BUDGET_CAP_USD, "HOURLY_BUDGET_CAP_USD");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start-of-today in UTC (epoch ms). */
function utcDayStartMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Start of the current hour in UTC (epoch ms). */
function utcHourStartMs(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
  );
}

// ---------------------------------------------------------------------------
// In-memory counters
// ---------------------------------------------------------------------------

// The daily counter is an in-memory FALLBACK used only when the DB is
// unavailable (the DB is authoritative for the daily count otherwise).
//
// The concurrent counter, by contrast, is ALWAYS authoritative — it is the
// single source of truth for "calls live right now" in both DB and in-memory
// modes. Under the wait:true model a call is live exactly for the duration of
// PatterServer.makeCall (which increments on entry and decrements in finally),
// leaving no in-progress DB row to count, so this ephemeral per-process
// counter is the right home for that state.

const memoryDailyCount: Map<string, { date: string; count: number }> =
  new Map();
const memoryConcurrentCount: Map<string, number> = new Map();

function todayUtcString(): string {
  return new Date().toISOString().slice(0, 10);
}

function memoryGetDaily(userId: string): number {
  const entry = memoryDailyCount.get(userId);
  if (!entry || entry.date !== todayUtcString()) return 0;
  return entry.count;
}

function memoryIncrementDaily(userId: string): void {
  const today = todayUtcString();
  const entry = memoryDailyCount.get(userId);
  if (!entry || entry.date !== today) {
    memoryDailyCount.set(userId, { date: today, count: 1 });
  } else {
    memoryDailyCount.set(userId, { date: today, count: entry.count + 1 });
  }
}

function memoryGetConcurrent(userId: string): number {
  return memoryConcurrentCount.get(userId) ?? 0;
}

/** Increment the in-memory concurrent counter for a user. Call when a call starts. */
export function incrementConcurrent(userId: string | undefined): void {
  if (!userId) return;
  const current = memoryConcurrentCount.get(userId) ?? 0;
  memoryConcurrentCount.set(userId, current + 1);
}

/** Decrement the in-memory concurrent counter for a user. Call when a call ends. */
export function decrementConcurrent(userId: string | undefined): void {
  if (!userId) return;
  const current = memoryConcurrentCount.get(userId) ?? 0;
  memoryConcurrentCount.set(userId, Math.max(0, current - 1));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a new outbound call is permitted for `userId`.
 *
 * When `userId` is undefined (unauthenticated / local dev), all checks are
 * skipped and the call is always allowed.
 *
 * When the SQLite DB is available it is used as the authoritative source.
 * When unavailable, in-memory counters are used as a best-effort fallback.
 */
export function checkRateLimit(userId: string | undefined): RateLimitResult {
  if (!userId) return { allowed: true };

  if (isDbAvailable()) {
    return checkRateLimitDb(userId);
  }

  return checkRateLimitMemory(userId);
}

/**
 * Record a newly-started call for daily rate-limit tracking.
 *
 * When the DB is available this is a no-op (the daily count is read from the
 * persisted call rows). When the DB is unavailable it primes the in-memory
 * daily fallback counter. Concurrent accounting is NOT done here — it is
 * owned by PatterServer.makeCall (increment on entry / decrement in finally),
 * the only window in which a call is actually live under the wait:true model.
 */
export function recordCallStart(userId: string | undefined): void {
  if (!userId) return;
  if (!isDbAvailable()) {
    memoryIncrementDaily(userId);
  }
}

// ---------------------------------------------------------------------------
// DB-backed checks
// ---------------------------------------------------------------------------

function checkRateLimitDb(userId: string): RateLimitResult {
  const dailyCount = countDailyCallsByUser(userId, utcDayStartMs());
  if (dailyCount >= RATE_LIMIT_DAILY) {
    return {
      allowed: false,
      reason:
        `Daily call limit reached (${RATE_LIMIT_DAILY} calls per day). ` +
        `Please try again tomorrow.`,
    };
  }

  // Concurrent count is always read from the in-memory counter, which is the
  // authoritative live-call tracker in both modes (see the counter section
  // above). The DB has no in-progress row to count under the wait:true model.
  const concurrentCount = memoryGetConcurrent(userId);
  if (concurrentCount >= MAX_CONCURRENT_CALLS) {
    return {
      allowed: false,
      reason:
        `Too many active calls (max ${MAX_CONCURRENT_CALLS} concurrent). ` +
        `Please wait for an existing call to finish.`,
    };
  }

  if (HOURLY_BUDGET_CAP_USD !== undefined) {
    const hourlySpend = sumHourlyCostUsd(utcHourStartMs());
    if (hourlySpend >= HOURLY_BUDGET_CAP_USD) {
      return {
        allowed: false,
        reason:
          `Hourly budget cap of $${HOURLY_BUDGET_CAP_USD.toFixed(2)} USD reached. ` +
          `New calls are paused until the next hour.`,
      };
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// In-memory fallback checks
// ---------------------------------------------------------------------------

function checkRateLimitMemory(userId: string): RateLimitResult {
  const dailyCount = memoryGetDaily(userId);
  if (dailyCount >= RATE_LIMIT_DAILY) {
    return {
      allowed: false,
      reason:
        `Daily call limit reached (${RATE_LIMIT_DAILY} calls per day). ` +
        `Please try again tomorrow.`,
    };
  }

  const concurrentCount = memoryGetConcurrent(userId);
  if (concurrentCount >= MAX_CONCURRENT_CALLS) {
    return {
      allowed: false,
      reason:
        `Too many active calls (max ${MAX_CONCURRENT_CALLS} concurrent). ` +
        `Please wait for an existing call to finish.`,
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Max call duration (informational)
// ---------------------------------------------------------------------------

// Parsed/validated config kept for operators who set MAX_CALL_DURATION_SECONDS.
// The hard duration ceiling is now enforced by the SDK: `call({ wait: true })`
// is timeout-bounded and the embedded server arms its own per-call max-duration
// guard, so patter-mcp no longer runs a duration timer of its own.
export const MAX_CALL_DURATION_SECONDS = parsePositiveInt(
  process.env.MAX_CALL_DURATION_SECONDS,
  300,
  "MAX_CALL_DURATION_SECONDS",
);

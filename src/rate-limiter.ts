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
  countConcurrentCallsByUser,
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
// In-memory fallback counters (used when DB is unavailable)
// ---------------------------------------------------------------------------

// NOTE: If the DB becomes unavailable *after* calls have already been started
// in DB mode, the in-memory concurrent counter will be inaccurate because
// those ongoing calls were never tracked here. The in-memory fallback is only
// reliable when it has been the active tracking mechanism from the start.

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
 * Record a newly-started call for rate-limit tracking purposes.
 *
 * When the DB is available this is a no-op (the call row is already written
 * by PatterServer.persist). Only updates in-memory counters, which are used
 * as fallback when the DB is unavailable.
 */
export function recordCallStart(userId: string | undefined): void {
  if (!userId) return;
  if (!isDbAvailable()) {
    memoryIncrementDaily(userId);
    incrementConcurrent(userId);
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

  const concurrentCount = countConcurrentCallsByUser(userId);
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
// Re-export config for use elsewhere (e.g. duration enforcement)
// ---------------------------------------------------------------------------

export const MAX_CALL_DURATION_SECONDS = parsePositiveInt(
  process.env.MAX_CALL_DURATION_SECONDS,
  300,
  "MAX_CALL_DURATION_SECONDS",
);

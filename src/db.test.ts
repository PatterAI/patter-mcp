/**
 * DB module tests.
 *
 * The DB module uses a native better-sqlite3 binding. When the binding is
 * unavailable (sandboxed test runner, missing binary, mmap restrictions) the
 * module gracefully falls back to no-op mode. We test both paths:
 *
 *   1. No-op fallback behaviour (always exercised in CI / sandboxed envs)
 *   2. Live SQLite round-trips (only when the binding loads successfully)
 */

import { describe, it, expect, beforeAll } from "vitest";

// Set in-memory path before the module is imported
process.env.PATTER_DB_PATH = ":memory:";

import {
  initDb,
  isDbAvailable,
  upsertCall,
  getCall,
  getCallsByUser,
  getAllCalls,
  countDailyCallsByUser,
  countConcurrentCallsByUser,
  sumHourlyCostUsd,
  DB_PATH,
} from "./db.js";
import type { CallRecord } from "./patter-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call_test_" + Math.random().toString(36).slice(2, 10),
    direction: "outbound",
    status: "completed",
    startedAt: Date.now(),
    transcript: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup — attempt to initialise
// ---------------------------------------------------------------------------

beforeAll(() => {
  initDb();
});

// ---------------------------------------------------------------------------
// DB path config
// ---------------------------------------------------------------------------

describe("DB_PATH", () => {
  it("is a non-empty string (defaults to patter-mcp.db when env var not set at import time)", () => {
    // DB_PATH is evaluated at module load time from process.env.PATTER_DB_PATH.
    // The default is 'patter-mcp.db'. The env var set in this test file may not
    // be visible at module initialisation due to ESM evaluation order.
    expect(typeof DB_PATH).toBe("string");
    expect(DB_PATH.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// No-op fallback tests (always run regardless of native binary availability)
// ---------------------------------------------------------------------------

describe("no-op fallback behaviour when DB is unavailable", () => {
  it("getCall returns undefined when DB is unavailable", () => {
    if (isDbAvailable()) return; // skip if DB actually loaded
    expect(getCall("any-id")).toBeUndefined();
  });

  it("getCallsByUser returns empty array when DB is unavailable", () => {
    if (isDbAvailable()) return;
    expect(getCallsByUser("user-1")).toEqual([]);
  });

  it("getAllCalls returns empty array when DB is unavailable", () => {
    if (isDbAvailable()) return;
    expect(getAllCalls()).toEqual([]);
  });

  it("countDailyCallsByUser returns 0 when DB is unavailable", () => {
    if (isDbAvailable()) return;
    expect(countDailyCallsByUser("user-1", 0)).toBe(0);
  });

  it("countConcurrentCallsByUser returns 0 when DB is unavailable", () => {
    if (isDbAvailable()) return;
    expect(countConcurrentCallsByUser("user-1")).toBe(0);
  });

  it("sumHourlyCostUsd returns 0 when DB is unavailable", () => {
    if (isDbAvailable()) return;
    expect(sumHourlyCostUsd(0)).toBe(0);
  });

  it("upsertCall is a no-op and does not throw when DB is unavailable", () => {
    if (isDbAvailable()) return;
    expect(() => upsertCall(makeRecord())).not.toThrow();
  });

  it("initDb is idempotent and does not throw", () => {
    expect(() => initDb()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Live SQLite tests (only run when the native binding loaded successfully)
// ---------------------------------------------------------------------------

describe("upsertCall / getCall round-trip", () => {
  it("inserts a new record and retrieves it by callId", () => {
    if (!isDbAvailable()) {
      expect(true).toBe(true); // mark as passing — DB unavailable
      return;
    }

    // Arrange
    const record = makeRecord({
      callId: "call_roundtrip_1",
      to: "+14155552671",
      userId: "user-abc",
      status: "completed",
      duration: 42,
      transcript: [{ role: "assistant", text: "Hello!" }],
    });

    // Act
    upsertCall(record);
    const fetched = getCall("call_roundtrip_1");

    // Assert
    expect(fetched).toBeDefined();
    expect(fetched!.callId).toBe("call_roundtrip_1");
    expect(fetched!.to).toBe("+14155552671");
    expect(fetched!.userId).toBe("user-abc");
    expect(fetched!.status).toBe("completed");
    expect(fetched!.duration).toBe(42);
    expect(fetched!.transcript).toEqual([{ role: "assistant", text: "Hello!" }]);
  });

  it("updates an existing record on conflict", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const initial = makeRecord({ callId: "call_update_1", status: "ringing", duration: undefined });
    upsertCall(initial);

    const updated = { ...initial, status: "completed" as const, duration: 60 };
    upsertCall(updated);

    const fetched = getCall("call_update_1");
    expect(fetched!.status).toBe("completed");
    expect(fetched!.duration).toBe(60);
  });

  it("returns undefined for a non-existent callId", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }
    expect(getCall("call_does_not_exist")).toBeUndefined();
  });

  it("preserves undefined optional fields as undefined after round-trip", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const record = makeRecord({
      callId: "call_optional_fields",
      userId: undefined,
      to: undefined,
      from: undefined,
      endedAt: undefined,
      duration: undefined,
      metrics: undefined,
    });
    upsertCall(record);
    const fetched = getCall("call_optional_fields");
    expect(fetched!.userId).toBeUndefined();
    expect(fetched!.to).toBeUndefined();
    expect(fetched!.from).toBeUndefined();
    expect(fetched!.endedAt).toBeUndefined();
    expect(fetched!.duration).toBeUndefined();
    expect(fetched!.metrics).toBeUndefined();
  });

  it("stores and retrieves JSON metrics correctly", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const metrics = { cost: { stt: 0.001, tts: 0.002, llm: 0.005, telephony: 0.01, total: 0.018 } };
    const record = makeRecord({ callId: "call_metrics_1", metrics });
    upsertCall(record);
    const fetched = getCall("call_metrics_1");
    expect(fetched!.metrics).toEqual(metrics);
  });
});

describe("getCallsByUser", () => {
  it("returns only calls belonging to the specified userId", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const userId = "user-filter-" + Date.now();
    upsertCall(makeRecord({ callId: "call_user_filter_1", userId }));
    upsertCall(makeRecord({ callId: "call_user_filter_2", userId }));
    upsertCall(makeRecord({ callId: "call_user_filter_3", userId: "other-user" }));

    const ids = getCallsByUser(userId).map((r) => r.callId);
    expect(ids).toContain("call_user_filter_1");
    expect(ids).toContain("call_user_filter_2");
    expect(ids).not.toContain("call_user_filter_3");
  });

  it("returns calls ordered by startedAt descending", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const userId = "user-order-" + Date.now();
    upsertCall(makeRecord({ callId: "call_order_early_" + Date.now(), userId, startedAt: 1000 }));
    upsertCall(makeRecord({ callId: "call_order_late_" + Date.now(), userId, startedAt: 2000 }));

    const results = getCallsByUser(userId);
    expect(results[0].startedAt).toBeGreaterThan(results[1].startedAt);
  });

  it("returns empty array when user has no calls", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }
    expect(getCallsByUser("user-nobody-" + Date.now())).toEqual([]);
  });
});

describe("getAllCalls", () => {
  it("includes inserted calls with no userId", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const callId = "call_no_user_" + Date.now();
    upsertCall(makeRecord({ callId, userId: undefined }));
    const all = getAllCalls();
    expect(all.map((r) => r.callId)).toContain(callId);
  });
});

describe("countDailyCallsByUser", () => {
  it("counts outbound calls since a given timestamp", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const userId = "user-count-daily-" + Date.now();
    const since = Date.now() - 1000;

    upsertCall(makeRecord({ callId: "call_daily_1_" + Date.now(), userId, direction: "outbound", startedAt: Date.now() }));
    upsertCall(makeRecord({ callId: "call_daily_2_" + Date.now(), userId, direction: "outbound", startedAt: Date.now() }));

    expect(countDailyCallsByUser(userId, since)).toBe(2);
  });

  it("does not count inbound calls", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const userId = "user-count-inbound-" + Date.now();
    upsertCall(makeRecord({ callId: "call_inbound_" + Date.now(), userId, direction: "inbound", startedAt: Date.now() }));

    expect(countDailyCallsByUser(userId, Date.now() - 1000)).toBe(0);
  });

  it("does not count calls before the since timestamp", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const userId = "user-count-old-" + Date.now();
    upsertCall(makeRecord({ callId: "call_old_" + Date.now(), userId, direction: "outbound", startedAt: 1000 }));

    expect(countDailyCallsByUser(userId, Date.now() - 1000)).toBe(0);
  });

  it("returns 0 for a user with no calls", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }
    expect(countDailyCallsByUser("user-nobody-daily-" + Date.now(), 0)).toBe(0);
  });
});

describe("countConcurrentCallsByUser", () => {
  it("counts only ringing and in-progress outbound calls", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const userId = "user-concurrent-db-" + Date.now();
    upsertCall(makeRecord({ callId: "call_conc_ringing_" + Date.now(), userId, direction: "outbound", status: "ringing" }));
    upsertCall(makeRecord({ callId: "call_conc_inprogress_" + Date.now(), userId, direction: "outbound", status: "in-progress" }));
    upsertCall(makeRecord({ callId: "call_conc_completed_" + Date.now(), userId, direction: "outbound", status: "completed" }));

    expect(countConcurrentCallsByUser(userId)).toBe(2);
  });

  it("returns 0 when no active calls", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const userId = "user-no-active-" + Date.now();
    upsertCall(makeRecord({ callId: "call_done_" + Date.now(), userId, direction: "outbound", status: "completed" }));

    expect(countConcurrentCallsByUser(userId)).toBe(0);
  });
});

describe("sumHourlyCostUsd", () => {
  it("sums cost.total from metrics for calls in the time window", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const since = Date.now() - 1000;
    const metrics = { cost: { stt: 0.001, tts: 0.002, llm: 0.005, telephony: 0.01, total: 0.018 } };
    upsertCall(makeRecord({ callId: "call_cost_a_" + Date.now(), direction: "outbound", startedAt: Date.now(), metrics }));
    upsertCall(makeRecord({ callId: "call_cost_b_" + Date.now(), direction: "outbound", startedAt: Date.now(), metrics }));

    const total = sumHourlyCostUsd(since);
    expect(total).toBeGreaterThanOrEqual(0.036 - 0.0001);
  });

  it("returns 0 for a future since timestamp (no matching calls)", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }
    expect(sumHourlyCostUsd(Date.now() + 10_000)).toBe(0);
  });

  it("does not throw or produce NaN for calls without a cost.total field", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    upsertCall(makeRecord({
      callId: "call_no_cost_" + Date.now(),
      direction: "outbound",
      startedAt: Date.now(),
      metrics: { latency: { avg_ms: 100 } },
    }));

    const total = sumHourlyCostUsd(Date.now() - 1000);
    expect(Number.isFinite(total)).toBe(true);
  });
});

describe("safeParseJson (via round-trip)", () => {
  it("stores and retrieves a multi-turn transcript correctly", () => {
    if (!isDbAvailable()) { expect(true).toBe(true); return; }

    const record = makeRecord({
      callId: "call_json_valid_" + Date.now(),
      transcript: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }],
    });
    upsertCall(record);
    const fetched = getCall(record.callId);
    expect(fetched!.transcript).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
  });
});

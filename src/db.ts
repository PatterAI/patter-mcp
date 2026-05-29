/**
 * SQLite persistence layer for call records.
 *
 * Uses better-sqlite3 (synchronous) for local storage.
 * Gracefully falls back to a no-op in-memory mode if the
 * native binary is unavailable (e.g. some container environments).
 */

import type { CallRecord } from "./patter-server.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A row as stored in the calls table (snake_case, JSON-serialised fields). */
interface CallRow {
  call_id: string;
  user_id: string | null;
  to_number: string | null;
  from_number: string | null;
  direction: "outbound" | "inbound";
  status: "ringing" | "in-progress" | "completed" | "failed";
  outcome: string | null;
  started_at: number;
  ended_at: number | null;
  duration: number | null;
  transcript: string | null;
  metrics: string | null;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS calls (
  call_id    TEXT PRIMARY KEY,
  user_id    TEXT,
  to_number  TEXT,
  from_number TEXT,
  direction  TEXT NOT NULL CHECK(direction IN ('outbound', 'inbound')),
  status     TEXT NOT NULL CHECK(status IN ('ringing', 'in-progress', 'completed', 'failed')),
  outcome    TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  duration   INTEGER,
  transcript TEXT,
  metrics    TEXT
);

CREATE INDEX IF NOT EXISTS idx_calls_user_id ON calls(user_id);
CREATE INDEX IF NOT EXISTS idx_calls_status  ON calls(status);
`.trim();

/**
 * Idempotent migration for databases created before the `outcome` column
 * existed. `ALTER TABLE ... ADD COLUMN` throws "duplicate column name" when
 * the column is already present, so the caller swallows that specific error.
 */
const MIGRATIONS: ReadonlyArray<string> = [
  "ALTER TABLE calls ADD COLUMN outcome TEXT",
];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[patter-db] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Row <-> CallRecord conversion (immutable — always return new objects)
// ---------------------------------------------------------------------------

function safeParseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    log("Corrupt JSON column, using fallback");
    return fallback;
  }
}

function rowToRecord(row: CallRow): CallRecord {
  return {
    callId: row.call_id,
    userId: row.user_id ?? undefined,
    to: row.to_number ?? undefined,
    from: row.from_number ?? undefined,
    direction: row.direction,
    status: row.status,
    outcome: (row.outcome as CallRecord["outcome"]) ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    duration: row.duration ?? undefined,
    transcript: safeParseJson<Array<{ role: string; text: string }>>(
      row.transcript,
      [],
    ),
    metrics: safeParseJson<Record<string, unknown> | undefined>(
      row.metrics,
      undefined,
    ),
  };
}

function recordToRow(r: CallRecord): CallRow {
  return {
    call_id: r.callId,
    user_id: r.userId ?? null,
    to_number: r.to ?? null,
    from_number: r.from ?? null,
    direction: r.direction,
    status: r.status,
    outcome: r.outcome ?? null,
    started_at: r.startedAt,
    ended_at: r.endedAt ?? null,
    duration: r.duration ?? null,
    transcript: JSON.stringify(r.transcript),
    metrics: r.metrics !== undefined ? JSON.stringify(r.metrics) : null,
  };
}

// ---------------------------------------------------------------------------
// DB handle (module-level singleton)
// ---------------------------------------------------------------------------

type Database = import("better-sqlite3").Database;
type Statement = import("better-sqlite3").Statement;

interface Statements {
  upsert: Statement;
  selectOne: Statement;
  selectByUser: Statement;
  selectAll: Statement;
  countDailyByUser: Statement;
  countConcurrentByUser: Statement;
  sumHourlyCost: Statement;
}

let db: Database | undefined;
let stmts: Statements | undefined;

/** True when the SQLite database initialised successfully. */
let _dbAvailable = false;

/** Returns true when the SQLite database initialised successfully. */
export function isDbAvailable(): boolean {
  return _dbAvailable;
}

// ---------------------------------------------------------------------------
// Exported path so callers / tests can inspect where the DB lives
// ---------------------------------------------------------------------------

export const DB_PATH =
  process.env.PATTER_DB_PATH ?? "patter-mcp.db";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function prepareStatements(database: Database): Statements {
  return {
    upsert: database.prepare(`
      INSERT INTO calls (
        call_id, user_id, to_number, from_number,
        direction, status, outcome, started_at, ended_at,
        duration, transcript, metrics
      ) VALUES (
        @call_id, @user_id, @to_number, @from_number,
        @direction, @status, @outcome, @started_at, @ended_at,
        @duration, @transcript, @metrics
      )
      ON CONFLICT(call_id) DO UPDATE SET
        user_id      = excluded.user_id,
        to_number    = excluded.to_number,
        from_number  = excluded.from_number,
        direction    = excluded.direction,
        status       = excluded.status,
        outcome      = excluded.outcome,
        started_at   = excluded.started_at,
        ended_at     = excluded.ended_at,
        duration     = excluded.duration,
        transcript   = excluded.transcript,
        metrics      = excluded.metrics
    `),
    selectOne: database.prepare(
      "SELECT * FROM calls WHERE call_id = ?",
    ),
    selectByUser: database.prepare(
      "SELECT * FROM calls WHERE user_id = ? ORDER BY started_at DESC",
    ),
    selectAll: database.prepare(
      "SELECT * FROM calls ORDER BY started_at DESC",
    ),
    /** Count outbound calls placed by a user today (UTC day boundary). */
    countDailyByUser: database.prepare(`
      SELECT COUNT(*) as count
      FROM calls
      WHERE user_id = ?
        AND direction = 'outbound'
        AND started_at >= ?
    `),
    /** Count active (ringing or in-progress) outbound calls for a user. */
    countConcurrentByUser: database.prepare(`
      SELECT COUNT(*) as count
      FROM calls
      WHERE user_id = ?
        AND direction = 'outbound'
        AND status IN ('ringing', 'in-progress')
    `),
    /**
     * Sum the total field from the cost JSON within metrics for calls
     * started within the current hour window.
     */
    sumHourlyCost: database.prepare(`
      SELECT metrics
      FROM calls
      WHERE direction = 'outbound'
        AND started_at >= ?
        AND metrics IS NOT NULL
    `),
  };
}

/**
 * Apply additive schema migrations to an existing database. Each statement
 * is an `ALTER TABLE ... ADD COLUMN`; the "duplicate column name" error is
 * swallowed so the migration is idempotent across restarts and fresh DBs
 * (where the column already came from CREATE TABLE).
 */
function runMigrations(database: Database): void {
  for (const statement of MIGRATIONS) {
    try {
      database.exec(statement);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("duplicate column name")) {
        throw err;
      }
    }
  }
}

/**
 * Initialise the SQLite connection and create tables.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * Falls back to a no-op in-memory mode and logs a warning when
 * better-sqlite3's native binary cannot be loaded.
 */
export function initDb(): void {
  if (_dbAvailable) return;

  try {
    // Dynamic import keeps the module loadable even when the native
    // binary is missing — the error only surfaces here, not at import time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
    db = new BetterSqlite3(DB_PATH);
    db.exec(CREATE_TABLE);
    runMigrations(db);
    stmts = prepareStatements(db);
    _dbAvailable = true;
    log(`SQLite ready at ${DB_PATH}`);
  } catch (err) {
    log(
      `WARNING: SQLite unavailable — falling back to in-memory mode. ` +
      `Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Insert or update a call record in the database.
 * No-op when DB is unavailable.
 */
export function upsertCall(record: CallRecord): void {
  if (!_dbAvailable || !stmts) return;
  const row = recordToRow(record);
  stmts.upsert.run(row);
}

/**
 * Retrieve a single call by ID.
 * Returns `undefined` when not found or DB is unavailable.
 */
export function getCall(callId: string): CallRecord | undefined {
  if (!_dbAvailable || !stmts) return undefined;
  const row = stmts.selectOne.get(callId) as CallRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

/**
 * Return all calls belonging to `userId`, or every call when `userId`
 * is `undefined` (unauthenticated / admin mode).
 */
export function getCallsByUser(userId?: string): CallRecord[] {
  if (!_dbAvailable || !stmts) return [];
  const rows =
    userId !== undefined
      ? (stmts.selectByUser.all(userId) as CallRow[])
      : (stmts.selectAll.all() as CallRow[]);
  return rows.map(rowToRecord);
}

/**
 * Return every call record in the database.
 */
export function getAllCalls(): CallRecord[] {
  if (!_dbAvailable || !stmts) return [];
  return (stmts.selectAll.all() as CallRow[]).map(rowToRecord);
}

/**
 * Count outbound calls placed by `userId` since `sinceMs` (epoch ms).
 * Returns 0 when the DB is unavailable.
 */
export function countDailyCallsByUser(userId: string, sinceMs: number): number {
  if (!_dbAvailable || !stmts) return 0;
  const row = stmts.countDailyByUser.get(userId, sinceMs) as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

/**
 * Count active (ringing or in-progress) outbound calls for `userId`.
 * Returns 0 when the DB is unavailable.
 */
export function countConcurrentCallsByUser(userId: string): number {
  if (!_dbAvailable || !stmts) return 0;
  const row = stmts.countConcurrentByUser.get(userId) as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

/**
 * Sum estimated call costs for all outbound calls started since `sinceMs`.
 * Reads the `cost.total` field from the JSON-serialised metrics column.
 * Returns 0 when the DB is unavailable or no metrics are recorded.
 */
export function sumHourlyCostUsd(sinceMs: number): number {
  if (!_dbAvailable || !stmts) return 0;

  const rows = stmts.sumHourlyCost.all(sinceMs) as Array<{ metrics: string }>;
  let total = 0;
  for (const row of rows) {
    try {
      const metrics = JSON.parse(row.metrics) as Record<string, unknown>;
      const cost = metrics.cost as Record<string, unknown> | undefined;
      if (typeof cost?.total === "number") {
        total += cost.total;
      }
    } catch {
      // malformed metrics — skip
    }
  }
  return total;
}

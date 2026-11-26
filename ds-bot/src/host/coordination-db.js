// SQLite coordination ledger for DS Bot: works, calls, inbox, waits, and ready.
//
// Owns scheduling truth without duplicating full chat logs or tool output bodies.
// Uses Node 24's built-in `node:sqlite` in WAL mode: a single state.lock holder writes
// atomically via BEGIN IMMEDIATE transactions, while secondary windows open the same
// file with `{ readonly: true }` and never take write locks or mutate state.
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 3

const IS_WINDOWS = process.platform === 'win32'
const isCorruptSqliteError = error => /malformed|not a database|corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(String(error?.message ?? error))

const LEGACY_V2_TABLES_SQL = `
  DROP TABLE IF EXISTS obligations;
  DROP TABLE IF EXISTS deliveries;
  DROP TABLE IF EXISTS active_turns;
  DROP TABLE IF EXISTS silent_notes;
  DROP TABLE IF EXISTS terminal_markers;
  DROP TABLE IF EXISTS meta;
`

export const WORK_KINDS = Object.freeze(['foreground', 'task', 'room_work'])
export const WORK_STATUSES = Object.freeze([
  'idle',
  'queued',
  'running',
  'waiting',
  'paused',
  'needs_verification',
  'stopping',
  'done',
  'failed',
  'stopped',
])
export const TERMINAL_WORK_STATUSES = new Set(['done', 'failed', 'stopped'])
export const CALL_STATUSES = Object.freeze(['open', 'done', 'failed', 'stopped'])
export const CALL_DELIVERY_STATUSES = Object.freeze(['pending', 'delivered', 'undeliverable', 'archived'])
export const INBOX_KINDS = Object.freeze(['request', 'revise', 'ask', 'answer', 'result', 'note'])
export const WAIT_KINDS = Object.freeze(['call', 'ask', 'approval', 'user_question', 'secret'])
export const WAIT_STATUSES = Object.freeze(['open', 'resolved', 'cancelled'])
export const PRIORITIES = Object.freeze(['foreground', 'interactive', 'background'])
export const PRIORITY_RANK = Object.freeze({ foreground: 0, interactive: 1, background: 2 })
export const VISIBILITIES = Object.freeze(['private', 'direct', 'room'])
export const WORKSPACE_MODES = Object.freeze(['read', 'write', 'isolated'])
export const EXECUTION_KINDS = Object.freeze(['dsh', 'local_cli'])

const DEFAULT_STAGNATION_THRESHOLD = 3
const ACTIVE_LEGACY_TASK_STATUSES = new Set(['running', 'waiting_work', 'waiting_approval'])

export class CoordinationError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'CoordinationError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const toSql = value => (value === undefined ? null : value)
const toJson = value => (value === undefined || value === null ? null : JSON.stringify(value))
const fromJson = (raw) => {
  if (typeof raw !== 'string' || raw === '') return null
  try { return JSON.parse(raw) } catch { return null }
}
const nonEmptyString = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CoordinationError('coordination/invalid_argument', `${field} must be a non-empty string`)
  }
  return value
}
const oneOf = (value, allowed, field) => {
  if (!allowed.includes(value)) {
    throw new CoordinationError('coordination/invalid_argument', `${field} must be one of: ${allowed.join(', ')}`)
  }
  return value
}
const rankOf = priority => PRIORITY_RANK[oneOf(priority, PRIORITIES, 'priority')]

// Canonicalizes a workspace path so equivalent paths (relative segments, trailing slashes,
// symlinks like `/var` vs `/private/var` on macOS) serialize on the same write lock key.
export function canonicalizeWorkspaceDir(dir) {
  if (typeof dir !== 'string') return null
  const trimmed = dir.trim()
  if (trimmed === '') return null
  const resolved = resolve(trimmed)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function computeProgressSignature({
  revision = 1,
  workspaceDigest = '',
  outputDigest = '',
  errorSignature = '',
} = {}) {
  const payload = JSON.stringify([
    Number.isInteger(revision) ? revision : 1,
    String(workspaceDigest ?? ''),
    String(outputDigest ?? ''),
    String(errorSignature ?? ''),
  ])
  return createHash('sha256').update(payload).digest('hex')
}

function mapWork(row) {
  if (!row) return undefined
  return {
    workId: row.work_id,
    workRef: row.work_ref,
    botId: row.bot_id,
    kind: row.kind,
    logicalAddress: row.logical_address,
    status: row.status,
    priority: row.priority,
    revision: row.revision,
    rootWorkId: row.root_work_id,
    parentWorkId: row.parent_work_id,
    roomId: row.room_id,
    title: row.title,
    originKind: row.origin_kind,
    imOrigin: fromJson(row.im_origin_json),
    apiRunId: row.api_run_id,
    apiIdempotencyKey: row.api_idempotency_key,
    apiMeta: fromJson(row.api_meta_json),
    visibility: row.visibility,
    privacyScoped: row.privacy_scoped === 1,
    sessionId: row.session_id,
    executionKind: row.execution_kind,
    workspaceDir: row.workspace_dir,
    workspaceMode: row.workspace_mode,
    lastDeliveredSeq: row.last_delivered_seq,
    lastConsumedSeq: row.last_consumed_seq,
    activeDeliveryKey: row.active_delivery_key,
    deliveryAttempt: row.delivery_attempt,
    activeTurn: row.active_turn,
    claimToken: row.claim_token,
    claimOwner: row.claim_owner,
    claimedAt: row.claimed_at,
    claimedRevision: row.claimed_revision,
    claimedInboxSeq: row.claimed_inbox_seq,
    progressSignature: row.progress_signature,
    stagnationKey: row.stagnation_key,
    stagnationCount: row.stagnation_count,
    pauseReason: row.pause_reason,
    pauseDetail: fromJson(row.pause_detail_json),
    resultSummary: row.result_summary,
    resultRef: row.result_ref,
    error: fromJson(row.error_json),
    meta: fromJson(row.meta_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function mapCall(row) {
  if (!row) return undefined
  return {
    callId: row.call_id,
    parentWorkId: row.parent_work_id,
    childWorkId: row.child_work_id,
    callerBotId: row.caller_bot_id,
    calleeBotId: row.callee_bot_id,
    returnAddress: row.return_address,
    visibleScope: row.visible_scope,
    roomId: row.room_id,
    status: row.status,
    deliveryStatus: row.delivery_status,
    targetRevision: row.target_revision,
    resultSummary: row.result_summary,
    resultRef: row.result_ref,
    error: fromJson(row.error_json),
    meta: fromJson(row.meta_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
    deliveredAt: row.delivered_at,
  }
}

function mapInbox(row) {
  if (!row) return undefined
  return {
    workId: row.work_id,
    seq: row.seq,
    dedupKey: row.dedup_key,
    kind: row.kind,
    senderAddress: row.sender_address,
    senderBotId: row.sender_bot_id,
    callId: row.call_id,
    waitId: row.wait_id,
    targetRevision: row.target_revision,
    bodyRef: row.body_ref,
    bodyPreview: row.body_preview,
    payload: fromJson(row.payload_json),
    readAt: row.read_at,
    dshIdempotencyKey: row.dsh_idempotency_key,
    createdAt: row.created_at,
  }
}

function mapWait(row) {
  if (!row) return undefined
  return {
    waitId: row.wait_id,
    workId: row.work_id,
    kind: row.kind,
    targetId: row.target_id,
    targetWorkId: row.target_work_id,
    required: row.required === 1,
    status: row.status,
    resolution: fromJson(row.resolution_json),
    meta: fromJson(row.meta_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  }
}

function mapReady(row) {
  if (!row) return undefined
  return {
    workId: row.work_id,
    botId: row.bot_id,
    priority: row.priority,
    priorityRank: row.priority_rank,
    reason: row.reason,
    enqueuedAt: row.enqueued_at,
    updatedAt: row.updated_at,
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS works (
  work_id TEXT PRIMARY KEY,
  work_ref TEXT UNIQUE,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('foreground', 'task', 'room_work')),
  logical_address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'idle', 'queued', 'running', 'waiting', 'paused', 'needs_verification', 'stopping', 'done', 'failed', 'stopped'
  )),
  priority TEXT NOT NULL DEFAULT 'background' CHECK (priority IN ('foreground', 'interactive', 'background')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  root_work_id TEXT NOT NULL,
  parent_work_id TEXT,
  room_id TEXT,
  title TEXT,
  origin_kind TEXT,
  im_origin_json TEXT,
  api_run_id TEXT UNIQUE,
  api_idempotency_key TEXT UNIQUE,
  api_meta_json TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'direct', 'room')),
  privacy_scoped INTEGER NOT NULL DEFAULT 0 CHECK (privacy_scoped IN (0, 1)),
  session_id TEXT,
  execution_kind TEXT NOT NULL DEFAULT 'dsh' CHECK (execution_kind IN ('dsh', 'local_cli')),
  workspace_dir TEXT,
  workspace_mode TEXT NOT NULL DEFAULT 'write' CHECK (workspace_mode IN ('read', 'write', 'isolated')),
  last_delivered_seq INTEGER NOT NULL DEFAULT 0,
  last_consumed_seq INTEGER NOT NULL DEFAULT 0,
  active_delivery_key TEXT,
  delivery_attempt INTEGER NOT NULL DEFAULT 0,
  active_turn INTEGER,
  claim_token TEXT,
  claim_owner TEXT,
  claimed_at INTEGER,
  claimed_revision INTEGER,
  claimed_inbox_seq INTEGER,
  progress_signature TEXT,
  stagnation_key TEXT,
  stagnation_count INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  pause_detail_json TEXT,
  result_summary TEXT,
  result_ref TEXT,
  error_json TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_works_bot_foreground
  ON works (bot_id)
  WHERE kind = 'foreground' AND status NOT IN ('done', 'failed', 'stopped');
CREATE INDEX IF NOT EXISTS idx_works_bot_status ON works (bot_id, status);
CREATE INDEX IF NOT EXISTS idx_works_room_status ON works (room_id, status) WHERE room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_works_session ON works (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_works_logical_address ON works (logical_address);
CREATE INDEX IF NOT EXISTS idx_works_root ON works (root_work_id);

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  parent_work_id TEXT NOT NULL REFERENCES works(work_id),
  child_work_id TEXT NOT NULL REFERENCES works(work_id),
  caller_bot_id TEXT NOT NULL,
  callee_bot_id TEXT NOT NULL,
  return_address TEXT NOT NULL,
  visible_scope TEXT NOT NULL DEFAULT 'direct' CHECK (visible_scope IN ('private', 'direct', 'room')),
  room_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'failed', 'stopped')),
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'delivered', 'undeliverable', 'archived')),
  target_revision INTEGER NOT NULL DEFAULT 1,
  result_summary TEXT,
  result_ref TEXT,
  error_json TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER,
  delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_calls_parent_status ON calls (parent_work_id, status);
CREATE INDEX IF NOT EXISTS idx_calls_child_status ON calls (child_work_id, status);
CREATE INDEX IF NOT EXISTS idx_calls_delivery ON calls (delivery_status) WHERE delivery_status = 'pending';

CREATE TRIGGER IF NOT EXISTS trg_calls_immutable_routing
BEFORE UPDATE ON calls
WHEN NEW.return_address <> OLD.return_address
  OR NEW.parent_work_id <> OLD.parent_work_id
  OR NEW.child_work_id <> OLD.child_work_id
BEGIN
  SELECT RAISE(ABORT, 'calls routing fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_calls_single_settlement
BEFORE UPDATE ON calls
WHEN OLD.status <> 'open' AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'call already settled');
END;

CREATE TABLE IF NOT EXISTS inbox (
  work_id TEXT NOT NULL REFERENCES works(work_id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  dedup_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'revise', 'ask', 'answer', 'result', 'note')),
  sender_address TEXT,
  sender_bot_id TEXT,
  call_id TEXT,
  wait_id TEXT,
  target_revision INTEGER,
  body_ref TEXT,
  body_preview TEXT,
  payload_json TEXT,
  read_at INTEGER,
  dsh_idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (work_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_work_dedup
  ON inbox (work_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_unread
  ON inbox (work_id, seq)
  WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS waits (
  wait_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(work_id),
  kind TEXT NOT NULL CHECK (kind IN ('call', 'ask', 'approval', 'user_question', 'secret')),
  target_id TEXT NOT NULL,
  target_work_id TEXT REFERENCES works(work_id),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'cancelled')),
  resolution_json TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_waits_open_unique
  ON waits (work_id, kind, target_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_waits_work_status ON waits (work_id, status);
CREATE INDEX IF NOT EXISTS idx_waits_target ON waits (kind, target_id, status);
CREATE INDEX IF NOT EXISTS idx_waits_target_work ON waits (target_work_id, status) WHERE target_work_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ready (
  work_id TEXT PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('foreground', 'interactive', 'background')),
  priority_rank INTEGER NOT NULL CHECK (priority_rank IN (0, 1, 2)),
  reason TEXT,
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ready_dispatch ON ready (priority_rank ASC, enqueued_at ASC, work_id ASC);
CREATE INDEX IF NOT EXISTS idx_ready_bot_dispatch ON ready (bot_id, priority_rank ASC, enqueued_at ASC, work_id ASC);
`

export function openCoordinationDb({
  path: explicitPath,
  home,
  readonly = false,
  busyTimeoutMs = 5000,
  now = Date.now,
  idGenerator = randomUUID,
  onWarn,
} = {}) {
  const dbPath = explicitPath ?? (home ? join(home, 'coordination.sqlite') : undefined)
  if (!dbPath) {
    throw new CoordinationError('coordination/invalid_argument', 'openCoordinationDb requires path or home')
  }
  const inMemory = dbPath === ':memory:'
  if (!readonly && !inMemory) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const makeCorruptTag = () => {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    return `corrupt-${stamp}-${String(idGenerator()).slice(0, 8)}`
  }

  const preserveCorruptFiles = (cause, preSaved = undefined) => {
    if (inMemory || readonly) return
    const tag = preSaved?.tag ?? makeCorruptTag()
    const preserved = [...(preSaved?.preserved ?? [])]
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const src = `${dbPath}${suffix}`
      if (!existsSync(src)) continue
      const dst = `${dbPath}.${tag}${suffix}`
      if (preserved.includes(dst)) {
        try { unlinkSync(src) } catch {}
        continue
      }
      try {
        renameSync(src, dst)
        preserved.push(dst)
      } catch {
        try { unlinkSync(src) } catch {}
      }
    }
    if (preserved.length > 0) {
      onWarn?.(
        'ds-bot: coordination database %s was corrupt (%s); preserved backup (%s) and initialized a fresh ledger',
        dbPath,
        cause?.message ?? cause,
        preserved.join(', '),
      )
    }
  }

  const openAndInit = (allowCorruptReset) => {
    let conn
    try {
      conn = readonly
        ? new DatabaseSync(dbPath, { readOnly: true })
        : new DatabaseSync(dbPath)
    } catch (error) {
      if (allowCorruptReset && !readonly && !inMemory && isCorruptSqliteError(error)) {
        preserveCorruptFiles(error)
        return openAndInit(false)
      }
      throw new CoordinationError('coordination/open_failed', `Failed to open coordination database at ${dbPath}: ${error?.message ?? error}`, { cause: error })
    }

    try {
      conn.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`)
      conn.exec('PRAGMA foreign_keys = ON')
      if (readonly) {
        conn.exec('PRAGMA query_only = ON')
        const version = conn.prepare('PRAGMA user_version').get()?.user_version ?? 0
        if (version > SCHEMA_VERSION) {
          throw new CoordinationError(
            'coordination/schema_newer',
            `Coordination database version ${version} is newer than supported version ${SCHEMA_VERSION}`,
            { version, supported: SCHEMA_VERSION },
          )
        }
        if (version < SCHEMA_VERSION) {
          throw new CoordinationError(
            'coordination/schema_uninitialized',
            `Coordination database version ${version} is not initialized (expected ${SCHEMA_VERSION})`,
            { version, expected: SCHEMA_VERSION },
          )
        }
      } else {
        if (!inMemory) {
          // On Windows, DELETE rollback journal avoids lingering NTFS WAL/SHM locks
          // while preserving full atomic crash-safe transactions.
          conn.exec(IS_WINDOWS ? 'PRAGMA journal_mode = DELETE' : 'PRAGMA journal_mode = WAL')
          conn.exec('PRAGMA synchronous = FULL')
        }
        const version = conn.prepare('PRAGMA user_version').get()?.user_version ?? 0
        if (version > SCHEMA_VERSION) {
          throw new CoordinationError(
            'coordination/schema_newer',
            `Coordination database version ${version} is newer than supported version ${SCHEMA_VERSION}`,
            { version, supported: SCHEMA_VERSION },
          )
        }
        if (version < SCHEMA_VERSION) {
          conn.exec('BEGIN IMMEDIATE')
          try {
            if (version === 2) {
              // Clean single-track upgrade from prior sidecar coordination tables (`user_version = 2`).
              conn.exec(LEGACY_V2_TABLES_SQL)
            }
            conn.exec(SCHEMA_SQL)
            conn.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
            conn.exec('COMMIT')
          } catch (error) {
            try { conn.exec('ROLLBACK') } catch {}
            throw error
          }
        }
      }
      return conn
    } catch (error) {
      const willReset = allowCorruptReset && !readonly && !inMemory && isCorruptSqliteError(error)
      let preSaved
      if (willReset) {
        // Snapshot any `-wal` / `-journal` sidecar BEFORE `conn.close()`, since SQLite may
        // unlink sidecar files during close of a malformed database handle.
        const tag = makeCorruptTag()
        const preserved = []
        for (const suffix of ['-wal', '-journal']) {
          const src = `${dbPath}${suffix}`
          if (!existsSync(src)) continue
          const dst = `${dbPath}.${tag}${suffix}`
          try {
            copyFileSync(src, dst)
            preserved.push(dst)
          } catch {}
        }
        preSaved = { tag, preserved }
      }
      try { conn.close() } catch {}
      if (willReset) {
        preserveCorruptFiles(error, preSaved)
        return openAndInit(false)
      }
      throw error
    }
  }

  let db = openAndInit(true)
  let closed = false
  let txDepth = 0

  const ensureOpen = () => {
    if (closed) throw new CoordinationError('coordination/closed', 'Coordination database is closed')
  }
  const ensureWritable = () => {
    ensureOpen()
    if (readonly) {
      throw new CoordinationError('coordination/readonly', 'Coordination database is open in readonly mode')
    }
  }

  const stmt = {
    getWork: db.prepare('SELECT * FROM works WHERE work_id = ?'),
    getWorkByRef: db.prepare('SELECT * FROM works WHERE work_ref = ?'),
    getWorkByApiRun: db.prepare('SELECT * FROM works WHERE api_run_id = ?'),
    getWorkByApiIdem: db.prepare('SELECT * FROM works WHERE api_idempotency_key = ?'),
    getForegroundWork: db.prepare(
      "SELECT * FROM works WHERE bot_id = ? AND kind = 'foreground' AND status NOT IN ('done', 'failed', 'stopped') LIMIT 1",
    ),
    getWorkBySession: db.prepare(
      "SELECT * FROM works WHERE session_id = ? ORDER BY CASE WHEN status NOT IN ('done', 'failed', 'stopped') THEN 0 ELSE 1 END, updated_at DESC LIMIT 1",
    ),
    getWorkByAddress: db.prepare(
      "SELECT * FROM works WHERE logical_address = ? ORDER BY CASE WHEN status NOT IN ('done', 'failed', 'stopped') THEN 0 ELSE 1 END, updated_at DESC LIMIT 1",
    ),
    listInterruptedWorks: db.prepare(
      "SELECT * FROM works WHERE status = 'running' OR active_delivery_key IS NOT NULL ORDER BY updated_at ASC",
    ),
    insertWork: db.prepare(`
      INSERT INTO works (
        work_id, work_ref, bot_id, kind, logical_address, status, priority, revision,
        root_work_id, parent_work_id, room_id, title, origin_kind, im_origin_json,
        api_run_id, api_idempotency_key, api_meta_json, visibility, privacy_scoped,
        session_id, execution_kind, workspace_dir, workspace_mode,
        meta_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    rebindSession: db.prepare(`
      UPDATE works
      SET session_id = ?,
          execution_kind = COALESCE(?, execution_kind),
          workspace_dir = COALESCE(?, workspace_dir),
          updated_at = ?
      WHERE work_id = ?
    `),
    getInboxByDedup: db.prepare('SELECT * FROM inbox WHERE work_id = ? AND dedup_key = ? LIMIT 1'),
    nextInboxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM inbox WHERE work_id = ?'),
    maxInboxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM inbox WHERE work_id = ?'),
    countInboxByIdempotencyKey: db.prepare(
      'SELECT COUNT(*) AS n FROM inbox WHERE work_id = ? AND dsh_idempotency_key = ?',
    ),
    ackInboxByIdempotencyKey: db.prepare(
      'UPDATE inbox SET read_at = COALESCE(read_at, ?) WHERE work_id = ? AND dsh_idempotency_key = ?',
    ),
    contiguousConsumedSeq: db.prepare(`
      SELECT COALESCE(
        (SELECT MIN(seq) - 1 FROM inbox WHERE work_id = ? AND read_at IS NULL),
        (SELECT COALESCE(MAX(seq), 0) FROM inbox WHERE work_id = ?)
      ) AS contiguous_seq
    `),
    maxWakingInboxSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM inbox WHERE work_id = ? AND kind <> 'note'"),
    hasUnreadWakingAfter: db.prepare(
      "SELECT seq FROM inbox WHERE work_id = ? AND seq > ? AND read_at IS NULL AND kind <> 'note' ORDER BY seq ASC LIMIT 1",
    ),
    hasUnreadInterruptingAfter: db.prepare(
      "SELECT seq FROM inbox WHERE work_id = ? AND seq > ? AND read_at IS NULL AND kind IN ('request', 'revise', 'ask') ORDER BY seq ASC LIMIT 1",
    ),
    hasUnreadForegroundInterruptingAfter: db.prepare(
      "SELECT seq FROM inbox WHERE work_id = ? AND seq > ? AND read_at IS NULL AND (kind IN ('request', 'revise', 'ask') OR (kind = 'result' AND sender_address LIKE 'room-report:%')) ORDER BY seq ASC LIMIT 1",
    ),
    insertInbox: db.prepare(`
      INSERT INTO inbox (
        work_id, seq, dedup_key, kind, sender_address, sender_bot_id,
        call_id, wait_id, target_revision, body_ref, body_preview,
        payload_json, read_at, dsh_idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getInboxRow: db.prepare('SELECT * FROM inbox WHERE work_id = ? AND seq = ?'),
    unreadInbox: db.prepare('SELECT * FROM inbox WHERE work_id = ? AND read_at IS NULL ORDER BY seq ASC'),
    ackInbox: db.prepare('UPDATE inbox SET read_at = COALESCE(read_at, ?) WHERE work_id = ? AND seq <= ?'),
    ackInboxExact: db.prepare('UPDATE inbox SET read_at = COALESCE(read_at, ?) WHERE work_id = ? AND seq = ?'),
    bumpRevision: db.prepare('UPDATE works SET revision = revision + 1, updated_at = ? WHERE work_id = ?'),
    upsertReady: db.prepare(`
      INSERT INTO ready (work_id, bot_id, priority, priority_rank, reason, enqueued_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_id) DO UPDATE SET
        priority = CASE WHEN excluded.priority_rank < ready.priority_rank THEN excluded.priority ELSE ready.priority END,
        priority_rank = MIN(ready.priority_rank, excluded.priority_rank),
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `),
    deleteReady: db.prepare('DELETE FROM ready WHERE work_id = ?'),
    getReady: db.prepare('SELECT * FROM ready WHERE work_id = ?'),
    listReadyAll: db.prepare('SELECT * FROM ready ORDER BY priority_rank ASC, enqueued_at ASC, work_id ASC LIMIT ?'),
    listReadyBot: db.prepare('SELECT * FROM ready WHERE bot_id = ? ORDER BY priority_rank ASC, enqueued_at ASC, work_id ASC LIMIT ?'),
    listReadyAllUnbounded: db.prepare('SELECT * FROM ready ORDER BY priority_rank ASC, enqueued_at ASC, work_id ASC'),
    listReadyBotUnbounded: db.prepare('SELECT * FROM ready WHERE bot_id = ? ORDER BY priority_rank ASC, enqueued_at ASC, work_id ASC'),
    hasWorkspaceWriteConflict: db.prepare(`
      SELECT work_id FROM works
      WHERE status = 'running'
        AND kind <> 'foreground'
        AND workspace_mode = 'write'
        AND workspace_dir = ?
        AND work_id <> ?
      LIMIT 1
    `),
    countOpenRequiredWaits: db.prepare("SELECT COUNT(*) AS n FROM waits WHERE work_id = ? AND status = 'open' AND required = 1"),
    openWorkWaitTargets: db.prepare(
      "SELECT target_work_id, kind FROM waits WHERE work_id = ? AND status = 'open' AND target_work_id IS NOT NULL",
    ),
    openIncomingAsksForTarget: db.prepare(
      "SELECT * FROM waits WHERE kind = 'ask' AND target_work_id = ? AND status = 'open' ORDER BY created_at ASC",
    ),
    sumChainRevisions: db.prepare('SELECT COALESCE(SUM(revision), 1) AS rev_sum FROM works WHERE root_work_id = ?'),
    getWait: db.prepare('SELECT * FROM waits WHERE wait_id = ?'),
    getOpenWaitByTarget: db.prepare("SELECT * FROM waits WHERE work_id = ? AND kind = ? AND target_id = ? AND status = 'open' LIMIT 1"),
    insertWait: db.prepare(`
      INSERT INTO waits (
        wait_id, work_id, kind, target_id, target_work_id, required, status, meta_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `),
    closeWait: db.prepare(`
      UPDATE waits
      SET status = ?, resolution_json = ?, updated_at = ?, resolved_at = ?
      WHERE wait_id = ? AND status = 'open'
    `),
    cancelWorkOpenWaits: db.prepare(`
      UPDATE waits
      SET status = 'cancelled', updated_at = ?, resolved_at = ?
      WHERE work_id = ? AND status = 'open'
    `),
    getCall: db.prepare('SELECT * FROM calls WHERE call_id = ?'),
    insertCall: db.prepare(`
      INSERT INTO calls (
        call_id, parent_work_id, child_work_id, caller_bot_id, callee_bot_id,
        return_address, visible_scope, room_id, status, delivery_status,
        target_revision, meta_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 'pending', ?, ?, ?, ?)
    `),
    openCallsForChild: db.prepare("SELECT * FROM calls WHERE child_work_id = ? AND status = 'open' ORDER BY created_at ASC"),
    openCallsForParent: db.prepare("SELECT * FROM calls WHERE parent_work_id = ? AND status = 'open' ORDER BY created_at ASC"),
    settleCall: db.prepare(`
      UPDATE calls
      SET status = ?,
          delivery_status = ?,
          target_revision = ?,
          result_summary = ?,
          result_ref = ?,
          error_json = ?,
          updated_at = ?,
          settled_at = ?,
          delivered_at = ?
      WHERE call_id = ? AND status = 'open'
    `),
    updateCallDelivery: db.prepare(`
      UPDATE calls
      SET delivery_status = ?,
          updated_at = ?,
          delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END
      WHERE call_id = ?
    `),
    listChainActiveWorks: db.prepare(
      "SELECT * FROM works WHERE root_work_id = ? AND status NOT IN ('done', 'failed', 'stopped')",
    ),
    listChainPausedWorks: db.prepare(
      "SELECT * FROM works WHERE root_work_id = ? AND status IN ('paused', 'needs_verification')",
    ),
  }

  function transaction(fn) {
    ensureWritable()
    if (txDepth === 0) {
      db.exec('BEGIN IMMEDIATE')
      txDepth = 1
      try {
        const result = fn()
        db.exec('COMMIT')
        txDepth = 0
        return result
      } catch (error) {
        try { db.exec('ROLLBACK') } finally { txDepth = 0 }
        throw error
      }
    }
    const sp = `sp_${txDepth}`
    db.exec(`SAVEPOINT ${sp}`)
    txDepth += 1
    try {
      const result = fn()
      db.exec(`RELEASE SAVEPOINT ${sp}`)
      txDepth -= 1
      return result
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${sp}`)
        db.exec(`RELEASE SAVEPOINT ${sp}`)
      } finally {
        txDepth -= 1
      }
      throw error
    }
  }

  function enqueueReadyInternal(workRow, priorityOverride, reason, ts) {
    const chosenPriority = priorityOverride ?? (workRow.kind === 'foreground' ? 'foreground' : workRow.priority)
    const rank = rankOf(chosenPriority)
    stmt.upsertReady.run(workRow.work_id, workRow.bot_id, chosenPriority, rank, toSql(reason), ts, ts)
  }

  function detectWaitCycle(workId, targetWorkId, { kinds = ['call'] } = {}) {
    ensureOpen()
    nonEmptyString(workId, 'workId')
    nonEmptyString(targetWorkId, 'targetWorkId')
    const kindSet = new Set(kinds)
    if (workId === targetWorkId) {
      return { hasCycle: true, path: [workId, targetWorkId] }
    }
    const queue = [[targetWorkId, [workId, targetWorkId]]]
    const visited = new Set([targetWorkId])
    while (queue.length > 0) {
      const [current, path] = queue.shift()
      const edges = stmt.openWorkWaitTargets.all(current)
      for (const edge of edges) {
        if (!kindSet.has(edge.kind)) continue
        const next = edge.target_work_id
        if (next === workId) {
          return { hasCycle: true, path: [...path, workId] }
        }
        if (!visited.has(next)) {
          visited.add(next)
          queue.push([next, [...path, next]])
        }
      }
    }
    return { hasCycle: false, path: [] }
  }

  function ensureForegroundWork({
    botId,
    workId,
    logicalAddress,
    sessionId,
    workspaceDir,
    executionKind = 'dsh',
    privacyScoped = false,
    meta,
  }) {
    nonEmptyString(botId, 'botId')
    return transaction(() => {
      const existing = stmt.getForegroundWork.get(botId)
      if (existing) return { work: mapWork(existing), created: false }
      const ts = now()
      const id = workId ?? `fg:${botId}`
      const address = logicalAddress ?? `foreground:${botId}`
      const terminalExisting = stmt.getWork.get(id)
      if (terminalExisting) {
        db.prepare(`
          UPDATE works
          SET status = 'idle',
              session_id = COALESCE(?, session_id),
              finished_at = NULL,
              updated_at = ?
          WHERE work_id = ?
        `).run(toSql(sessionId), ts, id)
        return { work: mapWork(stmt.getWork.get(id)), created: false }
      }
      stmt.insertWork.run(
        id,
        null,
        botId,
        'foreground',
        address,
        'idle',
        'foreground',
        1,
        id,
        null,
        null,
        null,
        'foreground',
        null,
        null,
        null,
        null,
        privacyScoped ? 'private' : 'direct',
        privacyScoped ? 1 : 0,
        toSql(sessionId),
        oneOf(executionKind, EXECUTION_KINDS, 'executionKind'),
        canonicalizeWorkspaceDir(workspaceDir),
        'write',
        toJson(meta),
        ts,
        ts,
      )
      return { work: mapWork(stmt.getWork.get(id)), created: true }
    })
  }

  function createWork({
    workId,
    workRef,
    botId,
    kind = 'task',
    logicalAddress,
    status = 'idle',
    priority,
    rootWorkId,
    parentWorkId,
    roomId,
    title,
    originKind,
    imOrigin,
    apiRunId,
    apiIdempotencyKey,
    apiMeta,
    visibility,
    privacyScoped = false,
    sessionId,
    executionKind = 'dsh',
    workspaceDir,
    workspaceMode = 'write',
    meta,
  }) {
    nonEmptyString(botId, 'botId')
    oneOf(kind, WORK_KINDS, 'kind')
    oneOf(status, WORK_STATUSES, 'status')
    oneOf(executionKind, EXECUTION_KINDS, 'executionKind')
    oneOf(workspaceMode, WORKSPACE_MODES, 'workspaceMode')
    const resolvedPriority = priority ?? (kind === 'foreground' ? 'foreground' : 'background')
    oneOf(resolvedPriority, PRIORITIES, 'priority')
    const resolvedVisibility = visibility ?? (privacyScoped ? 'private' : (roomId ? 'room' : 'direct'))
    oneOf(resolvedVisibility, VISIBILITIES, 'visibility')

    if (privacyScoped && resolvedVisibility === 'room') {
      throw new CoordinationError('coordination/privacy_escalation', 'Privacy-scoped work cannot be created with room visibility')
    }

    return transaction(() => {
      if (apiIdempotencyKey) {
        const existingByIdem = stmt.getWorkByApiIdem.get(apiIdempotencyKey)
        if (existingByIdem) return { work: mapWork(existingByIdem), created: false, deduplicated: true }
      }
      if (apiRunId) {
        const existingByRun = stmt.getWorkByApiRun.get(apiRunId)
        if (existingByRun) return { work: mapWork(existingByRun), created: false, deduplicated: true }
      }
      if (kind === 'foreground') {
        const existingFg = stmt.getForegroundWork.get(botId)
        if (existingFg) {
          throw new CoordinationError('coordination/foreground_exists', `Bot ${botId} already has an active foreground work`, { workId: existingFg.work_id })
        }
      }

      const id = workId ?? `w_${idGenerator()}`
      const existingById = stmt.getWork.get(id)
      if (existingById) return { work: mapWork(existingById), created: false, deduplicated: true }

      let effectiveRoot = rootWorkId ?? id
      if (parentWorkId && !rootWorkId) {
        const parent = stmt.getWork.get(parentWorkId)
        if (!parent) {
          throw new CoordinationError('coordination/not_found', `Parent work ${parentWorkId} not found`)
        }
        // Foreground chats are permanent interactive anchors, not shared causal chains:
        // each work spawned from foreground starts its own isolated causal chain.
        effectiveRoot = parent.kind === 'foreground' ? id : (parent.root_work_id ?? parent.work_id)
      }

      const address = logicalAddress
        ?? (kind === 'foreground'
          ? `foreground:${botId}`
          : kind === 'room_work' && roomId
            ? `room:${roomId}:${botId}`
            : `task:${id}`)
      const ts = now()
      stmt.insertWork.run(
        id,
        toSql(workRef),
        botId,
        kind,
        address,
        status,
        resolvedPriority,
        1,
        effectiveRoot,
        toSql(parentWorkId),
        toSql(roomId),
        toSql(title),
        toSql(originKind),
        toJson(imOrigin),
        toSql(apiRunId),
        toSql(apiIdempotencyKey),
        toJson(apiMeta),
        resolvedVisibility,
        privacyScoped ? 1 : 0,
        toSql(sessionId),
        executionKind,
        canonicalizeWorkspaceDir(workspaceDir),
        workspaceMode,
        toJson(meta),
        ts,
        ts,
      )
      const createdRow = stmt.getWork.get(id)
      if (status === 'queued') {
        enqueueReadyInternal(createdRow, resolvedPriority, 'created', ts)
      }
      return { work: mapWork(createdRow), created: true, deduplicated: false }
    })
  }

  function rebindSession(workId, sessionId, { executionKind, workspaceDir } = {}) {
    nonEmptyString(workId, 'workId')
    if (executionKind !== undefined) oneOf(executionKind, EXECUTION_KINDS, 'executionKind')
    return transaction(() => {
      const existing = stmt.getWork.get(workId)
      if (!existing) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      stmt.rebindSession.run(
        toSql(sessionId),
        toSql(executionKind),
        toSql(workspaceDir !== undefined ? canonicalizeWorkspaceDir(workspaceDir) : undefined),
        now(),
        workId,
      )
      return mapWork(stmt.getWork.get(workId))
    })
  }

  function updateApiMeta(workId, patch) {
    nonEmptyString(workId, 'workId')
    return transaction(() => {
      const existing = stmt.getWork.get(workId)
      if (!existing) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      const current = fromJson(existing.api_meta_json) ?? {}
      const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch }
      db.prepare('UPDATE works SET api_meta_json = ?, updated_at = ? WHERE work_id = ?').run(toJson(next), now(), workId)
      return mapWork(stmt.getWork.get(workId))
    })
  }

  function receiveMessage({
    workId,
    kind,
    dedupKey,
    senderAddress,
    senderBotId,
    callId,
    waitId,
    targetRevision,
    bodyRef,
    bodyPreview,
    payload,
    priority,
    wake,
    dshIdempotencyKey,
  }) {
    nonEmptyString(workId, 'workId')
    oneOf(kind, INBOX_KINDS, 'kind')
    if (priority !== undefined) oneOf(priority, PRIORITIES, 'priority')

    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)

      if (dedupKey !== undefined && dedupKey !== null) {
        const existing = stmt.getInboxByDedup.get(workId, dedupKey)
        if (existing) {
          return {
            accepted: true,
            deduplicated: true,
            archived: false,
            message: mapInbox(existing),
            work: mapWork(work),
            readyEnqueued: false,
          }
        }
      }

      const ts = now()
      const terminal = TERMINAL_WORK_STATUSES.has(work.status)
      if (terminal) {
        if (kind === 'result' || kind === 'note') {
          const seq = stmt.nextInboxSeq.get(workId).next_seq
          stmt.insertInbox.run(
            workId,
            seq,
            toSql(dedupKey),
            kind,
            toSql(senderAddress),
            toSql(senderBotId),
            toSql(callId),
            toSql(waitId),
            toSql(targetRevision),
            toSql(bodyRef),
            toSql(bodyPreview),
            toJson(payload),
            ts,
            toSql(dshIdempotencyKey),
            ts,
          )
          return {
            accepted: true,
            deduplicated: false,
            archived: true,
            message: mapInbox(stmt.getInboxRow.get(workId, seq)),
            work: mapWork(work),
            readyEnqueued: false,
          }
        }
        return {
          accepted: false,
          deduplicated: false,
          archived: false,
          reason: 'work_terminal',
          status: work.status,
          work: mapWork(work),
          readyEnqueued: false,
        }
      }

      let effectiveRevision = work.revision
      if (kind === 'revise') {
        stmt.bumpRevision.run(ts, workId)
        effectiveRevision += 1
      }

      const seq = stmt.nextInboxSeq.get(workId).next_seq
      stmt.insertInbox.run(
        workId,
        seq,
        toSql(dedupKey),
        kind,
        toSql(senderAddress),
        toSql(senderBotId),
        toSql(callId),
        toSql(waitId),
        toSql(targetRevision ?? (kind === 'revise' ? effectiveRevision : null)),
        toSql(bodyRef),
        toSql(bodyPreview),
        toJson(payload),
        null,
        toSql(dshIdempotencyKey),
        ts,
      )

      if (kind === 'answer' && waitId) {
        const waitRow = stmt.getWait.get(waitId)
        if (waitRow && waitRow.work_id === workId && waitRow.status === 'open') {
          stmt.closeWait.run('resolved', toJson({ seq, bodyRef, bodyPreview }), ts, ts, waitId)
        }
      }

      // Strict invariant: `note` NEVER sets ready and NEVER wakes a work.
      let readyEnqueued = false
      const refreshed = stmt.getWork.get(workId)
      const isNote = kind === 'note'
      const openReqWaits = stmt.countOpenRequiredWaits.get(workId).n

      let shouldWake = false
      if (!isNote && wake !== false) {
        if (kind === 'request' || kind === 'revise' || kind === 'ask') {
          shouldWake = true
        } else if (kind === 'answer') {
          shouldWake = openReqWaits === 0
        } else if (kind === 'result') {
          shouldWake = wake === true && openReqWaits === 0
        }
      }

      if (shouldWake && (refreshed.status === 'idle' || refreshed.status === 'queued' || refreshed.status === 'waiting')) {
        let readyPriority = priority
        if (!readyPriority) {
          if (refreshed.kind === 'foreground') readyPriority = 'foreground'
          else if (kind === 'ask' || kind === 'revise' || kind === 'answer') readyPriority = 'interactive'
          else readyPriority = refreshed.priority
        }
        if (refreshed.status !== 'queued') {
          db.prepare("UPDATE works SET status = 'queued', updated_at = ? WHERE work_id = ?").run(ts, workId)
        }
        enqueueReadyInternal(refreshed, readyPriority, kind, ts)
        readyEnqueued = true
      }

      return {
        accepted: true,
        deduplicated: false,
        archived: false,
        message: mapInbox(stmt.getInboxRow.get(workId, seq)),
        work: mapWork(stmt.getWork.get(workId)),
        readyEnqueued,
      }
    })
  }

  function addWait({
    waitId,
    workId,
    kind,
    targetId,
    targetWorkId,
    required = true,
    meta,
  }) {
    nonEmptyString(workId, 'workId')
    oneOf(kind, WAIT_KINDS, 'kind')
    nonEmptyString(targetId, 'targetId')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      if (TERMINAL_WORK_STATUSES.has(work.status)) {
        throw new CoordinationError('coordination/work_terminal', `Cannot add wait to terminal work ${workId}`)
      }
      const existing = stmt.getOpenWaitByTarget.get(workId, kind, targetId)
      if (existing) return { wait: mapWait(existing), created: false }

      if (targetWorkId) {
        const target = stmt.getWork.get(targetWorkId)
        if (!target) throw new CoordinationError('coordination/not_found', `Target work ${targetWorkId} not found`)
        if (kind === 'call') {
          const check = detectWaitCycle(workId, targetWorkId, { kinds: ['call'] })
          if (check.hasCycle) {
            throw new CoordinationError(
              'coordination/wait_cycle',
              `Adding call wait ${workId} -> ${targetWorkId} would form a cycle`,
              { cycle: check.path, suggestedAction: 'ask' },
            )
          }
        } else if (kind === 'ask') {
          const check = detectWaitCycle(workId, targetWorkId, { kinds: ['ask'] })
          if (check.hasCycle) {
            throw new CoordinationError(
              'coordination/ask_cycle',
              `Adding ask wait ${workId} -> ${targetWorkId} would form a mutual-questioning cycle`,
              { cycle: check.path, suggestedAction: 'user_question' },
            )
          }
        }
      }

      const id = waitId ?? `wt_${idGenerator()}`
      const ts = now()
      stmt.insertWait.run(id, workId, kind, targetId, toSql(targetWorkId), required ? 1 : 0, toJson(meta), ts, ts)
      return { wait: mapWait(stmt.getWait.get(id)), created: true }
    })
  }

  function createCall({
    callId,
    parentWorkId,
    childWorkId,
    callerBotId,
    calleeBotId,
    returnAddress,
    visibleScope = 'direct',
    roomId,
    explicitPublish = false,
    required = true,
    waitId,
    initialMessage,
    meta,
  }) {
    nonEmptyString(parentWorkId, 'parentWorkId')
    nonEmptyString(childWorkId, 'childWorkId')
    nonEmptyString(callerBotId, 'callerBotId')
    nonEmptyString(calleeBotId, 'calleeBotId')
    oneOf(visibleScope, VISIBILITIES, 'visibleScope')

    return transaction(() => {
      const parent = stmt.getWork.get(parentWorkId)
      if (!parent) throw new CoordinationError('coordination/not_found', `Parent work ${parentWorkId} not found`)
      if (TERMINAL_WORK_STATUSES.has(parent.status)) {
        throw new CoordinationError('coordination/work_terminal', `Parent work ${parentWorkId} is terminal`)
      }
      const child = stmt.getWork.get(childWorkId)
      if (!child) throw new CoordinationError('coordination/not_found', `Child work ${childWorkId} not found`)
      if (TERMINAL_WORK_STATUSES.has(child.status)) {
        throw new CoordinationError('coordination/work_terminal', `Child work ${childWorkId} is terminal`)
      }

      if ((child.privacy_scoped === 1 || child.visibility === 'private') && visibleScope === 'room' && !explicitPublish) {
        throw new CoordinationError(
          'coordination/privacy_escalation',
          'Privacy-scoped work cannot implicitly escalate call visibility to room',
        )
      }

      const id = callId ?? `c_${idGenerator()}`
      const existingCall = stmt.getCall.get(id)
      if (existingCall) {
        const existingWait = stmt.getOpenWaitByTarget.get(parentWorkId, 'call', id)
        return {
          call: mapCall(existingCall),
          wait: mapWait(existingWait),
          childMessage: undefined,
          childWork: mapWork(child),
          created: false,
        }
      }

      const cycleCheck = detectWaitCycle(parentWorkId, childWorkId, { kinds: ['call'] })
      if (cycleCheck.hasCycle) {
        throw new CoordinationError(
          'coordination/wait_cycle',
          `Delegation ${parentWorkId} -> ${childWorkId} would create a wait cycle`,
          { cycle: cycleCheck.path, suggestedAction: 'ask' },
        )
      }

      const lockedReturnAddress = returnAddress ?? parent.logical_address
      const ts = now()
      stmt.insertCall.run(
        id,
        parentWorkId,
        childWorkId,
        callerBotId,
        calleeBotId,
        lockedReturnAddress,
        visibleScope,
        toSql(roomId ?? parent.room_id ?? child.room_id),
        child.revision,
        toJson(meta),
        ts,
        ts,
      )

      if (child.parent_work_id === null) {
        const nextRoot = parent.kind === 'foreground' ? childWorkId : parent.root_work_id
        db.prepare('UPDATE works SET parent_work_id = ?, root_work_id = ?, updated_at = ? WHERE work_id = ?')
          .run(parentWorkId, nextRoot, ts, childWorkId)
      }

      const { wait } = addWait({
        waitId: waitId ?? `wt_call_${id}`,
        workId: parentWorkId,
        kind: 'call',
        targetId: id,
        targetWorkId: childWorkId,
        required,
        meta: { callId: id, calleeBotId },
      })

      let childMessage
      if (initialMessage) {
        const received = receiveMessage({
          workId: childWorkId,
          kind: 'request',
          dedupKey: initialMessage.dedupKey ?? `call:${id}:request`,
          senderAddress: initialMessage.senderAddress ?? lockedReturnAddress,
          senderBotId: initialMessage.senderBotId ?? callerBotId,
          callId: id,
          bodyRef: initialMessage.bodyRef,
          bodyPreview: initialMessage.bodyPreview,
          payload: initialMessage.payload,
          priority: initialMessage.priority,
          dshIdempotencyKey: initialMessage.dshIdempotencyKey,
          ...(initialMessage.wake === false ? { wake: false } : {}),
        })
        childMessage = received.message
      }

      return {
        call: mapCall(stmt.getCall.get(id)),
        wait,
        childMessage,
        childWork: mapWork(stmt.getWork.get(childWorkId)),
        created: true,
      }
    })
  }

  function askBack({
    waitId,
    askerWorkId,
    targetWorkId,
    dedupKey,
    bodyRef,
    bodyPreview,
    payload,
    meta,
  }) {
    nonEmptyString(askerWorkId, 'askerWorkId')
    nonEmptyString(targetWorkId, 'targetWorkId')
    return transaction(() => {
      const asker = stmt.getWork.get(askerWorkId)
      if (!asker) throw new CoordinationError('coordination/not_found', `Asker work ${askerWorkId} not found`)
      const target = stmt.getWork.get(targetWorkId)
      if (!target) throw new CoordinationError('coordination/not_found', `Target work ${targetWorkId} not found`)
      if (TERMINAL_WORK_STATUSES.has(target.status)) {
        throw new CoordinationError('coordination/work_terminal', `Target work ${targetWorkId} is terminal`)
      }

      const id = waitId ?? `ask_${idGenerator()}`
      const { wait } = addWait({
        waitId: id,
        workId: askerWorkId,
        kind: 'ask',
        targetId: id,
        targetWorkId,
        required: true,
        meta,
      })

      const delivered = receiveMessage({
        workId: targetWorkId,
        kind: 'ask',
        dedupKey: dedupKey ?? `ask:${id}`,
        senderAddress: asker.logical_address,
        senderBotId: asker.bot_id,
        waitId: id,
        bodyRef,
        bodyPreview,
        payload,
      })

      return {
        wait,
        message: delivered.message,
        targetWork: delivered.work,
        readyEnqueued: delivered.readyEnqueued,
      }
    })
  }

  function resolveWait({
    waitId,
    workId,
    kind,
    targetId,
    status = 'resolved',
    resolution,
    inboxMessage,
    wake = true,
  }) {
    if (status !== 'resolved' && status !== 'cancelled') {
      throw new CoordinationError('coordination/invalid_argument', 'resolveWait status must be resolved or cancelled')
    }
    return transaction(() => {
      let waitRow
      if (waitId) {
        waitRow = stmt.getWait.get(waitId)
      } else if (workId && kind && targetId) {
        waitRow = stmt.getOpenWaitByTarget.get(workId, kind, targetId)
      } else {
        throw new CoordinationError('coordination/invalid_argument', 'resolveWait requires waitId or (workId, kind, targetId)')
      }
      if (!waitRow) {
        return { resolved: false, alreadyClosed: false, notFound: true, wait: undefined, workWoken: false }
      }
      if (waitRow.status !== 'open') {
        return {
          resolved: false,
          alreadyClosed: true,
          notFound: false,
          wait: mapWait(waitRow),
          work: mapWork(stmt.getWork.get(waitRow.work_id)),
          workWoken: false,
        }
      }

      const beforeRequired = stmt.countOpenRequiredWaits.get(waitRow.work_id).n
      const ts = now()
      stmt.closeWait.run(status, toJson(resolution), ts, ts, waitRow.wait_id)
      const afterRequired = stmt.countOpenRequiredWaits.get(waitRow.work_id).n

      let deliveredMsg
      if (inboxMessage) {
        const res = receiveMessage({
          workId: waitRow.work_id,
          kind: inboxMessage.kind ?? 'answer',
          dedupKey: inboxMessage.dedupKey ?? `wait:${waitRow.wait_id}:${status}`,
          senderAddress: inboxMessage.senderAddress,
          senderBotId: inboxMessage.senderBotId,
          callId: inboxMessage.callId,
          waitId: waitRow.wait_id,
          bodyRef: inboxMessage.bodyRef,
          bodyPreview: inboxMessage.bodyPreview,
          payload: inboxMessage.payload,
          wake: false,
        })
        deliveredMsg = res.message
      }

      const workRow = stmt.getWork.get(waitRow.work_id)
      let workWoken = false
      if (
        beforeRequired > 0
        && afterRequired === 0
        && (workRow.status === 'waiting' || workRow.status === 'idle')
      ) {
        if (wake === false) {
          if (workRow.status === 'waiting') {
            db.prepare("UPDATE works SET status = 'idle', updated_at = ? WHERE work_id = ?").run(ts, workRow.work_id)
          }
        } else {
          db.prepare("UPDATE works SET status = 'queued', updated_at = ? WHERE work_id = ?").run(ts, workRow.work_id)
          const priority = workRow.kind === 'foreground' ? 'foreground' : workRow.priority
          enqueueReadyInternal(workRow, priority, 'waits_satisfied', ts)
          workWoken = true
        }
      }

      return {
        resolved: true,
        alreadyClosed: false,
        notFound: false,
        wait: mapWait(stmt.getWait.get(waitRow.wait_id)),
        message: deliveredMsg,
        remainingRequiredWaits: afterRequired,
        work: mapWork(stmt.getWork.get(waitRow.work_id)),
        workWoken,
      }
    })
  }

  function peekReady({ botId, limit = 50 } = {}) {
    ensureOpen()
    const rows = botId
      ? stmt.listReadyBot.all(botId, limit)
      : stmt.listReadyAll.all(limit)
    return rows.map(mapReady)
  }

  function claimReady({
    botId,
    workId,
    owner,
    respectWorkspaceLock = false,
    excludeWorkIds,
    excludeSessionIds,
  } = {}) {
    const excluded = excludeWorkIds instanceof Set
      ? excludeWorkIds
      : (Array.isArray(excludeWorkIds) && excludeWorkIds.length > 0 ? new Set(excludeWorkIds) : undefined)
    const excludedSessions = excludeSessionIds instanceof Set
      ? excludeSessionIds
      : (Array.isArray(excludeSessionIds) && excludeSessionIds.length > 0 ? new Set(excludeSessionIds) : undefined)
    return transaction(() => {
      const candidates = workId
        ? [stmt.getReady.get(workId)].filter(Boolean)
        : (botId ? stmt.listReadyBotUnbounded.all(botId) : stmt.listReadyAllUnbounded.all())

      for (const candidate of candidates) {
        if (excluded?.has(candidate.work_id)) continue
        const work = stmt.getWork.get(candidate.work_id)
        if (!work || TERMINAL_WORK_STATUSES.has(work.status) || work.status === 'running' || work.status === 'paused' || work.status === 'needs_verification' || work.status === 'stopping') {
          if (!work || TERMINAL_WORK_STATUSES.has(work.status) || work.status === 'paused' || work.status === 'needs_verification' || work.status === 'stopping') {
            stmt.deleteReady.run(candidate.work_id)
          }
          continue
        }
        if (excludedSessions && work.kind !== 'foreground' && work.session_id && excludedSessions.has(work.session_id)) continue
        // Foreground chat is never blocked by background writable tasks on the same folder.
        if (respectWorkspaceLock && work.kind !== 'foreground' && work.workspace_mode === 'write' && work.workspace_dir) {
          const conflict = stmt.hasWorkspaceWriteConflict.get(work.workspace_dir, work.work_id)
          if (conflict) continue
        }

        const ts = now()
        const claimToken = `clm_${idGenerator()}`
        const maxSeq = stmt.maxInboxSeq.get(work.work_id).max_seq
        const unreadRows = stmt.unreadInbox.all(work.work_id)

        stmt.deleteReady.run(work.work_id)
        db.prepare(`
          UPDATE works
          SET status = 'running',
              claim_token = ?,
              claim_owner = ?,
              claimed_at = ?,
              claimed_revision = revision,
              claimed_inbox_seq = ?,
              started_at = COALESCE(started_at, ?),
              updated_at = ?
          WHERE work_id = ?
        `).run(claimToken, toSql(owner), ts, maxSeq, ts, ts, work.work_id)

        const unread = unreadRows.map(mapInbox)
        return {
          work: mapWork(stmt.getWork.get(work.work_id)),
          claimToken,
          claimedRevision: work.revision,
          claimedInboxSeq: maxSeq,
          unreadMessages: unread.filter(msg => msg.kind !== 'note'),
          notes: unread.filter(msg => msg.kind === 'note'),
        }
      }
      return undefined
    })
  }

  // Issues a deterministic DSH D2 idempotencyKey for the active delivery attempt before calling DSH send().
  function beginDeliveryAttempt({
    workId,
    claimToken,
    throughSeq,
    idempotencyKey,
    sessionId,
  }) {
    nonEmptyString(workId, 'workId')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      if (claimToken !== undefined && work.claim_token !== claimToken) {
        throw new CoordinationError('coordination/claim_mismatch', `Claim token mismatch on work ${workId}`)
      }
      const attempt = (work.delivery_attempt ?? 0) + 1
      const bound = Math.max(work.last_delivered_seq ?? 0, Math.trunc(throughSeq ?? work.claimed_inbox_seq ?? 0))
      const deliveryKey = idempotencyKey ?? `coord:${workId}:rev${work.revision}:seq${bound}:a${attempt}`
      const ts = now()
      db.prepare(`
        UPDATE works
        SET delivery_attempt = ?,
            active_delivery_key = ?,
            last_delivered_seq = MAX(last_delivered_seq, ?),
            session_id = COALESCE(?, session_id),
            updated_at = ?
        WHERE work_id = ?
      `).run(attempt, deliveryKey, bound, toSql(sessionId), ts, workId)
      return {
        deliveryKey,
        attempt,
        work: mapWork(stmt.getWork.get(workId)),
      }
    })
  }

  function markDelivered(workId, throughSeq) {
    nonEmptyString(workId, 'workId')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      db.prepare('UPDATE works SET last_delivered_seq = MAX(last_delivered_seq, ?), updated_at = ? WHERE work_id = ?')
        .run(Math.max(0, Math.trunc(throughSeq)), now(), workId)
      return mapWork(stmt.getWork.get(workId))
    })
  }

  function ackInbox(workId, throughSeq, { claimToken, turn } = {}) {
    nonEmptyString(workId, 'workId')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      if (claimToken !== undefined && work.claim_token !== claimToken) {
        throw new CoordinationError('coordination/claim_mismatch', `Claim token mismatch on work ${workId}`)
      }
      const ts = now()
      const bound = Math.max(0, Math.trunc(throughSeq))
      stmt.ackInbox.run(ts, workId, bound)
      db.prepare(`
        UPDATE works
        SET last_consumed_seq = MAX(last_consumed_seq, ?),
            last_delivered_seq = MAX(last_delivered_seq, ?),
            active_turn = COALESCE(?, active_turn),
            updated_at = ?
        WHERE work_id = ?
      `).run(bound, bound, toSql(turn), ts, workId)
      return mapWork(stmt.getWork.get(workId))
    })
  }

  // Marks exactly one inbox row read (e.g. a silent note committed via user/message)
  // without advancing `last_consumed_seq` or touching earlier unread waking rows.
  function ackInboxSeq(workId, seq, { claimToken, turn } = {}) {
    nonEmptyString(workId, 'workId')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      if (claimToken !== undefined && work.claim_token !== claimToken) {
        throw new CoordinationError('coordination/claim_mismatch', `Claim token mismatch on work ${workId}`)
      }
      const ts = now()
      const targetSeq = Math.max(0, Math.trunc(seq))
      stmt.ackInboxExact.run(ts, workId, targetSeq)
      const contiguous = stmt.contiguousConsumedSeq.get(workId, workId).contiguous_seq
      db.prepare(`
        UPDATE works
        SET last_consumed_seq = MAX(last_consumed_seq, ?),
            active_turn = COALESCE(?, active_turn),
            updated_at = ?
        WHERE work_id = ?
      `).run(contiguous, toSql(turn), ts, workId)
      return mapWork(stmt.getWork.get(workId))
    })
  }

  // Records `active_turn` on `turn/start` without prematurely marking inbox messages read.
  function recordActiveTurn(workId, turn, { claimToken } = {}) {
    nonEmptyString(workId, 'workId')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      if (claimToken !== undefined && work.claim_token !== claimToken) {
        throw new CoordinationError('coordination/claim_mismatch', `Claim token mismatch on work ${workId}`)
      }
      const ts = now()
      db.prepare('UPDATE works SET active_turn = ?, updated_at = ? WHERE work_id = ?')
        .run(toSql(turn), ts, workId)
      return mapWork(stmt.getWork.get(workId))
    })
  }

  // Records a durable delivery attempt key + sessionId for direct-dispatched works
  // (such as group `room_work` dispatched via `rt.deliver` rather than `claimReady`),
  // so startup recovery can reconcile them against DSH D2 `DeliveryStatus` instead of
  // losing them or falsely settling them `stopped`.
  function recordDirectDeliveryAttempt({
    workId,
    idempotencyKey,
    sessionId,
    throughSeq,
    setRunning = true,
  }) {
    nonEmptyString(workId, 'workId')
    nonEmptyString(idempotencyKey, 'idempotencyKey')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      if (TERMINAL_WORK_STATUSES.has(work.status)) {
        return mapWork(work)
      }
      if (work.status === 'paused' || work.status === 'needs_verification' || work.status === 'stopping') {
        throw new CoordinationError(
          'coordination/work_paused',
          `Cannot start direct delivery for ${work.status} work ${workId}`,
        )
      }
      const ts = now()
      const nextStatus = setRunning ? 'running' : work.status
      const nextSession = sessionId !== undefined ? toSql(sessionId) : work.session_id
      // Only batch direct deliveries whose prompt genuinely includes all unread inbox items
      // up to `throughSeq` (e.g. group synthesis turns) stamp `dsh_idempotency_key` across
      // `seq <= throughSeq` and advance `last_delivered_seq`. Single-message direct deliveries
      // (such as `deliverToTask` follow-ups) omit `throughSeq` and rely on their single inbox
      // row's own `dsh_idempotency_key`, never sweeping earlier unread `result`/`answer`/`note` rows.
      const batchThroughSeq = Number.isInteger(throughSeq) ? Math.max(0, Math.trunc(throughSeq)) : 0
      if (batchThroughSeq > 0) {
        db.prepare(`
          UPDATE inbox
          SET dsh_idempotency_key = COALESCE(dsh_idempotency_key, ?)
          WHERE work_id = ? AND seq <= ? AND read_at IS NULL
        `).run(idempotencyKey, workId, batchThroughSeq)
      }
      db.prepare(`
        UPDATE works
        SET status = ?,
            session_id = ?,
            active_delivery_key = ?,
            active_turn = NULL,
            last_delivered_seq = MAX(last_delivered_seq, ?),
            updated_at = ?
        WHERE work_id = ?
      `).run(nextStatus, nextSession, idempotencyKey, batchThroughSeq, ts, workId)
      return mapWork(stmt.getWork.get(workId))
    })
  }

  // Parks a direct-dispatched running work (e.g. a group `room_work` that delegated
  // nested child work during its turn) into `waiting` without requiring a scheduler `claimToken`.
  // Only transitions `running -> waiting` so `paused`, `needs_verification`, and terminal states stay untouched.
  function parkWaiting(workId) {
    nonEmptyString(workId, 'workId')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      if (work.status !== 'running' && work.status !== 'queued' && work.status !== 'idle') return mapWork(work)
      const ts = now()
      stmt.deleteReady.run(workId)
      db.prepare(`
        UPDATE works
        SET status = 'waiting',
            claim_token = NULL,
            claim_owner = NULL,
            claimed_at = NULL,
            active_delivery_key = NULL,
            active_turn = NULL,
            updated_at = ?
        WHERE work_id = ?
          AND status IN ('running', 'queued', 'idle')
      `).run(ts, workId)
      return mapWork(stmt.getWork.get(workId))
    })
  }

  // Reconciles an interrupted work against DSH D2 `DeliveryStatus` during startup recovery.
  // Never routes a failed/unstarted background task into the foreground chat.
  function reconcileDeliveryStatus({
    workId,
    deliveryStatus,
    autoSettle = false,
  }) {
    nonEmptyString(workId, 'workId')
    if (!deliveryStatus || typeof deliveryStatus !== 'object') {
      throw new CoordinationError('coordination/invalid_argument', 'deliveryStatus object is required')
    }
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      if (TERMINAL_WORK_STATUSES.has(work.status)) {
        return { action: 'already_terminal', work: mapWork(work) }
      }
      const ts = now()
      if (work.status === 'paused' || work.status === 'needs_verification') {
        db.prepare('UPDATE works SET claim_token = NULL, claim_owner = NULL, claimed_at = NULL, active_delivery_key = NULL, active_turn = NULL, updated_at = ? WHERE work_id = ?')
          .run(ts, workId)
        return { action: 'keep_paused', work: mapWork(stmt.getWork.get(workId)) }
      }
      if (work.status === 'stopping') {
        const stopped = settleWork({
          workId,
          outcome: 'stopped',
          force: true,
          error: { code: 'work/stopped', message: 'Stopped before host restart' },
        })
        return { action: 'stopped', ...stopped }
      }
      const status = deliveryStatus.status
      const consumed = deliveryStatus.consumed === true
      const interruptedTools = Array.isArray(deliveryStatus.interruptedTools) ? deliveryStatus.interruptedTools : []
      const deliveryKey = deliveryStatus.idempotencyKey ?? work.active_delivery_key
      const hasKeyedRows = typeof deliveryKey === 'string' && deliveryKey !== ''
        && stmt.countInboxByIdempotencyKey.get(workId, deliveryKey).n > 0
      const consumeDelivered = () => {
        if (hasKeyedRows) {
          // Exact key-based consumption: ONLY marks inbox rows tagged with THIS deliveryKey,
          // and advances `last_consumed_seq` only to the contiguous consumed watermark so earlier
          // unread `result`/`answer`/`note` rows are never swallowed or skipped.
          stmt.ackInboxByIdempotencyKey.run(ts, workId, deliveryKey)
          const contiguous = stmt.contiguousConsumedSeq.get(workId, workId).contiguous_seq
          return Math.max(work.last_consumed_seq, contiguous)
        }
        const bound = Math.max(work.last_consumed_seq, work.last_delivered_seq)
        if (bound > work.last_consumed_seq) {
          stmt.ackInbox.run(ts, workId, bound)
        }
        return bound
      }

      if (status === 'running' || status === 'queued') {
        const nextConsumed = consumed ? consumeDelivered() : work.last_consumed_seq
        db.prepare(`
          UPDATE works
          SET active_turn = COALESCE(?, active_turn),
              last_consumed_seq = MAX(last_consumed_seq, ?),
              updated_at = ?
          WHERE work_id = ?
        `).run(toSql(deliveryStatus.turn), nextConsumed, ts, workId)
        return { action: 'adopt_live', work: mapWork(stmt.getWork.get(workId)) }
      }

      if (status === 'not_found' || (status === 'aborted' && !consumed)) {
        db.prepare(`
          UPDATE works
          SET status = 'queued',
              claim_token = NULL,
              claim_owner = NULL,
              claimed_at = NULL,
              active_delivery_key = NULL,
              active_turn = NULL,
              updated_at = ?
          WHERE work_id = ?
        `).run(ts, workId)
        const refreshed = stmt.getWork.get(workId)
        enqueueReadyInternal(refreshed, refreshed.kind === 'foreground' ? 'foreground' : refreshed.priority, 'restart_reconcile', ts)
        return { action: 'requeue', work: mapWork(stmt.getWork.get(workId)) }
      }

      if (status === 'aborted' && consumed) {
        const ackBound = consumeDelivered()
        db.prepare('UPDATE works SET last_consumed_seq = MAX(last_consumed_seq, ?) WHERE work_id = ?').run(ackBound, workId)
        if (interruptedTools.length > 0) {
          db.prepare('UPDATE works SET active_delivery_key = NULL, active_turn = NULL WHERE work_id = ?').run(workId)
          const paused = pauseWork(workId, {
            status: 'needs_verification',
            reason: 'interrupted_tools',
            detail: {
              interruptedTools,
              turn: deliveryStatus.turn ?? null,
              deliveryKey: deliveryStatus.idempotencyKey ?? work.active_delivery_key,
              cancelCause: deliveryStatus.cancelCause ?? null,
            },
          })
          return { action: 'needs_verification', work: paused.work }
        }
        db.prepare(`
          UPDATE works
          SET status = 'queued',
              claim_token = NULL,
              claim_owner = NULL,
              claimed_at = NULL,
              active_delivery_key = NULL,
              active_turn = NULL,
              updated_at = ?
          WHERE work_id = ?
        `).run(ts, workId)
        const refreshed = stmt.getWork.get(workId)
        enqueueReadyInternal(refreshed, refreshed.kind === 'foreground' ? 'foreground' : refreshed.priority, 'aborted_retry', ts)
        return { action: 'requeue', work: mapWork(stmt.getWork.get(workId)) }
      }

      if (status === 'completed') {
        const ackBound = consumeDelivered()
        db.prepare(`
          UPDATE works
          SET last_consumed_seq = MAX(last_consumed_seq, ?),
              active_delivery_key = NULL,
              active_turn = NULL,
              updated_at = ?
          WHERE work_id = ?
        `).run(ackBound, ts, workId)
        const openReqWaits = stmt.countOpenRequiredWaits.get(workId).n
        const revisionChanged = work.claimed_revision !== null && work.claimed_revision !== undefined && work.revision !== work.claimed_revision
        const unreadAfter = openReqWaits > 0
          ? (work.kind === 'foreground'
              ? stmt.hasUnreadForegroundInterruptingAfter.get(workId, ackBound)
              : stmt.hasUnreadInterruptingAfter.get(workId, ackBound))
          : stmt.hasUnreadWakingAfter.get(workId, ackBound)

        if (deliveryStatus.yielded === true || work.kind === 'foreground' || openReqWaits > 0) {
          if (revisionChanged || unreadAfter) {
            db.prepare(`
              UPDATE works
              SET status = 'queued',
                  claim_token = NULL,
                  claim_owner = NULL,
                  claimed_at = NULL,
                  updated_at = ?
              WHERE work_id = ?
            `).run(ts, workId)
            const refreshed = stmt.getWork.get(workId)
            enqueueReadyInternal(refreshed, refreshed.kind === 'foreground' ? 'foreground' : 'interactive', 'reconcile_unread', ts)
            return { action: 'requeue', work: mapWork(stmt.getWork.get(workId)) }
          }
          const nextStatus = openReqWaits > 0 ? 'waiting' : 'idle'
          db.prepare(`
            UPDATE works
            SET status = ?,
                claim_token = NULL,
                claim_owner = NULL,
                claimed_at = NULL,
                updated_at = ?
            WHERE work_id = ?
          `).run(nextStatus, ts, workId)
          return { action: 'yielded', work: mapWork(stmt.getWork.get(workId)) }
        }
        if (autoSettle) {
          const settled = settleWork({
            workId,
            outcome: 'done',
            expectedRevision: work.claimed_revision ?? undefined,
            expectedInboxSeq: ackBound,
            force: false,
            releaseOnConflict: true,
            summary: deliveryStatus.assistantText,
          })
          if (settled.conflict) {
            return { action: 'requeue', ...settled }
          }
          return { action: 'settled', ...settled }
        }
        return { action: 'ready_to_settle', work: mapWork(stmt.getWork.get(workId)), assistantText: deliveryStatus.assistantText }
      }

      if (status === 'failed') {
        const failure = deliveryStatus.error ?? { code: 'turn/failed', message: 'Turn failed before host acknowledgement' }
        const ackBound = consumed ? consumeDelivered() : work.last_consumed_seq
        db.prepare(`
          UPDATE works
          SET last_consumed_seq = MAX(last_consumed_seq, ?),
              active_delivery_key = NULL,
              active_turn = NULL,
              updated_at = ?
          WHERE work_id = ?
        `).run(ackBound, ts, workId)
        if (autoSettle && work.kind !== 'foreground') {
          const settled = settleWork({
            workId,
            outcome: 'failed',
            force: true,
            error: failure,
          })
          return { action: 'failed', ...settled }
        }
        // Release claim and return foreground (or non-autoSettled work) to a schedulable state so it never sticks in `running`.
        const openReqWaits = stmt.countOpenRequiredWaits.get(workId).n
        const unreadAfter = openReqWaits > 0
          ? (work.kind === 'foreground'
              ? stmt.hasUnreadForegroundInterruptingAfter.get(workId, ackBound)
              : stmt.hasUnreadInterruptingAfter.get(workId, ackBound))
          : stmt.hasUnreadWakingAfter.get(workId, ackBound)
        const nextStatus = unreadAfter ? 'queued' : (openReqWaits > 0 ? 'waiting' : 'idle')
        db.prepare(`
          UPDATE works
          SET status = ?,
              claim_token = NULL,
              claim_owner = NULL,
              claimed_at = NULL,
              error_json = ?,
              updated_at = ?
          WHERE work_id = ?
        `).run(nextStatus, toJson(failure), ts, workId)
        if (nextStatus === 'queued') {
          const refreshed = stmt.getWork.get(workId)
          enqueueReadyInternal(refreshed, refreshed.kind === 'foreground' ? 'foreground' : refreshed.priority, 'failed_turn_pending_inbox', ts)
        }
        return { action: 'failed', work: mapWork(stmt.getWork.get(workId)), error: failure }
      }

      throw new CoordinationError('coordination/invalid_argument', `Unsupported deliveryStatus.status: ${String(status)}`)
    })
  }

  function yieldWork({
    workId,
    claimToken,
    nextStatus,
    expectedRevision,
    expectedInboxSeq,
    ackThroughSeq,
    releaseOnConflict = true,
    pauseReason,
    pauseDetail,
  }) {
    nonEmptyString(workId, 'workId')
    nonEmptyString(claimToken, 'claimToken')
    if (nextStatus !== undefined) {
      oneOf(nextStatus, ['idle', 'waiting', 'paused', 'needs_verification'], 'nextStatus')
    }

    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      if (TERMINAL_WORK_STATUSES.has(work.status)) {
        return { yielded: false, conflict: true, reason: 'work_terminal', status: work.status, work: mapWork(work) }
      }
      if (work.status !== 'running' || work.claim_token !== claimToken) {
        return { yielded: false, conflict: true, reason: 'claim_mismatch', status: work.status, work: mapWork(work) }
      }

      const ts = now()
      if (ackThroughSeq !== undefined) {
        const bound = Math.max(0, Math.trunc(ackThroughSeq))
        stmt.ackInbox.run(ts, workId, bound)
        db.prepare(`
          UPDATE works
          SET last_consumed_seq = MAX(last_consumed_seq, ?),
              last_delivered_seq = MAX(last_delivered_seq, ?)
          WHERE work_id = ?
        `).run(bound, bound, workId)
      }

      const openReqWaits = stmt.countOpenRequiredWaits.get(workId).n
      const checkRevision = expectedRevision ?? work.claimed_revision
      const checkSeq = expectedInboxSeq ?? work.claimed_inbox_seq ?? 0
      const revisionChanged = checkRevision !== null && checkRevision !== undefined && work.revision !== checkRevision
      // When required waits remain open, partial `result`/`answer` messages wait in inbox until
      // all required waits resolve; only `request`/`revise`/`ask` (or foreground `room-report:`
      // results) or revision bumps block yield.
      const unreadWaking = openReqWaits > 0
        ? (work.kind === 'foreground'
            ? stmt.hasUnreadForegroundInterruptingAfter.get(workId, checkSeq)
            : stmt.hasUnreadInterruptingAfter.get(workId, checkSeq))
        : stmt.hasUnreadWakingAfter.get(workId, checkSeq)

      // Silent notes never block yield; only revision changes or unread waking messages do.
      if ((revisionChanged || unreadWaking) && nextStatus !== 'paused' && nextStatus !== 'needs_verification') {
        const latestWakingSeq = stmt.maxWakingInboxSeq.get(workId).max_seq
        if (releaseOnConflict) {
          db.prepare(`
            UPDATE works
            SET status = 'queued',
                claim_token = NULL,
                claim_owner = NULL,
                claimed_at = NULL,
                active_delivery_key = NULL,
                active_turn = NULL,
                updated_at = ?
            WHERE work_id = ?
          `).run(ts, workId)
          const refreshed = stmt.getWork.get(workId)
          enqueueReadyInternal(refreshed, refreshed.kind === 'foreground' ? 'foreground' : 'interactive', 'requeue', ts)
        }
        return {
          yielded: false,
          conflict: true,
          reason: revisionChanged ? 'revision_changed' : 'unread_inbox',
          requeued: releaseOnConflict,
          currentRevision: work.revision,
          latestWakingSeq,
          work: mapWork(stmt.getWork.get(workId)),
        }
      }

      let targetStatus = nextStatus
      if (targetStatus === undefined) {
        targetStatus = openReqWaits > 0 ? 'waiting' : 'idle'
      } else if (targetStatus === 'idle' && openReqWaits > 0) {
        targetStatus = 'waiting'
      }

      db.prepare(`
        UPDATE works
        SET status = ?,
            claim_token = NULL,
            claim_owner = NULL,
            claimed_at = NULL,
            active_delivery_key = NULL,
            active_turn = NULL,
            pause_reason = ?,
            pause_detail_json = ?,
            updated_at = ?
        WHERE work_id = ?
      `).run(
        targetStatus,
        targetStatus === 'paused' || targetStatus === 'needs_verification' ? toSql(pauseReason) : null,
        targetStatus === 'paused' || targetStatus === 'needs_verification' ? toJson(pauseDetail) : null,
        ts,
        workId,
      )
      stmt.deleteReady.run(workId)

      return {
        yielded: true,
        conflict: false,
        work: mapWork(stmt.getWork.get(workId)),
      }
    })
  }

  function settleWork({
    workId,
    outcome,
    claimToken,
    expectedRevision,
    expectedInboxSeq,
    ackThroughSeq,
    force = false,
    releaseOnConflict = true,
    summary,
    resultRef,
    resultMeta,
    error,
    explicitPublish = false,
    archiveLate = true,
    notifyParents = true,
    suppressParentBotId,
  }) {
    nonEmptyString(workId, 'workId')
    oneOf(outcome, ['done', 'failed', 'stopped'], 'outcome')

    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)

      const ts = now()

      if (TERMINAL_WORK_STATUSES.has(work.status)) {
        let lateArchived = false
        if (archiveLate && work.status !== outcome && (summary || resultRef || error)) {
          const seq = stmt.nextInboxSeq.get(workId).next_seq
          stmt.insertInbox.run(
            workId,
            seq,
            null,
            'note',
            work.logical_address,
            work.bot_id,
            null,
            null,
            work.revision,
            toSql(resultRef),
            toSql(summary),
            toJson({ lateOutcome: outcome, error: error ?? null }),
            ts,
            null,
            ts,
          )
          lateArchived = true
        }
        return {
          settled: false,
          alreadyTerminal: true,
          status: work.status,
          lateArchived,
          work: mapWork(work),
          settledCalls: [],
          wokenParents: [],
        }
      }

      if (work.kind === 'foreground' && outcome !== 'stopped' && !force) {
        throw new CoordinationError('coordination/foreground_permanent', 'Foreground work stays active and yields to idle instead of settling as done/failed')
      }

      if (!force && outcome === 'done') {
        if (claimToken !== undefined && work.claim_token !== claimToken) {
          return {
            settled: false,
            alreadyTerminal: false,
            conflict: true,
            reason: 'claim_mismatch',
            work: mapWork(work),
            settledCalls: [],
            wokenParents: [],
          }
        }
        const checkRevision = expectedRevision ?? work.claimed_revision
        const checkSeq = expectedInboxSeq ?? work.claimed_inbox_seq ?? 0
        const revisionChanged = checkRevision !== null && checkRevision !== undefined && work.revision !== checkRevision
        const unreadWaking = stmt.hasUnreadWakingAfter.get(workId, checkSeq)
        if (revisionChanged || unreadWaking) {
          const latestWakingSeq = stmt.maxWakingInboxSeq.get(workId).max_seq
          if (releaseOnConflict && work.status === 'running') {
            db.prepare(`
              UPDATE works
              SET status = 'queued',
                  claim_token = NULL,
                  claim_owner = NULL,
                  claimed_at = NULL,
                  active_delivery_key = NULL,
                  active_turn = NULL,
                  updated_at = ?
              WHERE work_id = ?
            `).run(ts, workId)
            const refreshed = stmt.getWork.get(workId)
            enqueueReadyInternal(refreshed, 'interactive', 'requeue', ts)
          }
          return {
            settled: false,
            alreadyTerminal: false,
            conflict: true,
            reason: revisionChanged ? 'revision_changed' : 'unread_inbox',
            requeued: releaseOnConflict && work.status === 'running',
            currentRevision: work.revision,
            latestWakingSeq,
            work: mapWork(stmt.getWork.get(workId)),
            settledCalls: [],
            wokenParents: [],
          }
        }
      }

      if (ackThroughSeq !== undefined) {
        const bound = Math.max(0, Math.trunc(ackThroughSeq))
        stmt.ackInbox.run(ts, workId, bound)
        db.prepare(`
          UPDATE works
          SET last_consumed_seq = MAX(last_consumed_seq, ?),
              last_delivered_seq = MAX(last_delivered_seq, ?)
          WHERE work_id = ?
        `).run(bound, bound, workId)
      }

      db.prepare(`
        UPDATE works
        SET status = ?,
            claim_token = NULL,
            claim_owner = NULL,
            claimed_at = NULL,
            active_delivery_key = NULL,
            active_turn = NULL,
            result_summary = ?,
            result_ref = ?,
            error_json = ?,
            finished_at = ?,
            updated_at = ?
        WHERE work_id = ?
      `).run(outcome, toSql(summary), toSql(resultRef), toJson(error), ts, ts, workId)
      stmt.deleteReady.run(workId)
      stmt.cancelWorkOpenWaits.run(ts, ts, workId)

      // Unblock any live work waiting on an `ask` directed at this now-terminal work.
      const incomingAsks = stmt.openIncomingAsksForTarget.all(workId)
      const wokenAskers = []
      for (const askWait of incomingAsks) {
        const beforeReq = stmt.countOpenRequiredWaits.get(askWait.work_id).n
        stmt.closeWait.run(
          'cancelled',
          toJson({ reason: 'target_work_terminal', targetWorkId: workId, outcome }),
          ts,
          ts,
          askWait.wait_id,
        )
        const asker = stmt.getWork.get(askWait.work_id)
        if (asker && !TERMINAL_WORK_STATUSES.has(asker.status)) {
          const dedupKey = `ask:${askWait.wait_id}:target_terminal`
          if (!stmt.getInboxByDedup.get(asker.work_id, dedupKey)) {
            const seq = stmt.nextInboxSeq.get(asker.work_id).next_seq
            stmt.insertInbox.run(
              asker.work_id,
              seq,
              dedupKey,
              'answer',
              work.logical_address,
              work.bot_id,
              null,
              askWait.wait_id,
              work.revision,
              null,
              `Target work ${workId} ended (${outcome}) before answering.`,
              toJson({ targetTerminal: true, targetWorkId: workId, outcome }),
              null,
              null,
              ts,
            )
          }
          const afterReq = stmt.countOpenRequiredWaits.get(asker.work_id).n
          const latestAsker = stmt.getWork.get(asker.work_id)
          if (beforeReq > 0 && afterReq === 0 && (latestAsker.status === 'waiting' || latestAsker.status === 'idle')) {
            db.prepare("UPDATE works SET status = 'queued', updated_at = ? WHERE work_id = ?").run(ts, asker.work_id)
            const priority = latestAsker.kind === 'foreground' ? 'foreground' : 'interactive'
            enqueueReadyInternal(latestAsker, priority, 'ask_target_terminal', ts)
            wokenAskers.push(asker.work_id)
          }
        }
      }

      const openCalls = stmt.openCallsForChild.all(workId)
      const settledCalls = []
      const wokenParents = []
      const satisfiedParents = []

      for (const call of openCalls) {
        const parent = stmt.getWork.get(call.parent_work_id)
        const parentLive = parent !== undefined && !TERMINAL_WORK_STATUSES.has(parent.status)
        const effectiveScope = (work.privacy_scoped === 1 || work.visibility === 'private') && call.visible_scope === 'room' && !explicitPublish
          ? 'private'
          : call.visible_scope
        const deliveryStatus = !parent ? 'undeliverable' : parentLive ? 'delivered' : 'archived'

        stmt.settleCall.run(
          outcome,
          deliveryStatus,
          work.revision,
          toSql(summary),
          toSql(resultRef),
          toJson(error),
          ts,
          ts,
          deliveryStatus === 'delivered' ? ts : null,
          call.call_id,
        )

        if (parent) {
          const shouldNotifyParent = parentLive && notifyParents && (suppressParentBotId === undefined || parent.bot_id !== suppressParentBotId)
          const dedupKey = `call:${call.call_id}:result`
          const existingMsg = stmt.getInboxByDedup.get(parent.work_id, dedupKey)
          if (!existingMsg) {
            const seq = stmt.nextInboxSeq.get(parent.work_id).next_seq
            stmt.insertInbox.run(
              parent.work_id,
              seq,
              dedupKey,
              'result',
              work.logical_address,
              work.bot_id,
              call.call_id,
              null,
              work.revision,
              toSql(resultRef),
              toSql(summary),
              toJson({
                ...(resultMeta && typeof resultMeta === 'object' ? resultMeta : {}),
                ...(work.meta_json ? { workMeta: fromJson(work.meta_json) } : {}),
                ...(call.meta_json ? { callMeta: fromJson(call.meta_json) } : {}),
                outcome,
                returnAddress: call.return_address,
                visibleScope: effectiveScope,
                ...(error !== undefined ? { error } : {}),
              }),
              shouldNotifyParent ? null : ts,
              null,
              ts,
            )
          }

          const waitRow = stmt.getOpenWaitByTarget.get(parent.work_id, 'call', call.call_id)
          if (waitRow) {
            const beforeReq = stmt.countOpenRequiredWaits.get(parent.work_id).n
            stmt.closeWait.run(
              parentLive ? 'resolved' : 'cancelled',
              toJson({ callId: call.call_id, outcome, targetRevision: work.revision }),
              ts,
              ts,
              waitRow.wait_id,
            )
            const afterReq = stmt.countOpenRequiredWaits.get(parent.work_id).n
            const latestParent = stmt.getWork.get(parent.work_id)
            if (shouldNotifyParent && ((latestParent.kind === 'foreground' && work.origin_kind === 'group_report') || (beforeReq > 0 && afterReq === 0))) {
              if (latestParent.status === 'waiting' || latestParent.status === 'idle') {
                satisfiedParents.push(parent.work_id)
                db.prepare("UPDATE works SET status = 'queued', updated_at = ? WHERE work_id = ?").run(ts, parent.work_id)
                const priority = latestParent.kind === 'foreground' ? 'foreground' : latestParent.priority
                enqueueReadyInternal(latestParent, priority, 'waits_satisfied', ts)
                wokenParents.push(parent.work_id)
              } else if (latestParent.status === 'running') {
                satisfiedParents.push(parent.work_id)
              }
            }
          }
        }

        settledCalls.push(mapCall(stmt.getCall.get(call.call_id)))
      }

      return {
        settled: true,
        alreadyTerminal: false,
        conflict: false,
        work: mapWork(stmt.getWork.get(workId)),
        settledCalls,
        wokenParents,
        satisfiedParents,
        wokenAskers,
      }
    })
  }

  function stopWork(workId, { reason = 'Stopped', by, cascadeChildren = false, summary, resultMeta, notifyParents = true, suppressParentBotId } = {}) {
    nonEmptyString(workId, 'workId')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      const stoppedChildren = []
      if (cascadeChildren) {
        const outgoing = stmt.openCallsForParent.all(workId)
        for (const call of outgoing) {
          const child = stmt.getWork.get(call.child_work_id)
          if (child && !TERMINAL_WORK_STATUSES.has(child.status)) {
            const childRes = stopWork(child.work_id, { reason, by, cascadeChildren: true, notifyParents: false })
            if (childRes.settled) stoppedChildren.push(child.work_id, ...childRes.stoppedChildren)
          }
        }
      }
      const res = settleWork({
        workId,
        outcome: 'stopped',
        force: true,
        summary: summary ?? reason,
        ...(resultMeta !== undefined ? { resultMeta } : {}),
        notifyParents,
        ...(suppressParentBotId !== undefined ? { suppressParentBotId } : {}),
        error: { code: 'work/stopped', message: reason, ...(by ? { by } : {}) },
      })
      return { ...res, stoppedChildren }
    })
  }

  function pauseWork(workId, { reason = 'paused', detail, status = 'paused', pauseChain = false } = {}) {
    nonEmptyString(workId, 'workId')
    oneOf(status, ['paused', 'needs_verification'], 'status')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      if (TERMINAL_WORK_STATUSES.has(work.status)) {
        return { paused: false, reason: 'work_terminal', pausedWorkIds: [], work: mapWork(work) }
      }
      const targets = pauseChain
        ? stmt.listChainActiveWorks.all(work.root_work_id).filter(t => t.kind !== 'foreground' || t.work_id === workId)
        : [work]
      const ts = now()
      const pausedWorkIds = []
      const updateStmt = db.prepare(`
        UPDATE works
        SET status = ?,
            claim_token = NULL,
            claim_owner = NULL,
            claimed_at = NULL,
            pause_reason = ?,
            pause_detail_json = ?,
            updated_at = ?
        WHERE work_id = ?
      `)
      for (const target of targets) {
        updateStmt.run(status, toSql(reason), toJson(detail), ts, target.work_id)
        stmt.deleteReady.run(target.work_id)
        pausedWorkIds.push(target.work_id)
      }
      return {
        paused: true,
        pausedWorkIds,
        work: mapWork(stmt.getWork.get(workId)),
      }
    })
  }

  function resumeWork(workId, { resumeChain = true, resetProgress = true, reason = 'resume' } = {}) {
    nonEmptyString(workId, 'workId')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      const targets = resumeChain
        ? stmt.listChainPausedWorks.all(work.root_work_id)
        : (work.status === 'paused' || work.status === 'needs_verification' ? [work] : [])
      if (targets.length === 0) {
        return { resumed: false, resumedWorkIds: [], queuedWorkIds: [], work: mapWork(work) }
      }
      const ts = now()
      const resumedWorkIds = []
      const queuedWorkIds = []
      for (const target of targets) {
        const openReqWaits = stmt.countOpenRequiredWaits.get(target.work_id).n
        const nextStatus = openReqWaits > 0 ? 'waiting' : 'queued'
        db.prepare(`
          UPDATE works
          SET status = ?,
              pause_reason = NULL,
              pause_detail_json = NULL,
              stagnation_count = CASE WHEN ? = 1 THEN 0 ELSE stagnation_count END,
              stagnation_key = CASE WHEN ? = 1 THEN NULL ELSE stagnation_key END,
              progress_signature = CASE WHEN ? = 1 THEN NULL ELSE progress_signature END,
              updated_at = ?
          WHERE work_id = ?
        `).run(nextStatus, resetProgress ? 1 : 0, resetProgress ? 1 : 0, resetProgress ? 1 : 0, ts, target.work_id)
        resumedWorkIds.push(target.work_id)
        if (nextStatus === 'queued') {
          const refreshed = stmt.getWork.get(target.work_id)
          enqueueReadyInternal(refreshed, refreshed.kind === 'foreground' ? 'foreground' : refreshed.priority, reason, ts)
          queuedWorkIds.push(target.work_id)
        }
      }
      if (resetProgress) {
        db.prepare('UPDATE works SET stagnation_count = 0, stagnation_key = NULL, progress_signature = NULL, updated_at = ? WHERE root_work_id = ? OR work_id = ?')
          .run(ts, work.root_work_id, work.root_work_id)
      }
      return {
        resumed: true,
        resumedWorkIds,
        queuedWorkIds,
        work: mapWork(stmt.getWork.get(workId)),
      }
    })
  }

  function recordProgressCheck({
    workId,
    unresolvedKey,
    workspaceDigest = '',
    outputDigest = '',
    errorSignature = '',
    revision,
    threshold = DEFAULT_STAGNATION_THRESHOLD,
    pauseOnStagnation = true,
    reason,
  }) {
    nonEmptyString(workId, 'workId')
    nonEmptyString(unresolvedKey, 'unresolvedKey')
    const limit = Math.max(2, Math.trunc(threshold))

    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      const rootWorkId = work.root_work_id ?? work.work_id
      const root = stmt.getWork.get(rootWorkId) ?? work
      // Chain-wide revision sum ensures parent and child checks share a consistent revision
      // baseline while any revision anywhere in the chain immediately invalidates stagnation.
      const effectiveRevision = revision ?? stmt.sumChainRevisions.get(root.work_id).rev_sum
      const signature = computeProgressSignature({
        revision: effectiveRevision,
        workspaceDigest,
        outputDigest,
        errorSignature,
      })

      const sameKey = root.stagnation_key === unresolvedKey
      const sameSig = root.progress_signature === signature
      const progressed = !(sameKey && sameSig)
      const count = progressed ? 1 : (root.stagnation_count + 1)
      const ts = now()

      db.prepare(`
        UPDATE works
        SET stagnation_key = ?,
            progress_signature = ?,
            stagnation_count = ?,
            updated_at = ?
        WHERE work_id = ?
      `).run(unresolvedKey, signature, count, ts, root.work_id)

      if (work.work_id !== root.work_id) {
        db.prepare(`
          UPDATE works
          SET stagnation_key = ?,
              progress_signature = ?,
              stagnation_count = ?,
              updated_at = ?
          WHERE work_id = ?
        `).run(unresolvedKey, signature, count, ts, work.work_id)
      }

      const stagnant = !progressed && count >= limit
      let pausedWorkIds = []
      if (stagnant && pauseOnStagnation) {
        const paused = pauseWork(workId, {
          reason: 'no_progress',
          pauseChain: true,
          detail: {
            message: reason ?? `No measurable progress across ${count} visits to "${unresolvedKey}"`,
            unresolvedKey,
            signature,
            count,
            threshold: limit,
            revision: effectiveRevision,
            workspaceDigest,
            outputDigest,
            errorSignature,
          },
        })
        pausedWorkIds = paused.pausedWorkIds
      }

      return {
        progressed,
        stagnant,
        paused: pausedWorkIds.length > 0,
        count,
        threshold: limit,
        signature,
        rootWorkId: root.work_id,
        pausedWorkIds,
      }
    })
  }

  function setCallDeliveryStatus(callId, deliveryStatus) {
    nonEmptyString(callId, 'callId')
    oneOf(deliveryStatus, CALL_DELIVERY_STATUSES, 'deliveryStatus')
    return transaction(() => {
      const existing = stmt.getCall.get(callId)
      if (!existing) throw new CoordinationError('coordination/not_found', `Call ${callId} not found`)
      const ts = now()
      stmt.updateCallDelivery.run(deliveryStatus, ts, deliveryStatus, ts, callId)
      return mapCall(stmt.getCall.get(callId))
    })
  }

  function requeueInterruptedWork(workId, { reason = 'restart_reconcile', priority } = {}) {
    nonEmptyString(workId, 'workId')
    return transaction(() => {
      const work = stmt.getWork.get(workId)
      if (!work) throw new CoordinationError('coordination/not_found', `Work ${workId} not found`)
      if (TERMINAL_WORK_STATUSES.has(work.status)) {
        return { requeued: false, reason: 'work_terminal', work: mapWork(work) }
      }
      const ts = now()
      db.prepare(`
        UPDATE works
        SET status = 'queued',
            claim_token = NULL,
            claim_owner = NULL,
            claimed_at = NULL,
            active_delivery_key = NULL,
            active_turn = NULL,
            updated_at = ?
        WHERE work_id = ?
      `).run(ts, workId)
      const refreshed = stmt.getWork.get(workId)
      enqueueReadyInternal(refreshed, priority ?? (refreshed.kind === 'foreground' ? 'foreground' : refreshed.priority), reason, ts)
      return { requeued: true, work: mapWork(refreshed) }
    })
  }

  // Idempotent migration of legacy state.json / inflight.json / api-runs.json into SQLite.
  function importLegacyState({
    state: legacyState,
    inflight: legacyInflight,
    apiRuns: legacyApiRuns,
    includeSettledTasks = false,
  } = {}) {
    return transaction(() => {
      const imported = { works: 0, calls: 0, inbox: 0, waits: 0, ready: 0 }
      const skipped = { works: 0, calls: 0, inbox: 0, waits: 0, ready: 0 }
      const sessionToWorkId = new Map()
      const foregroundSessionsByBot = new Map()
      const terminalTaskSessions = new Set()
      const taskToWorkId = new Map()
      const legacyWorkToWorkId = new Map()

      const trackWork = (res) => {
        if (res.created) imported.works += 1
        else skipped.works += 1
        // Preserve earlier foreground / dedicated task session bindings so legacy handoffs
        // referencing a Bot's foreground session never hijack that session's owner mapping.
        if (res.work.sessionId && !sessionToWorkId.has(res.work.sessionId)) {
          sessionToWorkId.set(res.work.sessionId, res.work.workId)
        }
        return res.work
      }

      const bots = legacyState?.bots && typeof legacyState.bots === 'object' ? legacyState.bots : {}
      for (const [key, bot] of Object.entries(bots)) {
        if (!bot || typeof bot !== 'object') continue
        const botId = typeof bot.id === 'string' && bot.id !== '' ? bot.id : key
        const fgSession = bot.sessionId ?? botId
        const fgSet = new Set([botId, fgSession].filter(Boolean))
        for (const seg of Array.isArray(bot.segments) ? bot.segments : []) {
          if (typeof seg?.sessionId === 'string' && seg.sessionId !== '') fgSet.add(seg.sessionId)
        }
        foregroundSessionsByBot.set(botId, fgSet)
        for (const sid of Array.isArray(bot.retiredTaskSessions) ? bot.retiredTaskSessions : []) {
          if (typeof sid === 'string' && sid !== '') terminalTaskSessions.add(sid)
        }
        const fgRes = ensureForegroundWork({
          botId,
          workId: `fg:${botId}`,
          logicalAddress: `foreground:${botId}`,
          sessionId: fgSession,
          workspaceDir: bot.workDir,
          privacyScoped: bot.private === true || bot.privacy === true,
          meta: { migratedFrom: 'state.bots' },
        })
        trackWork(fgRes)
        for (const sid of fgSet) sessionToWorkId.set(sid, fgRes.work.workId)
      }
      for (const [sid, sw] of Object.entries(legacyState?.switching && typeof legacyState.switching === 'object' ? legacyState.switching : {})) {
        if (typeof sid === 'string' && sid !== '' && typeof sw?.botId === 'string' && sw.botId !== '' && !sessionToWorkId.has(sid)) {
          sessionToWorkId.set(sid, `fg:${sw.botId}`)
        }
      }
      for (const [key, bot] of Object.entries(bots)) {
        if (!bot || typeof bot !== 'object') continue
        const botId = typeof bot.id === 'string' && bot.id !== '' ? bot.id : key

        for (const task of Array.isArray(bot.tasks) ? bot.tasks : []) {
          if (!task || typeof task !== 'object' || typeof task.id !== 'string' || task.id === '') continue
          const active = ACTIVE_LEGACY_TASK_STATUSES.has(task.status)
          if (!active) {
            if (typeof task.sessionId === 'string' && task.sessionId !== '') terminalTaskSessions.add(task.sessionId)
            for (const seg of Array.isArray(task.segments) ? task.segments : []) {
              if (typeof seg?.sessionId === 'string' && seg.sessionId !== '') terminalTaskSessions.add(seg.sessionId)
            }
          }
          if (!active && !includeSettledTasks) continue
          const mappedStatus = task.status === 'running'
            ? 'queued'
            : (task.status === 'waiting_work' || task.status === 'waiting_approval')
              ? 'waiting'
              : task.status === 'completed'
                ? 'done'
                : task.status === 'failed'
                  ? 'failed'
                  : 'stopped'
          const tWorkId = `task:${task.id}`
          const tRes = createWork({
            workId: tWorkId,
            botId,
            kind: task.roomId ? 'room_work' : 'task',
            logicalAddress: `task:${task.id}`,
            status: mappedStatus,
            priority: 'background',
            parentWorkId: `fg:${botId}`,
            roomId: task.roomId,
            title: task.title,
            originKind: task.origin ?? 'task',
            imOrigin: task.imOrigin,
            privacyScoped: bot.private === true || bot.privacy === true,
            sessionId: task.sessionId,
            workspaceDir: task.workDir ?? bot.workDir,
            meta: { migratedFrom: 'bot.tasks', legacyTaskId: task.id, legacyStatus: task.status },
          })
          trackWork(tRes)
          for (const seg of Array.isArray(task.segments) ? task.segments : []) {
            if (typeof seg?.sessionId === 'string' && seg.sessionId !== '' && !sessionToWorkId.has(seg.sessionId)) {
              sessionToWorkId.set(seg.sessionId, tWorkId)
            }
          }
          taskToWorkId.set(task.id, tWorkId)
          if (tRes.created && mappedStatus === 'queued') imported.ready += 1
          if (task.status === 'waiting_approval') {
            const wRes = addWait({
              waitId: `wt_legacy_appr_task_${task.id}`,
              workId: tWorkId,
              kind: 'approval',
              targetId: `legacy_task_approval:${task.id}`,
              meta: { migratedFrom: 'bot.tasks' },
            })
            if (wRes.created) imported.waits += 1
            else skipped.waits += 1
          }
        }
      }

      const legacyWorks = legacyState?.works && typeof legacyState.works === 'object' ? legacyState.works : {}
      const legacyWorkEntries = Object.entries(legacyWorks).filter(([, w]) => w && typeof w === 'object')

      const hasLegacyInflightTurns = legacyInflight?.turns && typeof legacyInflight.turns === 'object'
        && Object.keys(legacyInflight.turns).length > 0

      for (const [id, lw] of legacyWorkEntries) {
        const ownerBot = lw.to ?? lw.from
        if (!ownerBot) continue
        if (lw.toTaskId && taskToWorkId.has(lw.toTaskId)) {
          legacyWorkToWorkId.set(id, taskToWorkId.get(lw.toTaskId))
          continue
        }
        const workId = `handoff:${id}`
        const bot = bots[ownerBot]
        const hasPendingSubwork = lw.state === 'need_input'
          || (Array.isArray(lw.open) && lw.open.length > 0)
          || (Array.isArray(lw.results) && lw.results.length > 0)
        const isOrphanLegacyOpen = hasLegacyInflightTurns && lw.state === 'open' && !hasPendingSubwork && !lw.toSession
        const status = lw.state === 'paused'
          ? 'paused'
          : isOrphanLegacyOpen
            ? 'queued'
            : 'waiting'
        const resolvedSessionId = lw.toSession
          ?? (!isOrphanLegacyOpen && !lw.room ? (bot?.sessionId ?? (bot ? ownerBot : undefined)) : undefined)
        const res = createWork({
          workId,
          workRef: typeof lw.ref === 'string' ? lw.ref : undefined,
          botId: ownerBot,
          kind: lw.room ? 'room_work' : 'task',
          logicalAddress: lw.room ? `room:${lw.room}:${ownerBot}` : `task:${workId}`,
          status,
          priority: 'background',
          roomId: lw.room ?? lw.fromRoom,
          title: lw.goal,
          originKind: 'bot',
          imOrigin: lw.imOrigin,
          privacyScoped: bot?.private === true || bot?.privacy === true,
          sessionId: resolvedSessionId,
          meta: { migratedFrom: 'state.works', legacyWorkId: id, legacyState: lw.state ?? 'open', ...(Array.isArray(lw.results) && lw.results.length > 0 ? { legacyResults: lw.results } : {}) },
        })
        trackWork(res)
        if (lw.state === 'paused' && res.created) {
          pauseWork(workId, { reason: lw.paused?.reason ?? 'legacy_paused', detail: lw.paused ?? null })
        }
        legacyWorkToWorkId.set(id, workId)
      }

      for (const [id, lw] of legacyWorkEntries) {
        const childWorkId = legacyWorkToWorkId.get(id)
        const calleeBotId = lw.to ?? lw.from
        if (!childWorkId || !lw.from || !calleeBotId) continue
        const parentWorkId = (lw.parent && legacyWorkToWorkId.get(lw.parent))
          ?? (lw.fromPart && sessionToWorkId.get(lw.fromPart))
          ?? ensureForegroundWork({ botId: lw.from }).work.workId
        const parent = stmt.getWork.get(parentWorkId)
        const child = stmt.getWork.get(childWorkId)
        if (!parent || !child || parentWorkId === childWorkId) continue

        const callId = `call:${id}`
        if (stmt.getCall.get(callId)) {
          skipped.calls += 1
        } else {
          const check = detectWaitCycle(parentWorkId, childWorkId, { kinds: ['call'] })
          if (!check.hasCycle) {
            const visibleScope = lw.room && child.privacy_scoped !== 1 ? 'room' : 'direct'
            const callRes = createCall({
              callId,
              parentWorkId,
              childWorkId,
              callerBotId: lw.from,
              calleeBotId,
              returnAddress: parent.logical_address,
              visibleScope,
              roomId: lw.room ?? lw.fromRoom,
              waitId: `wt_legacy_call_${id}`,
              meta: { migratedFrom: 'state.works' },
            })
            if (callRes.created) {
              imported.calls += 1
              imported.waits += 1
            } else {
              skipped.calls += 1
            }
          }
        }
        if (lw.state === 'need_input') {
          const askWait = addWait({
            waitId: `wt_legacy_ask_${id}`,
            workId: childWorkId,
            kind: 'ask',
            targetId: `legacy_ask:${id}`,
            targetWorkId: parentWorkId,
            meta: { question: lw.question ?? null, migratedFrom: 'state.works' },
          })
          if (askWait.created) imported.waits += 1
          else skipped.waits += 1
        }
      }

      const roomReports = legacyState?.roomReports && typeof legacyState.roomReports === 'object' ? legacyState.roomReports : {}
      for (const [id, report] of Object.entries(roomReports)) {
        if (!report || typeof report !== 'object' || !report.botId || !report.roomId) continue
        const parentWorkId = (report.fromTaskId && taskToWorkId.get(report.fromTaskId))
          ?? ensureForegroundWork({ botId: report.botId }).work.workId
        const rWorkId = `room-report:${id}`
        const rRes = createWork({
          workId: rWorkId,
          botId: report.botId,
          kind: 'room_work',
          logicalAddress: `room:${report.roomId}:${report.botId}`,
          status: report.paused ? 'paused' : 'waiting',
          priority: 'background',
          parentWorkId,
          roomId: report.roomId,
          originKind: 'group',
          imOrigin: report.imOrigin,
          meta: { migratedFrom: 'state.roomReports', ids: report.ids ?? null, fromSeq: report.fromSeq ?? null },
        })
        trackWork(rRes)
      }

      const roomBatches = legacyState?.roomBatches && typeof legacyState.roomBatches === 'object' ? legacyState.roomBatches : {}
      for (const [key, batch] of Object.entries(roomBatches)) {
        if (!batch || typeof batch !== 'object' || !Array.isArray(batch.pending) || batch.pending.length === 0) continue
        const callerBotId = batch.botId ?? batch.callerBotId ?? batch.from
        const roomId = batch.roomId
        if (!callerBotId || !roomId) continue
        const bWorkId = `room-batch:${key}`
        const bRes = createWork({
          workId: bWorkId,
          botId: callerBotId,
          kind: 'room_work',
          logicalAddress: `room:${roomId}:${callerBotId}`,
          status: 'waiting',
          priority: 'background',
          roomId,
          originKind: 'group',
          meta: { migratedFrom: 'state.roomBatches', done: batch.done ?? [] },
        })
        trackWork(bRes)
        for (const memberBotId of batch.pending) {
          if (typeof memberBotId !== 'string' || memberBotId === '') continue
          const mWorkId = `room-batch:${key}:member:${memberBotId}`
          const mRes = createWork({
            workId: mWorkId,
            botId: memberBotId,
            kind: 'room_work',
            logicalAddress: `room:${roomId}:${memberBotId}`,
            status: 'queued',
            priority: 'background',
            parentWorkId: bWorkId,
            roomId,
            originKind: 'group',
            meta: { migratedFrom: 'state.roomBatches' },
          })
          trackWork(mRes)
          if (mRes.created) imported.ready += 1
          const cId = `call_batch:${key}:${memberBotId}`
          if (stmt.getCall.get(cId)) {
            skipped.calls += 1
          } else {
            const cRes = createCall({
              callId: cId,
              parentWorkId: bWorkId,
              childWorkId: mWorkId,
              callerBotId,
              calleeBotId: memberBotId,
              visibleScope: bots[memberBotId]?.privacy === true ? 'private' : 'room',
              roomId,
              waitId: `wt_batch_${key}_${memberBotId}`,
              meta: { migratedFrom: 'state.roomBatches' },
            })
            if (cRes.created) {
              imported.calls += 1
              imported.waits += 1
            } else {
              skipped.calls += 1
            }
          }
        }
      }

      const questions = legacyState?.questions && typeof legacyState.questions === 'object' ? legacyState.questions : {}
      for (const [sid, q] of Object.entries(questions)) {
        const wId = sessionToWorkId.get(sid) ?? stmt.getWorkBySession.get(sid)?.work_id
        if (!wId) continue
        const wRes = addWait({
          waitId: `wt_legacy_q_${sid}`,
          workId: wId,
          kind: 'user_question',
          targetId: `question:${sid}`,
          meta: { migratedFrom: 'state.questions', question: q ?? null },
        })
        if (wRes.created) imported.waits += 1
        else skipped.waits += 1
      }

      const secretReqs = legacyState?.secretRequests && typeof legacyState.secretRequests === 'object' ? legacyState.secretRequests : {}
      for (const [botId, list] of Object.entries(secretReqs)) {
        for (const req of Array.isArray(list) ? list : []) {
          if (!req || req.status !== 'pending') continue
          const reqId = String(req.id ?? req.name ?? '')
          if (!reqId) continue
          const wId = (req.sessionId && (sessionToWorkId.get(req.sessionId) ?? stmt.getWorkBySession.get(req.sessionId)?.work_id))
            ?? ensureForegroundWork({ botId }).work.workId
          const wRes = addWait({
            waitId: `wt_legacy_sec_${botId}_${reqId}`,
            workId: wId,
            kind: 'secret',
            targetId: `secret:${reqId}`,
            meta: { migratedFrom: 'state.secretRequests', name: req.name ?? null },
          })
          if (wRes.created) imported.waits += 1
          else skipped.waits += 1
        }
      }

      const resolveWorkForSession = (sessionId, fallbackBotId) => {
        // Never leak a settled/retired background task session back into foreground chat.
        if (terminalTaskSessions.has(sessionId)) return undefined
        if (sessionToWorkId.has(sessionId)) return sessionToWorkId.get(sessionId)
        const bySession = stmt.getWorkBySession.get(sessionId)
        if (bySession) {
          return TERMINAL_WORK_STATUSES.has(bySession.status) ? undefined : bySession.work_id
        }
        if (fallbackBotId) {
          const fgSessions = foregroundSessionsByBot.get(fallbackBotId)
          if (fgSessions === undefined ? sessionId === fallbackBotId : fgSessions.has(sessionId)) {
            return ensureForegroundWork({ botId: fallbackBotId, sessionId }).work.workId
          }
        }
        return undefined
      }

      const inflightTurns = legacyInflight?.turns && typeof legacyInflight.turns === 'object' ? legacyInflight.turns : {}
      for (const [sessionId, record] of Object.entries(inflightTurns)) {
        if (!record || typeof record !== 'object') continue
        const wId = resolveWorkForSession(sessionId, record.botId)
        if (!wId) continue
        const targetWork = stmt.getWork.get(wId)
        if (!targetWork || TERMINAL_WORK_STATUSES.has(targetWork.status)) continue
        // Record interrupted turn metadata for DSH D2 reconciliation instead of synthesizing
        // a fake inbox request or an unanswerable orphan approval wait (memory pending approvals
        // do not survive restart, so leaving an open required approval wait would deadlock the work).
        const turnKey = record.trigger?.exchangeId ?? `legacy:turn:${sessionId}:${record.turn ?? record.since ?? 0}`
        if (targetWork.active_delivery_key === turnKey) {
          skipped.works += 1
          continue
        }
        const ts = now()
        stmt.deleteReady.run(wId)
        db.prepare(`
          UPDATE works
          SET status = 'running',
              active_delivery_key = ?,
              active_turn = COALESCE(?, active_turn),
              updated_at = ?
          WHERE work_id = ?
        `).run(turnKey, toSql(Number.isInteger(record.turn) ? record.turn : null), ts, wId)
      }

      const cancelledLegacyIds = new Set()
      const closedLegacyWorks = legacyState?.closedWorks && typeof legacyState.closedWorks === 'object' ? legacyState.closedWorks : {}
      for (const [id, cw] of Object.entries(closedLegacyWorks)) {
        if (cw?.status === 'cancelled') cancelledLegacyIds.add(id)
      }

      const inflightQueued = legacyInflight?.queued && typeof legacyInflight.queued === 'object' ? legacyInflight.queued : {}
      for (const [sessionId, list] of Object.entries(inflightQueued)) {
        for (let idx = 0; idx < (Array.isArray(list) ? list.length : 0); idx += 1) {
          const item = list[idx]
          const args = item?.args
          if (!args || typeof args !== 'object') continue
          if ((typeof args.exchangeId === 'string' && cancelledLegacyIds.has(args.exchangeId))
            || (typeof args.work === 'string' && cancelledLegacyIds.has(args.work))) {
            skipped.inbox += 1
            continue
          }
          const wId = resolveWorkForSession(sessionId, args.toId)
          if (!wId) continue
          const isSilent = args.wake === false || args.role === 'note'
          const msgKind = isSilent
            ? 'note'
            : args.role === 'reply' || args.role === 'task-report' || args.role === 'report'
              ? 'result'
              : args.role === 'ask_back'
                ? 'ask'
                : args.role === 'answer'
                  ? 'answer'
                  : 'request'
          const dedup = `legacy:queued:${args.exchangeId ?? `${sessionId}:${idx}`}`
          const fullText = typeof args.text === 'string' ? args.text : undefined
          const res = receiveMessage({
            workId: wId,
            kind: msgKind,
            dedupKey: dedup,
            senderAddress: args.fromId ? `foreground:${args.fromId}` : 'system:migration',
            senderBotId: args.fromId,
            bodyPreview: fullText !== undefined ? fullText.slice(0, 400) : undefined,
            payload: {
              migratedFrom: 'inflight.queued',
              role: args.role ?? null,
              exchangeId: args.exchangeId ?? null,
              ...(fullText !== undefined ? { text: fullText, renderedText: fullText } : {}),
              ...(Array.isArray(args.images) && args.images.length > 0 ? { images: args.images } : {}),
              ...(Array.isArray(args.files) && args.files.length > 0 ? { files: args.files } : {}),
              ...(Array.isArray(args.attachments) && args.attachments.length > 0 ? { attachments: args.attachments } : {}),
              ...(args.work ? { work: args.work } : {}),
              ...(args.replyTo ? { replyTo: args.replyTo } : {}),
              ...(args.workRef ? { workRef: args.workRef } : {}),
              ...(args.roomId ? { roomId: args.roomId } : {}),
              ...(args.fromId ? { fromId: args.fromId } : {}),
              ...(args.toId ? { toId: args.toId } : {}),
            },
            dshIdempotencyKey: args.idempotencyKey ?? args.exchangeId,
            wake: isSilent ? false : true,
          })
          if (res.deduplicated) skipped.inbox += 1
          else imported.inbox += 1
          if (res.readyEnqueued) imported.ready += 1
        }
      }

      const inflightSilent = legacyInflight?.silent && typeof legacyInflight.silent === 'object' ? legacyInflight.silent : {}
      for (const [sessionId, list] of Object.entries(inflightSilent)) {
        for (let idx = 0; idx < (Array.isArray(list) ? list.length : 0); idx += 1) {
          const entry = list[idx]
          const msg = entry?.message
          if (!msg || typeof msg !== 'object') continue
          const wId = resolveWorkForSession(sessionId, msg.source?.toId)
          if (!wId) continue
          const dedup = `legacy:silent:${msg.source?.exchangeId ?? msg.id ?? `${sessionId}:${idx}`}`
          const silentText = typeof msg.text === 'string'
            ? msg.text
            : Array.isArray(msg.content)
              ? msg.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
              : undefined
          const res = receiveMessage({
            workId: wId,
            kind: 'note',
            dedupKey: dedup,
            senderAddress: msg.source?.fromId ? `foreground:${msg.source.fromId}` : 'system:migration',
            senderBotId: msg.source?.fromId,
            bodyPreview: silentText !== undefined ? silentText.slice(0, 400) : undefined,
            payload: {
              migratedFrom: 'inflight.silent',
              ledger: entry.ledger ?? null,
              ...(silentText !== undefined ? { text: silentText, renderedText: silentText } : {}),
              ...(Array.isArray(msg.content) ? { content: msg.content } : {}),
            },
          })
          if (res.deduplicated) skipped.inbox += 1
          else imported.inbox += 1
        }
      }

      const runsList = Array.isArray(legacyApiRuns?.runs) ? legacyApiRuns.runs : []
      for (const run of runsList) {
        if (!run || typeof run !== 'object' || typeof run.runId !== 'string' || run.runId === '') continue
        const botId = run.target?.kind === 'bot' ? run.target.id : (run.botId ?? 'api')
        const status = run.status === 'completed'
          ? 'done'
          : run.status === 'failed'
            ? 'failed'
            : 'stopped'
        const res = createWork({
          workId: `api:${run.runId}`,
          botId,
          kind: run.target?.kind === 'room' ? 'room_work' : 'task',
          logicalAddress: `api:${run.runId}`,
          status,
          originKind: 'api',
          roomId: run.target?.kind === 'room' ? run.target.id : undefined,
          apiRunId: run.runId,
          apiMeta: {
            tokenId: run.tokenId ?? null,
            tokenName: run.tokenName ?? null,
            target: run.target ?? null,
            mode: run.mode ?? 'chat',
            usage: run.usage ?? null,
          },
          sessionId: run.sessionId,
          meta: { migratedFrom: 'api-runs.json' },
        })
        trackWork(res)
      }

      return { imported, skipped }
    })
  }

  function getWork(workId) {
    ensureOpen()
    return mapWork(stmt.getWork.get(workId))
  }
  function getWorkByRef(workRef) {
    ensureOpen()
    return mapWork(stmt.getWorkByRef.get(workRef))
  }
  function getWorkByApiRunId(apiRunId) {
    ensureOpen()
    return mapWork(stmt.getWorkByApiRun.get(apiRunId))
  }
  function getWorkByApiIdempotencyKey(key) {
    ensureOpen()
    return mapWork(stmt.getWorkByApiIdem.get(key))
  }
  function getForegroundWork(botId) {
    ensureOpen()
    return mapWork(stmt.getForegroundWork.get(botId))
  }
  function getWorkBySessionId(sessionId) {
    ensureOpen()
    return mapWork(stmt.getWorkBySession.get(sessionId))
  }
  function getWorkByLogicalAddress(logicalAddress) {
    ensureOpen()
    return mapWork(stmt.getWorkByAddress.get(logicalAddress))
  }
  function listInterruptedWorks() {
    ensureOpen()
    return stmt.listInterruptedWorks.all().map(mapWork)
  }
  function listWorks({ botId, kind, status, statuses, roomId, rootWorkId, activeOnly = false, limit = 200 } = {}) {
    ensureOpen()
    const where = []
    const args = []
    if (botId !== undefined) { where.push('bot_id = ?'); args.push(botId) }
    if (kind !== undefined) { where.push('kind = ?'); args.push(kind) }
    if (status !== undefined) { where.push('status = ?'); args.push(status) }
    if (Array.isArray(statuses) && statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`)
      args.push(...statuses)
    }
    if (activeOnly) where.push("status NOT IN ('done', 'failed', 'stopped')")
    if (roomId !== undefined) { where.push('room_id = ?'); args.push(roomId) }
    if (rootWorkId !== undefined) { where.push('root_work_id = ?'); args.push(rootWorkId) }
    const sql = `SELECT * FROM works${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, work_id ASC LIMIT ?`
    args.push(limit)
    return db.prepare(sql).all(...args).map(mapWork)
  }
  function getCall(callId) {
    ensureOpen()
    return mapCall(stmt.getCall.get(callId))
  }
  function listCalls({ parentWorkId, childWorkId, status, deliveryStatus, limit = 200 } = {}) {
    ensureOpen()
    const where = []
    const args = []
    if (parentWorkId !== undefined) { where.push('parent_work_id = ?'); args.push(parentWorkId) }
    if (childWorkId !== undefined) { where.push('child_work_id = ?'); args.push(childWorkId) }
    if (status !== undefined) { where.push('status = ?'); args.push(status) }
    if (deliveryStatus !== undefined) { where.push('delivery_status = ?'); args.push(deliveryStatus) }
    const sql = `SELECT * FROM calls${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC LIMIT ?`
    args.push(limit)
    return db.prepare(sql).all(...args).map(mapCall)
  }
  function listInbox(workId, { afterSeq = 0, unreadOnly = false, includeNotes = true, limit = 200 } = {}) {
    ensureOpen()
    const where = ['work_id = ?', 'seq > ?']
    const args = [workId, Math.max(0, Math.trunc(afterSeq))]
    if (unreadOnly) where.push('read_at IS NULL')
    if (!includeNotes) where.push("kind <> 'note'")
    const sql = `SELECT * FROM inbox WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`
    args.push(limit)
    return db.prepare(sql).all(...args).map(mapInbox)
  }
  function listWaits({ workId, kind, status, targetId, targetWorkId, limit = 200 } = {}) {
    ensureOpen()
    const where = []
    const args = []
    if (workId !== undefined) { where.push('work_id = ?'); args.push(workId) }
    if (kind !== undefined) { where.push('kind = ?'); args.push(kind) }
    if (status !== undefined) { where.push('status = ?'); args.push(status) }
    if (targetId !== undefined) { where.push('target_id = ?'); args.push(targetId) }
    if (targetWorkId !== undefined) { where.push('target_work_id = ?'); args.push(targetWorkId) }
    const sql = `SELECT * FROM waits${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC LIMIT ?`
    args.push(limit)
    return db.prepare(sql).all(...args).map(mapWait)
  }
  function getSnapshot({ botId, roomId } = {}) {
    ensureOpen()
    const works = listWorks({ botId, roomId, limit: 1000 })
    const workIds = new Set(works.map(w => w.workId))
    const allCalls = listCalls({ limit: 1000 })
    const calls = botId !== undefined || roomId !== undefined
      ? allCalls.filter(c => workIds.has(c.parentWorkId) || workIds.has(c.childWorkId))
      : allCalls
    const allWaits = listWaits({ status: 'open', limit: 1000 })
    const waits = botId !== undefined || roomId !== undefined
      ? allWaits.filter(w => workIds.has(w.workId))
      : allWaits
    const ready = peekReady({ botId, limit: 1000 })
    return { works, calls, waits, ready }
  }
  function schemaVersion() {
    ensureOpen()
    return db.prepare('PRAGMA user_version').get()?.user_version ?? 0
  }
  function close() {
    if (closed) return
    closed = true
    db.close()
  }

  return {
    get readonly() { return readonly },
    get path() { return dbPath },
    isClosed: () => closed,
    schemaVersion,
    transaction,
    close,
    ensureForegroundWork,
    createWork,
    rebindSession,
    updateApiMeta,
    receiveMessage,
    addWait,
    createCall,
    askBack,
    resolveWait,
    detectWaitCycle,
    peekReady,
    claimReady,
    beginDeliveryAttempt,
    markDelivered,
    ackInbox,
    ackInboxSeq,
    recordActiveTurn,
    recordDirectDeliveryAttempt,
    parkWaiting,
    reconcileDeliveryStatus,
    yieldWork,
    settleWork,
    stopWork,
    pauseWork,
    resumeWork,
    recordProgressCheck,
    setCallDeliveryStatus,
    requeueInterruptedWork,
    importLegacyState,
    getWork,
    getWorkByRef,
    getWorkByApiRunId,
    getWorkByApiIdempotencyKey,
    getForegroundWork,
    getWorkBySessionId,
    getWorkByLogicalAddress,
    listInterruptedWorks,
    listWorks,
    getCall,
    listCalls,
    listInbox,
    listWaits,
    getSnapshot,
  }
}

// Host plugin lifecycle adapter: mounts `rt.coordDb`, respects `state.lock` read-only windows,
// upgrades cleanly on `rt.onAdopted`, and closes SQLite deterministically on disposal.
export function install(rt) {
  const dbPath = join(rt.home, 'coordination.sqlite')
  let handle = null

  const openHandle = () => {
    const isReadOnly = rt.readOnly?.() !== undefined
    if (handle !== null && !handle.isClosed() && handle.readonly === isReadOnly) {
      return handle
    }
    if (handle !== null) {
      handle.close()
      handle = null
    }
    if (isReadOnly && !existsSync(dbPath)) {
      return null
    }
    handle = openCoordinationDb({ path: dbPath, readonly: isReadOnly, onWarn: rt.warn })
    return handle
  }

  const refreshCoordDb = () => {
    try {
      rt.coordDb = openHandle()
    } catch (error) {
      rt.warn?.('ds-bot: coordination database unavailable: %s', error?.message ?? error)
      rt.coordDb = null
    }
    return rt.coordDb
  }

  if (typeof rt.hasLoaded !== 'function' || rt.hasLoaded()) refreshCoordDb()
  const offAdopted = rt.onAdopted?.(() => { refreshCoordDb() })
  rt.ctx?.effect?.(() => () => {
    offAdopted?.()
    if (handle !== null) {
      handle.close()
      handle = null
    }
    rt.coordDb = null
  }, 'ds-bot: coordination db')

  Object.assign(rt, { refreshCoordDb })
}

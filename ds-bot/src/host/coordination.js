// Coordination store: host-owned local SQLite WAL ledger for delivery obligations,
// active turns, non-waking work updates, and shared cold-session evidence checks.
//
// Chat bodies and tool transcripts remain in DSH Sessions and `ledger/*.jsonl`.
// This store keeps only the durable coordination truth so terminal settlement and
// pending report/return obligations commit in a single local transaction.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HISTORY_TIMEOUT_MS, SOURCE_KIND } from './constants.js'
import { isMissingSessionError } from './threads.js'

const SCHEMA_VERSION = 2
// On Windows, an open SQLite WAL handle blocks removing the team directory (EPERM).
// Closing the handle immediately after each operation keeps coordination durable while
// leaving zero lingering OS file locks between operations.
const CLOSE_AFTER_OP = process.platform === 'win32'

const isCorruptSqliteError = error => /malformed|not a database|corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(String(error?.message ?? error))

const parseJson = (raw, fallback = undefined) => {
  if (typeof raw !== 'string' || raw === '') return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}

const sha256 = text => createHash('sha256').update(String(text)).digest('hex')

export function receiptKeyOf(source) {
  if (!source || typeof source !== 'object') return ''
  return JSON.stringify([
    source.exchangeId ?? '',
    source.role ?? '',
    Boolean(source.deferred),
    Boolean(source.resumed),
    Boolean(source.retried),
  ])
}

export function eventMatchesReceipt(event, args) {
  if (event?.type !== 'user/message') return false
  const source = event.data?.source
  if (!source) return false
  const targetKey = receiptKeyOf(args)
  if (source.kind === SOURCE_KIND && source.exchangeId === args.exchangeId) {
    if (source.role === undefined || args.role === undefined || receiptKeyOf(source) === targetKey) return true
  }
  if (Array.isArray(source.joined)) {
    for (const item of source.joined) {
      const info = item?.info
      if (info?.exchangeId === args.exchangeId) {
        if (info.role === undefined || args.role === undefined || receiptKeyOf(info) === targetKey) return true
      }
    }
  }
  return false
}

export function install(rt) {
  const { ctx, home } = rt
  const dbPath = join(home, 'coordination.sqlite')
  const legacyInflightPath = join(home, 'inflight.json')

  let db = null
  let stmt = null
  let disposed = false
  let openedReadOnly = false
  let schemaReady = false
  let initialReadFailed = false
  let cachedGen = null
  let lastSyncedMirrorHash = null

  const canWrite = () => !disposed && rt.readOnly?.() === undefined

  const STATEMENT_SQL = {
    getMeta: 'SELECT value FROM meta WHERE key = ?',
    setMeta: 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',

    upsertDelivery: `
      INSERT INTO deliveries (
        exchange_id, session_id, address_json, role, bot_id, room_id, task_id, work_id,
        args_json, status, reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange_id) DO UPDATE SET
        session_id = excluded.session_id,
        address_json = excluded.address_json,
        role = excluded.role,
        bot_id = excluded.bot_id,
        room_id = excluded.room_id,
        task_id = excluded.task_id,
        work_id = excluded.work_id,
        args_json = excluded.args_json,
        status = excluded.status,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `,
    deleteDelivery: 'DELETE FROM deliveries WHERE exchange_id = ?',
    deleteDeliveriesByTaskStart: "DELETE FROM deliveries WHERE task_id = ? AND role = 'task'",
    deleteDeliveriesByWork: 'DELETE FROM deliveries WHERE exchange_id = ? OR work_id = ?',
    clearDeliveries: 'DELETE FROM deliveries',
    listDeliveries: 'SELECT exchange_id, session_id, address_json, role, bot_id, room_id, task_id, work_id, args_json, status, reason, created_at, updated_at FROM deliveries ORDER BY created_at ASC',

    upsertTurn: `
      INSERT INTO active_turns (
        session_id, bot_id, room_id, task_id, turn_num, since,
        trigger_json, approval_json, resumed, unverified, record_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        bot_id = excluded.bot_id,
        room_id = excluded.room_id,
        task_id = excluded.task_id,
        turn_num = excluded.turn_num,
        since = excluded.since,
        trigger_json = excluded.trigger_json,
        approval_json = excluded.approval_json,
        resumed = excluded.resumed,
        unverified = excluded.unverified,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
    `,
    deleteTurn: 'DELETE FROM active_turns WHERE session_id = ?',
    clearTurns: 'DELETE FROM active_turns',
    listTurns: 'SELECT session_id, bot_id, room_id, task_id, turn_num, since, trigger_json, approval_json, resumed, unverified, record_json, updated_at FROM active_turns ORDER BY since ASC',

    upsertObligation: `
      INSERT INTO obligations (
        obligation_id, kind, owner_id, bot_id, address_json, payload_json,
        status, delivery_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(obligation_id) DO UPDATE SET
        kind = excluded.kind,
        owner_id = excluded.owner_id,
        bot_id = excluded.bot_id,
        address_json = excluded.address_json,
        payload_json = excluded.payload_json,
        status = excluded.status,
        delivery_id = COALESCE(excluded.delivery_id, obligations.delivery_id),
        updated_at = excluded.updated_at
    `,
    updateObligationStatus: 'UPDATE obligations SET status = ?, delivery_id = COALESCE(?, delivery_id), updated_at = ? WHERE obligation_id = ?',
    deleteObligation: 'DELETE FROM obligations WHERE obligation_id = ?',
    listPendingObligations: "SELECT obligation_id, kind, owner_id, bot_id, address_json, payload_json, status, delivery_id, created_at, updated_at FROM obligations WHERE status IN ('pending', 'dispatched') ORDER BY created_at ASC",
    getObligation: 'SELECT obligation_id, kind, owner_id, bot_id, address_json, payload_json, status, delivery_id, created_at, updated_at FROM obligations WHERE obligation_id = ?',

    insertSilentNote: `
      INSERT OR IGNORE INTO silent_notes (scope, target_key, exchange_id, message_json, ledger_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    deleteSilentByScopeTarget: 'DELETE FROM silent_notes WHERE scope = ? AND target_key = ?',
    deleteSilentByScope: 'DELETE FROM silent_notes WHERE scope = ?',
    deleteSilentById: 'DELETE FROM silent_notes WHERE id = ?',
    deleteSilentByExchange: 'DELETE FROM silent_notes WHERE scope = ? AND target_key = ? AND exchange_id = ?',
    listSilentByScope: 'SELECT id, scope, target_key, exchange_id, message_json, ledger_json, created_at FROM silent_notes WHERE scope = ? ORDER BY id ASC',
    listSilentByScopeTarget: 'SELECT id, scope, target_key, exchange_id, message_json, ledger_json, created_at FROM silent_notes WHERE scope = ? AND target_key = ? ORDER BY id ASC',
    countSilentByScopeTarget: 'SELECT COUNT(*) AS count FROM silent_notes WHERE scope = ? AND target_key = ?',

    upsertTerminalMarker: `
      INSERT INTO terminal_markers (kind, owner_id, snapshot_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(kind, owner_id) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `,
    deleteTerminalMarker: 'DELETE FROM terminal_markers WHERE kind = ? AND owner_id = ?',
    listTerminalMarkers: 'SELECT kind, owner_id, snapshot_json, updated_at FROM terminal_markers ORDER BY updated_at ASC',
  }

  function prepareStatements(conn) {
    const cache = Object.create(null)
    return new Proxy(cache, {
      get(target, prop) {
        if (typeof prop !== 'string' || !Object.hasOwn(STATEMENT_SQL, prop)) return undefined
        return (target[prop] ??= conn.prepare(STATEMENT_SQL[prop]))
      },
    })
  }

  function initSchema(conn) {
    conn.exec('PRAGMA busy_timeout = 5000')
    conn.exec('PRAGMA synchronous = NORMAL')
    if (schemaReady) return
    // On Windows we close the handle after each op to avoid EPERM directory locks;
    // rollback DELETE journal avoids per-close WAL checkpoint + SHM unlink overhead on NTFS
    // while keeping every transaction fully atomic and crash-safe. Once set, DELETE is
    // persisted in the database header so subsequent opens skip re-probing journal_mode.
    conn.exec(CLOSE_AFTER_OP ? 'PRAGMA journal_mode = DELETE' : 'PRAGMA journal_mode = WAL')
    const current = conn.prepare('PRAGMA user_version').get()?.user_version ?? 0
    if (current !== SCHEMA_VERSION) {
      conn.exec('BEGIN IMMEDIATE')
      try {
        conn.exec(`
          CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS deliveries (
            exchange_id TEXT PRIMARY KEY,
            session_id TEXT,
            address_json TEXT,
            role TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            room_id TEXT,
            task_id TEXT,
            work_id TEXT,
            args_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            reason TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_deliveries_task ON deliveries (task_id);
          CREATE INDEX IF NOT EXISTS idx_deliveries_work ON deliveries (work_id);
          CREATE TABLE IF NOT EXISTS active_turns (
            session_id TEXT PRIMARY KEY,
            bot_id TEXT NOT NULL,
            room_id TEXT,
            task_id TEXT,
            turn_num INTEGER,
            since INTEGER NOT NULL,
            trigger_json TEXT,
            approval_json TEXT,
            resumed INTEGER NOT NULL DEFAULT 0,
            unverified INTEGER NOT NULL DEFAULT 0,
            record_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS obligations (
            obligation_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            bot_id TEXT NOT NULL,
            address_json TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            delivery_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_obligations_status ON obligations (status);
          CREATE INDEX IF NOT EXISTS idx_obligations_owner ON obligations (kind, owner_id);
          CREATE TABLE IF NOT EXISTS silent_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL,
            target_key TEXT NOT NULL,
            exchange_id TEXT,
            message_json TEXT NOT NULL,
            ledger_json TEXT,
            created_at INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_silent_unique
            ON silent_notes (scope, target_key, exchange_id)
            WHERE exchange_id IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_silent_scope_target
            ON silent_notes (scope, target_key, id);
          CREATE TABLE IF NOT EXISTS terminal_markers (
            kind TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (kind, owner_id)
          );
          PRAGMA user_version = ${SCHEMA_VERSION};
        `)
        conn.exec('COMMIT')
      } catch (error) {
        try { conn.exec('ROLLBACK') } catch { /* ignore */ }
        throw error
      }
    }
    schemaReady = true
  }

  function closeDb() {
    if (db !== null) {
      try { db.close() } catch { /* ignore */ }
      db = null
      stmt = null
      openedReadOnly = false
    }
  }

  function ensureDb({ write = false } = {}) {
    if (disposed) return null
    if (write && !canWrite()) return null
    const dbExists = existsSync(dbPath)
    if (!dbExists) {
      schemaReady = false
      cachedGen = null
      lastSyncedMirrorHash = null
    }
    const hasHotJournal = dbExists && existsSync(`${dbPath}-journal`)
    const allowWriteRecovery = !write && (initialReadFailed || hasHotJournal) && canWrite() && rt.hasLoaded?.() === true
    const readOnlyMode = (!write && !allowWriteRecovery) || !canWrite()
    if (db !== null) {
      if (!readOnlyMode && openedReadOnly) closeDb()
      else return db
    }
    if (readOnlyMode && !dbExists) return null
    if (!readOnlyMode) mkdirSync(home, { recursive: true })
    for (const fresh of [false, true]) {
      try {
        if (fresh) {
          schemaReady = false
          cachedGen = null
          lastSyncedMirrorHash = null
          for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
            try { unlinkSync(file) } catch { /* ignore */ }
          }
        }
        const conn = readOnlyMode
          ? new DatabaseSync(dbPath, { readOnly: true })
          : new DatabaseSync(dbPath)
        try {
          if (readOnlyMode) {
            conn.exec('PRAGMA busy_timeout = 5000')
            const version = conn.prepare('PRAGMA user_version').get()?.user_version ?? 0
            const tableCount = conn.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('meta','deliveries','active_turns','obligations','silent_notes','terminal_markers')").get()?.n ?? 0
            if (version !== SCHEMA_VERSION || tableCount < 6) {
              throw new Error(`incomplete coordination schema (version=${version}, tables=${tableCount})`)
            }
          } else {
            initSchema(conn)
          }
          const statements = prepareStatements(conn)
          // Touch one lightweight statement inside ensureDb so corrupt files, externally
          // truncated 0-byte files, and read-only opens blocked by a hot rollback journal
          // fail here without compiling all 22 statements per op.
          try {
            void statements.getMeta
          } catch (probeError) {
            if (!readOnlyMode && schemaReady && /no such table/i.test(String(probeError?.message ?? probeError))) {
              schemaReady = false
              initSchema(conn)
              void statements.getMeta
            } else {
              throw probeError
            }
          }
          stmt = statements
          db = conn
          openedReadOnly = readOnlyMode
          return db
        } catch (error) {
          try { conn.close() } catch { /* ignore */ }
          throw error
        }
      } catch (error) {
        if (readOnlyMode && !fresh) initialReadFailed = true
        if (fresh || readOnlyMode || !isCorruptSqliteError(error)) {
          rt.warn?.('ds-bot: coordination store unavailable: %s', error)
          return null
        }
      }
    }
    return null
  }

  // Opens an existing coordination DB writable once the host owns `state.lock` so SQLite
  // can roll back any hot rollback journal left by a hard crash. Returns true ONLY when
  // the initial pre-lock read actually failed (never for ordinary live WAL files), so
  // startup only reloads its recovery snapshot when pre-lock state could not be read.
  function recoverAfterLock() {
    if (!canWrite() || !existsSync(dbPath)) return false
    const hadFailure = initialReadFailed
    const hasHotJournal = existsSync(`${dbPath}-journal`)
    if (!hadFailure && !hasHotJournal) return false
    const conn = ensureDb({ write: true })
    if (conn === null) return false
    try {
      stmt?.getMeta?.get('coord_gen')
      initialReadFailed = false
      cachedGen = null
      lastSyncedMirrorHash = null
      return hadFailure
    } finally {
      if (CLOSE_AFTER_OP) closeDb()
    }
  }

  function withRead(fn, fallback) {
    const conn = ensureDb()
    if (conn === null || stmt === null) return fallback
    try {
      return fn(stmt, conn)
    } finally {
      if (CLOSE_AFTER_OP) closeDb()
    }
  }

  function withTx(fn) {
    const conn = ensureDb({ write: true })
    if (conn === null) return undefined
    conn.exec('BEGIN IMMEDIATE')
    try {
      const result = fn(stmt, conn)
      conn.exec('COMMIT')
      return result
    } catch (error) {
      try { conn.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    } finally {
      if (CLOSE_AFTER_OP) closeDb()
    }
  }

  const canCache = () => canWrite() && rt.hasLoaded?.() === true

  function currentGen() {
    if (canCache() && cachedGen !== null) return cachedGen
    const value = withRead((s) => {
      const row = s.getMeta.get('coord_gen')
      const parsed = Number.parseInt(row?.value ?? '0', 10)
      return Number.isFinite(parsed) ? parsed : 0
    }, 0)
    if (canCache() && existsSync(dbPath)) cachedGen = value
    return value
  }

  function bumpGen(s) {
    const row = s.getMeta.get('coord_gen')
    const next = (Number.isFinite(Number.parseInt(row?.value ?? '0', 10)) ? Number.parseInt(row?.value ?? '0', 10) : 0) + 1
    s.setMeta.run('coord_gen', String(next))
    if (canCache()) cachedGen = next
    return next
  }

  function writeDeliveryRow(s, sessionId, args, at = Date.now(), status = 'queued', reason = null) {
    if (!args || typeof args.exchangeId !== 'string' || args.exchangeId === '') return
    const now = Date.now()
    const workId = args.role === 'request' ? args.exchangeId : (args.askWork ?? args.work ?? null)
    s.upsertDelivery.run(
      args.exchangeId,
      sessionId ?? args.sessionId ?? null,
      args.address ? JSON.stringify(args.address) : null,
      String(args.role ?? 'unknown'),
      String(args.toId ?? ''),
      args.roomId ?? null,
      args.taskId ?? null,
      workId,
      JSON.stringify(args),
      status,
      reason,
      Number.isFinite(at) ? at : now,
      now,
    )
  }

  function writeTurnRow(s, sessionId, record) {
    if (typeof sessionId !== 'string' || sessionId === '' || !record || typeof record !== 'object') return
    const now = Date.now()
    s.upsertTurn.run(
      sessionId,
      String(record.botId ?? ''),
      record.roomId ?? null,
      record.taskId ?? null,
      typeof record.turn === 'number' ? record.turn : null,
      Number.isFinite(record.since) ? record.since : now,
      record.trigger !== undefined ? JSON.stringify(record.trigger) : null,
      record.approval !== undefined ? JSON.stringify(record.approval) : null,
      record.resumed === true ? 1 : 0,
      record.unverified === true ? 1 : 0,
      JSON.stringify(record),
      now,
    )
  }

  // Imports a legacy `inflight.json` (from v0.3.10 upgrades or test fixtures) into
  // `coordination.sqlite` when it has no `_coordGen` or a strictly newer generation.
  // A stale mirror written by an earlier generation of this store never resurrects cleared rows.
  // During initial install (before `rt.load()` acquires `state.lock`), `allowWrite` is false
  // so a read-only host never creates or mutates `coordination.sqlite`.
  function importLegacyInflightIfNeeded({ allowWrite = false } = {}) {
    const canCommit = allowWrite && canWrite()
    if (!existsSync(legacyInflightPath)) {
      lastSyncedMirrorHash = null
      // If a previous mirror existed and was externally removed (e.g. reset/test fixture),
      // clear only mirrored inflight tables while preserving committed SQLite obligations.
      const hadMirror = withRead(s => Boolean(s.getMeta.get('legacy_inflight_hash')?.value), false)
      if (hadMirror) {
        if (canCommit) {
          withTx((s) => {
            s.clearTurns.run()
            s.clearDeliveries.run()
            s.deleteSilentByScope.run('session')
            s.setMeta.run('legacy_inflight_hash', '')
            bumpGen(s)
          })
          return { imported: false }
        }
        return { imported: true, fallback: { turns: {}, queued: {}, silent: {} } }
      }
      return { imported: false }
    }
    let raw
    try { raw = readFileSync(legacyInflightPath, 'utf8') } catch { return { imported: false } }
    const fileHash = sha256(raw)
    if (canCache() && lastSyncedMirrorHash !== null && fileHash === lastSyncedMirrorHash) {
      return { imported: false }
    }
    const parsed = parseJson(raw)
    if (!parsed || typeof parsed !== 'object') return { imported: false }
    const obj = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
    const metaCheck = withRead((s) => {
      const lastImportedHash = s.getMeta.get('legacy_inflight_hash')?.value
      const genRow = s.getMeta.get('coord_gen')?.value
      const gen = Number.isFinite(Number.parseInt(genRow ?? '0', 10)) ? Number.parseInt(genRow ?? '0', 10) : 0
      return { lastImportedHash, gen }
    }, null)
    if (metaCheck !== null) {
      const fileGen = typeof parsed._coordGen === 'number' ? parsed._coordGen : undefined
      if (fileHash === metaCheck.lastImportedHash) {
        if (canCache()) lastSyncedMirrorHash = fileHash
        return { imported: false }
      }
      if (fileGen !== undefined && fileGen <= metaCheck.gen) {
        if (canCache()) lastSyncedMirrorHash = fileHash
        return { imported: false }
      }
    }
    if (!canCommit) {
      // When coordination.sqlite exists but failed pre-lock read-only open (e.g. hot
      // rollback journal), a `_coordGen`-stamped inflight.json is only a potentially stale
      // compatibility mirror; defer to post-lock recoverAfterLock() + syncLegacyInflight()
      // so old mirror entries never clobber newer SQLite deliveries or resurrect ended turns.
      if (metaCheck === null && initialReadFailed && typeof parsed._coordGen === 'number') {
        return { imported: false }
      }
      return {
        imported: true,
        fallback: { turns: obj(parsed.turns), queued: obj(parsed.queued), silent: obj(parsed.silent) },
      }
    }
    const fileGen = typeof parsed._coordGen === 'number' ? parsed._coordGen : undefined
    const turns = obj(parsed.turns)
    const queued = obj(parsed.queued)
    const silent = obj(parsed.silent)
    const committed = withTx((s) => {
      // A fresh legacy snapshot (no `_coordGen`) represents the full pre-SQLite inflight state.
      if (fileGen === undefined) {
        s.clearTurns.run()
        s.clearDeliveries.run()
        s.deleteSilentByScope.run('session')
      }
      for (const [sid, record] of Object.entries(turns)) {
        writeTurnRow(s, sid, record)
      }
      for (const [sid, list] of Object.entries(queued)) {
        if (!Array.isArray(list)) continue
        for (const item of list) {
          if (item?.args?.exchangeId) writeDeliveryRow(s, sid, item.args, item.at)
        }
      }
      for (const [sid, entries] of Object.entries(silent)) {
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          if (!entry?.message) continue
          const exchangeId = entry.message?.source?.exchangeId ?? null
          s.insertSilentNote.run('session', sid, exchangeId, JSON.stringify(entry.message), entry.ledger ? JSON.stringify(entry.ledger) : null, Date.now())
        }
      }
      s.setMeta.run('legacy_inflight_hash', fileHash)
      bumpGen(s)
      return true
    })
    if (committed === true && canCache()) lastSyncedMirrorHash = fileHash
    return { imported: committed === true }
  }

  function loadInitialState() {
    const legacy = importLegacyInflightIfNeeded({ allowWrite: false })
    if (legacy.fallback !== undefined) {
      return { ...legacy.fallback, obligations: listPendingObligations(), terminalMarkers: listTerminalMarkers() }
    }
    return withRead((s) => {
      const turns = {}
      for (const row of s.listTurns.all()) {
        const record = parseJson(row.record_json)
        if (record && typeof record === 'object') turns[row.session_id] = record
      }
      const queued = {}
      for (const row of s.listDeliveries.all()) {
        if (row.status === 'cancelled' || row.status === 'consumed') continue
        const args = parseJson(row.args_json)
        if (!args || typeof args !== 'object') continue
        const key = row.session_id || args.sessionId || args.toId
        if (!key) continue
        ;(queued[key] ??= []).push({ at: row.created_at, args, status: row.status })
      }
      const silent = {}
      for (const row of s.listSilentByScope.all('session')) {
        const message = parseJson(row.message_json)
        if (!message) continue
        const ledger = parseJson(row.ledger_json)
        ;(silent[row.target_key] ??= []).push({ message, ...(ledger !== undefined ? { ledger } : {}) })
      }
      const obligations = s.listPendingObligations.all().map(row => ({
        id: row.obligation_id,
        kind: row.kind,
        ownerId: row.owner_id,
        botId: row.bot_id,
        address: parseJson(row.address_json, { foreground: true }),
        payload: parseJson(row.payload_json, {}),
        status: row.status,
        deliveryId: row.delivery_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
      const terminalMarkers = s.listTerminalMarkers.all().map(row => ({
        kind: row.kind,
        ownerId: row.owner_id,
        snapshot: parseJson(row.snapshot_json, {}),
        updatedAt: row.updated_at,
      }))
      return { turns, queued, silent, obligations, terminalMarkers }
    }, { turns: {}, queued: {}, silent: {}, obligations: [], terminalMarkers: [] })
  }

  function upsertDelivery(sessionId, args, at = Date.now()) {
    if (!canWrite() || !args?.exchangeId) return 0
    return withTx((s) => {
      writeDeliveryRow(s, sessionId, args, at)
      return bumpGen(s)
    }) ?? 0
  }

  function replaceAllDeliveries(queuedBySession) {
    if (!canWrite()) return 0
    return withTx((s) => {
      s.clearDeliveries.run()
      for (const [sid, list] of Object.entries(queuedBySession ?? {})) {
        if (!Array.isArray(list)) continue
        for (const item of list) {
          if (item?.args?.exchangeId) writeDeliveryRow(s, sid, item.args, item.at)
        }
      }
      return bumpGen(s)
    }) ?? 0
  }

  function removeDelivery(exchangeId) {
    if (!canWrite() || typeof exchangeId !== 'string' || exchangeId === '') return 0
    return withTx((s) => {
      s.deleteDelivery.run(exchangeId)
      return bumpGen(s)
    }) ?? 0
  }

  function removeWorkDeliveries(workId) {
    if (!canWrite() || typeof workId !== 'string' || workId === '') return 0
    return withTx((s) => {
      s.deleteDeliveriesByWork.run(workId, workId)
      return bumpGen(s)
    }) ?? 0
  }

  function removeTaskStartDeliveries(taskId) {
    if (!canWrite() || typeof taskId !== 'string' || taskId === '') return 0
    return withTx((s) => {
      s.deleteDeliveriesByTaskStart.run(taskId)
      return bumpGen(s)
    }) ?? 0
  }

  function upsertTurn(sessionId, record) {
    if (!canWrite() || typeof sessionId !== 'string' || sessionId === '') return 0
    return withTx((s) => {
      if (record === undefined) s.deleteTurn.run(sessionId)
      else writeTurnRow(s, sessionId, record)
      return bumpGen(s)
    }) ?? 0
  }

  function replaceAllTurns(turnsMap) {
    if (!canWrite()) return 0
    return withTx((s) => {
      s.clearTurns.run()
      for (const [sid, record] of Object.entries(turnsMap ?? {})) {
        writeTurnRow(s, sid, record)
      }
      return bumpGen(s)
    }) ?? 0
  }

  function replaceSessionSilent(sessionId, entries) {
    if (!canWrite() || typeof sessionId !== 'string' || sessionId === '') return 0
    return withTx((s) => {
      s.deleteSilentByScopeTarget.run('session', sessionId)
      if (Array.isArray(entries)) {
        const now = Date.now()
        for (const entry of entries) {
          if (!entry?.message) continue
          const exchangeId = entry.message?.source?.exchangeId ?? null
          s.insertSilentNote.run('session', sessionId, exchangeId, JSON.stringify(entry.message), entry.ledger ? JSON.stringify(entry.ledger) : null, now)
        }
      }
      return bumpGen(s)
    }) ?? 0
  }

  // Atomically commits a background task's terminal coordination changes:
  // 1) cancels any unsent opening `role: 'task'` delivery so a failed start can never
  //    replay into the Bot's foreground chat after restart;
  // 2) records the owed `task_report` obligation in the same transaction
  //    so a crash between saving `state.json` and calling `deliver()` never drops the report;
  // 3) records a durable terminal task snapshot until `state.json` persists the settled status
  //    so a crash between SQLite commit and `state.json` save never lets startup re-mark the task interrupted.
  function commitTaskTerminal({ taskId, obligation, terminalSnapshot } = {}) {
    if (!canWrite()) return false
    return withTx((s) => {
      const now = Date.now()
      if (typeof taskId === 'string' && taskId !== '') {
        s.deleteDeliveriesByTaskStart.run(taskId)
        if (terminalSnapshot && typeof terminalSnapshot === 'object') {
          s.upsertTerminalMarker.run('task', taskId, JSON.stringify(terminalSnapshot), now)
        }
      }
      if (obligation && typeof obligation.id === 'string' && obligation.id !== '') {
        s.upsertObligation.run(
          obligation.id,
          String(obligation.kind ?? 'task_report'),
          String(obligation.ownerId ?? taskId ?? obligation.id),
          String(obligation.botId ?? ''),
          JSON.stringify(obligation.address ?? { foreground: true }),
          JSON.stringify(obligation.payload ?? {}),
          'pending',
          obligation.deliveryId ?? null,
          now,
          now,
        )
      }
      bumpGen(s)
      return true
    }) === true
  }

  function commitObligation({ id, kind, ownerId, botId, address, payload, deliveryId = null, terminalMarker }) {
    if (!canWrite() || typeof id !== 'string' || id === '') return false
    return withTx((s) => {
      const now = Date.now()
      s.upsertObligation.run(
        id,
        String(kind),
        String(ownerId ?? id),
        String(botId ?? ''),
        JSON.stringify(address ?? { foreground: true }),
        JSON.stringify(payload ?? {}),
        'pending',
        deliveryId,
        now,
        now,
      )
      if (terminalMarker?.kind && terminalMarker?.ownerId) {
        s.upsertTerminalMarker.run(
          String(terminalMarker.kind),
          String(terminalMarker.ownerId),
          JSON.stringify(terminalMarker.snapshot ?? {}),
          now,
        )
      }
      bumpGen(s)
      return true
    }) === true
  }

  function listTerminalMarkers() {
    return withRead(s => s.listTerminalMarkers.all().map(row => ({
      kind: row.kind,
      ownerId: row.owner_id,
      snapshot: parseJson(row.snapshot_json, {}),
      updatedAt: row.updated_at,
    })), [])
  }

  function clearTerminalMarker(kind, ownerId) {
    if (!canWrite() || typeof kind !== 'string' || kind === '' || typeof ownerId !== 'string' || ownerId === '') return false
    return withTx((s) => {
      s.deleteTerminalMarker.run(kind, ownerId)
      bumpGen(s)
      return true
    }) === true
  }

  function markObligation(id, status, deliveryId = null) {
    if (!canWrite() || typeof id !== 'string' || id === '') return false
    return withTx((s) => {
      if (status === 'settled' || status === 'cancelled') {
        s.deleteObligation.run(id)
      } else {
        s.updateObligationStatus.run(status, deliveryId, Date.now(), id)
      }
      bumpGen(s)
      return true
    }) === true
  }

  function hasPendingObligation(id) {
    if (typeof id !== 'string' || id === '') return false
    return withRead((s) => {
      const row = s.getObligation.get(id)
      return row !== undefined && (row.status === 'pending' || row.status === 'dispatched')
    }, false)
  }

  function listPendingObligations() {
    return withRead(s => s.listPendingObligations.all().map(row => ({
      id: row.obligation_id,
      kind: row.kind,
      ownerId: row.owner_id,
      botId: row.bot_id,
      address: parseJson(row.address_json, { foreground: true }),
      payload: parseJson(row.payload_json, {}),
      status: row.status,
      deliveryId: row.delivery_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })), [])
  }

  // Durable work-scoped mid-step notes (`scope = 'work'`).
  function addWorkNote(workKey, entry) {
    if (!canWrite() || typeof workKey !== 'string' || workKey === '' || !entry?.message) return false
    const exchangeId = entry.message?.source?.exchangeId ?? null
    return withTx((s) => {
      s.insertSilentNote.run(
        'work',
        workKey,
        exchangeId,
        JSON.stringify(entry.message),
        entry.ledger ? JSON.stringify(entry.ledger) : null,
        Date.now(),
      )
      bumpGen(s)
      return true
    }) === true
  }

  function listWorkNotes(workKey) {
    if (typeof workKey !== 'string' || workKey === '') return []
    return withRead(s => s.listSilentByScopeTarget.all('work', workKey).map((row) => {
      const message = parseJson(row.message_json)
      const ledger = parseJson(row.ledger_json)
      return {
        id: row.id,
        exchangeId: row.exchange_id ?? message?.source?.exchangeId,
        message,
        ...(ledger !== undefined ? { ledger } : {}),
      }
    }).filter(item => item.message !== undefined), [])
  }

  function removeWorkNote(workKey, exchangeId) {
    if (!canWrite() || typeof workKey !== 'string' || workKey === '' || typeof exchangeId !== 'string' || exchangeId === '') return false
    return withTx((s) => {
      s.deleteSilentByExchange.run('work', workKey, exchangeId)
      bumpGen(s)
      return true
    }) === true
  }

  function clearWorkNotes(workKey) {
    if (!canWrite() || typeof workKey !== 'string' || workKey === '') return false
    return withTx((s) => {
      s.deleteSilentByScopeTarget.run('work', workKey)
      bumpGen(s)
      return true
    }) === true
  }

  function countWorkNotes(workKey) {
    if (typeof workKey !== 'string' || workKey === '') return 0
    return withRead(s => Number(s.countSilentByScopeTarget.get('work', workKey)?.count ?? 0), 0)
  }

  function noteMirrorWritten(jsonText) {
    if (!canWrite() || typeof jsonText !== 'string') return
    const hash = sha256(jsonText)
    if (canCache() && lastSyncedMirrorHash === hash) return
    try {
      const committed = withTx((s) => {
        s.setMeta.run('legacy_inflight_hash', hash)
        return true
      })
      if (committed === true && canCache()) lastSyncedMirrorHash = hash
    } catch { /* best effort */ }
  }

  // Shared durable session evidence reader.
  // Works on real DSH 0.2.2-rc.5 (`sessionQuery.inspectSession` / `readSession`,
  // `sessionController.page`), live loaded sessions, and unit-test `sessionController.inspect`,
  // distinguishing missing sessions from I/O failures so recovery fails closed on errors.
  async function readSessionEvidence(sessionId, signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)) {
    if (typeof sessionId !== 'string' || sessionId === '') return { status: 'not_found', events: [] }
    const agentsSvc = ctx.get?.('agents') ?? ctx.agents
    const sessionsSvc = ctx.get?.('sessions') ?? ctx.sessions
    const liveSession = (typeof agentsSvc?.get === 'function' ? agentsSvc.get(sessionId)?.session : undefined)
      ?? (typeof sessionsSvc?.get === 'function' ? sessionsSvc.get(sessionId) : undefined)
    const liveEvents = typeof liveSession?.snapshotEvents === 'function' ? liveSession.snapshotEvents() : undefined

    const preferLiveIfNewer = (result) => {
      if (Array.isArray(liveEvents) && liveEvents.length > 0) {
        if (result.status === 'not_found') return { status: 'ok', events: liveEvents }
        if (result.status === 'ok' && liveEvents.length > result.events.length) {
          return { status: 'ok', events: liveEvents }
        }
      }
      return result
    }

    const query = ctx.get?.('sessionQuery') ?? ctx.sessionQuery
    if (typeof query?.inspectSession === 'function') {
      try {
        const events = await query.inspectSession(sessionId, session => session?.snapshotEvents?.() ?? [], signal)
        return preferLiveIfNewer({ status: 'ok', events: Array.isArray(events) ? events : [] })
      } catch (error) {
        if (isMissingSessionError(error)) return preferLiveIfNewer({ status: 'not_found', events: [] })
        return { status: 'error', error }
      }
    }
    if (typeof query?.readSession === 'function') {
      try {
        const seen = await query.readSession(sessionId)
        return preferLiveIfNewer({ status: 'ok', events: Array.isArray(seen?.events) ? seen.events : [] })
      } catch (error) {
        if (isMissingSessionError(error)) return preferLiveIfNewer({ status: 'not_found', events: [] })
        return { status: 'error', error }
      }
    }
    const controller = ctx.sessionController
    if (typeof controller?.inspect === 'function') {
      try {
        // Call inspect as a method of the controller so `this` stays bound (#2037).
        const seen = await controller.inspect(sessionId, signal)
        return preferLiveIfNewer({ status: 'ok', events: Array.isArray(seen?.events) ? seen.events : [] })
      } catch (error) {
        if (isMissingSessionError(error)) return preferLiveIfNewer({ status: 'not_found', events: [] })
        return { status: 'error', error }
      }
    }
    if (typeof ctx.sessionController?.page === 'function' && typeof rt.eventsBackwards === 'function') {
      try {
        const collected = []
        const read = {}
        for await (const event of rt.eventsBackwards(sessionId, signal, 50, read)) {
          collected.push(event)
        }
        collected.reverse()
        if (collected.length === 0 && read.complete) return preferLiveIfNewer({ status: 'not_found', events: [] })
        return preferLiveIfNewer({ status: 'ok', events: collected })
      } catch (error) {
        if (isMissingSessionError(error)) return preferLiveIfNewer({ status: 'not_found', events: [] })
        return { status: 'error', error }
      }
    }
    if (Array.isArray(liveEvents)) {
      return { status: 'ok', events: liveEvents }
    }
    return { status: 'unavailable' }
  }

  ctx.effect(() => () => {
    const flush = rt.flushInflight?.()
    if (flush && typeof flush.then === 'function') {
      return Promise.resolve(flush).catch(() => {}).finally(() => {
        disposed = true
        closeDb()
      })
    }
    disposed = true
    closeDb()
  }, 'ds-bot: coordination store')

  const coordination = {
    dbPath,
    currentGen,
    loadInitialState,
    hadInitialReadFailure: () => initialReadFailed,
    recoverAfterLock,
    syncLegacyInflight: () => importLegacyInflightIfNeeded({ allowWrite: true }),
    upsertDelivery,
    replaceAllDeliveries,
    removeDelivery,
    removeWorkDeliveries,
    removeTaskStartDeliveries,
    upsertTurn,
    replaceAllTurns,
    replaceSessionSilent,
    commitTaskTerminal,
    commitObligation,
    markObligation,
    hasPendingObligation,
    listPendingObligations,
    listTerminalMarkers,
    clearTerminalMarker,
    addWorkNote,
    listWorkNotes,
    removeWorkNote,
    clearWorkNotes,
    countWorkNotes,
    noteMirrorWritten,
    close: closeDb,
  }

  Object.assign(rt, {
    coordination,
    readSessionEvidence,
    readColdSessionEvents: readSessionEvidence,
  })
}

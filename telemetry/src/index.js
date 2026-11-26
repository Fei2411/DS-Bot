// DS Bot anonymous telemetry collector (Cloudflare Worker + D1).
// Privacy guarantees:
// - Never reads or stores CF-Connecting-IP, X-Forwarded-For, User-Agent, Referer, or Cookies.
// - Enforces strict allowlist validation (no unknown fields, no free-text messages, no file paths).
// - One-way ingest only: returns 204 No Content and never pushes remote config or scripts.

import { MAX_BODY_BYTES, validatePayload } from './validate.js'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const RATE_WINDOW_MS = 60_000
const MAX_WRITES_PER_WINDOW = 600
let windowStart = 0
let windowWrites = 0

function allowWrite(nowMs) {
  if (nowMs - windowStart >= RATE_WINDOW_MS) {
    windowStart = nowMs
    windowWrites = 0
  }
  if (windowWrites >= MAX_WRITES_PER_WINDOW) return false
  windowWrites += 1
  return true
}

async function readBoundedText(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function storeDaily(db, data, nowIso) {
  await db.prepare(
    `INSERT INTO daily_pings (
      day, anon_id, app_version, dsh_version, surface, os, arch, locale, is_first_day,
      bot_count_bucket, group_count_bucket, turns_bucket, connectors_count_bucket,
      theme, layout, providers_json, local_agents_json, features_json, im_platforms_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, anon_id) DO UPDATE SET
      app_version = excluded.app_version,
      dsh_version = excluded.dsh_version,
      surface = excluded.surface,
      os = excluded.os,
      arch = excluded.arch,
      locale = excluded.locale,
      is_first_day = excluded.is_first_day,
      bot_count_bucket = excluded.bot_count_bucket,
      group_count_bucket = excluded.group_count_bucket,
      turns_bucket = excluded.turns_bucket,
      connectors_count_bucket = excluded.connectors_count_bucket,
      theme = excluded.theme,
      layout = excluded.layout,
      providers_json = excluded.providers_json,
      local_agents_json = excluded.local_agents_json,
      features_json = excluded.features_json,
      im_platforms_json = excluded.im_platforms_json,
      updated_at = excluded.updated_at`,
  ).bind(
    data.day, data.anon_id, data.app_version, data.dsh_version, data.surface,
    data.os, data.arch, data.locale, data.is_first_day ? 1 : 0,
    data.bot_count_bucket, data.group_count_bucket, data.turns_bucket, data.connectors_count_bucket,
    data.theme, data.layout,
    JSON.stringify(data.providers_used), JSON.stringify(data.local_agents_used),
    JSON.stringify(data.features_active), JSON.stringify(data.im_platforms),
    nowIso,
  ).run()
}

async function storeError(db, data, nowIso) {
  await db.prepare(
    `INSERT INTO error_reports (
      day, fingerprint, anon_id, app_version, dsh_version, surface, os, arch,
      source, error_name, error_code, where_mod, stack_json, occurrences, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, fingerprint, anon_id) DO UPDATE SET
      occurrences = MAX(error_reports.occurrences, excluded.occurrences),
      app_version = excluded.app_version,
      dsh_version = excluded.dsh_version,
      updated_at = excluded.updated_at`,
  ).bind(
    data.day, data.fingerprint, data.anon_id, data.app_version, data.dsh_version,
    data.surface, data.os, data.arch, data.source, data.error_name,
    data.error_code, data.where, JSON.stringify(data.stack_frames), data.count, nowIso,
  ).run()
}

export async function handleRequest(request, env, nowMs = Date.now()) {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/healthz') {
    return new Response('ok\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
  }

  if (url.pathname !== '/v1/collect') {
    return new Response(null, { status: 404 })
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  // DS Bot sends telemetry from its Node host process (never browser cross-origin requests).
  if (request.headers.get('origin')) {
    return new Response(JSON.stringify({ error: 'browser origin not allowed' }), { status: 403, headers: JSON_HEADERS })
  }

  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return new Response(JSON.stringify({ error: 'content-type must be application/json' }), { status: 415, headers: JSON_HEADERS })
  }

  const rawText = await readBoundedText(request, MAX_BODY_BYTES)
  if (rawText === null) {
    return new Response(JSON.stringify({ error: 'payload too large' }), { status: 413, headers: JSON_HEADERS })
  }

  let parsed
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400, headers: JSON_HEADERS })
  }

  const result = validatePayload(parsed, nowMs)
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error }), { status: 400, headers: JSON_HEADERS })
  }

  if (!env?.DB) {
    return new Response(JSON.stringify({ error: 'storage unavailable' }), { status: 503, headers: JSON_HEADERS })
  }

  if (!allowWrite(nowMs)) {
    return new Response(JSON.stringify({ error: 'rate limit exceeded' }), { status: 429, headers: JSON_HEADERS })
  }

  const nowIso = new Date(nowMs).toISOString()
  if (result.value.type === 'daily') await storeDaily(env.DB, result.value, nowIso)
  else await storeError(env.DB, result.value, nowIso)

  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env)
  },
}

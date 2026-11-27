// Tool cards for Subagents (`subagent`, `subagent_fork`, `list_agents`, `wait_agent`,
// `send_message`, `interrupt_agent`, `spawn_teammate`) and Background Jobs (`job_list`,
// `job_output`, `job_kill`, plus backgrounded/promoted `bash` / `pwsh` shells).
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { CheckIcon, CopyIcon, PeopleIcon, StopIcon, TerminalIcon } from '../../../ds-bot/src/client/icons.js'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'
import { writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { elapsedLabel } from '../../../ds-bot/src/client/text.js'
import { CodeSection, clipLongText, formatArgs, formatResult, formatToolDuration } from './tool-card.js'
import { ToolCardShell, compact, errorLineOf, readArgText } from './tool-view-shared.js'

export const SUBAGENT_TOOL_NAMES = [
  'subagent',
  'subagent_fork',
  'list_agents',
  'wait_agent',
  'send_message',
  'interrupt_agent',
  'spawn_teammate',
]

export const JOB_TOOL_NAMES = ['job_list', 'job_output', 'job_kill']

const SUBAGENT_LABELS = {
  subagent: 'Subagent',
  subagent_fork: 'Fork subagent',
  list_agents: 'List agents',
  wait_agent: 'Wait for agent',
  send_message: 'Send to agent',
  interrupt_agent: 'Interrupt agent',
  spawn_teammate: 'Teammate',
}

const JOB_LABELS = {
  job_list: 'Background jobs',
  job_output: 'Job output',
  job_kill: 'Stop job',
}

const JOB_STATUS_LABELS = {
  running: 'Running',
  stopping: 'Stopping',
  completed: 'Completed',
  failed: 'Failed',
  killed: 'Stopped',
}

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'killed'])
const ARM_DISARM_MS = 3000
const JOB_POLL_MS = 1500

// ---------------------------------------------------------------------------
// Subagent catalog resolution & parsers

/**
 * Extracts a deduplicated catalog of child subagent sessions from a SessionLog's
 * snapshot projection (`log.projections.values.subagentCatalog`) and live `subagent/catalog` events.
 */
export function resolveSubagentCatalog(log) {
  const byId = new Map()
  const add = (raw) => {
    if (!raw || typeof raw !== 'object') return
    const childSessionId = typeof raw.id === 'string' && raw.id !== '' ? raw.id
      : (typeof raw.childId === 'string' && raw.childId !== '' ? raw.childId
        : (typeof raw.childSessionId === 'string' && raw.childSessionId !== '' ? raw.childSessionId
          : (typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : '')))
    if (!childSessionId) return
    const prev = byId.get(childSessionId) ?? {}
    const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt
      : (Number.isFinite(raw.childCreatedAt) ? raw.childCreatedAt : prev.createdAt)
    byId.set(childSessionId, {
      childSessionId,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : (prev.name ?? ''),
      mode: typeof raw.mode === 'string' && raw.mode !== '' ? raw.mode : (prev.mode ?? 'unknown'),
      label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : (prev.label ?? ''),
      createdAt,
    })
  }
  const proj = log?.projections?.values?.subagentCatalog
  if (Array.isArray(proj)) {
    for (const item of proj) add(item)
  } else if (proj && typeof proj === 'object') {
    for (const item of Object.values(proj)) add(item)
  }
  for (const event of Array.isArray(log?.events) ? log.events : []) {
    if (event?.type === 'subagent/catalog') add(event.data)
  }
  return [...byId.values()]
}

function subagentModeLabel(mode) {
  if (mode === 'continuable') return t('Continuable')
  if (mode === 'one-shot' || mode === 'one_shot') return t('One-shot')
  if (mode === 'external') return t('External')
  return mode
}

export function findSubagentInCatalog(catalog, { childId, name }) {
  if (!Array.isArray(catalog) || catalog.length === 0) return null
  if (childId) {
    const exact = catalog.find(item => item.childSessionId === childId)
    if (exact) return exact
  }
  if (name) {
    for (let i = catalog.length - 1; i >= 0; i -= 1) {
      if (catalog[i].name === name) return catalog[i]
    }
  }
  return null
}

export function parseSubagentRef(toolName, block, rawResult) {
  const meta = block?.meta && typeof block.meta === 'object' ? block.meta : null
  let childId = ''
  let name = ''
  let mode = ''

  if (typeof meta?.subagentId === 'string' && meta.subagentId !== '') childId = meta.subagentId
  if (typeof meta?.childId === 'string' && meta.childId !== '') childId = meta.childId
  if (typeof meta?.sessionId === 'string' && meta.sessionId !== '') childId = meta.sessionId
  if (typeof meta?.name === 'string' && meta.name !== '') name = meta.name
  if (typeof meta?.mode === 'string' && meta.mode !== '') mode = meta.mode

  if (!name) name = readArgText(block, 'name', 'to', 'target', 'agent')
  if (!childId) childId = readArgText(block, 'subagent_id', 'session_id', 'child_id')

  const text = typeof rawResult === 'string' ? rawResult : ''
  if (!childId && text !== '') {
    const started = /\bstarted subagent\s+([\w-]+)/i.exec(text)
      ?? /\b(?:subagent|session|child)[_\s-]?id[:=]\s*([\w-]+)/i.exec(text)
    if (started?.[1]) childId = started[1]
  }
  if (!name && text !== '') {
    const named = /\bname[:=]\s*([\w.-]+)/i.exec(text)
    if (named?.[1]) name = named[1]
  }

  return { childId, name, mode }
}

function parseListedAgents(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('(')) continue
    const match = /^([\w.-]+)\s*(?:\[([^\]]+)\])?\s*(?:[:—-]\s*(.*))?$/.exec(trimmed)
    if (match) rows.push({ idOrName: match[1], status: match[2] ?? '', detail: match[3] ?? '' })
  }
  return rows
}

/**
 * Tool card for subagent tools with "Open session" navigation into the child Session.
 */
export function SubagentToolView({
  toolName,
  block,
  phase,
  useDisclosure,
  sessionId,
  subagentCatalog,
  onOpenSubagent,
}) {
  const disclosure = useDisclosure()
  const isError = phase === 'result' && block?.isError === true
  const rawResult = useMemo(() => (phase === 'result' ? formatResult(block) : ''), [phase, block])
  const errLine = errorLineOf(block, isError)
  const ref = useMemo(() => parseSubagentRef(toolName, block, rawResult), [toolName, block, rawResult])
  const catalogMatch = useMemo(
    () => findSubagentInCatalog(subagentCatalog, ref),
    [subagentCatalog, ref],
  )
  const promptArg = readArgText(block, 'prompt', 'task', 'message', 'instructions')
  const descriptionArg = readArgText(block, 'description', 'label')
  const argsText = useMemo(() => (promptArg ? '' : formatArgs(block)), [promptArg, block])
  const listed = useMemo(
    () => (toolName === 'list_agents' && phase === 'result' ? parseListedAgents(rawResult) : []),
    [toolName, phase, rawResult],
  )

  const targetSessionId = catalogMatch?.childSessionId || ref.childId
  const targetName = catalogMatch?.name || ref.name
  const targetMode = catalogMatch?.mode || ref.mode || 'unknown'
  const summary = compact(descriptionArg || catalogMatch?.label || targetName || promptArg || targetSessionId)

  const openChild = (child) => {
    if (typeof onOpenSubagent !== 'function' || !sessionId || !child?.childSessionId) return
    onOpenSubagent({
      sessionId: child.childSessionId,
      parentSessionId: sessionId,
      mode: child.mode || 'unknown',
      label: child.label || child.name || child.childSessionId,
      name: child.name || '',
    })
  }

  const badges = []
  if (targetName && targetName !== summary) {
    badges.push(h('span', { key: 'name', className: 'dsb-tool-pill' }, targetName))
  }
  if (targetMode && targetMode !== 'unknown') {
    badges.push(h('span', { key: 'mode', className: 'dsb-tool-pill' }, subagentModeLabel(targetMode)))
  }

  const canOpen = Boolean(targetSessionId && sessionId && targetMode !== 'external' && typeof onOpenSubagent === 'function')
  const headerAction = canOpen
    ? h('button', {
      type: 'button',
      className: 'dsb-tool-action',
      onClick: () => openChild({
        childSessionId: targetSessionId,
        mode: targetMode,
        label: descriptionArg || catalogMatch?.label || targetName || targetSessionId,
        name: targetName,
      }),
    }, t('Open session'))
    : null

  const hasBody = promptArg !== '' || argsText !== '' || rawResult !== '' || errLine !== '' || listed.length > 0 || canOpen

  return h(ToolCardShell, {
    icon: PeopleIcon,
    label: t(SUBAGENT_LABELS[toolName] ?? 'Subagent'),
    summary,
    summaryTitle: descriptionArg || promptArg || targetSessionId || undefined,
    badges,
    headerAction,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  listed.length > 0 ? h('div', { className: 'dsb-subagent-list' },
    listed.map((row, index) => {
      const found = findSubagentInCatalog(subagentCatalog, { childId: row.idOrName, name: row.idOrName })
      return h('div', { key: `${row.idOrName}:${index}`, className: 'dsb-subagent-row' },
        h('span', { className: 'dsb-subagent-name' }, row.idOrName),
        row.status ? h('span', { className: 'dsb-tool-pill' }, row.status) : null,
        row.detail ? h('span', { className: 'dsb-subagent-detail' }, row.detail) : null,
        found && found.mode !== 'external' && typeof onOpenSubagent === 'function' ? h('button', {
          type: 'button',
          className: 'dsb-tool-action',
          onClick: () => openChild(found),
        }, t('Open session')) : null)
    })) : null,
  promptArg !== '' ? h(CodeSection, { label: t('Prompt'), text: promptArg }) : null,
  argsText !== '' ? h(CodeSection, { label: t('Arguments'), text: argsText }) : null,
  rawResult !== '' && listed.length === 0 ? h(CodeSection, { label: isError ? t('Error') : t('Output'), text: rawResult, error: isError }) : null)
}

// ---------------------------------------------------------------------------
// Background job parsers & live controller UI

/**
 * Extracts a DSH background job ID from a `bash` / `pwsh` tool result (either started
 * with `run_in_background: true` or promoted on timeout).
 */
export function parseBackgroundJobIdFromShell(text, meta) {
  if (typeof meta?.jobId === 'string' && meta.jobId !== '') return meta.jobId
  const source = typeof text === 'string' ? text : ''
  const started = /^started background job (\S+)/m.exec(source)
  if (started?.[1]) return started[1]
  const moved = /\[still running after \d+ms; moved to background job ([^\]\s]+)\]/.exec(source)
  if (moved?.[1]) return moved[1]
  return ''
}

export function parseJobListText(text) {
  const source = typeof text === 'string' ? text.trim() : ''
  if (source === '' || /^\(no background jobs\)$/i.test(source)) return []
  const items = []
  for (const line of source.split('\n')) {
    const match = /^(\S+)\s+\[([^\]]+)\]\s+(\S+)\s+[—-]\s+(.*)$/.exec(line.trim())
    if (match) {
      items.push({ id: match[1], kind: match[2], status: match[3], label: match[4] })
    }
  }
  return items
}

export function parseJobOutputText(text) {
  let body = typeof text === 'string' ? text : ''
  let status = ''
  let detail = ''
  let truncated = false
  const statusMatch = /\n?\[status:\s*([^,\]]+?)(?:,\s*([^\]]+))?\]\s*$/.exec(body)
  if (statusMatch) {
    status = statusMatch[1].trim()
    detail = (statusMatch[2] ?? '').trim()
    body = body.slice(0, statusMatch.index)
  }
  const truncMatch = /\n?\[output truncated\]\s*$/.exec(body)
  if (truncMatch) {
    truncated = true
    body = body.slice(0, truncMatch.index)
  }
  return { body, status, detail, truncated }
}

export function parseJobKillText(text) {
  const source = typeof text === 'string' ? text.trim() : ''
  const req = /^requested cancellation of job (\S+)/i.exec(source)
  if (req) return { jobId: req[1], outcome: 'stopping' }
  const done = /^job (\S+) had already finished(?:\s+\[status:\s*([^\]]+)\])?/i.exec(source)
  if (done) return { jobId: done[1], outcome: 'finished', status: done[2] ?? '' }
  return { jobId: '', outcome: '' }
}

export function jobStatusTone(status) {
  if (status === 'completed') return 'ok'
  if (status === 'failed') return 'danger'
  if (status === 'killed' || status === 'stopping') return 'warn'
  return undefined
}

/**
 * Two-press Stop button matching DSH's `JobListAction`: first press arms for 3s,
 * second press sends `job-kill` through `api/bot`.
 */
export function JobStopButton({ sessionId, jobId, disabled = false, onStopped }) {
  const [stage, setStage] = useState('idle') // 'idle' | 'armed' | 'pending'
  const [error, setError] = useState('')
  const timerRef = useRef(0)

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  const disarm = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = 0 }
    setStage(prev => (prev === 'armed' ? 'idle' : prev))
  }, [])

  const onClick = async () => {
    if (disabled || stage === 'pending' || !sessionId || !jobId) return
    setError('')
    if (stage === 'idle') {
      setStage('armed')
      timerRef.current = setTimeout(() => {
        timerRef.current = 0
        setStage(prev => (prev === 'armed' ? 'idle' : prev))
      }, ARM_DISARM_MS)
      return
    }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = 0 }
    setStage('pending')
    try {
      await call('job-kill', { sessionId, jobId })
      onStopped?.()
    } catch (failure) {
      setStage('idle')
      setError(failure?.message ? hostText(String(failure.message)) : t('Could not stop job'))
    }
  }

  return h('span', { className: 'dsb-job-stop-wrap' },
    h('button', {
      type: 'button',
      className: 'dsb-job-stop',
      'data-armed': stage === 'armed' ? '' : undefined,
      disabled: disabled || stage === 'pending',
      onClick: () => { void onClick() },
      onBlur: disarm,
    },
    h(StopIcon),
    h('span', null, stage === 'pending' ? t('Stopping…') : stage === 'armed' ? t('Confirm stop') : t('Stop'))),
    error ? h('span', { className: 'dsb-tool-errline', role: 'alert' }, error) : null)
}

/**
 * Live output, elapsed clock, status, and Stop control for a single DSH background job.
 * Reads via non-consuming `job-read` (`readAt`) and refreshes on `feed` `'jobs'` events.
 */
export function BackgroundJobPanel({ sessionId, jobId, feed, readOnly = false, initialStatus = '', onStatusChange, onUnavailable }) {
  const [job, setJob] = useState(null)
  const [segments, setSegments] = useState([])
  const [lossy, setLossy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [unavailable, setUnavailable] = useState(false)
  const offsetRef = useRef(0)
  const statusRef = useRef(initialStatus)
  const busyRef = useRef(false)
  const dirtyRef = useRef(false)
  const mountedRef = useRef(true)
  const onStatusRef = useRef(onStatusChange)
  onStatusRef.current = onStatusChange
  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const refresh = useCallback(async () => {
    if (!sessionId || !jobId) return
    if (busyRef.current) {
      dirtyRef.current = true
      return
    }
    busyRef.current = true
    try {
      const res = await call('job-read', { sessionId, jobId, from: offsetRef.current })
      if (!mountedRef.current) return
      if (res?.job) {
        setJob(res.job)
        const nextStatus = res.job.status ?? ''
        if (nextStatus && nextStatus !== statusRef.current) onStatusRef.current?.(nextStatus)
        statusRef.current = nextStatus
      }
      const chunks = Array.isArray(res?.chunks) ? res.chunks : null
      const hasChunkGap = chunks !== null && chunks.some(chunk => chunk?.gapBefore === true)
      if (res?.lossy === true || hasChunkGap) setLossy(true)
      const fallbackDelta = typeof res?.text === 'string' ? res.text : (typeof res?.output === 'string' ? res.output : '')
      const hasChunkText = chunks !== null && chunks.some(chunk => typeof chunk?.text === 'string' && chunk.text !== '')
      if (hasChunkGap || hasChunkText || fallbackDelta !== '') {
        setSegments((prev) => {
          const added = []
          if (chunks !== null && (hasChunkGap || hasChunkText)) {
            for (const chunk of chunks) {
              if (chunk?.gapBefore === true) added.push({ gap: true })
              if (typeof chunk?.text === 'string' && chunk.text !== '') added.push({ text: chunk.text })
            }
          } else if (fallbackDelta !== '') {
            added.push({ text: fallbackDelta })
          }
          return added.length > 0 ? [...prev, ...added] : prev
        })
      }
      const nextCursor = Number.isInteger(res?.next) ? res.next : res?.nextOffset
      if (Number.isInteger(nextCursor) && nextCursor >= offsetRef.current) {
        offsetRef.current = nextCursor
      }
      setUnavailable(false)
    } catch (error) {
      if (!mountedRef.current) return
      if (error?.code === 'bot/not-found' || error?.code === 'bot/refused') {
        setUnavailable(true)
        statusRef.current = 'unknown'
        onUnavailableRef.current?.(true)
      }
    } finally {
      busyRef.current = false
      if (dirtyRef.current && mountedRef.current) {
        dirtyRef.current = false
        void refresh()
      }
    }
  }, [sessionId, jobId])

  const status = job?.status || initialStatus || 'running'
  const active = !unavailable && (status === 'running' || status === 'stopping')

  useEffect(() => {
    offsetRef.current = 0
    setSegments([])
    setJob(null)
    setLossy(false)
    setUnavailable(false)
    statusRef.current = initialStatus
    if (!sessionId || !jobId) return undefined
    void refresh()
    return undefined
  }, [sessionId, jobId, initialStatus, refresh])

  useEffect(() => {
    if (!sessionId || !jobId || !active) return undefined
    const timer = setInterval(() => {
      if (TERMINAL_JOB_STATUSES.has(statusRef.current) || statusRef.current === 'unknown') return
      if (typeof document !== 'undefined' && document.hidden) return
      void refresh()
    }, JOB_POLL_MS)
    return () => clearInterval(timer)
  }, [sessionId, jobId, active, refresh])

  useEffect(() => {
    if (!feed || !sessionId || !jobId || !active) return undefined
    return feed.on((event, data) => {
      if (event !== 'jobs') return
      if (data?.sessionId && data.sessionId !== sessionId) return
      if (data?.jobId && data.jobId !== jobId) return
      void refresh()
    })
  }, [feed, sessionId, jobId, active, refresh])

  useEffect(() => {
    if (!active || !Number.isFinite(job?.startedAt)) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, job?.startedAt])

  const endedAt = Number.isFinite(job?.finishedAt) ? job.finishedAt : job?.endedAt
  const elapsed = Number.isFinite(job?.startedAt)
    ? elapsedLabel(Math.max(0, (Number.isFinite(endedAt) ? endedAt : now) - job.startedAt))
    : ''
  // Keep raw retained process text separate from rendered gap markers so Copy exports
  // exact job output without leaking localized UI prose into logs or JSONL streams.
  const rawOutput = useMemo(
    () => segments.map(seg => seg.text ?? '').join(''),
    [segments],
  )
  const displayOutput = useMemo(() => {
    let out = ''
    for (const seg of segments) {
      if (seg.gap) {
        if (out !== '' && !out.endsWith('\n')) out += '\n'
        out += `… ${t('Earlier output was dropped')} …\n`
      } else if (seg.text) {
        out += seg.text
      }
    }
    return out
  }, [segments])
  const clipped = useMemo(() => clipLongText(displayOutput), [displayOutput])
  const shownOutput = expanded || !clipped.folded ? displayOutput : clipped.shown

  const copy = () => {
    if (rawOutput === '') return
    void writeClipboard(rawOutput).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    })
  }

  if (unavailable && !job && displayOutput === '') return null

  return h('div', { className: 'dsb-job-panel', 'data-status': status },
    h('div', { className: 'dsb-job-head' },
      h('span', { className: 'dsb-job-id' }, jobId),
      h('span', { className: 'dsb-tool-pill', 'data-tone': jobStatusTone(status) }, t(JOB_STATUS_LABELS[status] ?? status)),
      lossy ? h('span', { className: 'dsb-tool-pill', 'data-tone': 'warn' }, t('Truncated')) : null,
      elapsed ? h('span', { className: 'dsb-tool-time' }, elapsed) : null,
      status === 'running' && !readOnly
        ? h(JobStopButton, { sessionId, jobId, onStopped: () => { void refresh() } })
        : null),
    job?.detail ? h('div', { className: 'dsb-job-detail' }, job.detail) : null,
    displayOutput !== '' ? h('div', { className: 'dsb-tool-sec' },
      h('div', { className: 'dsb-tool-sec-head' },
        h('span', { className: 'dsb-tool-sec-label' }, active ? t('Live output') : t('Output')),
        rawOutput !== '' ? h('button', {
          type: 'button',
          className: 'bt-mini dsb-tool-copy',
          'aria-label': copied ? t('Copied') : t('Copy'),
          title: copied ? t('Copied') : t('Copy'),
          onClick: copy,
        }, copied ? h(CheckIcon) : h(CopyIcon)) : null),
      h('pre', { className: 'dsb-tool-pre' }, h('code', null, shownOutput)),
      clipped.folded ? h('button', {
        type: 'button',
        className: 'dsb-tool-fold',
        'aria-expanded': expanded,
        onClick: () => setExpanded(v => !v),
      }, expanded ? t('Show less') : t('Show all ({count} lines)', { count: clipped.lines })) : null) : null)
}

const isActiveJob = item => item?.status === 'running' || item?.status === 'stopping'

/**
 * Tool card for `job_list`, `job_output`, and `job_kill`.
 */
export function JobToolView({ toolName, block, phase, useDisclosure, sessionId, feed, readOnly }) {
  const disclosure = useDisclosure(toolName === 'job_list')
  const [liveJobs, setLiveJobs] = useState(null)
  const [listUnavailable, setListUnavailable] = useState(false)
  const [liveOutputStatus, setLiveOutputStatus] = useState('')
  const [liveUnavailable, setLiveUnavailable] = useState(false)
  const isError = phase === 'result' && block?.isError === true
  const rawResult = useMemo(() => (phase === 'result' ? formatResult(block) : ''), [phase, block])
  const errLine = errorLineOf(block, isError)
  const jobId = readArgText(block, 'job_id', 'id')

  const parsedList = useMemo(
    () => (toolName === 'job_list' && phase === 'result' ? parseJobListText(rawResult) : []),
    [toolName, phase, rawResult],
  )
  const parsedOutput = useMemo(
    () => (toolName === 'job_output' && phase === 'result' ? parseJobOutputText(rawResult) : null),
    [toolName, phase, rawResult],
  )
  const parsedKill = useMemo(
    () => (toolName === 'job_kill' && phase === 'result' ? parseJobKillText(rawResult) : null),
    [toolName, phase, rawResult],
  )

  const refreshList = useCallback(async () => {
    if (!sessionId || toolName !== 'job_list') return
    try {
      const res = await call('job-list', { sessionId })
      if (!Array.isArray(res?.jobs)) return
      if (res.jobs.length === 0 && parsedList.length > 0) {
        // Keep the historical snapshot intact once live jobs have been pruned or after restart.
        setListUnavailable(true)
        return
      }
      setLiveJobs(res.jobs)
    } catch (error) {
      if (error?.code === 'bot/not-found' || error?.code === 'bot/refused') setListUnavailable(true)
    }
  }, [sessionId, toolName, parsedList.length])

  const snapshotListActive = toolName === 'job_list' && phase === 'result' && parsedList.some(isActiveJob)
  const watchJobList = snapshotListActive
    && Boolean(sessionId)
    && disclosure.expanded
    && !listUnavailable
    && (liveJobs === null || liveJobs.some(isActiveJob))

  useEffect(() => {
    if (!watchJobList) return undefined
    void refreshList()
    if (!feed) return undefined
    return feed.on((event, data) => {
      if (event === 'jobs' && (!data?.sessionId || data.sessionId === sessionId)) void refreshList()
    })
  }, [watchJobList, sessionId, feed, refreshList])

  const snapshotInProgress = parsedOutput?.status === 'running' || parsedOutput?.status === 'stopping'
  const effectiveOutputStatus = liveOutputStatus || parsedOutput?.status || ''
  const watchCollapsedStatus = toolName === 'job_output'
    && Boolean(sessionId && jobId)
    && !disclosure.expanded
    && snapshotInProgress
    && !liveUnavailable
    && !TERMINAL_JOB_STATUSES.has(effectiveOutputStatus)

  // Keep collapsed `job_output` status badge synchronized via lightweight `job-list`
  // (never `job-read` from 0) and stop watching once terminal or pruned.
  useEffect(() => {
    if (!watchCollapsedStatus) return undefined
    let alive = true
    const syncStatus = async () => {
      try {
        const res = await call('job-list', { sessionId })
        if (!alive || !Array.isArray(res?.jobs)) return
        const match = res.jobs.find(item => item?.id === jobId)
        if (match?.status) setLiveOutputStatus(match.status)
        else setLiveUnavailable(true)
      } catch (error) {
        if (!alive) return
        if (error?.code === 'bot/not-found' || error?.code === 'bot/refused') setLiveUnavailable(true)
      }
    }
    void syncStatus()
    if (!feed) return () => { alive = false }
    const off = feed.on((event, data) => {
      if (event !== 'jobs') return
      if (data?.sessionId && data.sessionId !== sessionId) return
      if (data?.jobId && data.jobId !== jobId) return
      void syncStatus()
    })
    return () => { alive = false; off?.() }
  }, [watchCollapsedStatus, sessionId, jobId, feed])

  const shownList = Array.isArray(liveJobs) && (liveJobs.length > 0 || parsedList.length === 0)
    ? liveJobs
    : parsedList
  const activeCount = shownList.filter(isActiveJob).length

  const badges = []
  if (toolName === 'job_list' && phase === 'result') {
    badges.push(h('span', { key: 'cnt', className: 'dsb-tool-pill', 'data-tone': activeCount > 0 ? 'warn' : undefined },
      shownList.length === 0 ? t('No jobs')
        : shownList.length === 1 ? t('1 job')
          : t('{count} jobs', { count: shownList.length })))
  } else if (toolName === 'job_output' && effectiveOutputStatus) {
    badges.push(h('span', { key: 'st', className: 'dsb-tool-pill', 'data-tone': jobStatusTone(effectiveOutputStatus) },
      t(JOB_STATUS_LABELS[effectiveOutputStatus] ?? effectiveOutputStatus)))
    if (parsedOutput?.truncated) {
      badges.push(h('span', { key: 'tr', className: 'dsb-tool-pill', 'data-tone': 'warn' }, t('Truncated')))
    }
  } else if (toolName === 'job_kill' && parsedKill?.outcome) {
    badges.push(h('span', { key: 'kill', className: 'dsb-tool-pill', 'data-tone': parsedKill.outcome === 'stopping' ? 'warn' : undefined },
      parsedKill.outcome === 'stopping' ? t('Stopping') : t('Already finished')))
  }

  const summary = toolName === 'job_list'
    ? (activeCount > 0 ? t('{count} running', { count: activeCount }) : '')
    : compact(jobId || parsedKill?.jobId || '')

  // Keep the live panel mounted after a running snapshot completes so post-snapshot output
  // stays visible (polling stops automatically at terminal status). Fall back to the static
  // snapshot only when the job can no longer be read (e.g. pruned after restart).
  const showLivePanel = toolName === 'job_output'
    && Boolean(sessionId && jobId)
    && snapshotInProgress
    && !liveUnavailable

  const hasBody = errLine !== ''
    || shownList.length > 0
    || Boolean(parsedOutput && (parsedOutput.body !== '' || parsedOutput.detail !== ''))
    || showLivePanel
    || rawResult !== ''

  return h(ToolCardShell, {
    icon: TerminalIcon,
    label: t(JOB_LABELS[toolName] ?? 'Background job'),
    summary,
    badges,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  toolName === 'job_list' && shownList.length > 0 ? h('div', { className: 'dsb-job-list' },
    shownList.map(item => h('div', { key: item.id, className: 'dsb-job-row' },
      h('span', { className: 'dsb-job-id' }, item.id),
      h('span', { className: 'dsb-tool-pill', 'data-tone': jobStatusTone(item.status) }, t(JOB_STATUS_LABELS[item.status] ?? item.status)),
      h('span', { className: 'dsb-job-label', title: item.label }, item.label),
      item.status === 'running' && !readOnly && !listUnavailable && sessionId
        ? h(JobStopButton, { sessionId, jobId: item.id, onStopped: () => { void refreshList() } })
        : null))) : null,
  showLivePanel ? h(BackgroundJobPanel, { sessionId, jobId, feed, readOnly, initialStatus: parsedOutput?.status || effectiveOutputStatus, onStatusChange: setLiveOutputStatus, onUnavailable: setLiveUnavailable }) : null,
  toolName === 'job_output' && parsedOutput?.detail ? h('div', { className: 'dsb-job-detail' }, parsedOutput.detail) : null,
  toolName === 'job_output' && !showLivePanel && parsedOutput?.body !== ''
    ? h(CodeSection, { label: isError ? t('Error') : t('Output'), text: parsedOutput.body, error: isError })
    : null,
  toolName !== 'job_list' && toolName !== 'job_output' && rawResult !== ''
    ? h(CodeSection, { label: isError ? t('Error') : t('Result'), text: rawResult, error: isError })
    : null)
}

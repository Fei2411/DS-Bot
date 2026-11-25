// Single canonical classification of non-waking / context-only messages shared
// across delivery, parts, and local-agent adapters.
import { SOURCE_KIND } from './constants.js'
import { GROUP_MEMORY_SOURCE, MEMORY_RECALL_SOURCE, MEMORY_UPDATE_SOURCE } from './memory-copy.js'

export const CLOCK_SOURCE_KINDS = new Set([
  'runtime-context',
  'time-context',
  'ds-bot-time-context',
])

export const CONTEXT_ONLY_SOURCE_KINDS = new Set([
  'working-directory',
  'runtime-context',
  'time-context',
  'ds-bot-time-context',
  'bot-memory',
  'skill-catalog',
  'compact-checkpoint',
  'snapshot',
  GROUP_MEMORY_SOURCE,
  MEMORY_UPDATE_SOURCE,
  MEMORY_RECALL_SOURCE,
])

export const isSilentBotSource = source => source?.kind === SOURCE_KIND
  && (source?.silent === true || ['note', 'cancelled', 'stopped'].includes(source?.role))

export const isClockSource = source => CLOCK_SOURCE_KINDS.has(source?.kind)

export const isSnapshotContextSource = source => source?.form === 'snapshot'
  || CLOCK_SOURCE_KINDS.has(source?.kind)
  || source?.kind === GROUP_MEMORY_SOURCE

export const isContextOnlySource = source => source?.form === 'snapshot'
  || CONTEXT_ONLY_SOURCE_KINDS.has(source?.kind)
  || isSilentBotSource(source)

export const isContextOnlyMessage = message => message?.role === 'user' && isContextOnlySource(message.source)

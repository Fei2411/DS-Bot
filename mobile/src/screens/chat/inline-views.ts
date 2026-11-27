import type { ShownView } from '../../connection.ts'

// Controls that give a view card a frame in the chat transcript (docs/plans/2026-10-20-widget-views.md):
// display-only views sit frameless in the conversation flow; views with local inputs or
// reply actions carry a light card frame.
const CONTROL_TYPES = new Set(['slider', 'number', 'choice', 'toggle', 'options', 'confirm', 'form', 'submit'])

export interface ViewLikeItem {
  kind: string
  id?: string
  callId?: string
  pending?: boolean
}

export interface ChatViewEntry {
  sessionId: string
  view: ShownView
}

export interface InlineViewMatch {
  sessionId: string
  view: ShownView
  rowIndex: number
  rowKey: string
}

export function viewHasControls(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(viewHasControls)
  const rec = node as Record<string, unknown>
  if (typeof rec.type === 'string' && CONTROL_TYPES.has(rec.type)) return true
  if (Array.isArray(rec.children) && rec.children.some(viewHasControls)) return true
  return false
}

export function matchesPendingView(item: ViewLikeItem, pending: ShownView): boolean {
  if (item.kind !== 'view' || item.pending !== true) return false
  if (pending.id !== undefined && item.id !== undefined) return item.id === pending.id
  if (pending.callId !== undefined && item.callId !== undefined) return item.callId === pending.callId
  return false
}

// Splits a chat's pending show_view cards into two groups, matching desktop WidgetCell + WidgetDock:
// - `inline`: drawn at the call site inside the transcript; above the composer only a single-line jump reminder shows.
// - `dock`: not present in the loaded transcript (hidden turn, rolled-over part, unloaded history, or older host),
//   so the full card floats above the composer as a fallback.
export function splitChatViews<R extends { item: ViewLikeItem; key: string }>(
  rows: readonly R[],
  shownViews: readonly ChatViewEntry[],
): {
  inline: InlineViewMatch[]
  dock: ChatViewEntry[]
  inlineByKey: Map<string, ChatViewEntry>
} {
  const inline: InlineViewMatch[] = []
  const dock: ChatViewEntry[] = []
  const inlineByKey = new Map<string, ChatViewEntry>()
  for (const entry of shownViews) {
    const rowIndex = rows.findIndex(row => matchesPendingView(row.item, entry.view))
    if (rowIndex >= 0) {
      const rowKey = rows[rowIndex].key
      inline.push({ sessionId: entry.sessionId, view: entry.view, rowIndex, rowKey })
      inlineByKey.set(rowKey, entry)
    } else {
      dock.push(entry)
    }
  }
  return { inline, dock, inlineByKey }
}

export function viewReminderLabel(
  botName: string | undefined,
  title: string | undefined,
  translate: (key: string, params?: Record<string, string | number>) => string,
): string {
  const bot = botName?.trim() || translate('the Bot')
  const cleanTitle = title?.trim() ?? ''
  return cleanTitle !== ''
    ? translate('{bot} is waiting for your reply: {title}', { bot, title: cleanTitle })
    : translate('{bot} is waiting for your reply', { bot })
}

export function viewFocusKey(entry: ChatViewEntry): string {
  return `view-${entry.view.id ?? entry.sessionId}`
}

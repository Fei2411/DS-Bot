// Workspace right-panel body and tab builders hosted inside unified `BotPanel`:
// File Tree, Multi-Format Document Preview, Turn Changes Diff Review, Interactive
// Terminal, and `sidebar.right.pane.tab` plugin slot support.
import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { call } from '../../../ds-bot/src/client/api.js'
import { fileSizeText, writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'
import { ChevronRightIcon, CopyIcon, DiffIcon, FileIcon, FolderIcon, SearchIcon, TerminalIcon } from '../../../ds-bot/src/client/icons.js'
import { stepMenuFocus, useLinger, useViewport, viewBottom } from '../../../ds-bot/src/client/motion.js'
import { ESCAPE_PRIORITY, useEscape } from '../../../ds-bot/src/client/overlay-hooks.js'
import { ChangesReview } from './changes-review.js'
import { FilePreview } from './file-preview.js'
import { defaultSlots, RIGHT_PANE_TAB_SLOT, SlotErrorBoundary, useSlotEntries } from './slots.js'
import { WorkspaceTerminal } from './workspace-terminal.js'

const RefreshIcon = () => h('svg', {
  width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, h('path', { d: 'M15.5 10a5.5 5.5 0 1 1-1.6-3.9' }), h('path', { d: 'M15.5 3.5v3.5H12' }))

const OpenExternalIcon = () => h('svg', {
  width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, h('path', { d: 'M11 4h5v5' }), h('path', { d: 'M16 4l-7 7' }), h('path', { d: 'M15 11.5V15a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 15V6.5A1.5 1.5 0 0 1 5.5 5H9' }))

const MAX_TREE_DEPTH = 32

function joinDisplayPath(root, rel) {
  if (!root) return rel || ''
  if (!rel) return root
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const cleanRoot = root.replace(/[\\/]+$/, '')
  const cleanRel = rel.replace(/^[\\/]+/, '').split('/').join(sep)
  return `${cleanRoot}${sep}${cleanRel}`
}

function resolvePluginTabs(pluginEntries) {
  if (!Array.isArray(pluginEntries)) return []
  return pluginEntries
    .filter(entry => entry && typeof entry.id === 'string' && entry.component)
    .map(entry => ({
      id: `plugin:${entry.id}`,
      slotId: entry.id,
      pluginId: entry.pluginId ?? entry.meta?.pluginId ?? null,
      runtime: entry.runtime ?? entry.meta?.runtime ?? null,
      onRetry: typeof entry.onRetry === 'function' ? entry.onRetry : null,
      label: typeof entry.meta?.label === 'function' ? entry.meta.label() : (entry.meta?.label ?? entry.id),
      icon: entry.meta?.icon ?? FileIcon,
      component: entry.component,
      closable: true,
    }))
}

export function buildWorkspacePluginMenuItems(pluginEntries = [], onOpen = null) {
  const plugins = resolvePluginTabs(pluginEntries)
  return plugins.map(plugin => ({
    key: plugin.id,
    icon: plugin.icon,
    label: plugin.label,
    onPick: () => { onOpen?.(plugin.id) },
  }))
}

function isPreviewTabId(id) {
  return id === 'preview' || (typeof id === 'string' && id.startsWith('preview:'))
}

function resolveOpenPreviews(panel) {
  const out = []
  const seen = new Set()
  const previews = panel?.previews && typeof panel.previews === 'object' ? panel.previews : null
  for (const id of openTabIds(panel)) {
    if (seen.has(id) || !isPreviewTabId(id)) continue
    const entry = previews?.[id]
    if (entry && typeof entry.path === 'string' && entry.path !== '') {
      seen.add(id)
      out.push({
        id,
        path: entry.path,
        line: entry.line ?? null,
        sessionId: entry.sessionId ?? null,
        root: entry.root ?? null,
        fallback: typeof entry.fallback === 'function' ? entry.fallback : null,
      })
    } else if (id === 'preview' && typeof panel?.file === 'string' && panel.file !== '') {
      seen.add(id)
      out.push({
        id: 'preview',
        path: panel.file,
        line: panel.fileLine ?? null,
        sessionId: panel.fileSessionId ?? null,
        root: panel.fileRoot ?? null,
        fallback: typeof panel.fileFallback === 'function' ? panel.fileFallback : null,
      })
    }
  }
  return out
}

function previewBaseName(filePath) {
  return String(filePath).split(/[\\/]/).filter(Boolean).at(-1) || t('Preview')
}

function previewDisambiguatedLabel(filePath) {
  const parts = String(filePath).split(/[\\/]/).filter(Boolean)
  if (parts.length <= 1) return parts[0] || t('Preview')
  return parts.slice(-2).join('/')
}

function openTabIds(panel) {
  if (!panel || typeof panel !== 'object') return []
  if (Array.isArray(panel.tabs)) return panel.tabs.filter(id => typeof id === 'string' && id !== '')
  return typeof panel.tab === 'string' && panel.tab !== '' ? [panel.tab] : []
}

/**
 * Builds the ordered workspace tab descriptors rendered in unified `BotPanel`'s tab strip.
 * Supports multiple preview tabs (with basename disambiguation) and closable plugin tabs
 * (unopened plugin tabs are omitted from the strip and exposed via the `+` menu instead).
 */
export function buildWorkspaceTabs(panel, pluginEntries = []) {
  const plugins = resolvePluginTabs(pluginEntries)
  const pluginById = new Map(plugins.map(tab => [tab.id, tab]))
  const previewEntries = resolveOpenPreviews(panel)
  const previewById = new Map(previewEntries.map(entry => [entry.id, entry]))
  const nameCounts = new Map()
  for (const entry of previewEntries) {
    const base = previewBaseName(entry.path)
    nameCounts.set(base, (nameCounts.get(base) ?? 0) + 1)
  }
  const tabs = []
  const seen = new Set()
  for (const id of openTabIds(panel)) {
    if (seen.has(id)) continue
    if (id === 'files') {
      seen.add(id)
      tabs.push({ id: 'files', label: t('Files'), icon: FolderIcon, closable: true })
    } else if (previewById.has(id)) {
      seen.add(id)
      const entry = previewById.get(id)
      const base = previewBaseName(entry.path)
      const label = (nameCounts.get(base) ?? 0) > 1 ? previewDisambiguatedLabel(entry.path) : base
      tabs.push({ id, label, title: entry.path, icon: FileIcon, closable: true })
    } else if (id === 'changes' && panel?.changes) {
      seen.add(id)
      tabs.push({ id: 'changes', label: t('Changes'), icon: DiffIcon, closable: true })
    } else if (id === 'terminal') {
      seen.add(id)
      tabs.push({ id: 'terminal', label: t('Terminal'), icon: TerminalIcon, closable: true })
    } else if (pluginById.has(id)) {
      seen.add(id)
      const plugin = pluginById.get(id)
      tabs.push({ id: plugin.id, label: plugin.label, icon: plugin.icon, closable: true })
    }
  }
  return tabs
}

function TreeBranch({
  entries,
  depth,
  ancestors,
  expanded,
  childrenByPath,
  loadingDirs,
  truncatedDirs,
  selectedPath,
  highlightedDir,
  menuPath,
  filter,
  onToggleDir,
  onSelectFile,
  onContextMenu,
}) {
  if (depth >= MAX_TREE_DEPTH) return []
  const needle = filter.trim().toLowerCase()
  const rows = []
  const openKeyboardMenu = (event, entry) => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      const rect = event.currentTarget?.getBoundingClientRect?.()
      onContextMenu(entry, rect ? Math.round(rect.left + 24) : 16, rect ? Math.round(rect.bottom + 4) : 16, event.currentTarget)
    }
  }
  for (const entry of entries) {
    if (entry.kind === 'dir') {
      const path = entry.path
      const isCyclic = ancestors.has(path)
      const isOpen = !isCyclic && expanded.has(path)
      const subEntries = childrenByPath[path]
      const matchesSelf = needle === '' || entry.name.toLowerCase().includes(needle)
      let childRows = []
      if (isOpen && Array.isArray(subEntries)) {
        const nextAncestors = new Set(ancestors)
        nextAncestors.add(path)
        childRows = TreeBranch({
          entries: subEntries,
          depth: depth + 1,
          ancestors: nextAncestors,
          expanded,
          childrenByPath,
          loadingDirs,
          truncatedDirs,
          selectedPath,
          highlightedDir,
          menuPath,
          filter,
          onToggleDir,
          onSelectFile,
          onContextMenu,
        })
      }
      if (!matchesSelf && childRows.length === 0) continue
      rows.push(h('button', {
        key: `dir:${depth}:${path}:${entry.name}`,
        type: 'button',
        role: 'treeitem',
        className: 'dsb-ft-row is-dir',
        'data-tree-path': path,
        'data-revealed': highlightedDir === path ? '' : undefined,
        style: { paddingLeft: `${10 + depth * 14}px` },
        'aria-expanded': isOpen,
        'data-path': path,
        'data-menu-open': menuPath === path ? '' : undefined,
        onClick: () => { if (!isCyclic) onToggleDir(path) },
        onContextMenu: (event) => {
          event.preventDefault()
          event.stopPropagation()
          onContextMenu(entry, event.clientX, event.clientY, event.currentTarget)
        },
        onKeyDown: event => openKeyboardMenu(event, entry),
      },
      h('span', { className: 'dsb-ft-chev', 'data-open': isOpen || undefined, 'aria-hidden': true }, h(ChevronRightIcon)),
      h('span', { className: 'dsb-ft-ico', 'aria-hidden': true }, h(FolderIcon)),
      h('span', { className: 'dsb-ft-name', title: path }, entry.name),
      loadingDirs.has(path) ? h('span', { className: 'dsb-ft-meta' }, '…') : null))
      if (isOpen && childRows.length > 0) rows.push(...childRows)
      if (isOpen && truncatedDirs?.has(path)) {
        rows.push(h('div', {
          key: `trunc:${depth}:${path}`,
          className: 'dsb-pv-note',
          style: { paddingLeft: `${26 + depth * 14}px` },
        }, t('Showing first {count} entries', { count: 500 })))
      }
    } else {
      if (needle !== '' && !entry.name.toLowerCase().includes(needle) && !entry.path.toLowerCase().includes(needle)) continue
      rows.push(h('button', {
        key: `file:${depth}:${entry.path}:${entry.name}`,
        type: 'button',
        role: 'treeitem',
        className: 'dsb-ft-row is-file',
        'data-tree-path': entry.path,
        style: { paddingLeft: `${26 + depth * 14}px` },
        'aria-current': selectedPath === entry.path ? 'true' : undefined,
        'data-path': entry.path,
        'data-menu-open': menuPath === entry.path ? '' : undefined,
        onClick: () => onSelectFile(entry.path),
        onContextMenu: (event) => {
          event.preventDefault()
          event.stopPropagation()
          onContextMenu(entry, event.clientX, event.clientY, event.currentTarget)
        },
        onKeyDown: event => openKeyboardMenu(event, entry),
      },
      h('span', { className: 'dsb-ft-ico', 'aria-hidden': true }, h(FileIcon)),
      h('span', { className: 'dsb-ft-name', title: entry.path }, entry.name),
      Number.isFinite(entry.size) ? h('span', { className: 'dsb-ft-meta' }, fileSizeText(entry.size)) : null))
    }
  }
  return rows
}

const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:(?:\/|$)/
const REVEAL_HIGHLIGHT_MS = 1800

function hasEscapingDotDot(relPath) {
  let depth = 0
  for (const seg of relPath.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      depth -= 1
      if (depth < 0) return true
    } else {
      depth += 1
    }
  }
  return false
}

function collapseRelativeSegments(relPath) {
  const out = []
  for (const seg of relPath.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else {
      out.push(seg)
    }
  }
  return out.join('/')
}

function normalizeFsPath(value) {
  if (typeof value !== 'string') return ''
  const s = value.trim().replace(/\\/g, '/')
  if (s === '') return ''
  if (/^\/+$/.test(s)) return '/'
  if (/^[A-Za-z]:\/+$/.test(s)) return `${s.slice(0, 2)}/`
  return s.replace(/\/+$/, '')
}

/**
 * Resolves a folder reveal target against the workspace root.
 * Returns `{ status: 'ok', path }` (workspace-relative path, `''` for root)
 * or `{ status: 'outside', raw }` when an absolute path or `..` traversal escapes the root.
 */
export function normalizeRevealPath(raw, rootPath) {
  if (typeof raw !== 'string') return { status: 'ok', path: '' }
  const p = normalizeFsPath(raw)
  if (p === '' || p === '.') return { status: 'ok', path: '' }

  const isWinAbs = WINDOWS_DRIVE_ABS_RE.test(p)
  const isPosixAbs = p.startsWith('/')
  if (isWinAbs || isPosixAbs) {
    const normRoot = normalizeFsPath(rootPath)
    if (normRoot === '') return { status: 'outside', raw: p }
    const caseInsensitive = isWinAbs || WINDOWS_DRIVE_ABS_RE.test(normRoot)
    const cmpPath = caseInsensitive ? p.toLowerCase() : p
    const cmpRoot = caseInsensitive ? normRoot.toLowerCase() : normRoot
    const rootPrefix = cmpRoot.endsWith('/') ? cmpRoot : `${cmpRoot}/`
    if (cmpPath !== cmpRoot && !cmpPath.startsWith(rootPrefix)) {
      return { status: 'outside', raw: p }
    }
    const remainder = p.slice(normRoot.length).replace(/^\/+/, '')
    if (remainder === '') return { status: 'ok', path: '' }
    const collapsed = collapseRelativeSegments(remainder)
    return collapsed === null ? { status: 'outside', raw: p } : { status: 'ok', path: collapsed }
  }

  if (hasEscapingDotDot(p)) return { status: 'outside', raw: p }
  const collapsed = collapseRelativeSegments(p)
  return collapsed === null ? { status: 'outside', raw: p } : { status: 'ok', path: collapsed }
}

function FileTreeContextMenu({ menu, expanded, onOpen, onToggleDir, onReveal, onOpenDefault, onCopyPath, onCopyRelativePath, onClose }) {
  const open = Boolean(menu)
  const [shown, leaving] = useLinger(open, 120)
  const lastMenuRef = useRef(menu)
  if (menu) lastMenuRef.current = menu
  const activeMenu = menu ?? lastMenuRef.current

  const ref = useRef(null)
  const triggerRef = useRef(null)
  const [place, setPlace] = useState(() => ({ left: activeMenu?.x ?? 16, top: activeMenu?.y ?? 16 }))
  const tick = useViewport(shown)

  useEffect(() => {
    if (!open) return
    triggerRef.current = menu?.trigger ?? (typeof document === 'undefined' ? null : document.activeElement)
  }, [open, menu])

  const closeWithFocus = useCallback(() => {
    const prev = triggerRef.current
    onClose()
    if (prev && prev.isConnected !== false && typeof prev.focus === 'function') {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => prev.focus())
      else prev.focus()
    }
  }, [onClose])

  useEscape(closeWithFocus, open, { priority: ESCAPE_PRIORITY.MENU })

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('.dsb-ft-menu')) onClose()
    }
    const onKey = (event) => {
      stepMenuFocus(ref.current, event, triggerRef.current)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])

  useLayoutEffect(() => {
    if (!shown || !activeMenu) return
    const box = ref.current?.getBoundingClientRect?.()
    if (!box) {
      setPlace({ left: activeMenu.x, top: activeMenu.y })
      return
    }
    setPlace({
      left: Math.max(8, Math.min(activeMenu.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(activeMenu.y, viewBottom() - box.height - 8)),
    })
  }, [shown, activeMenu?.x, activeMenu?.y, tick])

  if (!shown || !activeMenu) return null
  const entry = activeMenu.entry
  const isDir = entry.kind === 'dir'
  const isOpen = isDir && expanded.has(entry.path)
  const run = fn => () => { onClose(); fn() }

  const items = isDir
    ? [
        { key: 'toggle', icon: ChevronRightIcon, label: isOpen ? t('Collapse') : t('Expand'), onClick: run(() => onToggleDir(entry.path)) },
        { key: 'reveal', icon: FolderIcon, label: t('Show in folder'), onClick: run(() => onReveal(entry.path, activeMenu.root)) },
        { sep: true },
        { key: 'copy-path', icon: CopyIcon, label: t('Copy path'), onClick: run(() => onCopyPath(entry.path, activeMenu.root)) },
        { key: 'copy-rel', icon: CopyIcon, label: t('Copy relative path'), onClick: run(() => onCopyRelativePath(entry.path)) },
      ]
    : [
        { key: 'open', icon: FileIcon, label: t('Open'), onClick: run(() => onOpen(entry.path)) },
        { key: 'reveal', icon: FolderIcon, label: t('Show in folder'), onClick: run(() => onReveal(entry.path, activeMenu.root)) },
        { key: 'open-app', icon: OpenExternalIcon, label: t('Open in default app'), onClick: run(() => onOpenDefault(entry.path, activeMenu.root)) },
        { sep: true },
        { key: 'copy-path', icon: CopyIcon, label: t('Copy path'), onClick: run(() => onCopyPath(entry.path, activeMenu.root)) },
        { key: 'copy-rel', icon: CopyIcon, label: t('Copy relative path'), onClick: run(() => onCopyRelativePath(entry.path)) },
      ]

  const node = h('div', {
    ref,
    className: 'bt-menu dsb-ft-menu',
    role: 'menu',
    'aria-label': entry.name,
    'data-leaving': leaving ? '' : undefined,
    style: place,
  },
  items.map((item, idx) => (item.sep
    ? h('div', { key: `sep:${idx}`, className: 'bt-menu-sep', role: 'separator' })
    : h('button', {
      key: item.key,
      type: 'button',
      role: 'menuitem',
      className: 'bt-menu-item',
      'data-ft-action': item.key,
      onClick: item.onClick,
    }, h(item.icon), h('span', null, item.label)))))

  const target = typeof document !== 'undefined' && document?.body ? document.body : null
  return target ? createPortal(node, target) : node
}

const AUTO_REFRESH_STORAGE_KEY = 'dsb.preview.autoRefresh'

function readSavedAutoRefresh() {
  try { return globalThis.localStorage?.getItem(AUTO_REFRESH_STORAGE_KEY) === '1' } catch { return false }
}

function writeSavedAutoRefresh(value) {
  try { globalThis.localStorage?.setItem(AUTO_REFRESH_STORAGE_KEY, value ? '1' : '0') } catch { /* ignore storage errors */ }
}

function parentRelDir(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return ''
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const slash = norm.lastIndexOf('/')
  return slash > 0 ? norm.slice(0, slash) : ''
}

function previewMatchesChange(entry, changeData, activeWatchRoot) {
  if (!entry?.path || !changeData) return false
  const entryRoot = entry.root || activeWatchRoot || ''
  if (changeData.root && entryRoot && changeData.root !== entryRoot) return false
  if (changeData.overflow === true) return true
  const paths = Array.isArray(changeData.paths) ? changeData.paths : []
  if (paths.length === 0) return true
  const normTarget = String(entry.path).replace(/\\/g, '/').replace(/^\/+/, '')
  const targetParent = parentRelDir(normTarget)
  for (const raw of paths) {
    const p = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (p === '' || p === normTarget || (targetParent !== '' && p === targetParent)) return true
  }
  return false
}

function searchIncompleteMessage(searchState) {
  if (searchState.cancelled) return t('Search cancelled — showing partial results')
  const reasons = Array.isArray(searchState.incompleteReasons) ? searchState.incompleteReasons : []
  if (reasons.includes('permission') || reasons.includes('unreadable')) {
    return t('Some folders could not be read — results may be incomplete')
  }
  return t('Results may be incomplete')
}

function FileTree({ sessionId, feed, actions, selectedPath, revealDir = null, revealNonce = 0, onOpenFile, active = true }) {
  const [rootInfo, setRootInfo] = useState({ root: '', rootName: '', missing: false, truncated: false })
  const [childrenByPath, setChildrenByPath] = useState({})
  const [truncatedDirs, setTruncatedDirs] = useState(() => new Set())
  const [expanded, setExpanded] = useState(() => new Set())
  const [loadingDirs, setLoadingDirs] = useState(() => new Set())
  const [includeHidden, setIncludeHidden] = useState(false)
  const [filter, setFilter] = useState('')
  const [searchState, setSearchState] = useState({
    query: '',
    entries: [],
    searching: false,
    done: true,
    cancelled: false,
    incomplete: false,
    incompleteReasons: [],
    error: '',
  })
  const [highlightedDir, setHighlightedDir] = useState(null)
  const [revealNotice, setRevealNotice] = useState('')
  const [error, setError] = useState('')
  const [menu, setMenu] = useState(null)
  const genRef = useRef(0)
  const searchRunRef = useRef(0)
  const searchAbortRef = useRef(null)
  const searchIdRef = useRef(null)
  const listRef = useRef(null)
  const handledRevealNonceRef = useRef(0)
  const pendingHiddenRevealRef = useRef(null)
  const highlightTimerRef = useRef(null)
  const watchIdRef = useRef(null)
  const watchRecursiveRef = useRef(true)
  const syncedDirsKeyRef = useRef('')
  const prevSessionRef = useRef(sessionId)
  const prevActiveRef = useRef(active)

  const rootPathRef = useRef('')
  rootPathRef.current = rootInfo.root
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const flashHighlightedDir = useCallback((dirPath) => {
    if (highlightTimerRef.current !== null) {
      clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = null
    }
    setHighlightedDir(dirPath)
    if (dirPath !== null) {
      highlightTimerRef.current = setTimeout(() => {
        highlightTimerRef.current = null
        setHighlightedDir(cur => (cur === dirPath ? null : cur))
      }, REVEAL_HIGHLIGHT_MS)
    }
  }, [])

  useEffect(() => () => {
    if (highlightTimerRef.current !== null) {
      clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = null
    }
  }, [])

  const loadDir = useCallback(async (dirPath, gen, { silent = false, hiddenOverride } = {}) => {
    const showHidden = hiddenOverride ?? includeHidden
    if (!silent) setLoadingDirs(current => new Set(current).add(dirPath))
    try {
      const expectedRoot = dirPath !== '' && rootPathRef.current ? rootPathRef.current : undefined
      const res = await call('workspace-list', { sessionId, path: dirPath, includeHidden: showHidden, ...(expectedRoot ? { expectedRoot } : {}) })
      if (genRef.current !== gen) return { ok: false, stale: false }
      if (dirPath === '') {
        rootPathRef.current = res.root ?? ''
        setRootInfo({
          root: res.root ?? '',
          rootName: res.rootName ?? '',
          missing: res.missing === true,
          truncated: res.truncated === true,
        })
      } else {
        setTruncatedDirs((current) => {
          const isTrunc = res.truncated === true
          if (current.has(dirPath) === isTrunc) return current
          const next = new Set(current)
          if (isTrunc) next.add(dirPath)
          else next.delete(dirPath)
          return next
        })
      }
      setChildrenByPath(current => ({ ...current, [dirPath]: res.entries ?? [] }))
      setError('')
      return { ok: true, root: res.root ?? '', res }
    } catch (failure) {
      if (genRef.current !== gen) return { ok: false, stale: false }
      const message = hostText(failure?.message ?? String(failure))
      if (dirPath !== '' && failure?.code === 'bot/stale') {
        return { ok: false, stale: true, error: message }
      }
      if (dirPath !== '' && (failure?.code === 'bot/not-found' || failure?.code === 'bot/invalid')) {
        // Expanded folder was deleted or replaced; drop it cleanly without disturbing sibling state.
        if (expandedRef.current.has(dirPath)) {
          const next = new Set(expandedRef.current)
          next.delete(dirPath)
          expandedRef.current = next
        }
        setExpanded((current) => {
          if (!current.has(dirPath)) return current
          const next = new Set(current)
          next.delete(dirPath)
          return next
        })
        setChildrenByPath((current) => {
          if (!Object.hasOwn(current, dirPath)) return current
          const next = { ...current }
          delete next[dirPath]
          return next
        })
        setTruncatedDirs((current) => {
          if (!current.has(dirPath)) return current
          const next = new Set(current)
          next.delete(dirPath)
          return next
        })
        return { ok: false, removed: true, error: message }
      }
      if (dirPath === '') setError(message)
      return { ok: false, error: message }
    } finally {
      if (!silent && genRef.current === gen) {
        setLoadingDirs((current) => {
          if (!current.has(dirPath)) return current
          const next = new Set(current)
          next.delete(dirPath)
          return next
        })
      }
    }
  }, [sessionId, includeHidden])

  const refreshTree = useCallback(async ({ silent = false, reset = false } = {}) => {
    const gen = ++genRef.current
    const scrollTop = listRef.current?.scrollTop ?? 0
    const prevRoot = rootPathRef.current
    if (reset) {
      rootPathRef.current = ''
      expandedRef.current = new Set()
      setChildrenByPath({})
      setTruncatedDirs(new Set())
      setExpanded(new Set())
      setLoadingDirs(new Set())
      flashHighlightedDir(null)
      setError('')
      await loadDir('', gen, { silent: false })
      return
    }
    const rootRes = await loadDir('', gen, { silent })
    if (genRef.current !== gen || !rootRes?.ok) return
    if (prevRoot && rootRes.root && rootRes.root !== prevRoot) {
      // Workspace root changed (e.g. working_directory moved); reset stale expanded paths.
      expandedRef.current = new Set()
      setExpanded(new Set())
      setTruncatedDirs(new Set())
      flashHighlightedDir(null)
      setChildrenByPath(current => (Object.hasOwn(current, '') ? { '': current[''] } : {}))
      return
    }
    // Drop cached listings of collapsed folders so reopening them never serves stale entries.
    const openDirs = [...expandedRef.current].sort((a, b) => a.split('/').length - b.split('/').length)
    setChildrenByPath((current) => {
      const next = {}
      if (Object.hasOwn(current, '')) next[''] = current['']
      for (const dir of openDirs) {
        if (Object.hasOwn(current, dir)) next[dir] = current[dir]
      }
      return next
    })
    if (openDirs.length > 0) {
      await Promise.all(openDirs.map(dir => loadDir(dir, gen, { silent: true })))
    }
    if (listRef.current && scrollTop > 0) {
      const el = listRef.current
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { el.scrollTop = scrollTop })
      } else {
        el.scrollTop = scrollTop
      }
    }
  }, [loadDir, flashHighlightedDir])

  const refreshTreeRef = useRef(refreshTree)
  refreshTreeRef.current = refreshTree

  useEffect(() => {
    const sessionChanged = prevSessionRef.current !== sessionId
    prevSessionRef.current = sessionId
    setMenu(null)
    void refreshTree({ silent: false, reset: sessionChanged })
  }, [sessionId, includeHidden, refreshTree])

  useEffect(() => {
    setRevealNotice('')
    pendingHiddenRevealRef.current = null
  }, [sessionId])

  // When returning from a hidden tab (e.g. Preview/Terminal), refresh once cleanly.
  useEffect(() => {
    const wasActive = prevActiveRef.current
    prevActiveRef.current = active
    if (!active) {
      setMenu(null)
      return
    }
    if (!wasActive) {
      void refreshTreeRef.current({ silent: true, reset: false })
    }
  }, [active])

  // Watch the active workspace folder while Files tab is visible; rebind on root changes,
  // refresh on SSE `hello` reconnect so 6 s feed recycles never drop changes, and release on unload.
  useEffect(() => {
    if (!active) return undefined
    let alive = true
    let activeWatchId = null
    watchIdRef.current = null
    watchRecursiveRef.current = true
    const initialDirs = [...expandedRef.current].sort()
    syncedDirsKeyRef.current = initialDirs.join('\0')
    void call('workspace-watch', {
      sessionId,
      dirs: initialDirs,
      ...(rootInfo.root ? { expectedRoot: rootInfo.root } : {}),
    })
      .then((res) => {
        if (!alive) {
          if (res?.watchId) void call('workspace-unwatch', { watchId: res.watchId }).catch(() => {})
          return
        }
        activeWatchId = res?.watchId ?? null
        watchIdRef.current = activeWatchId
        watchRecursiveRef.current = res?.recursive === true
        // Sync folders expanded while the initial non-recursive watch request was still in flight.
        if (activeWatchId && !watchRecursiveRef.current) {
          const currentDirs = [...expandedRef.current].sort()
          const currentKey = currentDirs.join('\0')
          if (currentKey !== syncedDirsKeyRef.current) {
            syncedDirsKeyRef.current = currentKey
            void call('workspace-watch', {
              sessionId,
              watchId: activeWatchId,
              dirs: currentDirs,
            }).catch(() => {})
          }
        }
      })
      .catch(() => {})

    const off = typeof feed?.on === 'function'
      ? feed.on((event, data) => {
        if (!alive) return
        if (event === 'hello') {
          if (rootPathRef.current) void refreshTreeRef.current({ silent: true, reset: false })
          return
        }
        if (event !== 'workspace-changed') return
        const ids = Array.isArray(data?.watchIds) ? data.watchIds : (data?.watchId ? [data.watchId] : [])
        if (activeWatchId && ids.length > 0 && !ids.includes(activeWatchId)) return
        if (!activeWatchId && data?.root && rootPathRef.current && data.root !== rootPathRef.current) return
        void refreshTreeRef.current({ silent: true, reset: false })
      })
      : () => {}

    const onUnload = () => {
      const toClose = activeWatchId ?? watchIdRef.current
      if (!toClose || typeof fetch !== 'function') return
      try {
        void fetch('api/bot', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: 'workspace-unwatch', payload: { watchId: toClose } }),
          keepalive: true,
        })
      } catch { /* unload best-effort */ }
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', onUnload)
      window.addEventListener('beforeunload', onUnload)
    }

    return () => {
      alive = false
      off()
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('pagehide', onUnload)
        window.removeEventListener('beforeunload', onUnload)
      }
      const toClose = activeWatchId ?? watchIdRef.current
      watchIdRef.current = null
      syncedDirsKeyRef.current = ''
      if (toClose) void call('workspace-unwatch', { watchId: toClose }).catch(() => {})
    }
  }, [sessionId, active, rootInfo.root, feed])

  // On platforms without recursive fs.watch (e.g. Linux), keep expanded directories registered with the watch.
  useEffect(() => {
    if (!active || watchRecursiveRef.current || !watchIdRef.current) return
    const currentDirs = [...expanded].sort()
    const currentKey = currentDirs.join('\0')
    if (currentKey === syncedDirsKeyRef.current) return
    syncedDirsKeyRef.current = currentKey
    void call('workspace-watch', {
      sessionId,
      watchId: watchIdRef.current,
      dirs: currentDirs,
    }).catch(() => {})
  }, [sessionId, active, expanded])

  // Reveal a referenced folder in the tree: consume each `revealNonce` once so later
  // Hide-dotfiles toggles never replay an old dotfolder reveal.
  useEffect(() => {
    let targetDir = null
    let usingPendingHidden = false
    if (pendingHiddenRevealRef.current !== null && includeHidden) {
      targetDir = pendingHiddenRevealRef.current
      pendingHiddenRevealRef.current = null
      usingPendingHidden = true
    } else if (revealNonce && revealDir !== null && revealNonce !== handledRevealNonceRef.current) {
      handledRevealNonceRef.current = revealNonce
      pendingHiddenRevealRef.current = null
      targetDir = revealDir
    } else {
      return undefined
    }

    let alive = true
    const run = async () => {
      setRevealNotice('')
      if (!rootPathRef.current) {
        let rootRes
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const stepGen = genRef.current
          rootRes = await loadDir('', stepGen)
          if (!alive) return
          if (rootRes.ok || genRef.current === stepGen) break
        }
        if (!rootRes?.ok && rootRes?.error) {
          setRevealNotice(rootRes.error)
          return
        }
      }
      const norm = normalizeRevealPath(targetDir, rootPathRef.current)
      setFilter('')
      if (norm.status === 'outside') {
        flashHighlightedDir(null)
        setRevealNotice(t('Path is outside the workspace folder: {path}', { path: targetDir }))
        return
      }
      const rel = norm.path
      if (rel === '') {
        flashHighlightedDir(null)
        return
      }
      const segments = rel.split('/').filter(Boolean)
      const needsHidden = segments.some(seg => seg.startsWith('.'))
      if (needsHidden && !includeHidden && !usingPendingHidden) {
        pendingHiddenRevealRef.current = targetDir
        setIncludeHidden(true)
        return
      }
      const prefixes = segments.map((_, idx) => segments.slice(0, idx + 1).join('/'))
      const nextExpanded = new Set(expandedRef.current)
      for (const p of prefixes) nextExpanded.add(p)
      expandedRef.current = nextExpanded
      setExpanded((current) => {
        const next = new Set(current)
        for (const p of prefixes) next.add(p)
        return next
      })
      for (const p of prefixes) {
        if (!alive) return
        let loaded
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const stepGen = genRef.current
          loaded = await loadDir(p, stepGen, { hiddenOverride: needsHidden ? true : undefined })
          if (!alive) return
          if (loaded.ok || genRef.current === stepGen) break
        }
        if (!loaded?.ok) {
          if (loaded?.stale) void refreshTreeRef.current({ silent: false, reset: false })
          flashHighlightedDir(null)
          setRevealNotice(loaded?.error || t('Could not open folder'))
          return
        }
      }
      if (!alive) return
      flashHighlightedDir(rel)
      const scrollToRow = () => {
        const rows = listRef.current?.querySelectorAll?.('[data-tree-path]') ?? []
        for (const el of rows) {
          if (el.getAttribute('data-tree-path') === rel) {
            el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
            break
          }
        }
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scrollToRow)
      else scrollToRow()
    }
    void run()
    return () => { alive = false }
  }, [revealDir, revealNonce, includeHidden, loadDir, flashHighlightedDir])

  const toggleDir = useCallback((dirPath) => {
    setRevealNotice('')
    const isOpen = expandedRef.current.has(dirPath)
    const nextExpanded = new Set(expandedRef.current)
    if (isOpen) nextExpanded.delete(dirPath)
    else nextExpanded.add(dirPath)
    expandedRef.current = nextExpanded
    setExpanded((current) => {
      const next = new Set(current)
      if (isOpen) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
    if (!isOpen) {
      const hasCached = Object.hasOwn(childrenByPath, dirPath)
      void loadDir(dirPath, genRef.current, { silent: hasCached }).then((res) => {
        if (res?.stale) void refreshTree({ silent: false, reset: false })
      })
    }
  }, [childrenByPath, loadDir, refreshTree])

  const cancelActiveSearch = useCallback((markCancelled = false) => {
    searchRunRef.current += 1
    if (searchAbortRef.current) {
      searchAbortRef.current.abort()
      searchAbortRef.current = null
    }
    const sid = searchIdRef.current
    searchIdRef.current = null
    if (sid) {
      void call('workspace-search', { sessionId, searchId: sid, cancel: true }).catch(() => {})
    }
    if (markCancelled) {
      setSearchState(cur => (cur.searching
        ? { ...cur, searching: false, done: true, cancelled: true, incomplete: true, incompleteReasons: [...new Set([...cur.incompleteReasons, 'cancelled'])] }
        : cur))
    }
  }, [sessionId])

  // Full-workspace search via `workspace-search`: streams batches progressively without an
  // artificial match cap, respects `.gitignore`, reports incomplete results, and cancels cleanly.
  useEffect(() => {
    const trimmed = filter.trim()
    cancelActiveSearch(false)
    if (trimmed === '') {
      setSearchState({
        query: '',
        entries: [],
        searching: false,
        done: true,
        cancelled: false,
        incomplete: false,
        incompleteReasons: [],
        error: '',
      })
      return undefined
    }
    const runId = ++searchRunRef.current
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    searchAbortRef.current = controller
    setSearchState({
      query: trimmed,
      entries: [],
      searching: true,
      done: false,
      cancelled: false,
      incomplete: false,
      incompleteReasons: [],
      error: '',
    })

    const run = async () => {
      let nextSearchId = ''
      try {
        while (searchRunRef.current === runId) {
          const expectedRoot = rootPathRef.current || undefined
          const payload = nextSearchId
            ? { sessionId, searchId: nextSearchId, ...(expectedRoot ? { expectedRoot } : {}) }
            : { sessionId, query: trimmed, includeHidden, ...(expectedRoot ? { expectedRoot } : {}) }
          const res = await call('workspace-search', payload, controller?.signal)
          if (searchRunRef.current !== runId) {
            if (res?.searchId && !res.done) {
              void call('workspace-search', { sessionId, searchId: res.searchId, cancel: true }).catch(() => {})
            }
            return
          }
          const batchEntries = Array.isArray(res?.entries) ? res.entries : []
          const done = res?.done !== false
          nextSearchId = !done && typeof res?.searchId === 'string' ? res.searchId : ''
          searchIdRef.current = nextSearchId || null
          const reasons = Array.isArray(res?.incompleteReasons) ? res.incompleteReasons : []
          const incomplete = res?.incomplete === true || res?.truncated === true || reasons.length > 0
          setSearchState(cur => ({
            query: trimmed,
            entries: batchEntries.length > 0 ? [...cur.entries, ...batchEntries] : cur.entries,
            searching: !done,
            done,
            cancelled: res?.cancelled === true,
            incomplete: cur.incomplete || incomplete,
            incompleteReasons: reasons.length > 0 ? [...new Set([...cur.incompleteReasons, ...reasons])] : cur.incompleteReasons,
            error: '',
          }))
          if (done || nextSearchId === '') break
        }
      } catch (failure) {
        if (searchRunRef.current !== runId || failure?.name === 'AbortError') return
        setSearchState(cur => ({
          ...cur,
          searching: false,
          done: true,
          error: hostText(failure?.message ?? String(failure)),
        }))
      } finally {
        if (searchRunRef.current === runId) {
          searchAbortRef.current = null
          searchIdRef.current = null
        }
      }
    }
    void run()
    return () => {
      if (searchRunRef.current === runId) {
        cancelActiveSearch(false)
      }
    }
  }, [filter, sessionId, includeHidden, rootInfo.root, cancelActiveSearch])

  const openFileTarget = useCallback((path) => {
    setRevealNotice('')
    onOpenFile(rootPathRef.current ? { path, root: rootPathRef.current } : path)
  }, [onOpenFile])

  const openSearchDir = useCallback((dirPath) => {
    setFilter('')
    actions?.revealFolder?.({ path: dirPath, sessionId })
  }, [actions, sessionId])

  const runOpenAction = useCallback((path, action, capturedRoot) => {
    const expectedRoot = capturedRoot || rootPathRef.current || undefined
    void call('workspace-open', {
      sessionId,
      path,
      action,
      ...(expectedRoot ? { expectedRoot } : {}),
    }).catch((failure) => {
      if (failure?.code === 'bot/stale') {
        void refreshTreeRef.current({ silent: false, reset: false })
      }
      const msg = hostText(failure?.message ?? String(failure))
      if (actions?.reportError) actions.reportError(failure, 'workspace-open')
      else setError(msg)
    })
  }, [sessionId, actions])

  const copyPath = useCallback((path, relativeOnly, capturedRoot) => {
    const text = relativeOnly ? path : joinDisplayPath(capturedRoot || rootPathRef.current, path)
    void writeClipboard(text).then((ok) => {
      if (ok) actions?.notice?.(relativeOnly ? t('Relative path copied') : t('Path copied'))
    })
  }, [actions])

  const isSearchingMode = filter.trim() !== ''
  const rootEntries = childrenByPath[''] ?? []
  const rows = isSearchingMode
    ? searchState.entries.map((entry) => {
      const isDir = entry.kind === 'dir'
      const parent = parentRelDir(entry.path)
      return h('button', {
        key: `sr:${entry.kind}:${entry.path}`,
        type: 'button',
        role: 'treeitem',
        className: isDir ? 'dsb-ft-row is-dir is-search-hit' : 'dsb-ft-row is-file is-search-hit',
        'data-tree-path': entry.path,
        'data-path': entry.path,
        'data-menu-open': menu?.entry?.path === entry.path ? '' : undefined,
        'aria-current': !isDir && selectedPath === entry.path ? 'true' : undefined,
        onClick: () => { if (isDir) openSearchDir(entry.path); else openFileTarget(entry.path) },
        onContextMenu: (event) => {
          event.preventDefault()
          event.stopPropagation()
          setMenu({ entry, x: event.clientX, y: event.clientY, trigger: event.currentTarget, root: rootPathRef.current })
        },
      },
      h('span', { className: 'dsb-ft-ico', 'aria-hidden': true }, isDir ? h(FolderIcon) : h(FileIcon)),
      h('span', { className: 'dsb-ft-hit-text' },
        h('span', { className: 'dsb-ft-name', title: entry.path }, entry.name),
        parent ? h('span', { className: 'dsb-ft-sub', title: entry.path }, parent) : null),
      !isDir && Number.isFinite(entry.size) ? h('span', { className: 'dsb-ft-meta' }, fileSizeText(entry.size)) : null)
    })
    : TreeBranch({
      entries: rootEntries,
      depth: 0,
      ancestors: new Set(['']),
      expanded,
      childrenByPath,
      loadingDirs,
      truncatedDirs,
      selectedPath,
      highlightedDir,
      menuPath: menu?.entry?.path ?? null,
      filter: '',
      onToggleDir: toggleDir,
      onSelectFile: openFileTarget,
      onContextMenu: (entry, x, y, trigger) => setMenu({ entry, x, y, trigger, root: rootPathRef.current }),
    })

  return h('div', { className: 'dsb-ft' },
    h('div', { className: 'dsb-ft-bar' },
      h('span', { className: 'dsb-ft-root', title: rootInfo.root }, rootInfo.rootName || t('Workspace')),
      h('div', { className: 'dsb-ft-actions' },
        h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm',
          'aria-pressed': includeHidden,
          onClick: () => {
            pendingHiddenRevealRef.current = null
            setRevealNotice('')
            setIncludeHidden(v => !v)
          },
        }, includeHidden ? t('Hide dotfiles') : t('Show hidden')),
        h('button', {
          type: 'button',
          className: 'bt-icon-btn',
          'aria-label': t('Refresh'),
          title: t('Refresh'),
          onClick: () => {
            setRevealNotice('')
            void refreshTree({ silent: false, reset: false })
          },
        }, h(RefreshIcon)))),
    h('div', { className: 'dsb-ft-search' },
      h('span', { className: 'dsb-ft-search-ico', 'aria-hidden': true }, h(SearchIcon)),
      h('input', {
        type: 'search',
        className: 'dsb-ft-search-input',
        value: filter,
        placeholder: t('Filter files…'),
        'aria-label': t('Filter files…'),
        onChange: (event) => {
          setRevealNotice('')
          setFilter(event.target.value)
        },
      }),
      isSearchingMode && searchState.searching
        ? h('button', {
          type: 'button',
          className: 'dsb-ft-search-cancel',
          onClick: () => cancelActiveSearch(true),
        }, t('Cancel'))
        : null),
    isSearchingMode && (searchState.searching || searchState.incomplete || searchState.entries.length > 0)
      ? h('div', { className: 'dsb-ft-search-status', role: 'status' },
        searchState.searching
          ? h('span', null, t('Searching…'))
          : h('span', null, searchState.entries.length === 1 ? t('1 match') : t('{count} matches', { count: searchState.entries.length })),
        searchState.incomplete
          ? h('span', { className: 'dsb-ft-search-incomplete' }, searchIncompleteMessage(searchState))
          : null)
      : null,
    revealNotice ? h('div', { className: 'dsb-rp-error dsb-ft-notice', role: 'alert' }, h('p', null, revealNotice)) : null,
    (isSearchingMode ? searchState.error : error) ? h('div', { className: 'dsb-rp-error', role: 'alert' }, h('p', null, isSearchingMode ? searchState.error : error))
      : rootInfo.missing ? h('div', { className: 'dsb-rp-empty' }, t('Workspace folder is empty'))
        : (isSearchingMode ? (searchState.searching && rows.length === 0) : (loadingDirs.has('') && rootEntries.length === 0))
          ? h('div', { className: 'dsb-rp-empty' }, isSearchingMode ? t('Searching…') : t('Loading…'))
          : rows.length === 0 ? h('div', { className: 'dsb-rp-empty' }, isSearchingMode ? t('No matching files') : t('Workspace folder is empty'))
            : h('div', { ref: listRef, className: 'dsb-ft-list', role: 'tree', 'aria-label': t('Files') },
              rows,
              !isSearchingMode && rootInfo.truncated ? h('p', { className: 'dsb-pv-note' }, t('Showing first {count} entries', { count: 500 })) : null),
    h(FileTreeContextMenu, {
      menu,
      expanded,
      onOpen: openFileTarget,
      onToggleDir: toggleDir,
      onReveal: (path, root) => runOpenAction(path, 'reveal', root),
      onOpenDefault: (path, root) => runOpenAction(path, 'open', root),
      onCopyPath: (path, root) => copyPath(path, false, root),
      onCopyRelativePath: path => copyPath(path, true),
      onClose: () => setMenu(null),
    }))
}

/**
 * Inner workspace body mounted inside unified `BotPanel`'s `.bt-panel-workspace` view.
 * Keeps `FileTree`, open `FilePreview` tabs, `WorkspaceTerminal`, and opened plugin tabs
 * mounted while their tabs stay open so expanded folders, preview state, live PTY sessions,
 * and plugin state survive switching across Details, Side chat, Browser, and workspace tabs.
 */
export function WorkspacePaneBody({ sessionId, panel, team, registry = defaultSlots, readOnly = false, visible = true, terminalFocusNonce = 0, onConsumeTerminalFocus = null }) {
  const { actions, chat: feed } = team
  const [fileStates, setFileStates] = useState({})
  const [autoRefresh, setAutoRefresh] = useState(readSavedAutoRefresh)
  const [mountedPluginIds, setMountedPluginIds] = useState(() => new Set())
  const pluginEntries = useSlotEntries(registry, RIGHT_PANE_TAB_SLOT)
  const fileReqsRef = useRef(new Map())
  const loadedKeysRef = useRef(new Map())
  const autoRefreshRef = useRef(autoRefresh)
  autoRefreshRef.current = autoRefresh
  const previewWatchRootRef = useRef('')

  const openIds = useMemo(() => openTabIds(panel), [panel])
  const openSet = useMemo(() => new Set(openIds), [openIds])
  const previewEntries = useMemo(() => resolveOpenPreviews(panel), [panel])
  const previewEntriesRef = useRef(previewEntries)
  previewEntriesRef.current = previewEntries
  const changes = panel?.changes ?? null
  const terminalNonce = panel?.terminalNonce ?? 0

  const hasFiles = openSet.has('files')
  const hasChanges = openSet.has('changes') && Boolean(changes)
  const hasTerminal = openSet.has('terminal')

  const pluginTabs = useMemo(() => resolvePluginTabs(pluginEntries), [pluginEntries])
  const pluginById = useMemo(() => new Map(pluginTabs.map(tab => [tab.id, tab])), [pluginTabs])
  const rawTab = panel?.tab ?? openIds[0] ?? null
  const activePreview = previewEntries.find(entry => entry.id === rawTab) ?? null
  const activeTab = isPreviewTabId(rawTab) && !activePreview
    ? (hasFiles ? 'files' : openIds.find(id => !isPreviewTabId(id) || previewEntries.some(e => e.id === id)) ?? null)
    : rawTab
  const activePlugin = pluginById.get(activeTab) ?? null
  const selectedFilePath = activePreview?.path ?? panel?.file ?? null

  const openWorkspaceFile = useCallback((path) => {
    actions.openFile?.(path)
  }, [actions])
  const consumeAutoOpenNonce = useCallback((nonce) => {
    actions.consumeTerminalNonce?.(nonce)
  }, [actions])

  const toggleAutoRefresh = useCallback(() => {
    setAutoRefresh((cur) => {
      const next = !cur
      writeSavedAutoRefresh(next)
      return next
    })
  }, [])

  const loadPreviewEntry = useCallback((entry, { silent = false, retry = false } = {}) => {
    const reqId = (fileReqsRef.current.get(entry.id) ?? 0) + 1
    fileReqsRef.current.set(entry.id, reqId)
    const effectiveSessionId = entry.sessionId ?? sessionId
    const entryKey = `${effectiveSessionId ?? ''}:${entry.root ?? ''}:${entry.path}`
    loadedKeysRef.current.set(entry.id, entryKey)
    if (!silent) {
      setFileStates(current => ({
        ...current,
        [entry.id]: {
          key: entryKey,
          path: entry.path,
          data: current[entry.id]?.path === entry.path ? current[entry.id].data : null,
          loading: true,
          error: '',
          updated: false,
        },
      }))
    }
    const expectedRoot = !retry && entry.root ? entry.root : undefined
    void call('workspace-read', { sessionId: effectiveSessionId, path: entry.path, ...(expectedRoot ? { expectedRoot } : {}) })
      .then((res) => {
        if (fileReqsRef.current.get(entry.id) !== reqId) return
        if (res?.kind === 'dir') {
          actions.revealFolder?.({ path: res.path ?? entry.path, sessionId: effectiveSessionId })
          actions.closeWorkspaceTab?.(entry.id)
          return
        }
        setFileStates(current => ({
          ...current,
          [entry.id]: {
            key: entryKey,
            path: entry.path,
            data: res,
            loading: false,
            error: '',
            updated: false,
          },
        }))
      })
      .catch((failure) => {
        if (fileReqsRef.current.get(entry.id) !== reqId) return
        if (failure?.code === 'bot/refused' && entry.fallback !== null) {
          void Promise.resolve().then(() => entry.fallback()).catch(() => {
            actions.notice?.(t('Could not save this file'))
          })
          actions.closeWorkspaceTab?.(entry.id)
          return
        }
        setFileStates(current => ({
          ...current,
          [entry.id]: {
            key: entryKey,
            path: entry.path,
            data: silent ? (current[entry.id]?.data ?? null) : null,
            loading: false,
            error: hostText(failure?.message ?? String(failure)),
            updated: false,
          },
        }))
      })
  }, [sessionId, actions])
  const loadPreviewEntryRef = useRef(loadPreviewEntry)
  loadPreviewEntryRef.current = loadPreviewEntry

  // Load newly opened or changed preview tabs, and prune closed preview tab state.
  useEffect(() => {
    const activeIds = new Set(previewEntries.map(entry => entry.id))
    for (const id of [...loadedKeysRef.current.keys()]) {
      if (!activeIds.has(id)) {
        loadedKeysRef.current.delete(id)
        fileReqsRef.current.delete(id)
      }
    }
    setFileStates((current) => {
      const keys = Object.keys(current)
      if (keys.every(id => activeIds.has(id))) return current
      const next = {}
      for (const id of keys) if (activeIds.has(id)) next[id] = current[id]
      return next
    })
    for (const entry of previewEntries) {
      const effectiveSessionId = entry.sessionId ?? sessionId
      const entryKey = `${effectiveSessionId ?? ''}:${entry.root ?? ''}:${entry.path}`
      if (loadedKeysRef.current.get(entry.id) !== entryKey) {
        loadPreviewEntry(entry, { silent: false, retry: false })
      }
    }
  }, [previewEntries, sessionId, loadPreviewEntry])

  // Watch the active preview tab's workspace so external edits show "Updated · Reload"
  // or auto-refresh silently when enabled, even if the Files tab is hidden or closed.
  const activePreviewId = activePreview?.id ?? null
  const activePreviewPath = activePreview?.path ?? ''
  const activePreviewSessionId = activePreview?.sessionId ?? sessionId
  const activePreviewRoot = activePreview?.root ?? ''
  useEffect(() => {
    if (!visible || !activePreviewId || !activePreviewPath) return undefined
    let alive = true
    let watchId = null
    const parent = parentRelDir(activePreviewPath)
    const dirs = parent ? [parent] : []
    void call('workspace-watch', {
      sessionId: activePreviewSessionId,
      dirs,
      ...(activePreviewRoot ? { expectedRoot: activePreviewRoot } : {}),
    })
      .then((res) => {
        if (!alive) {
          if (res?.watchId) void call('workspace-unwatch', { watchId: res.watchId }).catch(() => {})
          return
        }
        watchId = res?.watchId ?? null
        previewWatchRootRef.current = res?.root ?? activePreviewRoot ?? ''
      })
      .catch(() => {})

    const off = typeof feed?.on === 'function'
      ? feed.on((event, data) => {
        if (!alive || event !== 'workspace-changed') return
        const entries = previewEntriesRef.current
        for (const entry of entries) {
          if (!previewMatchesChange(entry, data, previewWatchRootRef.current)) continue
          if (autoRefreshRef.current) {
            loadPreviewEntryRef.current(entry, { silent: true, retry: true })
          } else {
            setFileStates((current) => {
              const prev = current[entry.id]
              if (!prev || prev.updated) return current
              return { ...current, [entry.id]: { ...prev, updated: true } }
            })
          }
        }
      })
      : () => {}

    return () => {
      alive = false
      off()
      if (watchId) void call('workspace-unwatch', { watchId }).catch(() => {})
    }
  }, [visible, activePreviewId, activePreviewPath, activePreviewSessionId, activePreviewRoot, feed])

  // Lazily mount plugin tabs only once opened/activated, keep them mounted while open,
  // and unmount them as soon as their tab is closed or unregistered.
  useEffect(() => {
    setMountedPluginIds((current) => {
      let changed = false
      const next = new Set()
      for (const id of current) {
        if (openSet.has(id) && pluginById.has(id)) next.add(id)
        else changed = true
      }
      if (activePlugin && openSet.has(activePlugin.id) && !next.has(activePlugin.id)) {
        next.add(activePlugin.id)
        changed = true
      }
      return changed ? next : current
    })
  }, [activePlugin, openSet, pluginById])

  const mountedPlugins = useMemo(() => {
    const out = []
    const seen = new Set()
    for (const id of mountedPluginIds) {
      const plugin = pluginById.get(id)
      if (plugin && openSet.has(id) && !seen.has(id)) {
        seen.add(id)
        out.push(plugin)
      }
    }
    if (activePlugin && openSet.has(activePlugin.id) && !seen.has(activePlugin.id)) {
      out.push(activePlugin)
    }
    return out
  }, [mountedPluginIds, pluginById, openSet, activePlugin])

  // Notify terminal layout whenever the terminal pane becomes visible again after hiding.
  useEffect(() => {
    if (!visible || !hasTerminal || activeTab !== 'terminal') return undefined
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof Event !== 'function') return undefined
    const fire = () => { window.dispatchEvent(new Event('resize')) }
    if (typeof requestAnimationFrame === 'function') {
      const raf = requestAnimationFrame(fire)
      return () => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf) }
    }
    fire()
    return undefined
  }, [visible, hasTerminal, activeTab])

  if (!panel && mountedPlugins.length === 0) return null

  return h('div', { className: 'dsb-ws-body' },
    hasFiles
      ? h('div', { className: 'dsb-ws-pane', hidden: !visible || activeTab !== 'files' },
        h(FileTree, {
          sessionId,
          feed,
          actions,
          selectedPath: selectedFilePath,
          revealDir: panel?.revealDir ?? null,
          revealNonce: panel?.revealNonce ?? 0,
          onOpenFile: openWorkspaceFile,
          active: visible && activeTab === 'files',
        }))
      : null,
    previewEntries.map((entry) => {
      const state = fileStates[entry.id] ?? { data: null, loading: true, error: '', updated: false }
      return h('div', {
        key: entry.id,
        className: 'dsb-ws-pane',
        'data-preview-tab': entry.id,
        hidden: !visible || activeTab !== entry.id,
      },
      h(FilePreview, {
        file: state.data,
        line: entry.line ?? null,
        loading: state.loading,
        error: state.error,
        updated: state.updated === true,
        onReload: () => loadPreviewEntry(entry, { silent: true, retry: true }),
        autoRefresh,
        onToggleAutoRefresh: toggleAutoRefresh,
        onRetry: () => loadPreviewEntry(entry, { silent: false, retry: true }),
      }))
    }),
    hasChanges
      ? h('div', { className: 'dsb-ws-pane', hidden: !visible || activeTab !== 'changes' },
        h(ChangesReview, { changes, onOpenFile: openWorkspaceFile }))
      : null,
    hasTerminal
      ? h('div', { className: 'dsb-ws-pane', hidden: !visible || activeTab !== 'terminal' },
        h(WorkspaceTerminal, {
          sessionId,
          feed,
          readOnly,
          autoOpenNonce: terminalNonce,
          onConsumeAutoOpenNonce: consumeAutoOpenNonce,
          active: visible && activeTab === 'terminal',
          focusNonce: terminalFocusNonce,
          onConsumeFocusNonce: onConsumeTerminalFocus,
        }))
      : null,
    mountedPlugins.map(plugin => h('div', {
      key: plugin.id,
      className: 'dsb-ws-pane',
      'data-plugin-tab': plugin.id,
      hidden: !visible || activeTab !== plugin.id,
    },
    h(SlotErrorBoundary, {
      slotName: `${RIGHT_PANE_TAB_SLOT}:${plugin.slotId}`,
      resetKey: `${plugin.id}:${sessionId ?? ''}`,
      pluginId: plugin.pluginId,
      runtime: plugin.runtime,
      onRetry: (typeof plugin.component?.reset === 'function' || typeof plugin.onRetry === 'function')
        ? () => {
          plugin.component?.reset?.()
          plugin.onRetry?.()
        }
        : undefined,
    },
    h(plugin.component, { sessionId, team, actions })))))
}

export function RightPanel(props) {
  return h(WorkspacePaneBody, props)
}

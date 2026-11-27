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
      closable: false,
    }))
}

function openTabIds(panel) {
  if (!panel || typeof panel !== 'object') return []
  if (Array.isArray(panel.tabs)) return panel.tabs.filter(id => typeof id === 'string' && id !== '')
  return typeof panel.tab === 'string' && panel.tab !== '' ? [panel.tab] : []
}

/**
 * Builds the ordered workspace tab descriptors rendered in unified `BotPanel`'s tab strip.
 */
export function buildWorkspaceTabs(panel, pluginEntries = []) {
  const plugins = resolvePluginTabs(pluginEntries)
  const pluginById = new Map(plugins.map(tab => [tab.id, tab]))
  const tabs = []
  const seen = new Set()
  const filePath = panel?.file ?? null
  for (const id of openTabIds(panel)) {
    if (seen.has(id)) continue
    if (id === 'files') {
      seen.add(id)
      tabs.push({ id: 'files', label: t('Files'), icon: FolderIcon, closable: true })
    } else if (id === 'preview' && filePath) {
      seen.add(id)
      const name = String(filePath).split(/[\\/]/).filter(Boolean).at(-1) || t('Preview')
      tabs.push({ id: 'preview', label: name, icon: FileIcon, closable: true })
    } else if (id === 'changes' && panel?.changes) {
      seen.add(id)
      tabs.push({ id: 'changes', label: t('Changes'), icon: DiffIcon, closable: true })
    } else if (id === 'terminal') {
      seen.add(id)
      tabs.push({ id: 'terminal', label: t('Terminal'), icon: TerminalIcon, closable: true })
    } else if (pluginById.has(id)) {
      seen.add(id)
      const plugin = pluginById.get(id)
      tabs.push({ id: plugin.id, label: plugin.label, icon: plugin.icon, closable: false })
    }
  }
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) continue
    seen.add(plugin.id)
    tabs.push({ id: plugin.id, label: plugin.label, icon: plugin.icon, closable: false })
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

function FileTree({ sessionId, feed, actions, selectedPath, revealDir = null, revealNonce = 0, onOpenFile, active = true }) {
  const [rootInfo, setRootInfo] = useState({ root: '', rootName: '', missing: false, truncated: false })
  const [childrenByPath, setChildrenByPath] = useState({})
  const [truncatedDirs, setTruncatedDirs] = useState(() => new Set())
  const [expanded, setExpanded] = useState(() => new Set())
  const [loadingDirs, setLoadingDirs] = useState(() => new Set())
  const [includeHidden, setIncludeHidden] = useState(false)
  const [filter, setFilter] = useState('')
  const [highlightedDir, setHighlightedDir] = useState(null)
  const [revealNotice, setRevealNotice] = useState('')
  const [error, setError] = useState('')
  const [menu, setMenu] = useState(null)
  const genRef = useRef(0)
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

  const openFileTarget = useCallback((path) => {
    setRevealNotice('')
    onOpenFile(rootPathRef.current ? { path, root: rootPathRef.current } : path)
  }, [onOpenFile])

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

  const rootEntries = childrenByPath[''] ?? []
  const rows = TreeBranch({
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
    filter,
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
      })),
    revealNotice ? h('div', { className: 'dsb-rp-error dsb-ft-notice', role: 'alert' }, h('p', null, revealNotice)) : null,
    error ? h('div', { className: 'dsb-rp-error', role: 'alert' }, h('p', null, error))
      : rootInfo.missing ? h('div', { className: 'dsb-rp-empty' }, t('Workspace folder is empty'))
        : loadingDirs.has('') && rootEntries.length === 0 ? h('div', { className: 'dsb-rp-empty' }, t('Loading…'))
          : rows.length === 0 ? h('div', { className: 'dsb-rp-empty' }, filter.trim() ? t('No matching files') : t('Workspace folder is empty'))
            : h('div', { ref: listRef, className: 'dsb-ft-list', role: 'tree', 'aria-label': t('Files') },
              rows,
              rootInfo.truncated ? h('p', { className: 'dsb-pv-note' }, t('Showing first {count} entries', { count: 500 })) : null),
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
 * Keeps `FileTree` and `WorkspaceTerminal` mounted while their tabs stay open so expanded
 * folders and live PTY sessions survive switching across Details, Side chat, Browser, and
 * other workspace tabs.
 */
export function WorkspacePaneBody({ sessionId, panel, team, registry = defaultSlots, readOnly = false, visible = true }) {
  const { actions, chat: feed } = team
  const [fileState, setFileState] = useState({ path: null, data: null, loading: false, error: '' })
  const [retryState, setRetryState] = useState({ key: null, count: 0 })
  const pluginEntries = useSlotEntries(registry, RIGHT_PANE_TAB_SLOT)
  const fileReqRef = useRef(0)

  const openIds = useMemo(() => openTabIds(panel), [panel])
  const openSet = useMemo(() => new Set(openIds), [openIds])
  const filePath = panel?.file ?? null
  const fileSessionId = panel?.fileSessionId ?? sessionId
  const fileRoot = panel?.fileRoot ?? null
  const fileFallback = typeof panel?.fileFallback === 'function' ? panel.fileFallback : null
  const changes = panel?.changes ?? null
  const terminalNonce = panel?.terminalNonce ?? 0

  const hasFiles = openSet.has('files')
  const hasPreview = openSet.has('preview') && Boolean(filePath)
  const hasChanges = openSet.has('changes') && Boolean(changes)
  const hasTerminal = openSet.has('terminal')

  const fileKey = hasPreview ? `${fileSessionId ?? ''}:${fileRoot ?? ''}:${filePath}` : null
  const retryCount = retryState.key === fileKey ? retryState.count : 0

  const pluginTabs = useMemo(() => resolvePluginTabs(pluginEntries), [pluginEntries])
  const rawTab = panel?.tab ?? openIds[0] ?? null
  const activePlugin = pluginTabs.find(tab => tab.id === rawTab) ?? null
  const activeTab = rawTab === 'preview' && !hasPreview
    ? (hasFiles ? 'files' : openIds.find(id => id !== 'preview') ?? null)
    : rawTab

  const openWorkspaceFile = useCallback((path) => {
    actions.openFile?.(path)
  }, [actions])

  // Load workspace file contents whenever a preview tab is open and `panel.file` or retry updates.
  useEffect(() => {
    if (!hasPreview || !filePath) return undefined
    const reqId = ++fileReqRef.current
    setFileState(current => ({
      path: filePath,
      data: current.path === filePath ? current.data : null,
      loading: true,
      error: '',
    }))
    // Enforce `expectedRoot` on the initial click from FileTree so a mid-session `working_directory`
    // move never opens a different file; an explicit Retry (`retryCount > 0`) reads the live root.
    const expectedRoot = retryCount === 0 && fileRoot ? fileRoot : undefined
    void call('workspace-read', { sessionId: fileSessionId, path: filePath, ...(expectedRoot ? { expectedRoot } : {}) })
      .then((res) => {
        if (fileReqRef.current !== reqId) return
        if (res?.kind === 'dir') {
          actions.revealFolder?.({ path: res.path ?? filePath, sessionId: fileSessionId })
          actions.closeWorkspaceTab?.('preview')
          return
        }
        setFileState({ path: filePath, data: res, loading: false, error: '' })
      })
      .catch((failure) => {
        if (fileReqRef.current !== reqId) return
        if (failure?.code === 'bot/refused' && fileFallback !== null) {
          void Promise.resolve().then(() => fileFallback()).catch(() => {
            actions.notice?.(t('Could not save this file'))
          })
          actions.closeWorkspaceTab?.('preview')
          return
        }
        setFileState({ path: filePath, data: null, loading: false, error: hostText(failure?.message ?? String(failure)) })
      })
    return () => {
      if (fileReqRef.current === reqId) fileReqRef.current += 1
    }
  }, [hasPreview, fileSessionId, filePath, fileRoot, fileFallback, retryCount, actions])

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

  if (!panel && !activePlugin) return null

  return h('div', { className: 'dsb-ws-body' },
    hasFiles
      ? h('div', { className: 'dsb-ws-pane', hidden: !visible || activeTab !== 'files' },
        h(FileTree, {
          sessionId,
          feed,
          actions,
          selectedPath: filePath,
          revealDir: panel?.revealDir ?? null,
          revealNonce: panel?.revealNonce ?? 0,
          onOpenFile: openWorkspaceFile,
          active: visible && activeTab === 'files',
        }))
      : null,
    hasPreview
      ? h('div', { className: 'dsb-ws-pane', hidden: !visible || activeTab !== 'preview' },
        h(FilePreview, {
          file: fileState.data,
          line: panel?.fileLine ?? null,
          loading: fileState.loading,
          error: fileState.error,
          onRetry: () => setRetryState(prev => ({ key: fileKey, count: prev.key === fileKey ? prev.count + 1 : 1 })),
        }))
      : null,
    hasChanges
      ? h('div', { className: 'dsb-ws-pane', hidden: !visible || activeTab !== 'changes' },
        h(ChangesReview, { changes, onOpenFile: openWorkspaceFile }))
      : null,
    hasTerminal
      ? h('div', { className: 'dsb-ws-pane', hidden: !visible || activeTab !== 'terminal' },
        h(WorkspaceTerminal, { sessionId, feed, readOnly, autoOpenNonce: terminalNonce }))
      : null,
    activePlugin
      ? h('div', { className: 'dsb-ws-pane', hidden: !visible },
        h(SlotErrorBoundary, {
          key: activePlugin.id,
          slotName: `${RIGHT_PANE_TAB_SLOT}:${activePlugin.slotId}`,
          resetKey: `${activePlugin.id}:${sessionId ?? ''}`,
          pluginId: activePlugin.pluginId,
          runtime: activePlugin.runtime,
          onRetry: (typeof activePlugin.component?.reset === 'function' || typeof activePlugin.onRetry === 'function')
            ? () => {
              activePlugin.component?.reset?.()
              activePlugin.onRetry?.()
            }
            : undefined,
        },
        h(activePlugin.component, { sessionId, team, actions })))
      : null)
}

export function RightPanel(props) {
  return h(WorkspacePaneBody, props)
}

// Desktop workspace right panel: File Tree, Multi-Format Document Preview, Turn Changes
// Diff Review, Interactive Terminal, and `sidebar.right.pane.tab` plugin slot support.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { fileSizeText } from '../../../ds-bot/src/client/dsh-primitives.js'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'
import { ChevronRightIcon, CloseIcon, DiffIcon, FileIcon, FolderIcon, SearchIcon, TerminalIcon } from '../../../ds-bot/src/client/icons.js'
import { useEscape } from '../../../ds-bot/src/client/overlay-hooks.js'
import { ChangesReview } from './changes-review.js'
import { FilePreview } from './file-preview.js'
import { defaultSlots, RIGHT_PANE_TAB_SLOT, SlotErrorBoundary, useSlotEntries } from './slots.js'
import { WorkspaceTerminal } from './workspace-terminal.js'

const RefreshIcon = () => h('svg', {
  width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, h('path', { d: 'M15.5 10a5.5 5.5 0 1 1-1.6-3.9' }), h('path', { d: 'M15.5 3.5v3.5H12' }))

const WIDTH_STORAGE_KEY = 'dsb:right-panel-w'
const DEFAULT_WIDTH = 440
const MIN_WIDTH = 340
const MAX_WIDTH = 760
const MIN_CHAT_WIDTH = 420
const SIDEBAR_WIDE_WIDTH = 280
const SIDEBAR_RAIL_WIDTH = 56
const MAX_TREE_DEPTH = 32

function loadSavedWidth() {
  try {
    const raw = Number(globalThis.localStorage?.getItem?.(WIDTH_STORAGE_KEY))
    if (Number.isFinite(raw) && raw >= MIN_WIDTH && raw <= MAX_WIDTH) return Math.round(raw)
  } catch { /* storage unavailable */ }
  return DEFAULT_WIDTH
}

function saveWidth(width) {
  try {
    globalThis.localStorage?.setItem?.(WIDTH_STORAGE_KEY, String(Math.round(width)))
  } catch { /* storage unavailable */ }
}

function viewportWidth() {
  return typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1440
}

function measureMainLeft(vpWidth, wide) {
  if (typeof document !== 'undefined') {
    const main = document.querySelector?.('.dsb-main')
    const left = main?.getBoundingClientRect?.().left
    if (Number.isFinite(left) && left >= 0) return Math.round(left)
  }
  return vpWidth <= 768 ? 0 : (wide ? SIDEBAR_WIDE_WIDTH : SIDEBAR_RAIL_WIDTH)
}

function maxDockedWidth(vpWidth, leftOffset) {
  return Math.min(MAX_WIDTH, Math.round(vpWidth * 0.55), Math.max(0, vpWidth - leftOffset - MIN_CHAT_WIDTH))
}

function TreeBranch({ entries, depth, ancestors, expanded, childrenByPath, loadingDirs, selectedPath, filter, onToggleDir, onSelectFile }) {
  if (depth >= MAX_TREE_DEPTH) return []
  const needle = filter.trim().toLowerCase()
  const rows = []
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
          selectedPath,
          filter,
          onToggleDir,
          onSelectFile,
        })
      }
      if (!matchesSelf && childRows.length === 0) continue
      rows.push(h('button', {
        key: `dir:${depth}:${path}:${entry.name}`,
        type: 'button',
        role: 'treeitem',
        className: 'dsb-ft-row is-dir',
        style: { paddingLeft: `${10 + depth * 14}px` },
        'aria-expanded': isOpen,
        onClick: () => { if (!isCyclic) onToggleDir(path) },
      },
      h('span', { className: 'dsb-ft-chev', 'data-open': isOpen || undefined, 'aria-hidden': true }, h(ChevronRightIcon)),
      h('span', { className: 'dsb-ft-ico', 'aria-hidden': true }, h(FolderIcon)),
      h('span', { className: 'dsb-ft-name', title: path }, entry.name),
      loadingDirs.has(path) ? h('span', { className: 'dsb-ft-meta' }, '…') : null))
      if (isOpen && childRows.length > 0) rows.push(...childRows)
    } else {
      if (needle !== '' && !entry.name.toLowerCase().includes(needle) && !entry.path.toLowerCase().includes(needle)) continue
      rows.push(h('button', {
        key: `file:${depth}:${entry.path}:${entry.name}`,
        type: 'button',
        role: 'treeitem',
        className: 'dsb-ft-row is-file',
        style: { paddingLeft: `${26 + depth * 14}px` },
        'aria-current': selectedPath === entry.path ? 'true' : undefined,
        onClick: () => onSelectFile(entry.path),
      },
      h('span', { className: 'dsb-ft-ico', 'aria-hidden': true }, h(FileIcon)),
      h('span', { className: 'dsb-ft-name', title: entry.path }, entry.name),
      Number.isFinite(entry.size) ? h('span', { className: 'dsb-ft-meta' }, fileSizeText(entry.size)) : null))
    }
  }
  return rows
}

function FileTree({ sessionId, selectedPath, onOpenFile }) {
  const [rootInfo, setRootInfo] = useState({ root: '', rootName: '', missing: false, truncated: false })
  const [childrenByPath, setChildrenByPath] = useState({})
  const [expanded, setExpanded] = useState(() => new Set())
  const [loadingDirs, setLoadingDirs] = useState(() => new Set())
  const [includeHidden, setIncludeHidden] = useState(false)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [refreshTick, setRefreshTick] = useState(0)
  const genRef = useRef(0)

  const loadDir = useCallback(async (dirPath, gen) => {
    setLoadingDirs(current => new Set(current).add(dirPath))
    try {
      const res = await call('workspace-list', { sessionId, path: dirPath, includeHidden })
      if (genRef.current !== gen) return
      if (dirPath === '') {
        setRootInfo({
          root: res.root ?? '',
          rootName: res.rootName ?? '',
          missing: res.missing === true,
          truncated: res.truncated === true,
        })
      }
      setChildrenByPath(current => ({ ...current, [dirPath]: res.entries ?? [] }))
      setError('')
    } catch (failure) {
      if (genRef.current !== gen) return
      if (dirPath === '') setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (genRef.current === gen) {
        setLoadingDirs((current) => {
          const next = new Set(current)
          next.delete(dirPath)
          return next
        })
      }
    }
  }, [sessionId, includeHidden])

  useEffect(() => {
    const gen = ++genRef.current
    setChildrenByPath({})
    setExpanded(new Set())
    setLoadingDirs(new Set())
    setError('')
    void loadDir('', gen)
  }, [sessionId, includeHidden, refreshTick, loadDir])

  const toggleDir = (dirPath) => {
    const isOpen = expanded.has(dirPath)
    setExpanded((current) => {
      const next = new Set(current)
      if (isOpen) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
    if (!isOpen && !Object.hasOwn(childrenByPath, dirPath)) {
      void loadDir(dirPath, genRef.current)
    }
  }

  const rootEntries = childrenByPath[''] ?? []
  const rows = TreeBranch({
    entries: rootEntries,
    depth: 0,
    ancestors: new Set(['']),
    expanded,
    childrenByPath,
    loadingDirs,
    selectedPath,
    filter,
    onToggleDir: toggleDir,
    onSelectFile: onOpenFile,
  })

  return h('div', { className: 'dsb-ft' },
    h('div', { className: 'dsb-ft-bar' },
      h('span', { className: 'dsb-ft-root', title: rootInfo.root }, rootInfo.rootName || t('Workspace')),
      h('div', { className: 'dsb-ft-actions' },
        h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm',
          'aria-pressed': includeHidden,
          onClick: () => setIncludeHidden(v => !v),
        }, includeHidden ? t('Hide dotfiles') : t('Show hidden')),
        h('button', {
          type: 'button',
          className: 'bt-icon-btn',
          'aria-label': t('Refresh'),
          title: t('Refresh'),
          onClick: () => setRefreshTick(n => n + 1),
        }, h(RefreshIcon)))),
    h('div', { className: 'dsb-ft-search' },
      h('span', { className: 'dsb-ft-search-ico', 'aria-hidden': true }, h(SearchIcon)),
      h('input', {
        type: 'search',
        className: 'dsb-ft-search-input',
        value: filter,
        placeholder: t('Filter files…'),
        'aria-label': t('Filter files…'),
        onChange: event => setFilter(event.target.value),
      })),
    error ? h('div', { className: 'dsb-rp-error', role: 'alert' }, h('p', null, error))
      : rootInfo.missing ? h('div', { className: 'dsb-rp-empty' }, t('Workspace folder is empty'))
        : loadingDirs.has('') && rootEntries.length === 0 ? h('div', { className: 'dsb-rp-empty' }, t('Loading…'))
          : rows.length === 0 ? h('div', { className: 'dsb-rp-empty' }, filter.trim() ? t('No matching files') : t('Workspace folder is empty'))
            : h('div', { className: 'dsb-ft-list', role: 'tree', 'aria-label': t('Files') },
              rows,
              rootInfo.truncated ? h('p', { className: 'dsb-pv-note' }, t('Showing first {count} entries', { count: 500 })) : null))
}

/**
 * Resizable workspace right panel hosting Files, Preview, Changes, Terminal, and
 * `sidebar.right.pane.tab` slot contributions.
 */
export function RightPanel({ sessionId, panel, team, registry = defaultSlots, readOnly = false, wide = true }) {
  const { actions, chat: feed } = team
  const [savedWidth, setSavedWidth] = useState(loadSavedWidth)
  const [metrics, setMetrics] = useState(() => {
    const vp = viewportWidth()
    return { vp, left: measureMainLeft(vp, wide) }
  })
  const [resizing, setResizing] = useState(false)
  const [fileState, setFileState] = useState({ path: null, data: null, loading: false, error: '' })
  const [reloadNonce, setReloadNonce] = useState(0)
  const [terminalMounted, setTerminalMounted] = useState(false)
  const pluginEntries = useSlotEntries(registry, RIGHT_PANE_TAB_SLOT)
  const fileReqRef = useRef(0)
  const dragCleanupRef = useRef(null)

  const open = panel !== null && panel !== undefined
  const activeTab = panel?.tab ?? 'files'
  const filePath = panel?.file ?? null
  const changes = panel?.changes ?? null
  const terminalNonce = panel?.terminalNonce ?? 0

  const maxDock = maxDockedWidth(metrics.vp, metrics.left)
  const overlay = metrics.vp <= 960 || maxDock < MIN_WIDTH
  const renderedWidth = overlay
    ? Math.min(savedWidth, Math.round(metrics.vp * 0.92))
    : Math.max(MIN_WIDTH, Math.min(savedWidth, maxDock))

  useEffect(() => {
    if (open && activeTab === 'terminal') setTerminalMounted(true)
  }, [open, activeTab])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const sync = () => {
      const vp = viewportWidth()
      const left = measureMainLeft(vp, wide)
      setMetrics(prev => (prev.vp === vp && prev.left === left ? prev : { vp, left }))
    }
    sync()
    window.addEventListener('resize', sync)
    let ro = null
    if (typeof ResizeObserver === 'function') {
      const main = document.querySelector?.('.dsb-main')
      if (main) {
        ro = new ResizeObserver(sync)
        ro.observe(main)
      }
    }
    return () => {
      window.removeEventListener('resize', sync)
      ro?.disconnect()
    }
  }, [wide, open])
  useEffect(() => () => { dragCleanupRef.current?.() }, [])

  // Intercept Escape whenever the right panel floats over the conversation as an overlay.
  useEscape(() => actions.closeRightPanel?.(), open && overlay)

  // Load workspace file contents whenever `panel.file` or `reloadNonce` updates.
  useEffect(() => {
    if (!open || !filePath) return undefined
    const reqId = ++fileReqRef.current
    setFileState(current => ({
      path: filePath,
      data: current.path === filePath ? current.data : null,
      loading: true,
      error: '',
    }))
    void call('workspace-read', { sessionId, path: filePath })
      .then((res) => {
        if (fileReqRef.current !== reqId) return
        setFileState({ path: filePath, data: res, loading: false, error: '' })
      })
      .catch((failure) => {
        if (fileReqRef.current !== reqId) return
        setFileState({ path: filePath, data: null, loading: false, error: hostText(failure?.message ?? String(failure)) })
      })
    return () => {
      if (fileReqRef.current === reqId) fileReqRef.current += 1
    }
  }, [open, sessionId, filePath, reloadNonce])

  const pluginTabs = useMemo(() => pluginEntries
    .filter(entry => entry && typeof entry.id === 'string' && entry.component)
    .map(entry => ({
      id: `plugin:${entry.id}`,
      slotId: entry.id,
      label: typeof entry.meta?.label === 'function' ? entry.meta.label() : (entry.meta?.label ?? entry.id),
      icon: entry.meta?.icon ?? FileIcon,
      component: entry.component,
    })), [pluginEntries])

  const onDragStart = (event) => {
    if (overlay) return
    event.preventDefault()
    dragCleanupRef.current?.()
    const handleEl = event.currentTarget
    const pointerId = event.pointerId
    try { handleEl?.setPointerCapture?.(pointerId) } catch { /* pointer capture optional */ }
    const startX = event.clientX
    const startW = renderedWidth
    let latest = startW
    setResizing(true)
    const onMove = (moveEvent) => {
      const vp = viewportWidth()
      const cap = Math.max(MIN_WIDTH, maxDockedWidth(vp, measureMainLeft(vp, wide)))
      latest = Math.max(MIN_WIDTH, Math.min(cap, startW + (startX - moveEvent.clientX)))
      setSavedWidth(latest)
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
      try { handleEl?.releasePointerCapture?.(pointerId) } catch { /* already released */ }
      dragCleanupRef.current = null
      setResizing(false)
      saveWidth(latest)
    }
    dragCleanupRef.current = stop
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
  }

  if (!open) return null

  const tabs = [
    { id: 'files', label: t('Files'), icon: FolderIcon },
    ...(filePath ? [{ id: 'preview', label: filePath.split(/[\\/]/).filter(Boolean).at(-1) || t('Preview'), icon: FileIcon }] : []),
    ...(changes ? [{ id: 'changes', label: t('Changes'), icon: DiffIcon }] : []),
    { id: 'terminal', label: t('Terminal'), icon: TerminalIcon },
    ...pluginTabs,
  ]

  const activePlugin = pluginTabs.find(tab => tab.id === activeTab)
  const showFiles = activeTab === 'files' || (!activePlugin && activeTab !== 'preview' && activeTab !== 'changes' && activeTab !== 'terminal')

  return h('aside', {
    className: 'dsb-rightbar',
    'data-rightbar-col': '',
    'data-overlay': overlay ? '' : undefined,
    'data-resizing': resizing ? '' : undefined,
    style: { '--dsb-right-w': `${renderedWidth}px` },
    'aria-label': t('Workspace'),
  },
  overlay ? null : h('div', {
    className: 'dsb-rightbar-resize',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': t('Resize panel'),
    onPointerDown: onDragStart,
  }),
  h('div', { className: 'dsb-rightbar-head' },
    h('div', { className: 'dsb-rightbar-tabs', role: 'tablist' },
      tabs.map(tab => h('button', {
        key: tab.id,
        type: 'button',
        role: 'tab',
        className: 'dsb-rightbar-tab',
        'aria-selected': activeTab === tab.id,
        title: tab.label,
        onClick: () => actions.setRightPanelTab?.(tab.id),
      },
      h('span', { className: 'dsb-rightbar-tab-ico', 'aria-hidden': true }, h(tab.icon)),
      h('span', { className: 'dsb-rightbar-tab-label' }, tab.label)))),
    h('button', {
      type: 'button',
      className: 'bt-icon-btn dsb-rightbar-close',
      'aria-label': t('Close'),
      title: t('Close'),
      onClick: () => actions.closeRightPanel?.(),
    }, h(CloseIcon))),
  h('div', { className: 'dsb-rightbar-body' },
    h('div', { className: 'dsb-rightbar-pane', hidden: !showFiles },
      h(FileTree, { sessionId, selectedPath: filePath, onOpenFile: path => actions.openFile?.(path) })),
    activeTab === 'preview'
      ? h(FilePreview, {
        file: fileState.data,
        loading: fileState.loading,
        error: fileState.error,
        onRetry: () => setReloadNonce(n => n + 1),
      })
      : null,
    activeTab === 'changes'
      ? h(ChangesReview, { changes, onOpenFile: path => actions.openFile?.(path) })
      : null,
    terminalMounted || activeTab === 'terminal'
      ? h('div', { className: 'dsb-rightbar-pane', hidden: activeTab !== 'terminal' },
        h(WorkspaceTerminal, { sessionId, feed, readOnly, autoOpenNonce: terminalNonce }))
      : null,
    activePlugin
      ? h(SlotErrorBoundary, { key: activePlugin.id, slotName: `${RIGHT_PANE_TAB_SLOT}:${activePlugin.slotId}`, resetKey: `${activePlugin.id}:${sessionId ?? ''}` },
        h(activePlugin.component, { sessionId, team, actions }))
      : null))
}

// Workspace right-panel body and tab builders hosted inside unified `BotPanel`:
// File Tree, Multi-Format Document Preview, Turn Changes Diff Review, Interactive
// Terminal, and `sidebar.right.pane.tab` plugin slot support.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { fileSizeText } from '../../../ds-bot/src/client/dsh-primitives.js'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'
import { ChevronRightIcon, DiffIcon, FileIcon, FolderIcon, SearchIcon, TerminalIcon } from '../../../ds-bot/src/client/icons.js'
import { ChangesReview } from './changes-review.js'
import { FilePreview } from './file-preview.js'
import { defaultSlots, RIGHT_PANE_TAB_SLOT, SlotErrorBoundary, useSlotEntries } from './slots.js'
import { WorkspaceTerminal } from './workspace-terminal.js'

const RefreshIcon = () => h('svg', {
  width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, h('path', { d: 'M15.5 10a5.5 5.5 0 1 1-1.6-3.9' }), h('path', { d: 'M15.5 3.5v3.5H12' }))

const MAX_TREE_DEPTH = 32

function resolvePluginTabs(pluginEntries) {
  if (!Array.isArray(pluginEntries)) return []
  return pluginEntries
    .filter(entry => entry && typeof entry.id === 'string' && entry.component)
    .map(entry => ({
      id: `plugin:${entry.id}`,
      slotId: entry.id,
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

  const rootPathRef = useRef('')
  rootPathRef.current = rootInfo.root

  const loadDir = useCallback(async (dirPath, gen) => {
    setLoadingDirs(current => new Set(current).add(dirPath))
    try {
      const expectedRoot = dirPath !== '' && rootPathRef.current ? rootPathRef.current : undefined
      const res = await call('workspace-list', { sessionId, path: dirPath, includeHidden, ...(expectedRoot ? { expectedRoot } : {}) })
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
      if (dirPath !== '' && failure?.code === 'bot/stale') {
        setRefreshTick(n => n + 1)
        return
      }
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
    onSelectFile: path => onOpenFile(rootPathRef.current ? { path, root: rootPathRef.current } : path),
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
        setFileState({ path: filePath, data: res, loading: false, error: '' })
      })
      .catch((failure) => {
        if (fileReqRef.current !== reqId) return
        setFileState({ path: filePath, data: null, loading: false, error: hostText(failure?.message ?? String(failure)) })
      })
    return () => {
      if (fileReqRef.current === reqId) fileReqRef.current += 1
    }
  }, [hasPreview, fileSessionId, filePath, fileRoot, retryCount])

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
        h(FileTree, { sessionId, selectedPath: filePath, onOpenFile: openWorkspaceFile }))
      : null,
    hasPreview
      ? h('div', { className: 'dsb-ws-pane', hidden: !visible || activeTab !== 'preview' },
        h(FilePreview, {
          file: fileState.data,
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
        h(SlotErrorBoundary, { key: activePlugin.id, slotName: `${RIGHT_PANE_TAB_SLOT}:${activePlugin.slotId}`, resetKey: `${activePlugin.id}:${sessionId ?? ''}` },
          h(activePlugin.component, { sessionId, team, actions })))
      : null)
}

export function RightPanel(props) {
  return h(WorkspacePaneBody, props)
}

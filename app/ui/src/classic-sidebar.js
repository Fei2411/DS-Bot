// Classic Agent mode sidebar, session header, and blank-session hero for the desktop
// app's own interface (docs/plans/2026-11-21-own-frontend.md): a plain session list
// (create, rename, archive) sharing the exact same conversation view and workspace right panel.
import { createElement as h, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FishLogo } from '../../../ds-bot/src/client/dsh-primitives.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ArchiveIcon, DotsIcon, FolderIcon, PencilIcon, PlusIcon, SidebarIcon } from '../../../ds-bot/src/client/icons.js'
import { relativeShort } from '../../../ds-bot/src/client/text.js'

const sessionLabel = session => (!session.blank && session.title && session.title.trim() !== '' ? session.title : t('New session'))

function folderBaseName(cwd) {
  if (typeof cwd !== 'string') return ''
  const trimmed = cwd.trim().replace(/[\\/]+$/, '')
  if (trimmed === '') return ''
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

function canSwimOnHover(event) {
  if (event?.pointerType === 'touch') return false
  if (typeof document !== 'undefined') {
    const fx = document.body?.dataset?.btEffects
    if (fx === 'off' || fx === 'reduced') return false
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches
  }
  return false
}

function ClassicSessionRow({ session, agent, actions, renaming, readOnly }) {
  const inputRef = useRef(null)
  const settledRef = useRef(false)
  useLayoutEffect(() => {
    if (!renaming) { settledRef.current = false; return }
    settledRef.current = false
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [renaming])

  if (renaming) {
    const initialTitle = session.blank ? '' : session.title
    const commit = (keep) => {
      if (settledRef.current) return
      settledRef.current = true
      const value = inputRef.current?.value ?? ''
      if (!keep || value.trim() === '' || value.trim() === initialTitle) {
        actions.endAgentRename?.()
        return
      }
      void (async () => {
        try {
          await actions.renameAgentSession(agent.id, session.id, value)
          actions.endAgentRename?.()
        } catch (error) {
          settledRef.current = false
          actions.reportError?.(error, 'agent-rename')
        }
      })()
    }
    return h('div', { className: 'dsb-classic-row dsb-classic-editing', role: 'listitem' },
      h('input', {
        ref: inputRef,
        className: 'bt-input dsb-classic-input',
        defaultValue: initialTitle,
        placeholder: t('New session'),
        'aria-label': t('Rename'),
        onKeyDown: (event) => {
          if (event.nativeEvent?.isComposing) return
          if (event.key === 'Enter') commit(true)
          else if (event.key === 'Escape') {
            event.stopPropagation()
            commit(false)
          }
        },
        onBlur: () => commit(true),
      }))
  }

  return h('div', {
    className: 'dsb-classic-row',
    role: 'listitem',
    'data-active': session.active ? '' : undefined,
    'data-has-actions': !readOnly ? '' : undefined,
    'data-session-id': session.id,
  },
  h('button', {
    type: 'button',
    className: 'dsb-classic-btn',
    'aria-current': session.active ? 'page' : undefined,
    onClick: () => actions.openAgentSession(session.id),
    onContextMenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      actions.openMenu?.({ kind: 'agent-session', id: session.id, agentId: agent.id, x: event.clientX, y: event.clientY })
    },
  },
  session.running ? h('span', { className: 'dsb-classic-dot', 'aria-hidden': true }) : null,
  h('span', { className: 'dsb-classic-title' }, sessionLabel(session)),
  session.at > 0 ? h('span', { className: 'dsb-classic-time' }, relativeShort(session.at)) : null),
  !readOnly ? h('div', { className: 'dsb-classic-acts' },
    h('button', {
      type: 'button',
      className: 'bt-icon-btn dsb-classic-act',
      'aria-label': t('Rename'),
      title: t('Rename'),
      onClick: (event) => {
        event.stopPropagation()
        actions.beginAgentRename?.(session.id)
      },
    }, h(PencilIcon)),
    h('button', {
      type: 'button',
      className: 'bt-icon-btn dsb-classic-act',
      'aria-label': t('Archive'),
      title: t('Archive'),
      onClick: (event) => {
        event.stopPropagation()
        void actions.archiveAgentSession(agent.id, session.id).catch(error => actions.reportError?.(error, 'agent-archive'))
      },
    }, h(ArchiveIcon))) : null)
}

export function ClassicSidebar({ useRoster, useSessions, useSessionStatus, useUi, actions, wide }) {
  const roster = useRoster(value => value)
  const agent = (roster.agents ?? [])[0] ?? null
  const readOnly = Boolean(roster.readOnly)
  const renaming = useUi(value => value.renameAgent)

  const sessionIds = agent?.sessions ?? []
  const infoKey = useSessions(list => JSON.stringify(sessionIds.map((id, order) => {
    const row = list.byId[id]
    const blank = row?.blank === true
    return {
      id,
      order,
      blank,
      title: blank ? '' : (row?.displayTitle || row?.title || ''),
      at: row?.updatedAt ?? 0,
      running: row?.running === true,
      active: (row?.retainedBy?.mainView ?? 0) > 0,
    }
  }).sort((a, b) => (b.at - a.at) || (b.order - a.order))))

  const statusKey = useSessionStatus(map => JSON.stringify(sessionIds.map(id => ({
    id,
    running: map.get(id)?.running === true,
  }))))

  const sessions = useMemo(() => {
    const statuses = Object.fromEntries(JSON.parse(statusKey).map(entry => [entry.id, entry]))
    return JSON.parse(infoKey).map(entry => ({
      ...entry,
      running: statuses[entry.id]?.running ?? entry.running,
    }))
  }, [infoKey, statusKey])

  const createSession = () => {
    if (readOnly) return
    const promise = agent
      ? actions.newAgentSession(agent.id)
      : actions.addAgent()
    void Promise.resolve(promise).catch(error => actions.reportError?.(error, 'agent-session'))
  }

  if (!wide) {
    return h('div', { className: 'dsb-classic-rail', 'data-classic-sidebar': 'rail' },
      h('button', {
        type: 'button',
        className: 'bt-round dsb-classic-rail-btn',
        disabled: readOnly,
        'aria-label': t('New session'),
        title: t('New session'),
        onClick: createSession,
      }, h(PlusIcon)))
  }

  return h('div', { className: 'dsb-classic-side', 'data-classic-sidebar': 'wide' },
    h('div', { className: 'dsb-classic-head' },
      h('span', { className: 'dsb-classic-brand' },
        h('span', { className: 'dsb-classic-brand-logo', 'aria-hidden': true }, h(FishLogo, { size: 22 })),
        h('span', { className: 'dsb-classic-brand-name' }, 'DSH Agent')),
      h('button', {
        type: 'button',
        className: 'bt-round dsb-classic-collapse',
        'aria-label': t('Collapse sidebar'),
        title: t('Collapse sidebar'),
        onClick: () => actions.toggleSidebar?.(),
      }, h(SidebarIcon))),
    h('button', {
      type: 'button',
      className: 'dsb-classic-new',
      disabled: readOnly,
      onClick: createSession,
    },
    h('span', { className: 'dsb-classic-new-ico', 'aria-hidden': true }, h(PlusIcon)),
    h('span', { className: 'dsb-classic-new-label' }, t('New session'))),
    h('div', { className: 'dsb-classic-list', role: 'list', 'aria-label': t('Classic Agent mode') },
      sessions.length === 0
        ? h('div', { className: 'dsb-classic-empty' },
          h('span', { className: 'dsb-classic-empty-mark', 'aria-hidden': true }, h(FishLogo, { size: 28 })),
          h('span', { className: 'dsb-classic-empty-text' }, t('No messages yet')))
        : sessions.map(session => h(ClassicSessionRow, {
          key: session.id,
          session,
          agent,
          actions,
          renaming: renaming === session.id,
          readOnly,
        }))))
}

const NO_STATUS_MAP = new Map()
const NO_UI_STATE = {}
const useNoStatus = selector => selector(NO_STATUS_MAP)
const useNoUi = selector => selector(NO_UI_STATE)

export function ClassicHeader({ sessionId, agent, useSessions, useSessionStatus, useUi, actions, readOnly = false, sidebarWide = true }) {
  const hasRow = useSessions(list => list.byId[sessionId] !== undefined)
  const title = useSessions((list) => {
    const row = list.byId[sessionId]
    if (!row || row.blank === true) return ''
    return row.displayTitle || row.title || ''
  })
  const blank = useSessions((list) => {
    const row = list.byId[sessionId]
    if (!row) return true
    if (row.blank !== true) return false
    const outline = row.projectionValues?.turnOutline
    return !Array.isArray(outline) || outline.length === 0
  })
  const running = (useSessionStatus ?? useNoStatus)(map => map.get(sessionId)?.running === true)
  const renaming = (useUi ?? useNoUi)(value => value.renameAgent === sessionId)
  const moreRef = useRef(null)
  const inputRef = useRef(null)
  const settledRef = useRef(false)
  const inlineRename = renaming && !sidebarWide

  useLayoutEffect(() => {
    if (!inlineRename) { settledRef.current = false; return }
    settledRef.current = false
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [inlineRename])

  const named = !blank && title.trim() !== ''
  const label = named ? title : t('New session')
  const showActions = !readOnly && Boolean(agent) && hasRow && !blank

  if (inlineRename && agent) {
    const commit = (keep) => {
      if (settledRef.current) return
      settledRef.current = true
      const value = inputRef.current?.value ?? ''
      if (!keep || value.trim() === '' || value.trim() === title) {
        actions.endAgentRename?.()
        return
      }
      void (async () => {
        try {
          await actions.renameAgentSession(agent.id, sessionId, value)
          actions.endAgentRename?.()
        } catch (error) {
          settledRef.current = false
          actions.reportError?.(error, 'agent-rename')
        }
      })()
    }
    return h('header', { className: 'dsb-classic-bar dsb-classic-bar-editing' },
      h('div', { className: 'dsb-classic-bar-edit' },
        h('input', {
          ref: inputRef,
          className: 'bt-input dsb-classic-bar-input',
          defaultValue: title,
          placeholder: t('New session'),
          'aria-label': t('Rename'),
          onKeyDown: (event) => {
            if (event.nativeEvent?.isComposing) return
            if (event.key === 'Enter') commit(true)
            else if (event.key === 'Escape') {
              event.stopPropagation()
              commit(false)
            }
          },
          onBlur: () => commit(true),
        })))
  }

  const openActionsMenu = (event) => {
    event.stopPropagation()
    const rect = moreRef.current?.getBoundingClientRect?.()
    const x = rect ? Math.round(rect.left) : event.clientX
    const y = rect ? Math.round(rect.bottom + 6) : event.clientY
    actions.openMenu?.({ kind: 'agent-session', id: sessionId, agentId: agent.id, x, y })
  }

  if (blank) {
    return h('header', { className: 'dsb-classic-bar', 'data-blank': '' })
  }

  return h('header', {
    className: 'dsb-classic-bar',
    'data-has-actions': showActions ? '' : undefined,
  },
  h('div', { className: 'dsb-classic-bar-center' },
    h('span', { className: 'dsb-classic-bar-title', title: label }, label),
    running ? h('span', { className: 'dsb-classic-bar-dot', 'aria-hidden': true }) : null,
    showActions ? h('button', {
      ref: moreRef,
      type: 'button',
      className: 'dsb-classic-bar-more',
      'aria-label': t('Session actions'),
      'aria-haspopup': 'menu',
      title: t('Session actions'),
      onClick: openActionsMenu,
    }, h(DotsIcon)) : null))
}

export function AgentEmptyHero({ cwd, actions, readOnly = false, noSession = false }) {
  const [hovering, setHovering] = useState(false)
  const folderName = folderBaseName(cwd)
  const canOpenFiles = typeof actions?.openFiles === 'function'

  return h('div', { className: 'dsb-agent-hero', 'data-agent-hero': '' },
    h('div', { className: 'dsb-agent-hero-head' },
      h('span', {
        className: 'dsb-agent-hero-hitbox',
        'aria-hidden': true,
        onPointerEnter: (event) => {
          if (canSwimOnHover(event)) setHovering(true)
        },
        onPointerLeave: () => setHovering(false),
      }, h(FishLogo, { size: 36, className: 'dsb-agent-hero-fish', swim: hovering })),
      h('h1', { className: 'dsb-agent-hero-title' }, 'DSH Agent')),
    noSession
      ? h('button', {
        type: 'button',
        className: 'bt-soft dsb-agent-hero-cta',
        disabled: readOnly,
        onClick: () => {
          void Promise.resolve(actions?.createClassicSession?.()).catch(error => actions?.reportError?.(error, 'agent-session'))
        },
      }, h(PlusIcon), h('span', null, t('New session')))
      : folderName
        ? (canOpenFiles
            ? h('button', {
              type: 'button',
              className: 'dsb-agent-hero-folder',
              title: cwd,
              'aria-label': `${t('Working folder')}: ${folderName}`,
              onClick: () => actions.openFiles(),
            },
            h('span', { className: 'dsb-agent-hero-folder-ico', 'aria-hidden': true }, h(FolderIcon)),
            h('span', { className: 'dsb-agent-hero-folder-name' }, folderName))
            : h('span', { className: 'dsb-agent-hero-folder is-static', title: cwd },
              h('span', { className: 'dsb-agent-hero-folder-ico', 'aria-hidden': true }, h(FolderIcon)),
              h('span', { className: 'dsb-agent-hero-folder-name' }, folderName)))
        : null)
}

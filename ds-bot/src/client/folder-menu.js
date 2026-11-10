import { createElement as h, Fragment, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, FolderIcon, PencilIcon } from './icons.js'
import { Caret, useAnchoredMenu } from './model-menu.js'
import { t } from './i18n.js'

// The last segment of a host path, Windows or POSIX; a root keeps its own spelling.
export const folderName = path => String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(path)

const Tick = ({ on }) => h('span', { className: 'bt-model-tick', 'aria-hidden': true }, on ? h(CheckIcon) : null)

// Where a Bot, or every member of a group, works. `value` is the saved folder; without
// one a Bot works in the team workspace and a group member in its own folder. `onPick`
// gets the chosen path, or '' for that default. `team` is the menu for the team workspace
// itself, which has no default. `adding` picks one more extra folder: it has no default
// and no saved value.
export function FolderMenu({ value, group = false, team = false, adding = false, actions, run, onPick, wide = false, disabled = false }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu()
  const [info, setInfo] = useState(null)
  const [view, setView] = useState('list')
  const [draft, setDraft] = useState('')
  const [listing, setListing] = useState(null)
  const [problem, setProblem] = useState('')
  const fallback = group ? t("Each Bot's own folder") : t('Team workspace')
  const toggle = () => {
    if (isOpen) { close(); return }
    setView('list')
    setProblem('')
    // Projects added in DSH meanwhile show up, so opening asks again.
    void Promise.resolve(actions.folders()).then(setInfo).catch(() => setInfo(last => last ?? { team: null, picker: null, folders: [] }))
    open()
  }
  const choose = (path) => {
    close()
    if (path !== (value ?? '')) void onPick(path)
  }
  const browse = (path) => {
    setProblem('')
    void Promise.resolve(actions.folderList(path)).then((next) => { setListing(next); setView('browse') })
      .catch(failure => setProblem(failure?.message ?? String(failure)))
  }
  const pickNative = () => {
    close()
    void run(Promise.resolve(actions.folderPick()).then(path => (path ? onPick(path) : undefined)))
  }
  const typed = () => {
    const path = draft.trim()
    if (path !== '') choose(path)
  }
  const known = info?.folders ?? []
  const folders = value && !known.some(folder => folder.path === value) ? [{ path: value, title: folderName(value) }, ...known] : known
  const listView = h('div', { key: 'list', className: 'bt-folder-view' },
    team || adding ? null : h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': !value, title: group ? undefined : info?.team ?? undefined, onClick: () => choose('') },
      h('span', { className: 'bt-menu-label' }, fallback), h(Tick, { on: !value })),
    folders.length > 0 ? h('div', { className: 'bt-model-group', role: 'presentation' }, t('Folders')) : null,
    folders.map(folder => h('button', { key: folder.path, type: 'button', role: 'menuitemradio', 'aria-checked': folder.path === value, title: folder.path, onClick: () => choose(folder.path) },
      h('span', { className: 'bt-folder-copy' }, h('span', { className: 'bt-menu-label' }, folder.title), h('span', { className: 'bt-folder-path' }, folder.path)),
      h(Tick, { on: folder.path === value }))),
    h('div', { className: 'bt-menu-sep', role: 'separator' }),
    info?.picker === 'native' ? h('button', { type: 'button', role: 'menuitem', onClick: pickNative }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Choose a folder…'))) : null,
    info?.picker === 'browse' ? h('button', { type: 'button', role: 'menuitem', onClick: () => browse(value) }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Browse folders…'))) : null,
    h('button', { type: 'button', role: 'menuitem', onClick: () => { setDraft(value ?? ''); setView('type') } }, h(PencilIcon), h('span', { className: 'bt-menu-label' }, t('Enter a path…'))))
  const typeView = h('div', { key: 'type', className: 'bt-folder-view' },
    h('button', { type: 'button', className: 'bt-folder-back', onClick: () => setView('list') }, h(ChevronLeftIcon), h('span', { className: 'bt-menu-label' }, t('Back'))),
    h('input', {
      className: 'bt-folder-input', autoFocus: true, value: draft, spellCheck: false, 'aria-label': t('Folder path'), placeholder: t('Full path of a folder'),
      onChange: event => setDraft(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) typed() },
    }),
    h('button', { type: 'button', className: 'bt-folder-use', disabled: draft.trim() === '', onClick: typed }, t('Use this folder')))
  const parent = listing?.crumbs?.length > 1 ? listing.crumbs.at(-2) : undefined
  const inside = listing?.entries?.filter(entry => !entry.hidden) ?? []
  const browseView = listing ? h('div', { key: `browse:${listing.path}`, className: 'bt-folder-view' },
    h('button', { type: 'button', className: 'bt-folder-back', onClick: () => setView('list') }, h(ChevronLeftIcon), h('span', { className: 'bt-menu-label' }, t('Back'))),
    h('div', { className: 'bt-folder-path bt-folder-here' }, listing.path),
    parent ? h('button', { type: 'button', role: 'menuitem', title: parent.path, onClick: () => browse(parent.path) }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Up one level'))) : null,
    inside.map(entry => h('button', { key: entry.path, type: 'button', role: 'menuitem', onClick: () => browse(entry.path) },
      h(FolderIcon), h('span', { className: 'bt-menu-label' }, entry.name), h(ChevronRightIcon))),
    inside.length === 0 ? h('div', { className: 'bt-model-none' }, t('No folders inside.')) : null,
    listing.truncated ? h('div', { className: 'bt-folder-path bt-folder-here' }, t('Some folders are not shown.')) : null,
    h('div', { className: 'bt-menu-sep', role: 'separator' }),
    h('button', { type: 'button', className: 'bt-folder-use', onClick: () => choose(listing.path) }, t('Use this folder'))) : null
  const shownView = view === 'type' ? typeView : view === 'browse' && browseView ? browseView : listView
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-model-trigger', 'data-wide': wide || undefined,
      'aria-haspopup': 'menu', 'aria-expanded': isOpen, 'aria-label': adding ? t('Add an extra folder') : team ? t('Team workspace: {folder}', { folder: value ?? '' }) : t('Working folder: {folder}', { folder: value ?? fallback }),
      title: value, onClick: toggle, disabled,
    },
    h('span', { className: 'bt-model-copy' },
      h('span', { className: 'bt-model-name' }, adding ? t('Add folder') : value ? folderName(value) : fallback),
      value ? h('span', { className: 'bt-model-provider' }, value) : null),
    h(Caret)),
    shownPlace ? createPortal(h('div', { ref: menu, className: `bt-menu bt-model-menu bt-folder-menu${shownPlace.bottom !== undefined ? ' bt-menu-up' : ''}`, role: 'menu', 'aria-label': adding ? t('Extra folders') : team ? t('Team workspace') : t('Working folder'), style: shownPlace, 'data-leaving': leaving || undefined },
      shownView,
      problem ? h('div', { className: 'bt-folder-error', role: 'alert' }, problem) : null), document.body) : null)
}

// The folders a Bot, or every member of a group, works in besides its working folder:
// one row each with a remove button, then a menu that adds one. `onSave` gets the
// whole new list.
export function ExtraFolders({ value = [], group = false, actions, run, onSave, disabled = false }) {
  return h(Fragment, null,
    value.map(path => h('div', { key: path, className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy', title: path },
        h('span', { className: 'bt-bs-label' }, folderName(path)),
        h('span', { className: 'bt-set-hint bt-folder-path' }, path)),
      h('button', {
        type: 'button', className: 'bt-x', disabled,
        'aria-label': t('Remove {folder}', { folder: path }), title: t('Remove'),
        onClick: () => onSave(value.filter(entry => entry !== path)),
      }, '×'))),
    h('div', { className: 'bt-set-row bt-bs-row' },
      h('span', { className: 'bt-set-copy' },
        h('span', { className: 'bt-bs-label' }, t('Extra folders')),
        h('span', { className: 'bt-set-hint' }, group ? t('Every member also reads and changes files here, without asking you each time.') : t('The Bot also reads and changes files here, without asking you each time.'))),
      h(FolderMenu, { adding: true, actions, run, disabled, onPick: path => (value.includes(path) ? undefined : onSave([...value, path])) })))
}

export const FOLDER_CSS = `
.bt-folder-view{display:flex;flex-direction:column;gap:2px;animation:bt-veil-in .14s ease-out}
.bt-folder-copy{flex:1;display:flex;flex-direction:column;min-width:0}
.bt-folder-copy .bt-menu-label{flex:none}
.bt-folder-path{min-width:0;font-size:11px;line-height:14px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-folder-here{padding:0 8px 4px;white-space:normal;overflow-wrap:anywhere}
.bt-menu .bt-folder-back{color:var(--bt-ink-2);font-weight:500}
.bt-folder-input{height:30px;margin:2px 4px;padding:0 8px;border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;outline:none;box-sizing:border-box}
.bt-folder-input:focus{border-color:var(--bt-accent)}
.bt-menu .bt-folder-use{justify-content:center;font-weight:500;color:var(--bt-accent)}
.bt-menu .bt-folder-use:disabled{color:var(--bt-ink-3);cursor:default;background:none}
.bt-model-trigger:disabled{opacity:.6;cursor:default}
.bt-folder-error{padding:4px 8px;font-size:12px;line-height:16px;color:var(--bt-danger);overflow-wrap:anywhere}
@media (prefers-reduced-motion:reduce){.bt-folder-view{animation:none}}
`

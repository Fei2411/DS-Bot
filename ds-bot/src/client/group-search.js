// Search a group's own history. The group's ledger book keeps every line whole, so
// this dialog searches that book through the host (no second store): every hit shows
// who said it, when, and its neighbours, so the message can be read in context.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { t, hostText } from './i18n.js'
import { SearchIcon, CloseIcon, ChevronRightIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { clockLabel } from './text.js'

const EXIT_MS = 160
const MIN_QUERY = 2
const DEBOUNCE_MS = 220
const SNIPPET_CHARS = 180

const termsOf = query => [...new Set(String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean))]

// Every place a matched word lands, marked in the text.
function marked(text, terms) {
  const source = String(text ?? '')
  if (terms.length === 0) return source
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu')
  return source.split(pattern).map((part, at) => (at % 2 === 1 ? h('mark', { key: at }, part) : part))
}

// The first hit's place in a long line, kept short.
function snippetOf(text, terms) {
  const source = String(text ?? '')
  if (source.length <= SNIPPET_CHARS) return source
  const lower = source.toLowerCase()
  const at = terms.reduce((best, term) => {
    const found = lower.indexOf(term)
    return found >= 0 && (best < 0 || found < best) ? found : best
  }, -1)
  const from = Math.max(0, (at < 0 ? 0 : at) - 60)
  return `${from > 0 ? '…' : ''}${source.slice(from, from + SNIPPET_CHARS)}${from + SNIPPET_CHARS < source.length ? '…' : ''}`
}

const authorOf = (line, roster) => (line?.botId === undefined
  ? t('You')
  : roster.byId[line.botId]?.name ?? line?.name ?? t('a Bot'))

function Line({ line, roster, terms, className }) {
  return h('div', { className },
    h('div', { className: 'bt-gs-meta' },
      h('span', { className: 'bt-gs-author' }, authorOf(line, roster)),
      Number.isFinite(line.time) ? h('span', { className: 'bt-gs-when' }, clockLabel(line.time)) : null),
    h('div', { className: 'bt-gs-line' }, marked(line.text, terms)))
}

// One hit opened: the whole message, who said it, and the lines around it.
function Detail({ hit, roster, terms, back }) {
  return h('div', { className: 'bt-gs-detail' },
    h('button', { type: 'button', className: 'bt-gs-back', onClick: back },
      h('span', { className: 'bt-gs-back-ico', 'aria-hidden': true }, h(ChevronRightIcon)), t('Back to results')),
    h('div', { className: 'bt-gs-meta' },
      h('span', { className: 'bt-gs-author' }, authorOf(hit, roster)),
      Number.isFinite(hit.time) ? h('span', { className: 'bt-gs-when' }, clockLabel(hit.time)) : null),
    h('div', { className: 'bt-gs-full' }, marked(hit.text, terms)),
    hit.before !== undefined || hit.after !== undefined
      ? h('div', { className: 'bt-gs-context', 'aria-label': t('Around this message') },
        h('div', { className: 'bt-gs-context-label' }, t('Around this message')),
        hit.before !== undefined ? h(Line, { line: hit.before, roster, terms, className: 'bt-gs-ctx' }) : null,
        hit.after !== undefined ? h(Line, { line: hit.after, roster, terms, className: 'bt-gs-ctx' }) : null)
      : null)
}

export function GroupSearch({ room, roster, token, actions }) {
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState(null)
  const [busy, setBusy] = useState(false)
  const [paging, setPaging] = useState(false)
  const [error, setError] = useState(null)
  const [moreError, setMoreError] = useState(null)
  const [picked, setPicked] = useState(null)
  const [leaving, setLeaving] = useState(false)
  const input = useRef(null)
  const generation = useRef(0)
  const moreCall = useRef(null)
  const close = () => {
    if (leaving) return
    setLeaving(true)
    setTimeout(() => actions.closeGroupSearch(token), EXIT_MS)
  }
  useEscape(close)
  const terms = termsOf(query)
  const text = query.trim()
  useEffect(() => {
    const mine = ++generation.current
    moreCall.current?.abort()
    if (text.length < MIN_QUERY) {
      setAnswer(null)
      setBusy(false)
      setPaging(false)
      setError(null)
      setMoreError(null)
      return undefined
    }
    setPaging(false)
    setMoreError(null)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setBusy(true)
      call('group-search', { roomId: room.id, query: text }, controller.signal).then((result) => {
        if (mine !== generation.current) return
        setAnswer({ query: text, results: Array.isArray(result?.results) ? result.results : [], hasMore: result?.hasMore === true })
        setBusy(false)
        setError(null)
      }, (failure) => {
        if (failure?.name === 'AbortError' || mine !== generation.current) return
        setBusy(false)
        setError(failure)
      })
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); controller.abort(); moreCall.current?.abort() }
  }, [text, room.id])
  useEffect(() => { setPicked(null) }, [text])
  const results = answer?.results ?? []
  const loadMore = () => {
    if (paging || answer?.query !== text || answer?.hasMore !== true) return undefined
    const oldest = results.at(-1)?.seq
    const page = Number.isInteger(oldest) ? { before: oldest } : { offset: results.length }
    const mine = generation.current
    const controller = new AbortController()
    moreCall.current?.abort()
    moreCall.current = controller
    setPaging(true)
    setMoreError(null)
    return call('group-search', { roomId: room.id, query: text, ...page }, controller.signal).then((result) => {
      if (mine !== generation.current) return
      const incoming = Array.isArray(result?.results) ? result.results : []
      setAnswer(prev => {
        const seen = new Set((prev?.results ?? []).map(hit => hit.seq).filter(seq => seq !== undefined))
        const next = incoming.filter(hit => hit.seq === undefined || !seen.has(hit.seq))
        return { query: prev?.query ?? text, results: [...(prev?.results ?? []), ...next], hasMore: result?.hasMore === true }
      })
      setPaging(false)
    }, (failure) => {
      if (failure?.name === 'AbortError' || mine !== generation.current) return
      setPaging(false)
      setMoreError(failure)
    })
  }
  const body = picked !== null
    ? h(Detail, { hit: picked, roster, terms, back: () => setPicked(null) })
    : text.length < MIN_QUERY
      ? h('div', { className: 'bt-palette-empty' },
        h('span', { className: 'bt-palette-empty-icon', 'aria-hidden': true }, h(SearchIcon)),
        h('span', { className: 'bt-palette-empty-label' }, t('Search this group’s messages')),
        h('span', { className: 'bt-palette-empty-hint' }, t('Type at least two characters')))
      : error !== null
        ? h('div', { className: 'bt-palette-empty' }, h('span', { className: 'bt-palette-empty-label' }, hostText(error?.message ?? error)))
        : results.length === 0
          ? h('div', { className: 'bt-palette-empty' },
            busy ? h('span', { className: 'bt-palette-empty-label' }, t('Searching…'))
              : [h('span', { className: 'bt-palette-empty-icon', key: 'ico', 'aria-hidden': true }, h(SearchIcon)),
                h('span', { className: 'bt-palette-empty-label', key: 'label' }, t('No messages found')),
                h('span', { className: 'bt-palette-empty-hint', key: 'hint' }, t('Try a different word'))])
          : results.map((hit, index) => h('button', {
            key: `${hit.seq ?? index}`, type: 'button', className: 'bt-gs-row', onClick: () => setPicked(hit),
          },
          h('div', { className: 'bt-gs-meta' },
            h('span', { className: 'bt-gs-author' }, authorOf(hit, roster)),
            Number.isFinite(hit.time) ? h('span', { className: 'bt-gs-when' }, clockLabel(hit.time)) : null),
          h('div', { className: 'bt-gs-snippet' }, marked(snippetOf(hit.text, terms), terms))))
  const current = answer?.query === text
  const more = current && answer?.hasMore === true
    ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: paging, onClick: () => void loadMore() }, t('Load more'))
    : null
  const footer = current && picked === null && error === null && text.length >= MIN_QUERY && results.length > 0
    ? h('div', { className: 'bt-gs-foot' },
      h('span', null, results.length === 1 ? t('1 match') : t('{count} matches', { count: results.length })),
      more !== null || moreError !== null
        ? h('span', { className: 'bt-gs-foot-side' },
          moreError !== null ? h('span', null, hostText(moreError?.message ?? moreError)) : null,
          more)
        : null)
    : null
  return h('div', { className: 'bt-palette-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-backdrop', onMouseDown: close }),
    h('div', { className: 'bt-palette bt-gs', role: 'dialog', 'aria-modal': true, 'aria-label': t('Search this group') },
      h('div', { className: 'bt-palette-head' },
        h('span', { className: 'bt-palette-glyph', 'aria-hidden': true }, h(SearchIcon)),
        h('input', {
          ref: input, autoFocus: true, value: query, 'aria-label': t('Search this group'),
          placeholder: t('Search messages in {name}', { name: room.name }),
          onChange: event => setQuery(event.target.value),
        }),
        query !== ''
          ? h('button', { type: 'button', className: 'bt-palette-clear', 'aria-label': t('Clear search'), onClick: () => { setQuery(''); setPicked(null); input.current?.focus() } }, h(CloseIcon))
          : h('button', { type: 'button', className: 'bt-palette-clear', 'aria-label': t('Close'), onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-gs-body', 'aria-live': 'polite' }, body),
      footer))
}

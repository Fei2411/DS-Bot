// Plugin-only DOM adapter: bridges DSH's private DOM classes/attributes onto DS Bot's
// explicit `data-bt-*` contract so shared client modules never query DSH internals.
// Never imported by the desktop app (`app/ui/src/main.js`).
import { registerHostNodeSync } from './chat-room.js'

const MIRROR_ATTRS = [
  ['data-chat-flow-key', 'data-bt-flow-key'],
  ['data-chat-flow-kind', 'data-bt-flow-kind'],
  ['data-chat-group-key', 'data-bt-group-key'],
  ['data-slot', 'data-bt-slot'],
]
const MIRROR_BY_SOURCE = new Map(MIRROR_ATTRS)

// Grouped by target `data-bt-*` attribute so `stampOne` both sets AND removes flags
// when DSH removes its source attribute/class (e.g. `data-chat-running`).
const FLAG_RULES = [
  ['data-bt-center', ['[class*="_centerCol"]']],
  ['data-bt-scroll', ['[data-conversation-scroll]']],
  ['data-bt-to-bottom', ['[class*="_toBottomSlot"] > button']],
  ['data-bt-flow', ['[data-chat-flow]']],
  ['data-bt-running', ['[data-chat-running]']],
  ['data-bt-composer', ['[data-composer-card]']],
  ['data-bt-composer-input', ['[data-composer-input]', '[data-composer-card] [role="textbox"][contenteditable="true"]']],
  ['data-bt-composing', ['[data-composer-composing]']],
]

// Single compound selector for fast subtree scanning on childList mutations.
const ALL_SOURCE_SELECTOR = [
  ...FLAG_RULES.flatMap(([, sels]) => sels),
  ...MIRROR_ATTRS.map(([from]) => `[${from}]`),
].join(',')

const TAIL_NODE_SELECTOR = '[data-chat-following-tail],[class*="_toBottomSlot"],[class*="_toBottomSlot"] > button'
const TAIL_DESCENDANT_SELECTOR = '[data-chat-following-tail],[class*="_toBottomSlot"] > button'

const isElement = node => node != null && node.nodeType === 1

function setAttrIfChanged(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

function removeAttrIfPresent(el, name) {
  if (el.hasAttribute(name)) el.removeAttribute(name)
}

function syncTailState(scroller) {
  if (!isElement(scroller)) return
  if (!scroller.hasAttribute('data-conversation-scroll')) {
    removeAttrIfPresent(scroller, 'data-bt-following-tail')
    return
  }
  const following = scroller.querySelector('[data-chat-following-tail]') !== null
    ? 'true'
    : (scroller.querySelector('[class*="_toBottomSlot"] > button') !== null ? 'false' : 'true')
  setAttrIfChanged(scroller, 'data-bt-following-tail', following)
}

function syncFlag(el, attr, selectors) {
  let matched = false
  for (const sel of selectors) {
    if (el.matches?.(sel)) { matched = true; break }
  }
  if (matched) setAttrIfChanged(el, attr, '')
  else removeAttrIfPresent(el, attr)
}

function stampOne(el) {
  if (!isElement(el)) return
  for (const [attr, selectors] of FLAG_RULES) syncFlag(el, attr, selectors)
  for (const [from, to] of MIRROR_ATTRS) {
    if (el.hasAttribute(from)) setAttrIfChanged(el, to, el.getAttribute(from) ?? '')
    else removeAttrIfPresent(el, to)
  }
  syncTailState(el)
}

export function syncDshAncestors(node) {
  for (let cur = isElement(node) ? node : node?.parentElement; isElement(cur); cur = cur.parentElement) {
    stampOne(cur)
  }
}

export function syncDshNode(root) {
  if (!root) return
  if (isElement(root)) stampOne(root)
  if (typeof root.querySelectorAll !== 'function') return
  const matched = root.querySelectorAll(ALL_SOURCE_SELECTOR)
  for (const el of matched) stampOne(el)
}

function touchesTailNode(node) {
  if (!isElement(node)) return false
  if (node.matches?.(TAIL_NODE_SELECTOR)) return true
  return Boolean(node.querySelector?.(TAIL_DESCENDANT_SELECTOR))
}

const DIRECT_FLAG_ATTRS = new Map([
  ['data-conversation-scroll', 'data-bt-scroll'],
  ['data-chat-flow', 'data-bt-flow'],
  ['data-chat-running', 'data-bt-running'],
  ['data-composer-card', 'data-bt-composer'],
  ['data-composer-composing', 'data-bt-composing'],
])

const COMPOSER_INPUT_SELS = FLAG_RULES.find(([attr]) => attr === 'data-bt-composer-input')[1]
const TO_BOTTOM_SELS = FLAG_RULES.find(([attr]) => attr === 'data-bt-to-bottom')[1]

export function installDshAdapter(doc = document) {
  if (!doc) return () => {}
  const root = doc.body ?? doc.documentElement
  if (!root) return () => {}
  syncDshNode(root)
  const unregisterSync = registerHostNodeSync(syncDshAncestors)
  if (typeof MutationObserver !== 'function') return unregisterSync

  const observer = new MutationObserver((records) => {
    const dirtyScrollers = new Set()
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target
        if (!isElement(target)) continue
        const name = record.attributeName

        if (name === 'class') {
          const cls = typeof target.className === 'string' ? target.className : ''
          if (cls.includes('_centerCol')) setAttrIfChanged(target, 'data-bt-center', '')
          else if (target.hasAttribute('data-bt-center')) removeAttrIfPresent(target, 'data-bt-center')

          const isSlot = cls.includes('_toBottomSlot')
          const hadSlotBtn = !isSlot && target.querySelector?.(':scope > button[data-bt-to-bottom]') !== null
          if (isSlot || hadSlotBtn) {
            for (const child of target.children ?? []) {
              if (child.tagName === 'BUTTON') syncFlag(child, 'data-bt-to-bottom', TO_BOTTOM_SELS)
            }
            const scroller = target.closest?.('[data-conversation-scroll]')
            if (scroller) dirtyScrollers.add(scroller)
          }
          continue
        }

        if (name === 'data-chat-following-tail') {
          const scroller = target.closest?.('[data-conversation-scroll]')
          if (scroller) dirtyScrollers.add(scroller)
          continue
        }

        const mirrored = MIRROR_BY_SOURCE.get(name)
        if (mirrored) {
          if (target.hasAttribute(name)) setAttrIfChanged(target, mirrored, target.getAttribute(name) ?? '')
          else removeAttrIfPresent(target, mirrored)
          continue
        }

        const flag = DIRECT_FLAG_ATTRS.get(name)
        if (flag) {
          if (target.hasAttribute(name)) setAttrIfChanged(target, flag, '')
          else removeAttrIfPresent(target, flag)
          if (name === 'data-conversation-scroll') syncTailState(target)
          if (name === 'data-composer-card') {
            for (const tb of target.querySelectorAll?.('[role="textbox"][contenteditable="true"], [data-bt-composer-input]') ?? []) {
              syncFlag(tb, 'data-bt-composer-input', COMPOSER_INPUT_SELS)
            }
          }
          continue
        }

        if (name === 'data-composer-input' || name === 'role' || name === 'contenteditable') {
          syncFlag(target, 'data-bt-composer-input', COMPOSER_INPUT_SELS)
        }
        continue
      }
      if (record.type !== 'childList') continue
      const target = isElement(record.target) ? record.target : null
      for (const added of record.addedNodes) {
        if (!isElement(added)) continue
        syncDshNode(added)
        if (touchesTailNode(added)) {
          const scroller = added.closest?.('[data-conversation-scroll]') ?? target?.closest?.('[data-conversation-scroll]')
          if (scroller) dirtyScrollers.add(scroller)
        }
      }
      for (const removed of record.removedNodes) {
        if (!isElement(removed)) continue
        if (touchesTailNode(removed)) {
          const scroller = target?.closest?.('[data-conversation-scroll]')
          if (scroller) dirtyScrollers.add(scroller)
        }
      }
    }
    for (const scroller of dirtyScrollers) syncTailState(scroller)
  })

  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'class',
      'role',
      'contenteditable',
      'data-conversation-scroll',
      'data-chat-following-tail',
      'data-chat-flow',
      'data-chat-running',
      'data-chat-flow-key',
      'data-chat-flow-kind',
      'data-chat-group-key',
      'data-slot',
      'data-composer-card',
      'data-composer-input',
      'data-composer-composing',
    ],
  })
  return () => {
    unregisterSync()
    observer.disconnect()
  }
}

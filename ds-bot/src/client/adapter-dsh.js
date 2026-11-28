// Plugin-only DOM adapter: bridges DSH's private DOM classes/attributes onto DS Bot's
// explicit `data-bt-*` contract so shared client modules never query DSH internals.
// Never imported by the desktop app (`app/ui/src/main.js`).

const MIRROR_ATTRS = [
  ['data-chat-flow-key', 'data-bt-flow-key'],
  ['data-chat-flow-kind', 'data-bt-flow-kind'],
  ['data-chat-group-key', 'data-bt-group-key'],
  ['data-slot', 'data-bt-slot'],
]

const FLAG_SELECTORS = [
  ['[class*="_centerCol"]', 'data-bt-center'],
  ['[data-conversation-scroll]', 'data-bt-scroll'],
  ['[class*="_toBottomSlot"] > button', 'data-bt-to-bottom'],
  ['[data-chat-flow]', 'data-bt-flow'],
  ['[data-chat-running]', 'data-bt-running'],
  ['[data-composer-card]', 'data-bt-composer'],
  ['[data-composer-input]', 'data-bt-composer-input'],
  ['[data-composer-card] [role="textbox"][contenteditable="true"]', 'data-bt-composer-input'],
  ['[data-composer-composing]', 'data-bt-composing'],
]

const isElement = node => node != null && node.nodeType === 1

function setAttrIfChanged(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

function removeAttrIfPresent(el, name) {
  if (el.hasAttribute(name)) el.removeAttribute(name)
}

function syncTailState(scroller) {
  if (!isElement(scroller)) return
  const following = scroller.querySelector('[data-chat-following-tail]') !== null
    ? 'true'
    : (scroller.querySelector('[class*="_toBottomSlot"] > button') !== null ? 'false' : 'true')
  setAttrIfChanged(scroller, 'data-bt-following-tail', following)
}

function stampOne(el) {
  if (!isElement(el)) return
  for (const [selector, attr] of FLAG_SELECTORS) {
    if (el.matches?.(selector)) setAttrIfChanged(el, attr, '')
  }
  for (const [from, to] of MIRROR_ATTRS) {
    if (el.hasAttribute(from)) setAttrIfChanged(el, to, el.getAttribute(from) ?? '')
  }
  if (el.hasAttribute('data-conversation-scroll')) syncTailState(el)
}

export function syncDshNode(root) {
  if (!root) return
  if (isElement(root)) stampOne(root)
  if (typeof root.querySelectorAll !== 'function') return
  for (const [selector, attr] of FLAG_SELECTORS) {
    for (const el of root.querySelectorAll(selector)) setAttrIfChanged(el, attr, '')
  }
  for (const [from, to] of MIRROR_ATTRS) {
    for (const el of root.querySelectorAll(`[${from}]`)) {
      setAttrIfChanged(el, to, el.getAttribute(from) ?? '')
    }
  }
  for (const scroller of root.querySelectorAll('[data-conversation-scroll]')) {
    syncTailState(scroller)
  }
}

function touchesTailNode(node) {
  if (!isElement(node)) return false
  if (node.hasAttribute('data-chat-following-tail')) return true
  if (node.matches?.('[class*="_toBottomSlot"], [class*="_toBottomSlot"] > button')) return true
  return Boolean(node.querySelector?.('[data-chat-following-tail], [class*="_toBottomSlot"] > button'))
}

export function installDshAdapter(doc = document) {
  if (!doc) return () => {}
  const root = doc.body ?? doc.documentElement
  if (!root) return () => {}
  syncDshNode(root)
  if (typeof MutationObserver !== 'function') return () => {}

  const observer = new MutationObserver((records) => {
    const dirtyScrollers = new Set()
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target
        if (!isElement(target)) continue
        const name = record.attributeName
        if (name === 'data-composer-composing') {
          if (target.hasAttribute('data-composer-composing')) setAttrIfChanged(target, 'data-bt-composing', '')
          else removeAttrIfPresent(target, 'data-bt-composing')
          continue
        }
        if (name === 'data-chat-following-tail') {
          const scroller = target.closest?.('[data-conversation-scroll]')
          if (scroller) dirtyScrollers.add(scroller)
          continue
        }
        const mirrored = MIRROR_ATTRS.find(([from]) => from === name)
        if (mirrored) {
          const [from, to] = mirrored
          if (target.hasAttribute(from)) setAttrIfChanged(target, to, target.getAttribute(from) ?? '')
          else removeAttrIfPresent(target, to)
          continue
        }
        stampOne(target)
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
  return () => observer.disconnect()
}

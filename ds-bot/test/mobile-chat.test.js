import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// styles.js reaches React through motion.js; the CSS itself needs none of it, so the
// bundle is loaded with an empty React and only the CSS strings are read back.
const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { CONVERSATION_CSS, SHELL_CSS } from './src/client/styles.js'",
    resolveDir: plugin,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})
const loaded = { exports: {} }
new Function('module', 'exports', 'require', outputFiles[0].text)(loaded, loaded.exports, () => ({}))
const { CONVERSATION_CSS, SHELL_CSS } = loaded.exports

// The phone rules live in one width breakpoint, so both a Bot chat and a group's
// chat flow get them, and the desktop shares stay as they are.
const breakpoint = '@media (max-width:640px){'
const phone = (() => {
  const at = CONVERSATION_CSS.indexOf(breakpoint)
  assert.notEqual(at, -1, 'no phone breakpoint in the conversation styles')
  let depth = 0
  for (let index = at; index < CONVERSATION_CSS.length; index += 1) {
    if (CONVERSATION_CSS[index] === '{') depth += 1
    else if (CONVERSATION_CSS[index] === '}') {
      depth -= 1
      if (depth === 0) return CONVERSATION_CSS.slice(at, index + 1)
    }
  }
  assert.fail('the phone breakpoint is not closed')
})()

test('the phone breakpoint gives the chat flow the width of the screen', () => {
  assert.match(phone, /\.bt-msg,\.bt-astack\[data-lead\]>\.bt-msg\{max-width:100%\}/)
  assert.match(phone, /\.bt-bubble,\[data-chat-flow\] \[class\*="_bubble"\]\{max-width:100%;overflow-wrap:anywhere;word-break:break-word\}/)
  assert.match(phone, /\[data-chat-flow\] :is\(pre,table\)\{max-width:100%;overflow-x:auto\}/)
})

test('the phone breakpoint makes a card full width and its options tappable', () => {
  assert.match(phone, /\.bt-q\{width:100%;max-width:none;/)
  assert.match(phone, /\.bt-q-inline \.bt-q,\.bt-q-inline \.dv-view,\.bt-q-inline \.dv-q\{width:100%;max-width:100%\}/)
  assert.match(phone, /\.bt-q \.bt-q-opt,\.bt-q button,\.bt-q-inline \.dv-view button,\.dv-seg\.dv-view-seg button\{min-height:44px\}/)
  assert.match(phone, /\.bt-q-opt-label,\.bt-q-inline \.dv-q-label\{white-space:normal;overflow-wrap:anywhere\}/)
})

test('the desktop widths stay outside the phone breakpoint', () => {
  assert.ok(SHELL_CSS.includes('.bt-msg{display:flex;flex-direction:column;align-items:flex-start;max-width:min(calc(var(--bt-msg-w) * 100%),calc(100% - 82px))}'))
  assert.ok(SHELL_CSS.includes('.bt-bubble{max-width:min(calc(var(--bt-msg-w) * 100%),calc(100% - 82px))'))
  assert.ok(CONVERSATION_CSS.includes('.bt-q-inline .bt-q{margin:0;max-width:min(550px,86%);order:0}'))
})

test('the phone floating header paints solid so the transcript does not show through it', () => {
  // What scrolls under the header showed through the fade beneath the title
  // (issue 1669): on the phone both the header and its cover layer take the
  // main background, while the desktop keeps the floating transparent look.
  assert.match(phone, /header\[class\*="_header"\]:has\(\.bt-head\)\{background:var\(--bt-main\)!important\}/)
  assert.match(phone, /header\[class\*="_header"\]:has\(\.bt-head\)::before\{background:var\(--bt-main\)!important\}/)
  // The cover keeps the height the transcript's top padding clears, so the first
  // message meets the bar's bottom edge with no gap and no see-through band left.
  assert.match(CONVERSATION_CSS, /header\[class\*="_header"\]:has\(\.bt-head\)::before\{content:"";position:absolute;inset:0 0 auto;height:calc\(60px \+ env\(safe-area-inset-top,0px\)\)/)
  // The bar stays click-through on the phone: only its controls take taps.
  assert.doesNotMatch(phone, /header\[class\*="_header"\]:has\(\.bt-head\)\{background:var\(--bt-main\)!important;[^}]*pointer-events/)
})

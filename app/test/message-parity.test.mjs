import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DICTIONARY, installLocale, t } from '../../ds-bot/src/client/i18n.js'
import { installMiniDom } from './mini-dom.mjs'

const entryCode = `
  export {
    MarkdownText,
    projectUserText,
    FileTypeIcon,
    JsonBlock,
  } from './ui/src/primitives.js'
  export { ensureLanguage, isLanguageLoaded, highlightSync } from './ui/src/code-highlight.js'
  export { ensureKatex, normalizeMathDelimiters, escapeCurrencyDollars } from './ui/src/math-render.js'
  export { parseFileTarget, parseLocalFileHref, isInlineCodeFilePath, extractUserFileRefs, matchFileMention } from './ui/src/file-references.js'
  export { UserMessageText, tokenizeUserText, copyableUserText } from './ui/src/user-text.js'
  export { SessionTranscript } from './ui/src/session-chat.js'
  export { feedbackErrorMessage } from './ui/src/classic-feedback.js'
  export { FilePreview } from './ui/src/file-preview.js'
  export { WorkspacePaneBody, normalizeRevealPath } from './ui/src/right-panel.js'
  export { createTeam } from './ui/src/team.js'
  export { ChatRows } from '../ds-bot/src/client/cells.js'
  export { hasEscapeLayer } from '../ds-bot/src/client/overlay-hooks.js'
  export { QueueDock } from '../ds-bot/src/client/queue-dock.js'
`

const { outputFiles } = await build({
  stdin: {
    contents: entryCode,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'js',
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))],
  external: ['react', 'react-dom', 'react-dom/client'],
  plugins: [{
    name: 'parity-stubs',
    setup(bundler) {
      bundler.onResolve({ filter: /^@xterm\/(xterm|addon-fit)$/ }, args => ({ path: args.path, namespace: 'stub' }))
      bundler.onResolve({ filter: /dsh-primitives\.js$/ }, () => ({
        path: fileURLToPath(new URL('../ui/src/primitives.js', import.meta.url)),
      }))
      bundler.onResolve({ filter: /ds-bot\/src\/client\/api\.js$|^\.\/api\.js$/ }, (args) => {
        if (args.path === './api.js' && !args.resolveDir.replace(/\\/g, '/').endsWith('/ds-bot/src/client')) return null
        return { path: 'api.js', namespace: 'stub' }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
        if (args.path === 'api.js') return { contents: 'export const call = (...args) => globalThis.__testCall(...args)\n', loader: 'js' }
        return { contents: 'export class Terminal {}\nexport class FitAddon {}\n', loader: 'js' }
      })
    },
  }],
})

const React = await import('react')
const ReactJsxRuntime = await import('react/jsx-runtime')
const ReactDOM = await import('react-dom')
const ReactDOMClient = await import('react-dom/client')

const { document, window } = installMiniDom()
const { Element, HTMLElement, Node, Event } = window
const windowListeners = new Map()
window.addEventListener = (type, fn) => {
  let set = windowListeners.get(type)
  if (!set) { set = new Set(); windowListeners.set(type, set) }
  set.add(fn)
}
window.removeEventListener = (type, fn) => {
  windowListeners.get(type)?.delete(fn)
}
window.dispatchEvent = (ev) => {
  for (const fn of [...(windowListeners.get(ev.type) ?? [])]) fn(ev)
  return !ev.defaultPrevented
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const copied = []
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    language: 'en',
    platform: 'MacIntel',
    clipboard: { writeText: async (value) => { copied.push(value) } },
  },
})

const mod = { exports: {} }
const sandbox = {
  ...globalThis,
  module: mod,
  exports: mod.exports,
  __testCall: async () => ({}),
  navigator: globalThis.navigator,
  window,
  document,
  Element,
  HTMLElement,
  Node,
  Event,
  TextEncoder,
  URL,
  Blob,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame: id => clearTimeout(id),
  require: (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return ReactJsxRuntime
    if (name === 'react-dom') return ReactDOM
    if (name === 'react-dom/client') return ReactDOMClient
    throw new Error(`unexpected require ${name}`)
  },
}
runInNewContext(outputFiles[0].text, sandbox)

const {
  MarkdownText,
  projectUserText,
  FileTypeIcon,
  JsonBlock,
  ensureLanguage,
  ensureKatex,
  normalizeMathDelimiters,
  escapeCurrencyDollars,
  parseFileTarget,
  parseLocalFileHref,
  isInlineCodeFilePath,
  extractUserFileRefs,
  matchFileMention,
  UserMessageText,
  copyableUserText,
  SessionTranscript,
  feedbackErrorMessage,
  FilePreview,
  WorkspacePaneBody,
  normalizeRevealPath,
  ChatRows,
  hasEscapeLayer,
  QueueDock,
} = mod.exports

const flush = async (ms = 20) => {
  await React.act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

function mountDom(element) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  React.act(() => { root.render(element) })
  return {
    host,
    update(next) { React.act(() => { root.render(next) }) },
    unmount() { React.act(() => { root.unmount() }); host.remove() },
  }
}

const join = (...parts) => parts.join('')
const plain = v => JSON.parse(JSON.stringify(v))
const findBtn = (root, pred) => Array.from(root.querySelectorAll('button')).find(pred)
const reactProps = (el) => {
  const key = Object.keys(el).find(k => k.startsWith('__reactProps$'))
  return key ? el[key] : {}
}
const clickEl = el => reactProps(el).onClick?.({ preventDefault() {}, stopPropagation() {}, currentTarget: el, target: el })
const submitForm = el => reactProps(el).onSubmit?.({ preventDefault() {}, stopPropagation() {}, currentTarget: el, target: el })

test('primitives exports projectUserText, FileTypeIcon, and JsonBlock to prevent Vite warnings', () => {
  assert.equal(projectUserText, undefined)
  assert.equal(FileTypeIcon, undefined)
  assert.equal(JsonBlock, undefined)
})

test('UserRow masks credentials in Bot chat and Classic session, supports per-secret reveal, and Copy keeps mask unless revealed', async () => {
  copied.length = 0
  const sk = join('sk-', '1234567890', 'AbCdEfGhIjKlMnOpQr')
  const ghp = join('ghp_', '1234567890abcdefABCDEF1234567890abcd')
  const raw = `Keys: ${sk} and ${ghp}`
  const log = {
    header: { cwd: '/repo' },
    events: [
      { seq: 1, time: 1000, type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: raw }], source: { kind: 'user' } } },
    ],
    writing: null,
  }
  const roster = { bots: [{ id: 'b1', name: 'Chief', sessions: ['b1'] }], byId: { b1: { id: 'b1', name: 'Chief' } }, rooms: [], roomsById: {}, prefs: {} }
  const actions = { openSession() {}, openFile() {}, revealFolder() {}, notice() {} }

  for (const classic of [false, true]) {
    copied.length = 0
    sandbox.__testCall = async (ep) => (ep === 'engine-feedback-list' ? { available: false, items: [] } : {})
    const view = mountDom(React.createElement(SessionTranscript, {
      log,
      sessionId: classic ? 'as1' : 'b1',
      bot: classic ? undefined : roster.byId.b1,
      roster,
      actions,
      classic,
    }))
    try {
      await flush()
      const text = view.host.textContent
      assert.equal(text.includes(sk), false, `sk must be masked by default (classic=${classic})`)
      assert.equal(text.includes(ghp), false, `ghp must be masked by default (classic=${classic})`)
      assert.equal(text.includes('sk-12345***'), true)

      // Copy while masked must keep BOTH secrets masked.
      const copyBtn = findBtn(view.host, el => el.getAttribute('aria-label') === 'Copy')
      assert.ok(copyBtn, 'Copy button exists')
      await React.act(async () => { clickEl(copyBtn); await Promise.resolve() })
      assert.equal(copied.at(-1).includes(sk), false, 'Copy keeps sk masked')
      assert.equal(copied.at(-1).includes(ghp), false, 'Copy keeps ghp masked')

      // Reveal ONLY the first secret.
      const toggles = view.host.querySelectorAll('.dsb-secret-toggle')
      assert.equal(toggles.length, 2)
      assert.equal(toggles[0].getAttribute('aria-pressed'), 'false')
      await React.act(async () => { clickEl(toggles[0]) })
      assert.equal(toggles[0].getAttribute('aria-pressed'), 'true')
      assert.equal(view.host.textContent.includes(sk), true, 'First secret revealed on demand')
      assert.equal(view.host.textContent.includes(ghp), false, 'Second secret stays masked')

      // Copy now includes first secret raw, second still masked.
      await React.act(async () => { clickEl(copyBtn); await Promise.resolve() })
      assert.equal(copied.at(-1).includes(sk), true, 'Copy includes revealed secret')
      assert.equal(copied.at(-1).includes(ghp), false, 'Copy keeps unrevealed secret masked')

      // Hide again -> Copy re-masks.
      await React.act(async () => { clickEl(toggles[0]) })
      await React.act(async () => { clickEl(copyBtn); await Promise.resolve() })
      assert.equal(copied.at(-1).includes(sk), false, 'Copy re-masks after hiding')
    } finally {
      view.unmount()
    }
  }

  // QueueDock fallback preview masks secrets without corrupting edit buffer.
  const queuedToken = join('npm_', '1234567890abcdefABCDEF1234567890abcd')
  const qView = mountDom(React.createElement(QueueDock, {
    useProjection: () => ({ 'next-turn': [{ id: 'q1', source: { kind: 'user' }, content: [{ type: 'text', text: `token ${queuedToken}` }] }] }),
    useSession: sel => sel({ pendingSubmissions: [], running: false }),
    updateQueue: async () => ({ ok: true }),
    actions: { reportError() {} },
  }))
  try {
    assert.equal(qView.host.textContent.includes(queuedToken), false, 'QueueDock preview masks secret')
    assert.equal(qView.host.textContent.includes('npm_1234***'), true)
  } finally {
    qView.unmount()
  }
  assert.equal(copyableUserText(`ok ${sk}`, new Set()).includes(sk), false)
})

test('folded user messages, URL credentials, group chats, and earlier parts never leak secrets and keep reveal/copy parity', async () => {
  copied.length = 0
  const sk = join('sk-', 'proj123456', 'AbCdEfGhIjKlMnOpQrSt')
  const pemBegin = join('-----BEGIN ', 'RSA PRIVATE KEY-----')
  const pemEnd = join('-----END ', 'RSA PRIVATE KEY-----')
  const pem = `${pemBegin}\nMIIEowIBAAKCAQEAfoldedSecretBodyLine1\nsecondFoldedSecretLine2\n${pemEnd}`
  const roster = { bots: [{ id: 'b1', name: 'Chief', sessions: ['b1'] }], byId: { b1: { id: 'b1', name: 'Chief' } }, rooms: [], roomsById: {}, prefs: {} }
  const actions = { openSession() {}, openFile() {}, revealFolder() {}, notice() {} }

  // 1. Secret crossing the 600-char fold cut stays masked while folded and matches Copy after reveal.
  const crossedText = `${'a'.repeat(587)} ${sk}\n${'b'.repeat(1200)}`
  const crossedView = mountDom(React.createElement(SessionTranscript, {
    log: { header: { cwd: '/repo' }, events: [{ seq: 1, time: 1000, type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: crossedText }], source: { kind: 'user' } } }], writing: null },
    sessionId: 'b1', bot: roster.byId.b1, roster, actions, classic: false,
  }))
  try {
    await flush()
    assert.equal(crossedView.host.textContent.includes('123456'), false, 'chars past 8-char prefix stay masked across fold cut')
    const toggle = crossedView.host.querySelector('.dsb-secret-toggle')
    assert.ok(toggle, 'clipped secret still has reveal toggle')
    const copyBtn = findBtn(crossedView.host, el => el.getAttribute('aria-label') === 'Copy')
    await React.act(async () => { clickEl(copyBtn); await Promise.resolve() })
    assert.equal(copied.at(-1).includes(sk), false, 'Copy keeps folded secret masked')
    await React.act(async () => { clickEl(toggle) })
    await React.act(async () => { clickEl(copyBtn); await Promise.resolve() })
    assert.equal(copied.at(-1).includes(sk), true, 'Reveal-then-copy matches full secret even while folded')
  } finally {
    crossedView.unmount()
  }

  // 2. PEM key cut before `-----END` keeps full-text key so reveal-then-copy matches cleanly.
  const pemText = `${'p'.repeat(540)}\n${pem}\n${'q'.repeat(1200)}`
  const pemView = mountDom(React.createElement(SessionTranscript, {
    log: { header: { cwd: '/repo' }, events: [{ seq: 1, time: 1000, type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: pemText }], source: { kind: 'user' } } }], writing: null },
    sessionId: 'b1', bot: roster.byId.b1, roster, actions, classic: false,
  }))
  try {
    await flush()
    assert.equal(pemView.host.textContent.includes('MIIEowIBAAKCAQEA'), false, 'truncated PEM body is masked while folded')
    const toggle = pemView.host.querySelector('.dsb-secret-toggle')
    const copyBtn = findBtn(pemView.host, el => el.getAttribute('aria-label') === 'Copy')
    assert.ok(toggle && copyBtn)
    await React.act(async () => { clickEl(toggle) })
    await React.act(async () => { clickEl(copyBtn); await Promise.resolve() })
    assert.equal(copied.at(-1).includes(pem), true, 'Revealing folded PEM lets Copy include the full PEM')
  } finally {
    pemView.unmount()
  }

  // 3. URL credential cut before `@host` stays masked while folded; full URL never turns `@host/path` into a FileRefChip.
  const urlFolded = `${'u'.repeat(583)} https://admin:TopS3cretPwd!@db.example.com/src/demo.js\n${'z'.repeat(1200)}`
  const urlView = mountDom(React.createElement(SessionTranscript, {
    log: { header: { cwd: '/repo' }, events: [{ seq: 1, time: 1000, type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: urlFolded }], source: { kind: 'user' } } }], writing: null },
    sessionId: 'b1', bot: roster.byId.b1, roster, actions, classic: false,
  }))
  try {
    await flush()
    assert.equal(urlView.host.textContent.includes('TopS3'), false, 'URL password cut before @host stays masked')
    assert.ok(urlView.host.querySelector('.dsb-secret-toggle'))
  } finally {
    urlView.unmount()
  }

  const opened = []
  const urlChipView = mountDom(React.createElement(UserMessageText, {
    text: 'Check https://admin:s3cr3tPass!@db.example.com/src/demo.js and @src/real.js',
    onOpenFile: target => opened.push(target),
  }))
  try {
    const chips = Array.from(urlChipView.host.querySelectorAll('.dsb-file-ref'))
    assert.deepEqual(chips.map(el => el.getAttribute('data-file-ref')), ['src/real.js'])
    assert.equal(urlChipView.host.textContent.includes('s3cr3tPass!'), false)
  } finally {
    urlChipView.unmount()
  }

  // 4. Folded group/earlier user message containing fenced code with a secret never bypasses masking,
  //    and own-window group chats share mentions + file refs + secret masking identically to DMs.
  const fencedSecret = `Intro\n\n\`\`\`sh\nexport KEY=${sk}\n${'echo hi\n'.repeat(180)}\`\`\``
  const groupOpened = []
  const groupBots = []
  const pluginGroupView = mountDom(React.createElement(ChatRows, {
    items: [{ kind: 'user', text: fencedSecret, time: 1000 }],
    sessionId: 'r1',
    roster,
    actions,
  }))
  try {
    assert.equal(pluginGroupView.host.textContent.includes(sk), false, 'folded fenced secret in EarlierUser is masked even in plugin fallback')
    assert.equal(pluginGroupView.host.querySelectorAll('.bt-fold-pre').length, 0, 'secret-bearing user message never leaks into raw foldArea')
  } finally {
    pluginGroupView.unmount()
  }

  const ownGroupView = mountDom(React.createElement(ChatRows, {
    items: [{ kind: 'user', text: `@Chief inspect @README.md:42 with ${sk}`, time: 1000 }],
    sessionId: 'r1',
    roster,
    actions,
    renderUserText: ({ text, fullText, revealedSecrets, onToggleSecret }) => React.createElement(UserMessageText, {
      text,
      fullText,
      bots: roster.bots,
      revealedSecrets,
      onToggleSecret,
      onOpenBot: id => groupBots.push(id),
      onOpenFile: target => groupOpened.push(target),
    }),
  }))
  try {
    assert.equal(ownGroupView.host.textContent.includes(sk), false, 'group chat masks secret')
    const mentionBtn = ownGroupView.host.querySelector('.bt-umention')
    const fileBtn = ownGroupView.host.querySelector('.dsb-file-ref')
    assert.ok(mentionBtn, 'group chat keeps Bot @mention alongside secret')
    assert.equal(fileBtn?.getAttribute('data-file-ref'), 'README.md')
    assert.equal(fileBtn?.getAttribute('data-file-line'), '42')
    await React.act(async () => { clickEl(mentionBtn); clickEl(fileBtn) })
    assert.deepEqual(plain(groupBots), ['b1'])
    assert.deepEqual(plain(groupOpened), [{ path: 'README.md', line: 42 }])
  } finally {
    ownGroupView.unmount()
  }
})

test('file and folder references parse cleanly with no false positives and open files or reveal folders', async () => {
  assert.deepEqual(plain(parseFileTarget('src/app.js:42')), { path: 'src/app.js', line: 42, endLine: null, isDir: false, display: 'src/app.js:42' })
  assert.deepEqual(plain(parseFileTarget('app/ui/src/')), { path: 'app/ui/src', line: null, endLine: null, isDir: true, display: 'app/ui/src/' })
  assert.equal(parseFileTarget('https://example.com/a.js'), null)

  // Inline code: true positives vs false positives.
  assert.equal(isInlineCodeFilePath('src/app.js:12')?.path, 'src/app.js')
  assert.equal(isInlineCodeFilePath('README.md')?.path, 'README.md')
  assert.deepEqual(plain(isInlineCodeFilePath('README.md:42')), { path: 'README.md', line: 42, endLine: null, isDir: false, display: 'README.md:42' })
  assert.deepEqual(plain(isInlineCodeFilePath('src/')), { path: 'src', line: null, endLine: null, isDir: true, display: 'src/' })
  assert.deepEqual(plain(isInlineCodeFilePath('subdir/')), { path: 'subdir', line: null, endLine: null, isDir: true, display: 'subdir/' })
  assert.equal(isInlineCodeFilePath('src/main.c')?.path, 'src/main.c')
  assert.equal(isInlineCodeFilePath('include/box.h')?.path, 'include/box.h')
  assert.equal(isInlineCodeFilePath('./docs/plans/')?.isDir, true)
  assert.equal(isInlineCodeFilePath('console.log'), null)
  assert.equal(isInlineCodeFilePath('Math.max'), null)
  assert.equal(isInlineCodeFilePath('box.h'), null)
  assert.equal(isInlineCodeFilePath('color.r'), null)
  assert.equal(isInlineCodeFilePath('macOS/Linux/Windows'), null)
  assert.equal(isInlineCodeFilePath('yes/no/maybe'), null)
  assert.equal(isInlineCodeFilePath('github.com/Fei-Craft/DS-Bot'), null)
  assert.equal(isInlineCodeFilePath('tel:123456'), null)
  assert.equal(isInlineCodeFilePath('application/json'), null)
  assert.equal(isInlineCodeFilePath('light/dark'), null)
  assert.equal(isInlineCodeFilePath('2026/11/26'), null)
  assert.equal(isInlineCodeFilePath('--flag'), null)
  assert.equal(isInlineCodeFilePath('plainword'), null)
  assert.equal(isInlineCodeFilePath('@scope/pkg'), null)

  // Bare filename with `:line` in parseLocalFileHref and matchFileMention basename isolation.
  assert.equal(parseLocalFileHref('README.md:42')?.line, 42)
  assert.equal(parseLocalFileHref('mailto:user@example.com'), null)
  assert.equal(parseFileTarget('file://server/share/project/src/main.js'), null, 'remote/UNC file:// authority must not drop host and dispatch /share/...')
  assert.equal(parseLocalFileHref('file://server/share/project/src/main.js'), null)
  assert.equal(parseFileTarget('file://localhost/repo/src/main.js')?.path, '/repo/src/main.js')
  assert.equal(parseFileTarget('file:///repo/src/main.js')?.path, '/repo/src/main.js')
  const turnMentions = new Map([['src/foo.js', { path: 'src/foo.js' }], ['foo.js', { path: 'src/foo.js' }]])
  assert.equal(matchFileMention('foo.js:5', turnMentions)?.path, 'src/foo.js')
  assert.equal(matchFileMention('other/foo.js', turnMentions), null, 'explicit different path must not resolve to delivered basename')

  // User refs: `@"quoted"`, `@path`, `@README.md:42`, relative/absolute, no plain words or `/help`.
  const refs = extractUserFileRefs('Check @"docs/my spec.md", @README.md:42, @src/app.js:10, ./folder/, and /help or hello@example.com')
  assert.deepEqual(plain(refs.map(r => [r.target.path, r.target.line, r.target.isDir])), [
    ['docs/my spec.md', null, false],
    ['README.md', 42, false],
    ['src/app.js', 10, false],
    ['./folder', null, true],
  ])

  const openedFiles = []
  const revealedFolders = []
  const md = [
    'Open src/demo.js:4, [readme](README.md:42), [chat](app/ui/src/session-chat.js:42), [local](file:///repo/src/local.js#L9), [win](C:\\repo\\src\\win.js:7), `src/host/channel.js`, `subdir/`, [folder](app/ui/src/), [ext](https://example.com), [bad](javascript:alert(1)), and plain `console.log` or `box.h` or `macOS/Linux/Windows`.',
    '',
    '```js',
    'const path = "src/not-a-link.js"',
    '```',
  ].join('\n')
  const view = mountDom(React.createElement(MarkdownText, {
    text: md,
    labels: { code: { copyLabel: 'Copy', copiedLabel: 'Copied' } },
    onOpenFile: target => openedFiles.push(target),
    onRevealFolder: target => revealedFolders.push(target),
  }))
  try {
    const chips = Array.from(view.host.querySelectorAll('.dsb-file-ref'))
    assert.deepEqual(chips.map(el => el.getAttribute('data-file-ref')), [
      'src/demo.js',
      'README.md',
      'app/ui/src/session-chat.js',
      '/repo/src/local.js',
      'C:/repo/src/win.js',
      'src/host/channel.js',
      'subdir',
      'app/ui/src',
    ])
    // External https link stays an anchor, javascript: is stripped by defaultUrlTransform.
    const anchors = Array.from(view.host.querySelectorAll('a'))
    assert.equal(anchors.some(a => a.getAttribute('href') === 'https://example.com'), true)
    assert.equal(anchors.some(a => String(a.getAttribute('href') ?? '').startsWith('javascript:')), false)
    // Ensure zero file-ref buttons inside fenced code blocks.
    const preBlocks = view.host.querySelectorAll('pre')
    assert.equal(preBlocks.reduce((n, pre) => n + pre.querySelectorAll('.dsb-file-ref').length, 0), 0)
    await React.act(async () => { clickEl(chips[0]) })
    await React.act(async () => { clickEl(chips[1]) })
    await React.act(async () => { clickEl(chips[3]) })
    await React.act(async () => { clickEl(chips[4]) })
    await React.act(async () => { clickEl(chips[6]) })
    await React.act(async () => { clickEl(chips[7]) })
    assert.deepEqual(plain(openedFiles), [
      { path: 'src/demo.js', line: 4 },
      { path: 'README.md', line: 42 },
      { path: '/repo/src/local.js', line: 9 },
      { path: 'C:/repo/src/win.js', line: 7 },
    ])
    assert.deepEqual(plain(revealedFolders), [{ path: 'subdir' }, { path: 'app/ui/src' }])
  } finally {
    view.unmount()
  }

  // UserMessageText: Bot mentions win over file refs, secrets win over both.
  const uOpened = []
  const uBots = []
  const uView = mountDom(React.createElement(UserMessageText, {
    text: '@Chief check @README.md',
    bots: [{ id: 'b1', name: 'Chief' }],
    onOpenBot: id => uBots.push(id),
    onOpenFile: target => uOpened.push(target),
  }))
  try {
    const mentionBtn = uView.host.querySelector('.bt-umention')
    const fileBtn = uView.host.querySelector('.dsb-file-ref')
    assert.ok(mentionBtn)
    assert.equal(fileBtn?.getAttribute('data-file-ref'), 'README.md')
    await React.act(async () => { clickEl(mentionBtn); clickEl(fileBtn) })
    assert.deepEqual(plain(uBots), ['b1'])
    assert.deepEqual(plain(uOpened), [{ path: 'README.md' }])
  } finally {
    uView.unmount()
  }
})

test('Classic session renders reply feedback (submit, dialog, retract) and never renders it in Bot chats', async () => {
  const rpcCalls = []
  const notices = []
  sandbox.__testCall = async (ep, body) => {
    rpcCalls.push([ep, body])
    if (ep === 'engine-feedback-list') return { available: true, items: [] }
    if (ep === 'engine-feedback-put') {
      return { ok: true, item: { sessionId: body.sessionId, messageId: body.messageId, rating: body.rating, category: body.category, note: body.note, version: 'v1' } }
    }
    if (ep === 'engine-feedback-delete') return { ok: true, absent: true }
    return {}
  }

  const log = {
    header: { cwd: '/repo' },
    events: [
      { seq: 1, time: 1000, type: 'assistant/message', data: { turn: 1, message: { id: 'msg-42', content: [{ type: 'text', text: 'Here is the answer.' }] } } },
    ],
    writing: null,
  }
  const roster = { bots: [{ id: 'b1', name: 'Chief' }], byId: { b1: { id: 'b1', name: 'Chief' } }, rooms: [], roomsById: {}, prefs: {} }
  const actions = { openSession() {}, openFile() {}, revealFolder() {}, notice: msg => notices.push(msg), toggleReaction() {} }

  // Bot chat must NOT mount classic feedback buttons.
  const botView = mountDom(React.createElement(SessionTranscript, {
    log, sessionId: 'b1', bot: roster.byId.b1, roster, actions, classic: false,
  }))
  try {
    await flush()
    assert.equal(botView.host.querySelectorAll('.dsb-fb-btn').length, 0, 'Bot chat has no classic feedback row')
  } finally {
    botView.unmount()
  }

  // Read-only window (string reason from host) must hide classic feedback buttons.
  const roView = mountDom(React.createElement(SessionTranscript, {
    log, sessionId: 'as1', roster: { ...roster, readOnly: 'Team is open in another window' }, actions, classic: true,
  }))
  try {
    await flush()
    assert.equal(roView.host.querySelectorAll('.dsb-fb-btn').length, 0, 'String roster.readOnly hides classic feedback buttons')
  } finally {
    roView.unmount()
  }

  // Read-only Classic Agent subagent child transcript in a writable window must suppress
  // both the feedback fetch and rating controls even when the feedback service is available.
  let subagentFeedbackCalls = 0
  const prevTestCall = sandbox.__testCall
  sandbox.__testCall = async (ep, body) => {
    if (ep === 'engine-feedback-list') { subagentFeedbackCalls += 1; return { available: true, items: [] } }
    return prevTestCall?.(ep, body)
  }
  const subagentView = mountDom(React.createElement(SessionTranscript, {
    log, sessionId: 'child-1', parent: 'as1', readOnly: true, roster, actions, classic: true,
  }))
  try {
    await flush()
    assert.equal(subagentFeedbackCalls, 0, 'Read-only subagent child transcript must not fetch feedback')
    assert.equal(subagentView.host.querySelectorAll('.dsb-fb-btn').length, 0, 'Read-only subagent child transcript hides classic feedback buttons')
  } finally {
    subagentView.unmount()
    sandbox.__testCall = prevTestCall
  }

  // Distinct real DSH failure codes map to specific user-facing messages.
  assert.match(feedbackErrorMessage({ code: 'note-too-large', maxBytes: 128 }, 'fallback'), /128/)
  assert.equal(feedbackErrorMessage({ code: 'note-blank' }, 'fallback'), 'Feedback note cannot be blank')
  assert.equal(feedbackErrorMessage({ code: 'target-not-found' }, 'fallback'), 'This message can no longer receive feedback')
  assert.equal(feedbackErrorMessage({ code: 'session-not-found' }, 'fallback'), 'This session is no longer available')

  // Classic session: Escape when closed does not throw or block shortcuts; Escape when open closes dialog;
  // version-conflict reconciles `current` without wiping unsaved edits; retry submits reconciled version;
  // success does NOT emit an error toast (`actions.notice`).
  let putAttempt = 0
  sandbox.__testCall = async (ep, body) => {
    rpcCalls.push([ep, body])
    if (ep === 'engine-feedback-list') return { available: true, items: [] }
    if (ep === 'engine-feedback-put') {
      putAttempt += 1
      if (putAttempt === 1) {
        return {
          ok: false,
          error: {
            code: 'version-conflict',
            current: { messageId: body.messageId, rating: 'positive', version: 'v-remote' },
          },
        }
      }
      return { ok: true, item: { sessionId: body.sessionId, messageId: body.messageId, rating: body.rating, category: body.category, note: body.note, version: 'v2' } }
    }
    if (ep === 'engine-feedback-delete') return { ok: true, absent: true }
    return {}
  }

  const dispatchEscape = () => {
    const ev = new Event('keydown', { cancelable: true })
    ev.key = 'Escape'
    window.dispatchEvent(ev)
  }

  const classicView = mountDom(React.createElement(SessionTranscript, {
    log, sessionId: 'as1', roster, actions, classic: true,
  }))
  try {
    await flush()
    assert.equal(hasEscapeLayer(), false, 'Closed feedback dialog must not register an Escape layer')
    dispatchEscape() // Must not throw when closed.

    const up = findBtn(classicView.host, el => el.getAttribute('data-feedback-rating') === 'positive')
    const down = findBtn(classicView.host, el => el.getAttribute('data-feedback-rating') === 'negative')
    assert.ok(up && down, 'Classic assistant reply shows thumbs up and thumbs down')

    // Open and close with Escape.
    await React.act(async () => { clickEl(up) })
    await flush()
    assert.equal(hasEscapeLayer(), true, 'Open feedback dialog registers an Escape layer')
    assert.ok(document.body.querySelector('.dsb-fb-dialog'))
    await React.act(async () => { dispatchEscape() })
    await flush(200)
    assert.equal(document.body.querySelector('.dsb-fb-dialog'), null, 'Escape closes open feedback dialog')
    assert.equal(hasEscapeLayer(), false)

    // Open thumbs down, select category + type unsaved note, trigger `version-conflict`,
    // confirm unsaved note/category survive, then retry and succeed with reconciled `v-remote`.
    await React.act(async () => { clickEl(down) })
    await flush()
    const dialog = document.body.querySelector('.dsb-fb-dialog')
    assert.ok(dialog, 'Clicking thumbs down opens feedback dialog')
    const catBtn = dialog.querySelector('.dsb-fb-cat')
    const noteEl = dialog.querySelector('.dsb-fb-note')
    await React.act(async () => {
      clickEl(catBtn)
      reactProps(noteEl).onChange?.({ target: { value: 'Keep my draft note' } })
    })
    await React.act(async () => { submitForm(dialog) })
    await flush()

    assert.ok(document.body.querySelector('.dsb-fb-err')?.textContent.includes('Feedback changed elsewhere'))
    assert.equal(document.body.querySelector('.dsb-fb-note')?.value, 'Keep my draft note', 'version-conflict preserves unsaved note')
    assert.equal(document.body.querySelector('.dsb-fb-cat')?.getAttribute('aria-pressed'), 'true', 'version-conflict preserves unsaved category')

    // Retry submit immediately uses reconciled version `v-remote`.
    await React.act(async () => { submitForm(document.body.querySelector('.dsb-fb-dialog')) })
    await flush()
    const putCalls = rpcCalls.filter(([ep]) => ep === 'engine-feedback-put')
    assert.equal(putCalls[0][1].ifVersion, null)
    assert.equal(putCalls[1][1].ifVersion, 'v-remote')
    assert.equal(putCalls[1][1].category, 'task-result')
    assert.equal(putCalls[1][1].note, 'Keep my draft note')
    assert.equal(findBtn(classicView.host, el => el.getAttribute('data-feedback-rating') === 'negative')?.getAttribute('aria-pressed'), 'true')
    assert.equal(notices.length, 0, 'Successful feedback submission must not trigger error-styled actions.notice')

    // Click active thumbs down again to retract.
    await React.act(async () => { clickEl(findBtn(classicView.host, el => el.getAttribute('data-feedback-rating') === 'negative')) })
    await flush()
    const delCall = rpcCalls.find(([ep]) => ep === 'engine-feedback-delete')
    assert.equal(delCall?.[1]?.ifVersion, 'v2')
    assert.equal(findBtn(classicView.host, el => el.getAttribute('data-feedback-rating') === 'negative')?.getAttribute('aria-pressed'), 'false')
    assert.equal(notices.length, 0, 'Successful feedback retraction must not trigger error-styled actions.notice')
  } finally {
    classicView.unmount()
  }
})

test('syntax highlighting highlights fenced code blocks and FilePreview, and math renders KaTeX without currency false positives', async () => {
  await ensureLanguage('javascript')
  await ensureKatex()

  assert.equal(normalizeMathDelimiters('Inline \\(x+1\\) and `\\(code\\)`'), 'Inline $x+1$ and `\\(code\\)`')
  assert.match(normalizeMathDelimiters('Block \\[a^2 + b^2\\]'), /\$\$\na\^2 \+ b\^2\n\$\$/)
  // CommonMark indented code blocks & blockquoted code blocks must stay untouched (both displayed and copied).
  const indentedSrc = 'Intro paragraph\n\n    const raw = "\\\\(x\\\\)"\n    \\(keep_me\\)\n'
  assert.equal(normalizeMathDelimiters(indentedSrc), indentedSrc)
  assert.equal(escapeCurrencyDollars('    $5 and $10\n'), '    $5 and $10\n')
  assert.equal(escapeCurrencyDollars(">     echo '$5 and $10'\n"), ">     echo '$5 and $10'\n", 'quoted indented code keeps literal $')
  assert.equal(escapeCurrencyDollars('> ~~~\n> $5 and $10\n> ~~~\n'), '> ~~~\n> $5 and $10\n> ~~~\n', 'quoted tilde fence keeps literal $')
  assert.equal(escapeCurrencyDollars('> Costs $5 and $10\n'), '> Costs \\$5 and $10\n', 'quoted prose still disambiguates currency')

  const md = [
    'Price is $5 and $10, range $100-$200 or $10–$20 or $5/$10, 价格$5和$10.',
    '',
    'The item costs $5 and the answer is $x^2$, while $E = mc^2$, $10-3$, $1/2$, and \\(a + b\\) are math.',
    '',
    '    literal \\(indented\\) code',
    '',
    ">     echo '$5 and $10'",
    '',
    '> ~~~',
    '> $5 and $10',
    '> ~~~',
    '',
    '$$',
    '\\int_0^1 x\\,dx = \\frac{1}{2}',
    '$$',
    '',
    '```math',
    'x^2 + y^2 = r^2',
    '```',
    '',
    '```javascript',
    'const answer = 42',
    '```',
  ].join('\n')

  copied.length = 0
  const view = mountDom(React.createElement(MarkdownText, {
    text: md,
    labels: { code: { copyLabel: 'Copy', copiedLabel: 'Copied' } },
  }))
  try {
    await flush()
    assert.equal(view.host.textContent.includes('$5 and $10'), true, 'spaced currency stays plain text')
    assert.equal(view.host.textContent.includes('$100-$200'), true, 'hyphen currency range stays plain text')
    assert.equal(view.host.textContent.includes('$10–$20'), true, 'en-dash currency range stays plain text')
    assert.equal(view.host.textContent.includes('$5/$10'), true, 'slash currency stays plain text')
    assert.equal(view.host.textContent.includes('价格$5和$10'), true, 'CJK currency stays plain text')
    assert.equal(view.host.textContent.includes('costs $5 and the answer is '), true, 'leading price before equation stays plain text')
    assert.equal(view.host.textContent.includes('$10-3$'), false, 'inline arithmetic $10-3$ renders as math rather than literal dollar text')
    assert.equal(view.host.textContent.includes('$1/2$'), false, 'inline fraction $1/2$ renders as math rather than literal dollar text')
    assert.equal(view.host.querySelectorAll('.dsb-math-inline').length, 5, 'mixed price+equation ($x^2$), $E = mc^2$, $10-3$, $1/2$, and \\(a + b\\) all render as math')
    assert.equal(view.host.querySelectorAll('.dsb-math-block').length, 2, '$$...$$ and ```math render as display math')
    const mathEl = view.host.querySelector('.dsb-math-inline')
    assert.equal(mathEl?.textContent.includes('class="katex"'), true, 'KaTeX markup rendered')
    // Indented code block and blockquoted code blocks keep literal text both displayed and copied.
    const preBlocks = Array.from(view.host.querySelectorAll('pre'))
    const indentedPre = preBlocks.find(el => el.textContent.includes('indented'))
    assert.ok(indentedPre?.textContent.includes('\\(indented\\)'), 'indented code block displays literal LaTeX delimiters')
    const indentedCopy = indentedPre?.parentNode?.querySelector('.md-copy')
    await React.act(async () => { clickEl(indentedCopy); await Promise.resolve() })
    assert.equal(copied.at(-1), 'literal \\(indented\\) code', 'indented code block copies literal LaTeX delimiters')
    const quotedIndentedPre = preBlocks.find(el => el.textContent.includes("echo '$5 and $10'"))
    assert.ok(quotedIndentedPre, 'quoted indented code block displays unescaped $5 and $10')
    assert.equal(quotedIndentedPre.textContent.includes('\\$5'), false, 'quoted indented code block has no extra backslash')
    await React.act(async () => { clickEl(quotedIndentedPre.parentNode?.querySelector('.md-copy')); await Promise.resolve() })
    assert.equal(copied.at(-1), "echo '$5 and $10'", 'quoted indented code block copies without extra backslash')
    const quotedFencePre = preBlocks.find(el => el.textContent.trim() === '$5 and $10')
    assert.ok(quotedFencePre, 'quoted tilde-fenced code block displays unescaped $5 and $10')
    await React.act(async () => { clickEl(quotedFencePre.parentNode?.querySelector('.md-copy')); await Promise.resolve() })
    assert.equal(copied.at(-1), '$5 and $10', 'quoted tilde-fenced code block copies without extra backslash')
    const hljsCode = view.host.querySelector('.hljs')
    assert.ok(hljsCode?.querySelector('.hljs-keyword'), 'fenced JS code block is syntax highlighted')
    assert.equal(view.host.querySelector('.md-code-lang')?.textContent, 'javascript')
  } finally {
    view.unmount()
  }

  // FilePreview CodeLines highlights code and marks target line.
  const pv = mountDom(React.createElement(FilePreview, {
    file: { kind: 'code', language: 'javascript', name: 'demo.js', path: 'src/demo.js', size: 42, text: 'const a = 1\nexport const b = 2' },
    line: 2,
  }))
  try {
    await flush()
    assert.ok(pv.host.querySelector('.hljs-keyword'), 'FilePreview highlights syntax tokens')
    const targetRow = Array.from(pv.host.querySelectorAll('tr')).find(el => el.getAttribute('data-target-line') !== null)
    assert.ok(targetRow, 'target line row is marked')
    assert.equal(targetRow.querySelector('.dsb-pv-ln')?.textContent, '2')
  } finally {
    pv.unmount()
  }
})

test('WorkspacePaneBody reveals folders in FileTree (including when workspace-read returns kind:dir)', async () => {
  const revealed = []
  const closed = []
  sandbox.__testCall = async (ep, body) => {
    if (ep === 'workspace-read' && body.path === 'app/ui') {
      return { kind: 'dir', name: 'ui', path: 'app/ui', root: '/repo' }
    }
    if (ep === 'workspace-list') {
      if (body.path === '') return { root: '/repo', rootName: 'repo', path: '', truncated: false, entries: [{ name: 'app', path: 'app', kind: 'dir', size: 0, ext: '' }] }
      if (body.path === 'app') return { root: '/repo', rootName: 'repo', path: 'app', truncated: false, entries: [{ name: 'ui', path: 'app/ui', kind: 'dir', size: 0, ext: '' }] }
      if (body.path === 'app/ui') return { root: '/repo', rootName: 'repo', path: 'app/ui', truncated: false, entries: [{ name: 'src', path: 'app/ui/src', kind: 'dir', size: 0, ext: '' }] }
    }
    return {}
  }

  const fakeTeam = {
    actions: {
      openFile() {},
      revealFolder: target => revealed.push(target),
      closeWorkspaceTab: tab => closed.push(tab),
    },
    chat: { on: () => () => {} },
  }

  // Clicking a folder path without trailing `/` triggers workspace-read -> kind:'dir' -> revealFolder.
  const dirView = mountDom(React.createElement(WorkspacePaneBody, {
    sessionId: 'b1',
    panel: { tabs: ['preview'], tab: 'preview', file: 'app/ui', fileSessionId: 'b1' },
    team: fakeTeam,
    visible: true,
  }))
  try {
    await flush(30)
    assert.deepEqual(plain(revealed), [{ path: 'app/ui', sessionId: 'b1' }])
    assert.deepEqual(plain(closed), ['preview'])
  } finally {
    dirView.unmount()
  }

  // normalizeRevealPath: out-of-workspace detection, filesystem root `/`, and Windows case-insensitive root match.
  assert.deepEqual(plain(normalizeRevealPath('/etc/ssh', '/repo')), { status: 'outside', raw: '/etc/ssh' })
  assert.deepEqual(plain(normalizeRevealPath('/', '/repo')), { status: 'outside', raw: '/' })
  assert.deepEqual(plain(normalizeRevealPath('/etc/ssh', '/')), { status: 'ok', path: 'etc/ssh' })
  assert.deepEqual(plain(normalizeRevealPath('/', '/')), { status: 'ok', path: '' })
  assert.deepEqual(plain(normalizeRevealPath('/a/../b', '/')), { status: 'ok', path: 'b' })
  assert.deepEqual(plain(normalizeRevealPath('../outside', '/repo')), { status: 'outside', raw: '../outside' })
  assert.deepEqual(plain(normalizeRevealPath('D:\\other\\dir', 'C:\\Repo')), { status: 'outside', raw: 'D:/other/dir' })
  assert.deepEqual(plain(normalizeRevealPath('c:\\repo\\src\\nested', 'C:\\Repo')), { status: 'ok', path: 'src/nested' })
  assert.deepEqual(plain(normalizeRevealPath('C:\\src\\nested', 'C:\\')), { status: 'ok', path: 'src/nested' })
  assert.deepEqual(plain(normalizeRevealPath('C:\\', 'C:\\')), { status: 'ok', path: '' })
  assert.deepEqual(plain(normalizeRevealPath('D:\\other', 'C:\\')), { status: 'outside', raw: 'D:/other' })
  assert.deepEqual(plain(normalizeRevealPath('C:\\repo', '/')), { status: 'outside', raw: 'C:/repo' })
  assert.deepEqual(plain(normalizeRevealPath('/repo/app/ui', '/repo')), { status: 'ok', path: 'app/ui' })

  // Opening FileTree with revealDir expands ancestors, flashes reveal highlight, rejects out-of-workspace
  // paths with an explicit alert, and consumes dotfolder reveals once so Hide dotfiles works cleanly.
  const dotListCalls = []
  sandbox.__testCall = async (ep, body) => {
    if (ep === 'workspace-list') {
      dotListCalls.push([body.path, body.includeHidden])
      if (body.path === '') {
        const entries = [{ name: 'app', path: 'app', kind: 'dir', size: 0, ext: '' }]
        if (body.includeHidden) entries.unshift({ name: '.github', path: '.github', kind: 'dir', size: 0, ext: '' })
        return { root: '/repo', rootName: 'repo', path: '', truncated: false, entries }
      }
      if (body.path === 'app') return { root: '/repo', rootName: 'repo', path: 'app', truncated: false, entries: [{ name: 'ui', path: 'app/ui', kind: 'dir', size: 0, ext: '' }] }
      if (body.path === 'app/ui') return { root: '/repo', rootName: 'repo', path: 'app/ui', truncated: false, entries: [{ name: 'src', path: 'app/ui/src', kind: 'dir', size: 0, ext: '' }] }
      if (body.path === '.github') return { root: '/repo', rootName: 'repo', path: '.github', truncated: false, entries: [] }
    }
    return {}
  }

  const treeView = mountDom(React.createElement(WorkspacePaneBody, {
    sessionId: 'b1',
    panel: { tabs: ['files'], tab: 'files', revealDir: 'app/ui', revealNonce: 1 },
    team: fakeTeam,
    visible: true,
  }))
  try {
    await flush(50)
    const row = Array.from(treeView.host.querySelectorAll('.dsb-ft-row')).find(el => el.getAttribute('data-tree-path') === 'app/ui')
    assert.ok(row, 'nested folder app/ui expanded and rendered in FileTree')
    assert.equal(row.getAttribute('data-revealed') !== null, true, 'revealed folder flashes highlight')

    // Revealing an out-of-workspace path surfaces an explicit alert notice without hiding the tree.
    treeView.update(React.createElement(WorkspacePaneBody, {
      sessionId: 'b1',
      panel: { tabs: ['files'], tab: 'files', revealDir: '/etc/ssh', revealNonce: 2 },
      team: fakeTeam,
      visible: true,
    }))
    await flush(50)
    const alert = treeView.host.querySelector('.dsb-ft-notice')
    assert.ok(alert?.textContent.includes('/etc/ssh'), 'out-of-workspace path shows explicit alert notice')

    // Revealing `.github` turns hidden files on once; clicking Hide dotfiles keeps them off without replaying reveal.
    treeView.update(React.createElement(WorkspacePaneBody, {
      sessionId: 'b1',
      panel: { tabs: ['files'], tab: 'files', revealDir: '.github', revealNonce: 3 },
      team: fakeTeam,
      visible: true,
    }))
    await flush(60)
    const hideBtn = findBtn(treeView.host, el => el.textContent === 'Hide dotfiles')
    assert.ok(hideBtn, 'dotfolder reveal enables dotfiles')
    await React.act(async () => { clickEl(hideBtn) })
    await flush(60)
    const showBtn = findBtn(treeView.host, el => el.textContent === 'Show hidden')
    assert.ok(showBtn, 'Hide dotfiles stays off and does not replay previous dotfolder reveal')
  } finally {
    treeView.unmount()
  }
})

test('every t() key in app/ui/src exists across all supported locales and previously hardcoded English translates', () => {
  const dir = new URL('../ui/src/', import.meta.url)
  const locales = ['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de']
  const missing = []
  for (const name of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const text = readFileSync(new URL(name, dir), 'utf8')
    for (const m of text.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const key = m[2].replace(/\\(['"])/g, '$1')
      for (const loc of locales) {
        if (!Object.hasOwn(DICTIONARY[loc] ?? {}, key)) missing.push(`${loc}:${name}: ${key}`)
      }
    }
    for (const m of text.matchAll(/labelKey:\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const key = m[2].replace(/\\(['"])/g, '$1')
      for (const loc of locales) {
        if (!Object.hasOwn(DICTIONARY[loc] ?? {}, key)) missing.push(`${loc}:${name}: ${key}`)
      }
    }
  }
  assert.deepEqual(missing, [])

  // Verify previously hardcoded strings translate in zh.
  let active = 'zh'
  const dicts = new Map()
  const off = installLocale({
    getLocale: () => ({ active, locales: [] }),
    addLanguage: () => () => {},
    register: (ns, localeOrMap, dict) => {
      if (!dicts.has(ns)) dicts.set(ns, new Map())
      const map = dicts.get(ns)
      if (typeof localeOrMap === 'string') map.set(localeOrMap.toLowerCase(), dict)
      else for (const [k, v] of Object.entries(localeOrMap ?? {})) map.set(k.toLowerCase(), v)
      return () => dicts.delete(ns)
    },
    bind: ns => (key, params) => {
      const val = dicts.get(ns)?.get(active.toLowerCase())?.[key] ?? key
      return params ? val.replace(/\{(\w+)\}/g, (_, k) => String(params[k])) : val
    },
  })
  try {
    assert.equal(t('No newline at end of file'), '文件末尾无换行符')
    assert.equal(t('Column {n}', { n: 3 }), '第 3 列')
    assert.equal(t('Binary'), '二进制')
    assert.equal(t('Large'), '大文件')
  } finally {
    off()
  }
})

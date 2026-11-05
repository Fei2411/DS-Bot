// Settings → Connectors: connected rows, a catalog with search and categories,
// an Add menu, and the mailbox. One row component draws the mark, name, status
// and the expanding panels (browser sign-in, device code, key/token, client).
import { createElement as h, useRef, useState } from 'react'
import { useMorph } from './motion.js'
import { MaskedInput } from './secret-card.js'
import { SwitchRow } from './bot-settings.js'
import { CheckIcon, CloseIcon, MailIcon, PlugIcon } from './icons.js'
import { BotMark } from './mark.js'
import { contentText, currentPart } from './text.js'
import { useDockHold } from './card-hold.js'
import { heldCardKey } from './sources.js'
import { CellEmpty } from './cell-empty.js'
import { hostText, t } from './i18n.js'

export { GitHubMark } from './connector-marks.js'
import { MARKS } from './connector-marks.js'

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'
// Rows show a generated monogram: first letter, color from the id hash.
export function ConnectorMark({ connector }) {
  const Mark = MARKS[connector.id]
  if (Mark) return h(Mark)
  let hash = 0
  for (const ch of String(connector.id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return h('span', { className: 'bt-connector-mono', style: { '--bt-hue': hash % 360 }, 'aria-hidden': true }, (connector.name ?? '?').slice(0, 1).toUpperCase())
}

const CATEGORIES = ['dev', 'docs', 'work', 'design', 'data', 'commerce', 'search']
const CATEGORY_LABEL = { dev: 'Developer', docs: 'Docs & files', work: 'Work', design: 'Design', data: 'Data', commerce: 'Commerce', search: 'Search' }

function statusText(connector) {
  if (connector.state === 'connecting') return connector.pending ? t('Waiting for sign-in…') : t('Connecting…')
  if (connector.state === 'needs-sign-in') return t('Sign in again')
  if (connector.state === 'needs-client') return t('This service needs an app client ID')
  if (connector.state === 'error') return t('Could not connect: {error}', { error: connector.error ?? '' })
  if (connector.state === 'ready') return connector.account ? t('Connected as {account}', { account: connector.account }) : t('Connected')
  return connector.about ?? ''
}

function BrowserPanel({ connector, actions, run }) {
  const [input, setInput] = useState('')
  return h('div', { className: 'bt-connector-form' },
    h('div', { className: 'bt-connector-form-row' },
      h('a', { className: 'bt-connector-link', href: connector.pending.url, target: '_blank', rel: 'noopener noreferrer' }, t('Open the sign-in page')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void run(actions.connectorCancel(connector.id)) }, t('Cancel'))),
    h('input', { className: 'bt-input', 'aria-label': t('Paste the address you land on'), placeholder: t('Or paste the address you land on'), value: input, spellCheck: false, autoComplete: 'off', onChange: e => setInput(e.target.value) }),
    input.trim() !== '' ? h('div', { className: 'bt-connector-form-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void run(actions.connectorSignInCode(connector.id, input.trim())) }, t('Finish sign-in'))) : null)
}

function DevicePanel({ connector, actions, run, onUseToken }) {
  const [copied, setCopied] = useState(false)
  return h('div', { className: 'bt-connector-form' },
    h('div', { className: 'bt-connector-device' },
      h('code', { className: 'bt-connector-code' }, connector.pending.userCode),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { void navigator.clipboard?.writeText(connector.pending.userCode).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600) }) } }, copied ? t('Copied') : t('Copy'))),
    h('div', { className: 'bt-connector-form-row' },
      h('a', { className: 'bt-connector-link', href: connector.pending.verificationUri, target: '_blank', rel: 'noopener noreferrer' }, t('Open {host}', { host: connector.pending.verificationUri.replace(/^https?:\/\//, '') })),
      connector.auth?.token === true && onUseToken ? h('button', { type: 'button', className: 'bt-connector-link', onClick: () => void run(actions.connectorCancel(connector.id), onUseToken) }, t('Use a token instead')) : null,
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void run(actions.connectorCancel(connector.id)) }, t('Cancel'))))
}

function ClientPanel({ connector, actions, run }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  return h('div', { className: 'bt-connector-form' },
    h('input', { className: 'bt-input', 'aria-label': t('Client ID'), placeholder: t('Client ID'), value: clientId, spellCheck: false, autoComplete: 'off', onChange: e => setClientId(e.target.value) }),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value: clientSecret, onChange: setClientSecret, label: t('Client secret (optional)') })),
    h('div', { className: 'bt-connector-form-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void run(actions.connectorCancel(connector.id)) }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: clientId.trim() === '', onClick: () => void run(actions.connectorClient(connector.id, clientId.trim(), clientSecret.trim() || undefined)) }, t('Continue'))))
}

function TokenPanel({ connector, actions, run, onDone }) {
  const [token, setToken] = useState('')
  const isKey = connector.auth?.kind === 'key'
  const connect = () => {
    if (token.trim() === '') return
    void run(isKey ? actions.connectorConnect(connector.id, { key: token.trim() }) : actions.connectorConnect(connector.id, { token: token.trim() }), () => { setToken(''); onDone?.() })
  }
  return h('div', { className: 'bt-connector-form' },
    h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value: token, onChange: setToken, onEnter: connect, label: isKey ? t('{name} key', { name: connector.name }) : t('{name} token', { name: connector.name }), autoFocus: true })),
    h('div', { className: 'bt-connector-form-row' },
      (connector.id === 'github' ? h('a', { className: 'bt-connector-link', href: TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' }, t('Create a token on GitHub'))
        : connector.auth?.keyUrl ? h('a', { className: 'bt-connector-link', href: connector.auth.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, t('Get a key')) : h('span', { className: 'bt-connector-link' })),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDone }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: token.trim() === '', onClick: connect }, t('Connect'))))
}

export function ConnectorRow({ connector, actions }) {
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const run = (task, after) => {
    setBusy(true); setError(null)
    return Promise.resolve(task).then(() => { after?.() }, failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false))
  }
  const on = connector.state !== 'off' && connector.state !== 'needs-client'
  const pending = connector.pending
  const row = useRef(null)
  useMorph(row, `${form}:${error !== null}:${connector.state}:${pending?.kind ?? ''}`)
  const connect = () => {
    if (connector.auth?.kind === 'none') return void run(actions.connectorConnect(connector.id, {}))
    if (connector.auth?.kind === 'key') return setForm('token')
    if (connector.auth?.kind === 'oauth') {
      if (connector.auth.client?.id || !connector.auth.token) return void run(actions.connectorConnect(connector.id, {}))
      return setForm('token')
    }
    return undefined
  }
  return h('div', { ref: row, className: 'bt-connector', 'data-state': connector.state },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, h(ConnectorMark, { connector })),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, connector.name, connector.custom ? h('span', { className: 'bt-tag' }, t('Added')) : null),
        h('span', { className: 'bt-connector-status' }, t(statusText(connector)))),
      h('span', { className: 'bt-connector-actions' },
        connector.state === 'error' || connector.state === 'needs-sign-in' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorRetry(connector.id)) }, connector.state === 'needs-sign-in' ? t('Sign in again') : t('Try again')) : null,
        on && !pending
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.connectorDisconnect(connector.id)) }, connector.custom ? t('Remove') : t('Disconnect'))
          : pending || form ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: connect }, t('Connect')),
        !on && !pending && form === null && connector.auth?.kind === 'oauth' && connector.auth.token === true && connector.auth.client?.id
          ? h('button', { type: 'button', className: 'bt-connector-link', disabled: busy, onClick: () => setForm('token') }, t('Use a token instead'))
          : null)),
    connector.readOnly !== undefined && on ? h('div', { className: 'bt-connector-ro' },
      h(SwitchRow, { label: t('Read-only'), on: connector.readOnly === true, onChange: checked => void run(actions.connectorSet(connector.id, { readOnly: checked })) })) : null,
    pending?.kind === 'browser' ? h(BrowserPanel, { connector, actions, run }) : null,
    pending?.kind === 'device' ? h(DevicePanel, { connector, actions, run, onUseToken: () => setForm('token') }) : null,
    connector.state === 'needs-client' && !pending?.kind ? h(ClientPanel, { connector, actions, run }) : null,
    form === 'token' ? h(TokenPanel, { connector, actions, run, onDone: () => { setForm(null); setError(null) } }) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null,
    connector.tools > 0 ? h('div', { className: 'bt-connector-status' }, t('{count} tools', { count: connector.tools })) : null)
}

// Where each mail provider's authorization code or app password comes from.
const NETEASE_STEPS = [
  'Sign in at {host} and open Settings → POP3/SMTP/IMAP.',
  'Turn on IMAP/SMTP and send the text message it asks for.',
  'Paste the 16-character code below. It is shown only once.',
]
const NETEASE_HELP = 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b'
const MAIL_GUIDES = {
  qq: {
    host: 'mail.qq.com',
    open: 'https://mail.qq.com',
    help: 'https://help.mail.qq.com/detail/106/985',
    label: 'Authorization code',
    steps: [
      'Sign in at mail.qq.com, click your avatar at the top right, and open Settings → Account and Security → Security Settings.',
      'Turn on the POP3/IMAP/SMTP service, then click Generate authorization code and verify yourself.',
      'Paste the 16-letter code below. Changing your QQ password cancels it.',
    ],
  },
  '163': { host: 'mail.163.com', open: 'https://mail.163.com', help: NETEASE_HELP, label: 'Authorization code', steps: NETEASE_STEPS },
  '126': { host: 'mail.126.com', open: 'https://mail.126.com', help: NETEASE_HELP, label: 'Authorization code', steps: NETEASE_STEPS },
  gmail: {
    host: 'myaccount.google.com',
    open: 'https://myaccount.google.com/apppasswords',
    help: 'https://support.google.com/accounts/answer/185833',
    label: 'App password',
    steps: [
      'Turn on 2-Step Verification for your Google Account.',
      'Open App passwords, create one, and paste the 16-character password below.',
      'Work and school accounts cannot use app passwords.',
    ],
  },
  icloud: {
    host: 'account.apple.com',
    open: 'https://account.apple.com',
    help: 'https://support.apple.com/102654',
    label: 'App password',
    steps: [
      'Your Apple Account needs two-factor authentication.',
      'Sign in at account.apple.com and open Sign-In and Security → App-Specific Passwords.',
      'Generate a password and paste it below.',
    ],
  },
}

function MailAccount({ account, actions, run }) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const remove = () => {
    if (busyRef.current || busy) return
    busyRef.current = true
    setBusy(true)
    void Promise.resolve(run(actions.mailAccountRemove(account.id))).finally(() => { busyRef.current = false; setBusy(false) })
  }
  return h('div', { className: 'bt-connector', 'data-state': account.error ? 'error' : 'ready' },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, h(ConnectorMark, { connector: { id: `mail-${account.provider}`, name: account.address } })),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, account.address),
        h('span', { className: 'bt-connector-status' }, account.error ? hostText(account.error) : t('Connected'))),
      h('span', { className: 'bt-connector-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: remove }, t('Remove')))))
}

// The Google sign-in the host started: it waits as a row that looks like the
// connector rows, with the sign-in page one click away.
function MailPending({ pending }) {
  return h('div', { className: 'bt-connector', 'data-state': 'connecting' },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, h(ConnectorMark, { connector: { id: 'mail-gmail', name: 'Google' } })),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, pending.address ?? 'Google'),
        h('span', { className: 'bt-connector-status' }, t('Waiting for sign-in…'))),
      h('span', { className: 'bt-connector-actions' },
        h('a', { className: 'bt-soft bt-soft-sm bt-mail-open', href: pending.url, target: '_blank', rel: 'noopener noreferrer' }, t('Open the sign-in page')))))
}

// The add form lives in the card like the other pages' add rows. While the host
// verifies the sign-in every field and button is disabled, so a second click
// cannot start a second add. A good add closes the form, which drops the typed
// address, code, provider and hosts with it.
function MailForm({ mail, actions, mailRun, busy, error, fields, setField, onClose }) {
  const { address, password, provider, imapHost, smtpHost } = fields
  const setAddress = value => setField('address', value)
  const setPassword = value => setField('password', value)
  const setProvider = value => setField('provider', value)
  const setImapHost = value => setField('imapHost', value)
  const setSmtpHost = value => setField('smtpHost', value)
  const domain = address.split('@')[1]?.toLowerCase() ?? ''
  const guessed = ['qq.com', 'foxmail.com'].includes(domain) ? 'qq' : ['163.com', '126.com', 'gmail.com', 'googlemail.com'].includes(domain) ? domain.replace(/\..*/, '').replace('googlemail', 'gmail') : ['icloud.com', 'me.com', 'mac.com'].includes(domain) ? 'icloud' : ''
  const chosen = provider || guessed || 'other'
  const guide = MAIL_GUIDES[chosen]
  const add = () => void mailRun(() => actions.mailAccountAdd({ address: address.trim(), password, provider: chosen, imapHost: imapHost.trim(), smtpHost: smtpHost.trim() }), onClose)
  return h('div', { className: 'bt-set-row bt-set-paste bt-mail-form' },
    h('div', { className: 'bt-mail-providers', role: 'radiogroup', 'aria-label': t('Provider') },
      [['qq', 'QQ'], ['163', '163'], ['126', '126'], ['gmail', 'Gmail'], ['icloud', 'iCloud'], ['other', t('Other')]].map(([id, label]) =>
        h('button', { key: id, type: 'button', role: 'radio', 'aria-checked': chosen === id, className: 'bt-secret-seg', disabled: busy, onClick: () => setProvider(id) }, label))),
    guide ? [
      h('ol', { key: 'guide', className: 'bt-mail-guide' }, guide.steps.map(step => h('li', { key: step }, t(step, { host: guide.host })))),
      h('div', { key: 'links', className: 'bt-connector-form-row' },
        h('a', { className: 'bt-connector-link', href: guide.open, target: '_blank', rel: 'noopener noreferrer' }, t('Open {host}', { host: guide.host })),
        h('a', { className: 'bt-connector-link', href: guide.help, target: '_blank', rel: 'noopener noreferrer' }, t('Official help'))),
    ] : null,
    h('input', { className: 'bt-input', 'aria-label': t('Email address'), placeholder: t('Email address'), value: address, autoComplete: 'off', disabled: busy, onChange: e => setAddress(e.target.value) }),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value: password, onChange: setPassword, label: t(guide?.label ?? 'Password or app password'), disabled: busy })),
    chosen === 'other' ? [
      h('input', { key: 'ih', className: 'bt-input', 'aria-label': t('IMAP host'), placeholder: t('IMAP host'), value: imapHost, disabled: busy, onChange: e => setImapHost(e.target.value) }),
      h('input', { key: 'sh', className: 'bt-input', 'aria-label': t('SMTP host'), placeholder: t('SMTP host'), value: smtpHost, disabled: busy, onChange: e => setSmtpHost(e.target.value) }),
    ] : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, hostText(error)) : null,
    h('div', { className: 'bt-secret-row-actions' },
      mail?.google ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void mailRun(() => actions.mailAccountAdd({ address: address.trim(), google: true }), onClose) }, t('Sign in with Google')) : h('span', { className: 'bt-connector-link' }),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onClose }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !address.includes('@') || password === '', onClick: add }, busy ? t('Verifying…') : t('Add account'))))
}

const EMPTY_MAIL = { address: '', password: '', provider: '', imapHost: '', smtpHost: '' }
export function MailSection({ mail, actions, run }) {
  const [form, setForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState(EMPTY_MAIL)
  const busyRef = useRef(false)
  const accounts = mail?.accounts ?? []
  const setField = (key, value) => setFields(current => ({ ...current, [key]: value }))
  const close = () => { setError(null); setForm(false); setFields(EMPTY_MAIL) }
  const mailRun = (task, onDone) => {
    if (busyRef.current || busy) return false
    busyRef.current = true
    setBusy(true)
    setError(null)
    void Promise.resolve().then(task).then(() => { onDone?.() }, (failure) => { setError(failure?.message ?? String(failure)) }).finally(() => { busyRef.current = false; setBusy(false) })
    return true
  }
  return [
    h('div', { key: 'title', className: 'bt-section-title' }, t('Mailbox')),
    h('div', { key: 'card', className: 'bt-set-card bt-connectors-card' },
      accounts.length === 0 && !form ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No mail accounts yet'))) : null,
      accounts.map(account => h(MailAccount, { key: account.id, account, actions, run })),
      (mail?.pending ?? []).map(p => h(MailPending, { key: p.address ?? 'google', pending: p })),
      form ? h(MailForm, { mail, actions, mailRun, busy, error, fields, setField, onClose: close }) : null),
    form ? null : h('div', { key: 'add', className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { setError(null); setForm(true) } }, t('Add an account')),
      mail?.google ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.mailAccountAdd({ google: true })) }, t('Sign in with Google')) : null),
  ]
}

function AddMenu({ actions, run }) {
  const [kind, setKind] = useState(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [found, setFound] = useState(null)
  const [picked, setPicked] = useState([])
  const reset = () => { setKind(null); setName(''); setUrl(''); setCommand(''); setFound(null); setPicked([]) }
  if (kind === 'import' && found === null) { void Promise.resolve(actions.connectorImportScan()).then(list => setFound(Array.isArray(list) ? list : list?.items ?? []), () => setFound([])) }
  return h('div', { className: 'bt-connector-add' },
    kind === null ? h('div', { className: 'bt-connector-form-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setKind('url') }, t('Add an address')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setKind('command') }, t('Add a command')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setKind('import') }, t('Import from other apps'))) : null,
    kind === 'url' || kind === 'command' ? h('div', { className: 'bt-connector-form' },
      h('input', { className: 'bt-input', 'aria-label': t('Name'), placeholder: t('Name'), value: name, onChange: e => setName(e.target.value) }),
      kind === 'url'
        ? h('input', { className: 'bt-input', 'aria-label': t('Server address'), placeholder: 'https://…', value: url, onChange: e => setUrl(e.target.value) })
        : h('input', { className: 'bt-input', 'aria-label': t('Command'), placeholder: t('Command, e.g. npx -y some-mcp'), value: command, onChange: e => setCommand(e.target.value) }),
      h('div', { className: 'bt-connector-form-row' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: reset }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: name.trim() === '' || (kind === 'url' ? url.trim() === '' : command.trim() === ''), onClick: () => void run(kind === 'url' ? actions.connectorAdd({ name: name.trim(), url: url.trim() }) : actions.connectorAdd({ name: name.trim(), command: command.trim() }), reset) }, t('Add')))) : null,
    kind === 'import' ? h('div', { className: 'bt-connector-form' },
      found === null ? h('span', { className: 'bt-set-hint' }, t('Scanning…')) : found.length === 0 ? h('span', { className: 'bt-set-hint' }, t('No MCP servers found in Claude Desktop, Cursor, or VS Code settings.')) : [
        found.map(item => h('label', { key: `${item.source}:${item.name}`, className: 'bt-connector-import' },
          h('input', { type: 'checkbox', checked: picked.some(p => p.source === item.source && p.name === item.name), onChange: e => setPicked(list => e.target.checked ? [...list, { source: item.source, name: item.name }] : list.filter(p => !(p.source === item.source && p.name === item.name))) }),
          h('span', null, item.name), h('span', { className: 'bt-set-hint' }, `${item.source} · ${item.url ?? item.command}${item.envNames?.length ? ` · ${item.envNames.length} env` : ''}`))),
        h('div', { key: 'go', className: 'bt-connector-form-row' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: reset }, t('Cancel')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: picked.length === 0, onClick: () => void run(actions.connectorImport(picked), reset) }, t('Import {count}', { count: picked.length }))),
      ]) : null)
}

export function ConnectorsPage({ roster, actions }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [error, setError] = useState(null)
  const run = (task, onDone) => Promise.resolve(task).then(() => { setError(null); onDone?.() }, failure => setError(failure?.message ?? String(failure)))
  const data = roster?.connectors ?? { connectors: [], mail: { accounts: [], google: false } }
  const list = data.connectors ?? []
  const connected = list.filter(c => c.state !== 'off' || c.pending)
  const catalog = list.filter(c => c.state === 'off' && !c.pending)
    .filter(c => category === '' || c.category === category)
    .filter(c => query === '' || `${c.name} ${c.about}`.toLowerCase().includes(query.toLowerCase()))
  return h('section', { className: 'bt-set-section' },
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-section-title' }, t('Connected')),
    h('div', { className: 'bt-set-card bt-connectors-card' },
      connected.length === 0 ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No connectors connected'))) : null,
      connected.map(connector => h(ConnectorRow, { key: connector.id, connector, actions }))),
    h(MailSection, { mail: data.mail, actions, run }),
    h('div', { className: 'bt-section-title' }, t('Catalog')),
    h('div', { className: 'bt-set-card bt-connectors-card' },
      h('div', { className: 'bt-connector-search' },
        h('input', { className: 'bt-input', 'aria-label': t('Search connectors'), placeholder: t('Search'), value: query, onChange: e => setQuery(e.target.value) }),
        h('div', { className: 'bt-connector-chips' },
          h('button', { type: 'button', className: 'bt-secret-seg', 'aria-pressed': category === '', onClick: () => setCategory('') }, t('All')),
          CATEGORIES.map(id => h('button', { key: id, type: 'button', className: 'bt-secret-seg', 'aria-pressed': category === id, onClick: () => setCategory(category === id ? '' : id) }, t(CATEGORY_LABEL[id]))))),
      catalog.map(connector => h(ConnectorRow, { key: connector.id, connector, actions })),
      h(AddMenu, { actions, run })))
}

// Bot details → Connectors: one switch per connected connector (default on).
export function BotConnectors({ bot, roster, actions, run }) {
  const data = roster?.connectors
  const list = (data?.connectors ?? []).filter(c => c.state === 'ready')
  const mailOn = (data?.mail?.accounts ?? []).length > 0
  if (list.length === 0 && !mailOn) return null
  const rows = [...list, ...(mailOn ? [{ id: 'mail', name: t('Mailbox'), offFor: (data.mail?.offFor ?? []) }] : [])]
  return h('div', { className: 'bt-drawer-model' },
    h('div', { key: 't', className: 'bt-section-title' }, t('Connectors')),
    rows.map((connector) => {
      const off = (connector.offFor ?? []).includes(bot.id)
      return h(SwitchRow, { key: connector.id, label: connector.name, on: !off, onChange: (checked) => {
        const next = checked ? (connector.offFor ?? []).filter(id => id !== bot.id) : [...(connector.offFor ?? []), bot.id]
        void run(actions.connectorSet(connector.id, { offFor: next }))
      } })
    }))
}

// --- cards ---------------------------------------------------------------

// The request cards all draw on the secret card: mark with a kind badge, title
// and detail, the same close key, and .bt-q-btn/.bt-q-submit in the foot.
// Answered requests settle into the same read-only card the secret card leaves.
function RequestHead({ bot, badge, title, detail, onClose }) {
  return h('div', { className: 'bt-q-head bt-secret-head' },
    h('span', { className: 'bt-secret-who' }, h(BotMark, { bot, size: 28 }), badge ? h('span', { className: 'bt-secret-lock' }, badge) : null),
    h('div', { className: 'bt-q-text' },
      h('p', { className: 'bt-q-title' }, title),
      detail ? h('div', { className: 'bt-q-detail' }, detail) : null),
    onClose ? h('button', { type: 'button', className: 'bt-q-x', 'aria-label': t('Cancel the request'), title: t('Cancel'), onClick: onClose }, h(CloseIcon)) : null)
}

// The read-only card an answered request leaves in the transcript, on the same
// settled frame the secret and question cards use.
function SettledCard({ bot, title, done, badge }) {
  return h('div', { className: `bt-q bt-q-settled bt-secret bt-secret-done${done ? '' : ' bt-q-dismissed'}`, role: 'group', 'aria-label': title },
    h('div', { className: 'bt-q-head' },
      h('span', { className: 'bt-secret-who' }, h(BotMark, { bot, size: 22 })),
      h('div', { className: 'bt-q-text' }, h('p', { className: 'bt-q-title' }, title)),
      done ? h('span', { className: 'bt-q-check bt-secret-check', title: t('Done') }, h(CheckIcon)) : h('span', { className: 'bt-q-badge' }, badge)))
}

function ConnectorCard({ sessionId, bot, request, actions, inline = false }) {
  const hold = useDockHold(sessionId, 'connector', request.id, actions, inline)
  const name = request.name ?? request.connectorId
  const dismiss = () => { hold(); void actions.connectorRequestCancel(request.id) }
  return h('div', { className: 'bt-q bt-secret', role: 'group', onFocusCapture: hold, onPointerDownCapture: hold },
    h(RequestHead, { bot, badge: h(PlugIcon), title: t('{bot} needs {name}', { bot: bot.name, name }), detail: request.purpose, onClose: dismiss }),
    h('div', { className: 'bt-q-foot' },
      h('button', { type: 'button', className: 'bt-q-btn', onClick: dismiss }, t('Dismiss')),
      h('button', { type: 'button', className: 'bt-q-submit', onClick: () => { hold(); actions.openConnectors() } }, t('Connect'))))
}

function SettledConnector({ bot, request }) {
  return h(SettledCard, {
    bot,
    title: t('{bot} asked for {name}', { bot: bot.name, name: request.name ?? request.connectorId }),
    done: request.status === 'connected',
    badge: t('Canceled'),
  })
}

const humanSize = bytes => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`

const NONE = {}
export function ConnectorToolCell({ sessionId, callId, done, content, roster, actions, heldCards = NONE }) {
  const bot = roster.byId[sessionId]
  if (!bot) return h(CellEmpty)
  const request = (roster.connectorRequests?.[bot.id] ?? []).find(entry => entry.callId === callId && (entry.sessionId ?? sessionId) === sessionId)
  if (request?.status === 'pending' && heldCards[heldCardKey('connector', request.id)] > 0) return h(CellEmpty)
  if (request) {
    return request.status === 'pending'
      ? h('div', { className: 'bt-q-inline' }, h(ConnectorCard, { sessionId, bot, request, actions, inline: true }))
      : h('div', { className: 'bt-q-inline' }, h(SettledConnector, { bot, request }))
  }
  if (done && /already connected/.test(contentText(content))) return h(CellEmpty)
  return h(CellEmpty)
}

export function ConnectorDock({ sessionId, useRoster, useCards, useHeldCards, actions }) {
  const roster = useRoster(value => value)
  const shown = useCards?.(state => state[sessionId]) ?? NONE
  const held = useHeldCards?.(state => state[sessionId]) ?? NONE
  const bot = roster.byId[sessionId]
  if (!bot || currentPart(bot) !== sessionId) return null
  const drawn = entry => entry.callId && entry.sessionId === sessionId && shown[entry.callId] > 0 && !(held[heldCardKey('connector', entry.id)] > 0)
  const waiting = (roster.connectorRequests?.[bot.id] ?? []).filter(entry => entry.status === 'pending' && !drawn(entry))
  if (waiting.length === 0) return null
  return h('div', { className: 'bt-q-dock bt-secret-dock' }, waiting.map(request => h(ConnectorCard, { key: request.id, sessionId, bot, request, actions })))
}

export function MailSendCard({ sessionId, bot, request, roster, actions, inline = false }) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const hold = useDockHold(sessionId, 'mail', request.id, actions, inline)
  const answer = (choice) => {
    if (busyRef.current || busy) return
    busyRef.current = true
    hold()
    setBusy(true)
    void Promise.resolve(actions.mailSendAnswer(request.id, choice)).catch(() => {}).finally(() => { busyRef.current = false; setBusy(false) })
  }
  const account = (roster?.connectors?.mail?.accounts ?? []).find(entry => entry.id === request.account)
  const from = account?.address ?? request.account
  const route = [
    request.to ? `${t('To')} ${request.to}` : '',
    request.cc ? `${t('Cc')} ${request.cc}` : '',
    request.bcc ? `${t('Bcc')} ${request.bcc}` : '',
  ].filter(line => line !== '').join(' · ')
  return h('div', { className: 'bt-q bt-secret', role: 'group', onFocusCapture: hold, onPointerDownCapture: hold },
    h(RequestHead, {
      bot, badge: h(MailIcon), title: t('{bot} wants to send an email', { bot: bot.name }), detail: request.subject,
      onClose: busy ? undefined : () => answer('cancel'),
    }),
    // The message preview rides on the file box the other cards use for quoted
    // content; the body stays scrollable when it runs long.
    h('div', { className: 'bt-learning-file' },
      h('div', { className: 'bt-learning-filehead' },
        from ? h('span', { className: 'bt-learning-name' }, from) : null,
        h('span', { className: 'bt-learning-path' }, route)),
      h('div', { className: 'bt-mail-body' }, request.body)),
    request.attachmentDetails?.length ? h('div', { className: 'bt-q-detail' }, t('Attachments: {names}', { names: request.attachmentDetails.map(a => a.size !== undefined ? `${a.name} (${humanSize(a.size)})` : a.name).join(', ') })) : null,
    h('div', { className: 'bt-q-foot' },
      h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => answer('cancel') }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-q-submit', disabled: busy, onClick: () => answer('send') }, busy ? t('Sending…') : t('Send'))))
}

function SettledMail({ bot, request }) {
  return h(SettledCard, {
    bot,
    title: request.status === 'sent' ? t('Sent “{subject}”', { subject: request.subject }) : t('{bot} wanted to send “{subject}”', { bot: bot.name, subject: request.subject }),
    done: request.status === 'sent',
    badge: request.status === 'failed' ? t('Failed') : t('Canceled'),
  })
}

export function MailToolCell({ sessionId, callId, roster, actions, heldCards = NONE }) {
  const bot = roster.byId[sessionId]
  if (!bot) return h(CellEmpty)
  const request = (roster.mailRequests?.[bot.id] ?? []).find(entry => entry.callId === callId && (entry.sessionId ?? sessionId) === sessionId)
  if (request?.status === 'pending' && heldCards[heldCardKey('mail', request.id)] > 0) return h(CellEmpty)
  if (request) {
    return request.status === 'pending'
      ? h('div', { className: 'bt-q-inline' }, h(MailSendCard, { sessionId, bot, request, roster, actions, inline: true }))
      : h('div', { className: 'bt-q-inline' }, h(SettledMail, { bot, request }))
  }
  return h(CellEmpty)
}

export function MailDock({ sessionId, useRoster, useCards, useHeldCards, actions }) {
  const roster = useRoster(value => value)
  const shown = useCards?.(state => state[sessionId]) ?? NONE
  const held = useHeldCards?.(state => state[sessionId]) ?? NONE
  const bot = roster.byId[sessionId]
  if (!bot || currentPart(bot) !== sessionId) return null
  const drawn = entry => entry.callId && entry.sessionId === sessionId && shown[entry.callId] > 0 && !(held[heldCardKey('mail', entry.id)] > 0)
  const waiting = (roster.mailRequests?.[bot.id] ?? []).filter(entry => entry.status === 'pending' && !drawn(entry))
  if (waiting.length === 0) return null
  return h('div', { className: 'bt-q-dock bt-secret-dock' }, waiting.map(request => h(MailSendCard, { key: request.id, sessionId, bot, request, roster, actions })))
}

export const CONNECTOR_CSS = `
.bt-connector-mono{display:inline-flex;width:20px;height:20px;border-radius:6px;align-items:center;justify-content:center;background:var(--bt-accent);color:var(--bt-card);font-size:12px;font-weight:600;filter:hue-rotate(calc(var(--bt-hue,0)*1deg))}
.bt-connector-name{display:inline-flex;align-items:center;gap:6px}
.bt-connector-search{display:flex;flex-direction:column;gap:8px;padding:12px}
.bt-connector-chips{display:flex;flex-wrap:wrap;gap:6px}
.bt-connector-chips .bt-secret-seg{height:26px;padding:0 10px;border:.5px solid var(--bt-line)}
.bt-connector-chips .bt-secret-seg[aria-pressed=true]{background:var(--bt-active)}
.bt-connector-add{padding:0 12px 12px}
.bt-connector-ro{padding-left:48px}
.bt-connector-device{display:flex;align-items:center;gap:10px}
.bt-connector-code{font-family:ui-monospace,Menlo,monospace;font-size:16px;letter-spacing:.12em;padding:4px 10px;border-radius:8px;background:var(--bt-hover)}
.bt-connector-import{display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;cursor:pointer}
.bt-mail-providers{display:flex;gap:4px;flex-wrap:wrap}
.bt-mail-providers .bt-secret-seg{height:26px;padding:0 10px;border:.5px solid var(--bt-line)}
.bt-mail-providers .bt-secret-seg[aria-checked=true]{background:var(--bt-active)}
.bt-connector-bot .bt-set-copy{min-width:0}
.bt-mail-open{text-decoration:none}
.bt-mail-body{max-height:180px;overflow-y:auto;padding:8px 12px;font-size:13px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--bt-ink)}
`

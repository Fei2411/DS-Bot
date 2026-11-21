import { createElement as h, useState } from 'react'
import { Switch } from './bot-settings.js'
import { dateLocale, t } from './i18n.js'

const OFF = { on: false, port: 8797, status: 'off', error: null, url: 'http://127.0.0.1:8797/mcp', clients: [] }

function statusText(mcp) {
  if (mcp.error) return mcp.error
  if (!mcp.on) return t('Off. Other agents cannot reach DS Bot.')
  return mcp.status === 'on' ? t('On. Agents with a token can reach DS Bot at {url}', { url: mcp.url }) : t('Connecting…')
}

// Which Bots and groups one client may reach. Private Bots are never offered.
function ScopePicker({ client, bots, rooms, busy, onChange }) {
  const toggle = (key, id) => {
    const list = client[key].includes(id) ? client[key].filter(entry => entry !== id) : [...client[key], id]
    onChange({ [key]: list })
  }
  const box = (key, entry) => h('label', { key: `${key}:${entry.id}`, className: 'bt-mcp-scope' },
    h('input', { type: 'checkbox', checked: client[key].includes(entry.id), disabled: busy, onChange: () => toggle(key, entry.id) }),
    h('span', null, entry.name))
  return h('div', { className: 'bt-mcp-scopes' }, ...bots.map(entry => box('bots', entry)), ...rooms.map(entry => box('rooms', entry)))
}

// Settings → MCP access: other agents on this computer call the Bot team through MCP.
export function McpPage({ roster, actions, Section, Row }) {
  const mcp = roster.mcp ?? OFF
  const [port, setPort] = useState(String(mcp.port))
  const [name, setName] = useState('')
  const [token, setToken] = useState(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const bots = (roster.bots ?? []).filter(bot => bot.private !== true)
  const rooms = roster.rooms ?? []
  const run = task => {
    setBusy(true)
    setError(null)
    return task.catch(failure => setError(failure?.message ?? String(failure))).finally(() => setBusy(false))
  }
  const add = () => {
    if (busy || name.trim() === '') return
    void run(actions.mcpClientAdd({ name }).then((view) => {
      setToken({ name: name.trim(), value: view.token })
      setCopied(false)
      setName('')
    }))
  }
  const copy = () => {
    const task = navigator.clipboard?.writeText(token.value)
    if (task === undefined) return setError(t('Clipboard is not available'))
    void run(task.then(() => setCopied(true)))
  }
  const names = client => [...client.bots.map(id => bots.find(bot => bot.id === id)?.name), ...client.rooms.map(id => rooms.find(room => room.id === id)?.name)].filter(Boolean)
  return h('div', { className: 'bt-mcp' },
    error ? h('p', { className: 'bt-set-hint bt-phone-warn', role: 'alert' }, error) : null,
    h(Section, { title: t('Connection') },
      h(Row, { label: t('MCP access'), hint: statusText(mcp), className: mcp.error ? 'bt-phone-warn' : '' },
        h(Switch, { on: mcp.on, label: t('MCP access'), disabled: busy, onChange: on => void run(actions.mcpSet({ on })) })),
      h(Row, { label: t('Port'), hint: t('Only programs on this computer can connect.') },
        h('input', { className: 'bt-input', value: port, inputMode: 'numeric', 'aria-label': t('Port'), onChange: event => setPort(event.target.value) }),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || port === String(mcp.port), onClick: () => void run(actions.mcpSet({ port: Number(port) })) }, t('Save')))),
    h(Section, { title: t('Add a client') },
      h(Row, { label: t('Name'), hint: t('Each agent gets its own token. It can read chats, send messages and wait for replies; approvals, questions, settings and secrets stay here.') },
        h('input', { className: 'bt-input', value: name, placeholder: 'Claude Desktop', 'aria-label': t('Name'), onChange: event => setName(event.target.value), onKeyDown: event => { if (event.key === 'Enter') add() } }),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || name.trim() === '', onClick: add }, t('Create token'))),
      token ? h('div', { className: 'bt-mcp-token' },
        h('span', { className: 'bt-set-hint' }, t('Copy the token for {name} now. It is shown once.', { name: token.name })),
        h('code', null, token.value),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: copy }, copied ? t('Copied') : t('Copy')),
        h('span', { className: 'bt-set-hint' }, t('Clients that start a command use: {command}', { command: `DSBOT_MCP_TOKEN=… npx -p ds-bot ds-bot-mcp --url ${mcp.url}` })))
        : null),
    h(Section, { title: t('Clients') }, mcp.clients.length === 0
      ? h(Row, { label: t('No clients yet') })
      : mcp.clients.map(client => h('div', { key: client.id, className: 'bt-mcp-client' },
        h(Row, {
          label: client.name,
          hint: client.lastUsedAt
            ? t('Last used {date}', { date: new Date(client.lastUsedAt).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }) })
            : t('Can reach: {names}', { names: names(client).join(', ') || t('nothing yet') }),
        }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => void run(actions.mcpClientRemove(client.id)) }, t('Remove'))),
        h(ScopePicker, { client, bots, rooms, busy, onChange: patch => void run(actions.mcpClientUpdate(client.id, patch)) })))))
}

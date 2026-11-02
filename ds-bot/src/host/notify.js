// Outbound push: lets a Bot reach the user's phone while the chat is closed, so a
// scheduled task that ends at 07:00 is not only waiting inside the page.
// Channels come from <DSH_HOME>/bot/notify.json ("channels": [...]) when that file
// exists, else from the environment: BARK_URL, NTFY_TOPIC (+ NTFY_SERVER),
// SERVERCHAN_KEY, PUSH_WEBHOOK. The same four names the dsh-chat bridge uses, so one
// set of credentials serves both.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const TIMEOUT_MS = 8000
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const TITLE_MAX = 60
const BODY_MAX = 400

const text = value => (typeof value === 'string' ? value.trim() : '')
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

// Every configured channel, in the order the user listed them.
export function channelsOf(rt) {
  let saved
  try {
    saved = JSON.parse(readFileSync(join(rt.home, 'notify.json'), 'utf8'))?.channels
  } catch {
    saved = undefined
  }
  const fromFile = Array.isArray(saved) ? saved.filter(item => item && typeof item.kind === 'string') : []
  if (fromFile.length > 0) return fromFile

  const env = process.env
  const list = []
  if (text(env.BARK_URL)) list.push({ kind: 'bark', url: text(env.BARK_URL) })
  if (text(env.NTFY_TOPIC)) list.push({ kind: 'ntfy', topic: text(env.NTFY_TOPIC), server: text(env.NTFY_SERVER) || 'https://ntfy.sh' })
  if (text(env.SERVERCHAN_KEY)) list.push({ kind: 'serverchan', key: text(env.SERVERCHAN_KEY) })
  if (text(env.PUSH_WEBHOOK)) list.push({ kind: 'webhook', url: text(env.PUSH_WEBHOOK) })
  return list
}

function request(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) })
}

async function send(channel, title, body) {
  const kind = channel.kind
  if (kind === 'bark') {
    if (!text(channel.url)) throw new Error('bark: no url')
    const url = `${channel.url.replace(/\/+$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`
    const response = await request(url)
    if (!response.ok) throw new Error(`bark: HTTP ${response.status}`)
    return
  }
  if (kind === 'ntfy') {
    if (!text(channel.topic)) throw new Error('ntfy: no topic')
    // The JSON publish endpoint carries the title and message as UTF-8; a raw
    // non-ASCII HTTP header cannot be sent.
    const url = `${(text(channel.server) || 'https://ntfy.sh').replace(/\/+$/, '')}`
    const response = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: channel.topic, title, message: body, tags: ['robot'] }),
    })
    if (!response.ok) throw new Error(`ntfy: HTTP ${response.status}`)
    return
  }
  if (kind === 'serverchan') {
    if (!text(channel.key)) throw new Error('serverchan: no key')
    const response = await request(`https://sctapi.ftqq.com/${encodeURIComponent(channel.key)}.send`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title, desp: body }).toString(),
    })
    if (!response.ok) throw new Error(`serverchan: HTTP ${response.status}`)
    return
  }
  if (kind === 'webhook') {
    if (!text(channel.url)) throw new Error('webhook: no url')
    const response = await request(channel.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, body, from: 'ds-bot' }) })
    if (!response.ok) throw new Error(`webhook: HTTP ${response.status}`)
    return
  }
  throw new Error(`${kind}: unknown channel`)
}

export function install(rt) {
  rt.notifyChannels = () => channelsOf(rt)

  rt.notifyUser = async (title, body) => {
    const channels = channelsOf(rt)
    if (channels.length === 0) throw new Error('no push channel is configured')
    const results = await Promise.all(channels.map(async channel => {
      try {
        await send(channel, title, body)
        return `${channel.kind}: sent`
      } catch (error) {
        return `${channel.kind}: ${error?.message ?? 'failed'}`
      }
    }))
    return results
  }

  rt.teamTools.push(defineTool({
    name: 'notify_user',
    description: 'Push a short message to the user\'s phone (Bark, ntfy, ServerChan or a webhook) for when the chat is closed: a scheduled task has just finished, a long job ended, or something needs the user now. Use it with scheduled tasks, so the user learns the result without opening the page. Plain text only; the phone does not render Markdown. Do not use it for every turn, only when the user would otherwise miss the result.',
    output,
    parameters: {
      title: { type: 'string', required: true, description: `Short headline, at most ${TITLE_MAX} characters.` },
      body: { type: 'string', description: `The message itself, plain text, at most ${BODY_MAX} characters. Put the conclusion first.` },
    },
    async execute(args) {
      const title = clip(text(args?.title) || 'DS Bot', TITLE_MAX)
      const body = clip(text(args?.body) || title, BODY_MAX)
      const channels = channelsOf(rt)
      if (channels.length === 0) {
        return 'No push channel is configured. Add "channels" to notify.json in the Bot data folder, or set BARK_URL / NTFY_TOPIC / SERVERCHAN_KEY / PUSH_WEBHOOK, then try again. Nothing was sent.'
      }
      const results = await Promise.all(channels.map(async channel => {
        try {
          await send(channel, title, body)
          return `${channel.kind}: sent`
        } catch (error) {
          return `${channel.kind}: ${error?.message ?? 'failed'}`
        }
      }))
      return ['Push result:', ...results].join('\n')
    },
  }))
}

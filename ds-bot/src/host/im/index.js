// IM: talk to Bots from chat apps. A connection is one IM bot account bound to a Bot;
// direct chats reach that Bot, platform group chats can be bound to a DS Bot group.
// The platform adapters (im/platforms/) own the wire; this module owns pairing,
// routing, cards and the send queues. Only the dsh holding the team lock connects.
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from '../files.js'
import { viewCardText } from '../parts.js'
import { imPlatform, IM_PLATFORMS } from '../../shared/im-platforms.js'
import { adapters } from './platforms/index.js'

const RECONCILE_MS = 15_000
const RUNTIME_SAVE_MS = 400
const RETRY_MS = 5_000
const TYPING_MS = 4_000
const NUMBERS = /^\s*\d+(\s+\d+)*\s*$/

const secretField = key => key.replace(/[A-Z]/g, char => `_${char}`).toUpperCase()

export function install(rt) {
  const { ctx, state } = rt
  const imDir = join(rt.home, 'im')
  const zh = () => String(rt.uiLanguage?.() ?? '').startsWith('Chinese')
  const text = (key, values = {}) => {
    const line = {
      requested: zh() ? '已向 DS Bot 发出连接请求，请在电脑上的 DS Bot 设置 → IM 里允许。' : 'A connection request was sent to DS Bot; allow it in Settings → IM on the computer.',
      unbound: zh() ? '这个 IM 机器人还没绑定 Bot，请在 DS Bot 设置 → IM 里选一个。' : 'This IM bot is not bound to a Bot yet; pick one in DS Bot Settings → IM.',
      unboundGroup: zh() ? '这个群还没绑定，请在 DS Bot 设置 → IM 里给它选一个群或 Bot。' : 'This group is not bound yet; pick a group or a Bot for it in DS Bot Settings → IM.',
      connected: zh() ? `已连接，现在可以和 ${values.target} 说话了。` : `Connected — you can talk to ${values.target} now.`,
      stopped: zh() ? '已停下。' : 'Stopped.',
      idle: zh() ? '现在没有在做的活。' : 'Nothing is running.',
      stale: zh() ? '这张卡已经答过了。' : 'This card was already answered.',
      noFile: zh() ? '这个文件发不过去，请在电脑上发。' : 'This file cannot be sent here; send it on the computer.',
      greeting: zh() ? `你好，我是 ${values.name}。` : `Hello, I am ${values.name}.`,
      question: zh() ? `${values.bot} 问你：` : `${values.bot} asks: `,
      approval: zh() ? `${values.bot} 请你审批：` : `${values.bot} asks for approval: `,
      secretAsk: zh() ? `${values.bot} 要密钥 ${values.name}，请在电脑或手机 App 上填。` : `${values.bot} needs the key ${values.name} — fill it on the computer or the phone app.`,
      viewShow: zh() ? `${values.bot} 发了一个卡片，请在电脑或手机 App 上回复。` : `${values.bot} shared a card — answer it on the computer or the phone app.`,
      answered: zh() ? '已答' : 'answered',
      numbers: zh() ? '回复编号' : 'reply with the number',
      numbersMulti: zh() ? '回复编号，多选用空格隔开' : 'reply with the numbers, separated by spaces',
      allow: zh() ? '允许一次' : 'Allow once',
      reject: zh() ? '拒绝' : 'Reject',
    }[key]
    return line ?? key
  }

  // ---------------------------------------------------------------- runtime file
  const runtimes = new Map() // id → { data: {runtime, cards, open}, timer }
  const runtimeOf = async (id) => {
    let held = runtimes.get(id)
    if (held !== undefined) return held
    let data
    try {
      data = JSON.parse(await readFile(join(imDir, `${id}.json`), 'utf8'))
    } catch { data = undefined }
    held = {
      data: {
        runtime: data?.runtime !== null && typeof data?.runtime === 'object' ? data.runtime : {},
        cards: data?.cards !== null && typeof data?.cards === 'object' ? data.cards : {},
      },
      timer: undefined,
    }
    runtimes.set(id, held)
    return held
  }
  const scheduleWrite = (id) => {
    const held = runtimes.get(id)
    if (held === undefined || held.timer !== undefined) return
    held.timer = setTimeout(() => {
      held.timer = undefined
      void writeRuntime(id).catch(error => rt.warn('ds-bot: im runtime %s not saved: %s', id, error))
    }, RUNTIME_SAVE_MS)
    held.timer.unref?.()
  }
  const writeRuntime = async (id) => {
    const held = runtimes.get(id)
    if (held === undefined || rt.readOnly() !== undefined) return
    await mkdir(imDir, { recursive: true })
    const temp = join(imDir, `${id}.${process.pid}.tmp`)
    try {
      await writeFile(temp, JSON.stringify(held.data), { encoding: 'utf8', mode: 0o600 })
      await chmod(temp, 0o600)
      await replaceFile(temp, join(imDir, `${id}.json`))
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
  const runtimeEnv = async (id) => {
    const held = await runtimeOf(id)
    return {
      get: () => held.data.runtime,
      set: (patch) => {
        Object.assign(held.data.runtime, patch)
        scheduleWrite(id)
      },
    }
  }
  // Sent cards: cardKey → [{ chatKey, messageId, answer? }]. Persisted so a restart
  // does not send a card twice; an `answer` marks it settled from this side.
  const cardsOf = async (id) => (await runtimeOf(id)).data
  const markCard = async (id, cardKey, chatKey, messageId, body) => {
    const data = await cardsOf(id)
    const entries = data.cards[cardKey] ?? []
    const held = entries.find(entry => entry.chatKey === chatKey)
    if (held !== undefined) {
      held.messageId = messageId ?? held.messageId
      held.text = body ?? held.text
    } else {
      entries.push({ chatKey, messageId, text: body })
    }
    data.cards[cardKey] = entries
    scheduleWrite(id)
  }
  const settleCard = async (id, cardKey, answer) => {
    const data = await cardsOf(id)
    const entries = data.cards[cardKey]
    if (entries === undefined) return
    for (const entry of entries) entry.answer ??= answer
    scheduleWrite(id)
  }

  // ------------------------------------------------------------- connections
  const connections = () => (state.im ??= { connections: {} }).connections
  const adaptersFor = () => Object.keys(adapters)
  const hasSecrets = conn => Object.values(conn.secrets ?? {}).every(name => rt.secretValue(name) !== undefined)
  const fieldsOf = (conn) => {
    const fields = { ...conn.settings }
    for (const [key, name] of Object.entries(conn.secrets ?? {})) fields[key] = rt.secretValue(name)
    return fields
  }
  const envFor = async (conn, runtime) => ({
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    config: rt.config.im?.[conn.platform],
    runtime: runtime ?? await runtimeEnv(conn.id),
    log: { warn: (template, ...args) => rt.warn(template, ...args) },
    uploadFile: async (sessionId, file) => {
      const uploads = ctx.get?.('fileUploads')
      if (typeof uploads?.uploadStream !== 'function') throw new Error('no upload service')
      const data = file.data?.[Symbol.asyncIterator] !== undefined ? file.data : (async function* () { yield file.data })()
      const value = await uploads.uploadStream({ sessionId, data, name: file.name })
      return value.receiptId
    },
  })

  // ------------------------------------------------------------------ send out
  /** @type {Map<string, {handle:any, queues:Map<string, {jobs:any[], retry?:any}>, statuses:Map}>} */
  const runners = new Map()
  const statuses = new Map()
  const setStatus = (id, next) => {
    // Adapter errors can echo platform responses that quote the token; keep them out of the UI and logs.
    if (typeof next.error === 'string' && next.error !== '') return statuses.set(id, { ...next, error: rt.redactSecrets(next.error), at: Date.now() })
    return statuses.set(id, { ...next, at: Date.now() })
  }
  const targetsOf = (conn) => {
    const out = []
    for (const [chatKey, chat] of Object.entries(conn.chats ?? {})) {
      const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
      out.push({ chatKey, chat, target })
    }
    return out
  }
  // Chats of this connection that listen to a Bot's own chat or a group.
  const listeners = (conn, match) => targetsOf(conn).filter(({ target }) => {
    if (match.botId !== undefined) return target?.botId === match.botId && rt.botOf(target.botId) !== undefined
    if (match.roomId !== undefined) return target?.roomId === match.roomId && rt.roomOf(target.roomId) !== undefined
    return false
  })

  const failClass = (error) => {
    if (error?.permanent === true || (typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 429)) return 'permanent'
    if (error?.unknown === true || error?.stopped === true) return 'drop'
    return 'retry'
  }

  const enqueue = (conn, chatKey, job) => {
    const runner = runners.get(conn.id)
    if (runner === undefined) return
    let queue = runner.queues.get(chatKey)
    if (queue === undefined) runner.queues.set(chatKey, queue = { jobs: [] })
    queue.jobs.push(job)
    if (queue.jobs.length === 1) void drain(conn, chatKey)
  }
  const drain = async (conn, chatKey) => {
    const runner = runners.get(conn.id)
    const queue = runner?.queues.get(chatKey)
    // A reserved slot has no handle until connect() lands; start() re-kicks
    // anything queued in the meantime.
    if (runner?.handle === undefined || queue === undefined) return
    while (queue.jobs.length > 0) {
      const job = queue.jobs[0]
      try {
        const sent = await runner.handle.send(job.chat, job)
        job.after?.(sent)
        queue.jobs.shift()
      } catch (error) {
        const how = failClass(error)
        if (how === 'retry') {
          const wait = Number(error?.retryAfter) > 0 ? error.retryAfter * 1000 : RETRY_MS
          queue.retry = setTimeout(() => { void drain(conn, chatKey) }, wait)
          queue.retry.unref?.()
          return
        }
        queue.jobs.shift()
        if (how === 'permanent') setStatus(conn.id, { state: 'error', error: String(error?.message ?? error).slice(0, 300) })
      }
    }
  }
  const sendText = (conn, chat, body, buttons, after) => enqueue(conn, chat.key, { chat, text: body, buttons, after })
  const sendTo = (conn, chatKey, chat, body, buttons, after) => enqueue(conn, chatKey, { chat, text: body, buttons, after })

  // ----------------------------------------------------------------- inbound
  const paired = (conn, senderId) => (conn.paired ?? []).some(entry => entry.id === senderId)
  const requested = (conn, msg) => {
    if ((conn.requests ?? []).some(entry => entry.id === msg.sender.id)) return false
    conn.requests = [...(conn.requests ?? []), { id: msg.sender.id, name: msg.sender.name, chatKey: msg.chat.key, chatKind: msg.chat.kind, at: Date.now() }]
    return true
  }

  const targetName = (conn, target) => {
    if (target?.botId !== undefined) return rt.botOf(target.botId)?.name
    if (target?.roomId !== undefined) return rt.roomOf(target.roomId)?.name
    return undefined
  }
  const resolveTarget = (conn, chat) => {
    const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
    if (target?.botId !== undefined && rt.botOf(target.botId) !== undefined) return target
    if (target?.roomId !== undefined && rt.roomOf(target.roomId) !== undefined) return target
    return undefined
  }

  // One card this chat was sent and has not answered yet. A button names its own
  // card, so it must never fall through to a newer card of the same kind.
  const openCard = (conn, chatKey, cardKey) => {
    const entries = runtimes.get(conn.id)?.data?.cards[cardKey]
    const entry = entries?.find(item => item.chatKey === chatKey && item.answer === undefined)
    return entry === undefined ? undefined : { cardKey, entry }
  }
  const questionById = (id) => {
    for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
      if (question.id === id) return { sessionId, question }
    }
    return undefined
  }
  const answerQuestionCard = async (conn, chat, cardKey, labels) => {
    const held = openCard(conn, chat.key, cardKey)
    if (held === undefined) return false
    const found = questionById(held.cardKey.slice(2))
    if (found === undefined) {
      await sendCardReply(conn, chat, text('stale'))
      return true
    }
    const valid = labels.filter(label => (found.question.options ?? []).some(option => option.label === label))
    if (valid.length === 0) return false
    try {
      await rt.answerQuestion(found.sessionId, found.question.id, { selected: valid })
      await settleCard(conn.id, held.cardKey, valid.join(', '))
      await settledEdits(conn)
    } catch (error) {
      if (error?.code === 'bot/stale') {
        await settleCard(conn.id, held.cardKey, text('answered'))
        await sendCardReply(conn, chat, text('stale'))
        await settledEdits(conn)
        return true
      }
      throw error
    }
    return true
  }
  const answerApprovalCard = async (conn, chat, cardKey, choice) => {
    const held = openCard(conn, chat.key, cardKey)
    if (held === undefined) return false
    try {
      rt.answerApproval(held.cardKey.slice(2), choice)
      await settleCard(conn.id, held.cardKey, choice === 'allow' ? text('allow') : text('reject'))
      await settledEdits(conn)
    } catch (error) {
      if (error?.code === 'bot/stale') {
        await sendCardReply(conn, chat, text('stale'))
        return true
      }
      throw error
    }
    return true
  }
  const sendCardReply = async (conn, chat, body) => sendText(conn, { key: chat.key, kind: chat.kind, title: chat.title }, body)

  // The chat's newest still-open card, questions and approvals together: a bare
  // number answers whatever arrived last, not always a question.
  const newestOpenCard = (conn, chatKey) => {
    const data = runtimes.get(conn.id)?.data
    if (data === undefined) return undefined
    for (const [cardKey, entries] of Object.entries(data.cards).reverse()) {
      if (!cardKey.startsWith('q:') && !cardKey.startsWith('a:')) continue
      const entry = entries.find(item => item.chatKey === chatKey && item.answer === undefined)
      if (entry !== undefined) return { cardKey, entry }
    }
    return undefined
  }

  const onMessage = (conn) => async (msg) => {
    if (!paired(conn, msg.sender.id)) {
      if (msg.chat.kind === 'group' && !msg.mentioned) return
      if (!requested(conn, msg)) return
      await rt.save()
      await sendText(conn, msg.chat, text('requested'))
      return
    }
    conn.chats ??= {}
    if (msg.chat.kind === 'group' && !msg.mentioned) return
    if (conn.chats[msg.chat.key] === undefined) {
      conn.chats[msg.chat.key] = { kind: msg.chat.kind, title: msg.chat.title, at: Date.now() }
      await rt.save()
    }
    const body = String(msg.text ?? '').trim()
    const chat = conn.chats[msg.chat.key]
    const target = resolveTarget(conn, chat)
    if (/^\/start(?:@\S+)?\s*$/.test(body)) {
      const name = target === undefined ? undefined : targetName(conn, target)
      await sendText(conn, msg.chat, name === undefined ? text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound') : text('greeting', { name }))
      return
    }
    if (/^\/stop(?:@\S+)?\s*$/.test(body)) {
      if (target === undefined) {
        await sendText(conn, msg.chat, text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'))
        return
      }
      const stopped = target.botId !== undefined ? await rt.stopChat(target.botId) : await rt.stopRoomWork(target.roomId)
      await sendText(conn, msg.chat, text(stopped ? 'stopped' : 'idle'))
      return
    }
    if (NUMBERS.test(body)) {
      const picked = body.trim().split(/\s+/).map(Number)
      const held = newestOpenCard(conn, msg.chat.key)
      // Anything that does not clearly answer the newest open card — a stale
      // source, an out-of-range pick, several picks on a single choice — is a
      // normal message for the Bot, never swallowed and never 'stale'.
      if (held !== undefined && held.cardKey.startsWith('q:')) {
        const found = questionById(held.cardKey.slice(2))
        if (found !== undefined) {
          const options = found.question.options ?? []
          const inRange = picked.length > 0 && (found.question.multiSelect === true || picked.length === 1)
            && picked.every(index => options[index - 1] !== undefined)
          if (inRange && await answerQuestionCard(conn, msg.chat, held.cardKey, picked.map(index => options[index - 1].label))) return
        }
      } else if (held !== undefined && held.cardKey.startsWith('a:')
        && picked.length === 1 && (picked[0] === 1 || picked[0] === 2)
        && rt.approvalsView().some(entry => `a:${entry.id}` === held.cardKey)) {
        if (await answerApprovalCard(conn, msg.chat, held.cardKey, picked[0] === 1 ? 'allow' : 'reject')) return
      }
    }
    if (target === undefined) {
      await sendText(conn, msg.chat, text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'))
      return
    }
    const sessionId = target.botId ?? target.roomId
    const content = []
    if (body !== '') content.push({ type: 'text', text: body })
    for (const image of msg.images ?? []) content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
    const env = await envFor(conn)
    for (const file of msg.files ?? []) {
      try {
        const receiptId = await env.uploadFile(rt.botOf(sessionId) ? rt.chatOf(sessionId) : sessionId, file)
        content.push({ type: 'file', receiptId })
      } catch {
        await sendText(conn, msg.chat, text('noFile'))
      }
    }
    if (content.length === 0) return
    await rt.sendUser({ sessionId, content, requestId: `im:${conn.platform}:${randomUUID()}` })
  }

  const onAction = (conn) => async (action) => {
    if (!paired(conn, action.sender.id)) return
    const data = String(action.data ?? '')
    const chat = { key: action.chat.key, kind: action.chat.kind, title: action.chat.title }
    // Button data is `<kind>:<id>:<choice>`; the id is everything between the
    // first and the last colon, so an id with a colon in it still parses.
    const cut = data.lastIndexOf(':')
    const cardKey = data.slice(0, cut)
    const choice = data.slice(cut + 1)
    if (data.startsWith('q:') && cut > 2) {
      const found = questionById(cardKey.slice(2))
      const label = found?.question.options?.[Number(choice)]?.label
      if (label === undefined) {
        await sendCardReply(conn, chat, text('stale'))
        return
      }
      if (!(await answerQuestionCard(conn, chat, cardKey, [label]))) await sendCardReply(conn, chat, text('stale'))
      return
    }
    if (data.startsWith('a:') && cut > 2) {
      if (choice === 'allow' || choice === 'reject') {
        if (!(await answerApprovalCard(conn, chat, cardKey, choice))) await sendCardReply(conn, chat, text('stale'))
      }
    }
  }

  // ------------------------------------------------------------------ cards
  const cardText = {
    question: (bot, question) => {
      const options = (question.options ?? []).map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n')
      const hint = question.multiSelect === true ? text('numbersMulti') : text('numbers')
      return `${text('question', { bot })}${question.question}${question.detail ? `\n${question.detail}` : ''}\n${options}\n(${hint})`
    },
    approval: (bot, entry) => `${text('approval', { bot })}${entry.tool}${entry.reason ? ` — ${entry.reason}` : ''}${entry.detail?.text ? `\n${entry.detail.text}` : ''}${entry.detail?.code ? `\n${entry.detail.code}` : ''}`,
  }
  const cardButtons = {
    question: (question) => (question.multiSelect === true ? undefined : (question.options ?? []).map((option, index) => ({ data: `q:${question.id}:${index}`, label: option.label }))),
    approval: (id) => [{ data: `a:${id}:allow`, label: text('allow') }, { data: `a:${id}:reject`, label: text('reject') }],
  }

  const sendCard = async (conn, cardKey, targets, body, buttons) => {
    for (const { chatKey, chat } of targets) {
      sendTo(conn, chatKey, { key: chatKey, kind: chat.kind, title: chat.title }, body, buttons, (sent) => {
        void markCard(conn.id, cardKey, chatKey, sent?.messageId, body)
      })
    }
    // A card a chat never got (queued behind a failure) is still recorded below.
    for (const { chatKey } of targets) await markCard(conn.id, cardKey, chatKey, undefined, body)
  }

  const diffCards = async () => {
    if (rt.readOnly() !== undefined) return
    for (const conn of Object.values(connections())) {
      const runner = runners.get(conn.id)
      if (runner === undefined) continue
      const data = await cardsOf(conn.id)
      // Questions: one card per open question id, sent to the Bot's chats.
      for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
        const cardKey = `q:${question.id}`
        if (data.cards[cardKey] !== undefined) continue
        const botId = rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.question(question) : undefined
        await sendCard(conn, cardKey, listeners(conn, { botId }), cardText.question(bot.name, question), buttons)
      }
      // Secret requests: text only — the key is typed on the computer or phone.
      for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        for (const request of list) {
          const cardKey = `s:${request.id}`
          if (request.status !== 'pending' || data.cards[cardKey] !== undefined) continue
          await sendCard(conn, cardKey, listeners(conn, { botId }), text('secretAsk', { bot: bot.name, name: request.name }))
        }
      }
      // Views awaiting a reply: text form only.
      for (const [sessionId, view] of Object.entries(state.views ?? {})) {
        const cardKey = `v:${view.id}`
        if (data.cards[cardKey] !== undefined) continue
        const botId = rt.chatOwners.get(sessionId)
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        const form = viewCardText({ title: view.title, view: view.view })
        await sendCard(conn, cardKey, listeners(conn, { botId }), `${text('viewShow', { bot: bot.name })}${form !== '' ? `\n${form}` : view.title ? `\n${view.title}` : ''}`)
      }
    }
  }

  // Buttons drop and the answer shows wherever the card was settled.
  const settledEdits = async (conn) => {
    const runner = runners.get(conn.id)
    const data = runtimes.get(conn.id)?.data
    if (runner?.handle.edit === undefined || data === undefined) return
    for (const entries of Object.values(data.cards)) {
      for (const entry of entries) {
        if (entry.answer === undefined || entry.messageId === undefined || entry.edited === true) continue
        const chat = conn.chats?.[entry.chatKey]
        if (chat === undefined) continue
        entry.edited = true
        const body = entry.text !== undefined ? `${entry.text}\n— ${entry.answer}` : `(${text('answered')})`
        runner.handle.edit({ key: entry.chatKey, kind: chat.kind, title: chat.title }, entry.messageId, { text: body }).catch(() => {})
        scheduleWrite(conn.id)
      }
    }
  }
  // A card answered on the computer leaves the state; its IM copy settles too.
  const settleGone = async () => {
    for (const conn of Object.values(connections())) {
      const data = runtimes.get(conn.id)?.data
      if (data === undefined) continue
      let touched = false
      const openIds = new Set(Object.values(state.questions ?? {}).map(question => `q:${question.id}`))
      const openSecret = new Set(Object.values(state.secretRequests ?? {}).flat().filter(entry => entry.status === 'pending').map(entry => `s:${entry.id}`))
      const openViews = new Set(Object.values(state.views ?? {}).map(view => `v:${view.id}`))
      const openCard = cardKey => cardKey.startsWith('q:') ? openIds.has(cardKey)
        : cardKey.startsWith('a:') ? rt.approvalsView().some(entry => `a:${entry.id}` === cardKey)
          : cardKey.startsWith('s:') ? openSecret.has(cardKey)
            : cardKey.startsWith('v:') ? openViews.has(cardKey) : false
      for (const [cardKey, entries] of Object.entries(data.cards)) {
        if (openCard(cardKey)) continue
        for (const entry of entries) {
          if (entry.answer === undefined) {
            entry.answer = text('answered')
            touched = true
          }
        }
      }
      if (touched) {
        scheduleWrite(conn.id)
        await settledEdits(conn)
      }
      // A card whose source is gone stays only until its copies are settled and
      // edited where the platform can edit; keeping it forever grows the file.
      const editable = runners.get(conn.id)?.handle?.edit !== undefined
      let pruned = false
      for (const [cardKey, entries] of Object.entries(data.cards)) {
        if (openCard(cardKey)) continue
        const droppable = entries.length === 0 || entries.every(entry => entry.answer !== undefined
          && (entry.edited === true || entry.messageId === undefined || !editable || conn.chats?.[entry.chatKey] === undefined))
        if (droppable) {
          delete data.cards[cardKey]
          pruned = true
        }
      }
      if (pruned) scheduleWrite(conn.id)
    }
  }

  // ---------------------------------------------------------------- lifecycle
  // `state.im.connections` is replaced wholesale when a save is adopted, so anything
  // bound at connect time looks the connection up again by id instead of keeping it.
  const fresh = id => connections()[id]
  const onStatus = (id) => (next) => {
    setStatus(id, { state: next.state, error: next.error, at: Date.now() })
    const conn = fresh(id)
    if (conn !== undefined && next.account !== undefined && (conn.account?.id !== next.account.id || conn.account?.name !== next.account.name)) {
      conn.account = next.account
      void rt.save().catch(() => {})
    }
  }

  const busyOf = (target) => {
    if (target?.botId !== undefined) return rt.live.get(rt.chatOf(target.botId))?.turn !== undefined
    if (target?.roomId !== undefined) return (rt.roomWorkView?.()[target.roomId] ?? []).length > 0
    return false
  }

  const start = async (conn) => {
    const adapter = adapters[conn.platform]
    if (adapter === undefined || runners.has(conn.id)) return
    const platform = imPlatform(conn.platform)
    if (platform?.ws === true && globalThis.WebSocket === undefined) {
      setStatus(conn.id, { state: 'error', error: 'This dsh runs on a Node without WebSocket', at: Date.now() })
      return
    }
    // The slot is reserved before the async work: a concurrent sync cannot
    // start a second adapter for the same connection.
    const runner = { handle: undefined, queues: new Map(), typing: undefined }
    runners.set(conn.id, runner)
    setStatus(conn.id, { state: 'connecting', at: Date.now() })
    try {
      const env = await envFor(conn)
      const handle = adapter.connect(fieldsOf(conn), env, {
        onMessage: (msg) => {
          const current = fresh(conn.id)
          return current === undefined ? undefined : onMessage(current)(msg).catch(error => rt.warn('ds-bot: im message failed: %s', error))
        },
        onAction: (action) => {
          const current = fresh(conn.id)
          return current === undefined ? undefined : onAction(current)(action).catch(error => rt.warn('ds-bot: im action failed: %s', error))
        },
        onStatus: onStatus(conn.id),
      })
      // A stop() during connect took the slot back: undo the just-started
      // adapter instead of leaving it running unreachable.
      if (runners.get(conn.id) !== runner) {
        void Promise.resolve(handle?.stop?.()).catch(() => {})
        return
      }
      runner.handle = handle
      for (const chatKey of runner.queues.keys()) void drain(conn, chatKey)
      if (typeof runner.handle?.typing === 'function') {
        runner.typing = setInterval(() => {
          for (const { chat, target } of targetsOf(fresh(conn.id) ?? conn)) {
            if (target !== undefined && busyOf(target)) void runner.handle.typing({ key: chat.key ?? chat, kind: chat.kind, title: chat.title }).catch?.(() => {})
          }
        }, TYPING_MS)
        runner.typing.unref?.()
      }
      await diffCards()
    } catch (error) {
      runners.delete(conn.id)
      setStatus(conn.id, { state: 'error', error: String(error?.message ?? error).slice(0, 300), at: Date.now() })
    }
  }
  const stop = async (id) => {
    const runner = runners.get(id)
    runners.delete(id)
    if (runner?.typing !== undefined) clearInterval(runner.typing)
    for (const queue of runner?.queues.values() ?? []) clearTimeout(queue.retry)
    await Promise.resolve(runner?.handle?.stop?.()).catch(() => {})
    if (statuses.get(id)?.state !== 'error') setStatus(id, { state: 'off', at: Date.now() })
  }

  // Syncs run one behind the other: endpoints, onSaved and the interval can all
  // fire while a sync is still starting an adapter, and they must see its
  // reserved slots rather than start a second adapter.
  let syncing = Promise.resolve()
  const sync = () => {
    const run = syncing.then(async () => {
      const conns = connections()
      for (const conn of Object.values(conns)) {
        const wants = stopped !== true && adapters[conn.platform] !== undefined && conn.enabled !== false
          && rt.readOnly() === undefined && hasSecrets(conn)
        if (wants && !runners.has(conn.id)) await start(conn)
        else if (!wants && runners.has(conn.id)) await stop(conn.id)
      }
      for (const id of [...runners.keys()]) if (conns[id] === undefined) await stop(id)
      for (const id of [...statuses.keys()]) if (conns[id] === undefined) statuses.delete(id)
      for (const conn of Object.values(conns)) {
        if (conn.enabled === false || !runners.has(conn.id)) {
          if (statuses.get(conn.id)?.state !== 'error') setStatus(conn.id, { state: 'off', at: Date.now() })
        }
      }
    })
    syncing = run.catch(() => {})
    return run
  }

  let stopped = false

  // ---------------------------------------------------------------- endpoints
  const secretName = (conn, key) => `IM_${conn.platform.toUpperCase()}_${conn.id.slice(3, 9).toUpperCase()}_${secretField(key)}`
  const cleanFields = (platform, fields, base = {}) => {
    const given = fields !== null && typeof fields === 'object' ? fields : {}
    const out = {}
    for (const field of platform.fields) {
      const value = given[field.key]
      if (field.options !== undefined) {
        out[field.key] = field.options.some(([id]) => id === value) ? value
          : (value === undefined && base[field.key] !== undefined ? base[field.key] : field.options[0][0])
      } else if (typeof value === 'string' && value.trim() !== '') {
        out[field.key] = value.trim()
      } else if (!field.secret) {
        if (value !== undefined && typeof value !== 'string') throw new Error(`${field.label} must be text`)
        out[field.key] = value === undefined && base[field.key] !== undefined ? base[field.key] : ''
      }
      // Missing secret fields are allowed only on update, where the saved one stays.
    }
    return out
  }

  const saveSecrets = async (conn, platform, fields) => {
    for (const field of platform.fields) {
      if (!field.secret || fields[field.key] === undefined) continue
      const name = conn.secrets[field.key] ?? secretName(conn, field.key)
      await rt.secretEndpoint('secret-set', { name, value: fields[field.key], purpose: `${platform.name} IM bot`, scope: [] })
      conn.secrets[field.key] = name
    }
  }

  const viewOf = (conn) => ({
    id: conn.id,
    platform: conn.platform,
    account: conn.account ?? null,
    botId: conn.botId ?? null,
    settings: conn.settings ?? {},
    secrets: Object.keys(conn.secrets ?? {}),
    enabled: conn.enabled !== false,
    paired: conn.paired ?? [],
    requests: conn.requests ?? [],
    chats: Object.fromEntries(Object.entries(conn.chats ?? {}).map(([key, chat]) => [key, { ...chat }])),
    createdAt: conn.createdAt,
  })

  const endpoints = {
    async 'im-add'(body) {
      const platform = imPlatform(String(body.platform ?? ''))
      if (platform === undefined || adapters[platform.id] === undefined) throw new Error('This platform is not available yet')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      if (platform.login === 'qr') throw new Error('This platform signs in by scanning a code; not available yet')
      const fields = cleanFields(platform, body.fields)
      for (const field of platform.fields) {
        if (!field.options && (fields[field.key] === undefined || String(fields[field.key]).trim() === '')) throw new Error(`${field.label} is required`)
      }
      const env = await envFor({ id: 'im_check', platform: platform.id, settings: fields, secrets: {} }, { get: () => ({}), set: () => {} })
      const { account } = await adapters[platform.id].check(fields, env)
      const conn = {
        id: `im_${randomBytes(4).toString('hex')}`,
        platform: platform.id,
        account,
        botId: bot.id,
        settings: Object.fromEntries(platform.fields.filter(field => !field.secret).map(field => [field.key, fields[field.key]])),
        secrets: {},
        enabled: true,
        paired: [],
        requests: [],
        chats: {},
        createdAt: Date.now(),
      }
      await saveSecrets(conn, platform, fields)
      connections()[conn.id] = conn
      await rt.save()
      await sync()
      return viewOf(conn)
    },
    async 'im-update'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const platform = imPlatform(conn.platform)
      if (platform === undefined) throw new Error('No such platform')
      if (body.botId !== undefined) {
        const bot = rt.botOf(String(body.botId))
        if (bot === undefined) throw new Error('Choose a Bot first')
        conn.botId = bot.id
      }
      if (body.enabled !== undefined) conn.enabled = body.enabled === true
      if (body.fields !== undefined) {
        const fields = cleanFields(platform, body.fields, conn.settings)
        const env = await envFor(conn)
        const check = { ...fields }
        for (const field of platform.fields) {
          if (field.secret && check[field.key] === undefined) check[field.key] = rt.secretValue(conn.secrets[field.key])
        }
        const { account } = await adapters[conn.platform].check(check, env)
        conn.account = account
        await saveSecrets(conn, platform, fields)
        for (const field of platform.fields) {
          if (!field.secret && fields[field.key] !== undefined) conn.settings[field.key] = fields[field.key]
        }
      }
      await rt.save()
      if (runners.has(conn.id)) await stop(conn.id)
      await sync()
      return viewOf(conn)
    },
    async 'im-remove'(body) {
      const id = String(body.id ?? '')
      const conn = connections()[id]
      if (conn === undefined) throw new Error('No such IM bot')
      await stop(id)
      for (const name of Object.values(conn.secrets ?? {})) {
        await rt.secretEndpoint('secret-delete', { name }).catch(() => {})
      }
      delete connections()[id]
      runtimes.delete(id)
      await rm(join(imDir, `${id}.json`), { force: true }).catch(() => {})
      await rt.save()
      return true
    },
    async 'im-pair'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const at = (conn.requests ?? []).findIndex(entry => entry.id === String(body.senderId ?? ''))
      if (at === -1) throw new Error('This request is gone')
      const [request] = conn.requests.splice(at, 1)
      if (body.allow === true) {
        conn.paired = [...(conn.paired ?? []), { id: request.id, name: request.name, at: Date.now() }]
        conn.chats ??= {}
        conn.chats[request.chatKey] ??= { kind: request.chatKind, title: request.name, at: Date.now() }
        await rt.save()
        const chat = conn.chats[request.chatKey]
        const target = resolveTarget(conn, chat)
        const name = target === undefined ? undefined : targetName(conn, target)
        await sendTo(conn, request.chatKey, { key: request.chatKey, kind: request.chatKind, title: chat.title },
          name === undefined ? text(request.chatKind === 'group' ? 'unboundGroup' : 'unbound') : text('connected', { target: name }))
      } else {
        await rt.save()
      }
      return true
    },
    async 'im-unpair'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      conn.paired = (conn.paired ?? []).filter(entry => entry.id !== String(body.senderId ?? ''))
      await rt.save()
      return true
    },
    async 'im-chat'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      const chat = conn.chats?.[String(body.chatKey ?? '')]
      if (chat === undefined) throw new Error('No such chat')
      if (body.remove === true) {
        delete conn.chats[String(body.chatKey ?? '')]
      } else if (body.target === null) {
        delete chat.target
      } else if (body.target !== undefined) {
        const target = body.target
        if (target.botId !== undefined && rt.botOf(target.botId) === undefined) throw new Error('Choose a Bot or a group')
        if (target.roomId !== undefined && rt.roomOf(target.roomId) === undefined) throw new Error('Choose a Bot or a group')
        chat.target = target.botId !== undefined ? { botId: String(target.botId) } : { roomId: String(target.roomId) }
      }
      await rt.save()
      return true
    },
    async 'im-retry'(body) {
      const conn = connections()[String(body.id ?? '')]
      if (conn === undefined) throw new Error('No such IM bot')
      if (runners.has(conn.id)) await stop(conn.id)
      await sync()
      return true
    },
    async 'im-login-start'(body) {
      const platform = imPlatform(String(body.platform ?? ''))
      const adapter = platform === undefined ? undefined : adapters[platform.id]
      if (platform === undefined || typeof adapter?.loginStart !== 'function') throw new Error('This platform has no QR login')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      const env = await envFor({ id: 'im_login', platform: platform.id, settings: {}, secrets: {} }, { get: () => ({}), set: () => {} })
      const login = await adapter.loginStart(env)
      return { loginId: login.loginId, qr: login.qr, expiresAt: login.expiresAt, botId: bot.id }
    },
    async 'im-login-wait'(body) {
      const platform = imPlatform(String(body.platform ?? 'weixin'))
      const adapter = platform === undefined ? undefined : adapters[platform.id]
      if (platform === undefined || typeof adapter?.loginWait !== 'function') throw new Error('This platform has no QR login')
      const bot = rt.botOf(String(body.botId ?? ''))
      if (bot === undefined) throw new Error('Choose a Bot first')
      const env = await envFor({ id: 'im_login', platform: platform.id, settings: {}, secrets: {} }, { get: () => ({}), set: () => {} })
      const login = await adapter.loginWait(String(body.loginId ?? ''), env)
      if (login.status !== 'done') return { status: login.status }
      // Confirmed: create the connection with the platform credentials the
      // login returned, paired with the scanning owner — no review needed.
      const conn = {
        id: `im_${randomBytes(4).toString('hex')}`,
        platform: platform.id,
        account: login.connection.account,
        botId: bot.id,
        settings: login.connection.settings ?? {},
        secrets: {},
        enabled: true,
        paired: login.owner === undefined ? [] : [{ id: login.owner.id, name: login.owner.name, at: Date.now() }],
        requests: [],
        chats: login.owner === undefined ? {} : { [login.owner.id]: { kind: 'direct', title: login.owner.name, at: Date.now() } },
        createdAt: Date.now(),
      }
      for (const [key, value] of Object.entries(login.connection.secrets ?? {})) {
        const name = secretName(conn, key)
        await rt.secretEndpoint('secret-set', { name, value, purpose: `${platform.name} IM bot`, scope: [] })
        conn.secrets[key] = name
      }
      connections()[conn.id] = conn
      await rt.save()
      await sync()
      return { status: 'done', id: conn.id }
    },
  }

  const imEndpoint = async (endpoint, body) => {
    const result = await endpoints[endpoint]?.(body ?? {})
    if (result === undefined) throw new Error(`Unknown endpoint ${endpoint}`)
    void sync()
    void diffCards()
    return result
  }

  // ------------------------------------------------------------------ im via
  // IM-originated user messages, keyed by session and event seq, so the client
  // can tag a message with the platform it came from. A Session's entries go
  // when it stops being the chat's current part.
  const imVia = new Map()
  const imViaView = () => {
    for (const sessionId of imVia.keys()) if (!rt.chatOwners.has(sessionId)) imVia.delete(sessionId)
    return Object.fromEntries([...imVia.entries()].map(([sessionId, seqs]) => [sessionId, { ...seqs }]))
  }

  // ----------------------------------------------------------------- outbound
  ctx.on('session/event', (session, event) => {
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined) {
      imVia.delete(session.id)
      return
    }
    const rpcId = event.type === 'user/message' ? event.data?.source?.rpcId : undefined
    if (typeof rpcId === 'string' && rpcId.startsWith('im:') && Number.isInteger(event.seq)) {
      imVia.set(session.id, { ...imVia.get(session.id), [event.seq]: rpcId.split(':')[1] })
    }
    for (const item of rt.displayItems(session.id, [event])) {
      if (item.kind !== 'bot' && item.kind !== 'view') continue
      const body = item.kind === 'bot' ? item.text : viewCardText({ title: item.title, view: item.view }) || (item.title ?? '')
      for (const conn of Object.values(connections())) {
        if (!runners.has(conn.id)) continue
        for (const { chatKey, chat } of listeners(conn, { botId })) sendTo(conn, chatKey, { key: chatKey, kind: chat.kind, title: chat.title }, body)
      }
    }
  })

  rt.onRoomLine((room, line) => {
    if (line.botId === undefined || line.kind !== undefined || typeof line.text !== 'string' || line.text.trim() === '') return
    const body = `**${line.who}**: ${line.text}`
    for (const conn of Object.values(connections())) {
      if (!runners.has(conn.id)) continue
      for (const { chatKey, chat } of listeners(conn, { roomId: room.id })) sendTo(conn, chatKey, { key: chatKey, kind: chat.kind, title: chat.title }, body)
    }
  })

  rt.onApproval((kind, data) => {
    if (kind === 'open') {
      void (async () => {
        for (const conn of Object.values(connections())) {
          const runner = runners.get(conn.id)
          if (runner === undefined) continue
          const bot = rt.botOf(data.botId)
          const targets = data.roomId !== undefined ? listeners(conn, { roomId: data.roomId }) : listeners(conn, { botId: data.botId })
          const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.approval(data.id) : undefined
          await sendCard(conn, `a:${data.id}`, targets, cardText.approval(bot?.name ?? '?', data), buttons)
        }
      })().catch(error => rt.warn('ds-bot: im approval card failed: %s', error))
      return
    }
    void (async () => {
      for (const conn of Object.values(connections())) {
        await settleCard(conn.id, `a:${data.id}`, data.outcome === 'allowed-once' ? text('allow') : data.outcome === 'rejected' ? text('reject') : text('answered'))
        await settledEdits(conn)
      }
    })().catch(() => {})
  })

  rt.onSaved(() => {
    void diffCards().then(settleGone).catch(() => {})
    void sync().catch(() => {})
  })

  let interval
  ctx.effect(() => {
    interval = setInterval(() => {
      void rt.refresh().then(() => sync()).catch(() => {})
    }, RECONCILE_MS)
    interval.unref?.()
    void rt.load().then(() => sync()).catch(() => {})
    return () => {
      stopped = true
      clearInterval(interval)
      return Promise.all([...runners.keys()].map(stop)).then(async () => {
        for (const held of runtimes.values()) if (held.timer !== undefined) clearTimeout(held.timer)
        await Promise.all([...runtimes.keys()].map(writeRuntime)).catch(() => {})
      })
    }
  }, 'ds-bot: im')

  const imView = () => ({ connections: Object.values(connections()).map(viewOf), platforms: IM_PLATFORMS.filter(platform => adaptersFor().includes(platform.id)).map(platform => platform.id) })
  const imStatusView = () => Object.fromEntries([...statuses.entries()].map(([id, status]) => [id, { state: status.state, ...(status.error !== undefined ? { error: status.error } : {}), at: status.at }]))

  Object.assign(rt, { imView, imStatusView, imViaView, imEndpoint })
}

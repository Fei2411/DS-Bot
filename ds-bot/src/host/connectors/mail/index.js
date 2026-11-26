// The mailbox connector: mail accounts (IMAP+SMTP app password, or Gmail with
// Google sign-in) in state.connectors.mail.accounts, the mail_* Bot tools, the
// send card, and the mail-* endpoints. Transports come from transport.js;
// rt.config.mail.connect injects fakes in tests.
import { randomUUID } from 'node:crypto'
import { basename, join, resolve, sep } from 'node:path'
import { constants as fsConstants, realpathSync, statSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PRESETS, presetOf, mailSecretName } from './presets.js'
import { connectImap, connectGmail } from './transport.js'
import { output } from '../../tools.js'
import { matchSecretRefs } from '../../secret-refs.js'
import { refreshTokens, invalidGrant, discover, rediscover, beginBrowser, exchange } from '../oauth.js'

const GOOGLE_ISSUER = 'https://accounts.google.com'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify'
const MAX_REQUESTS = 20

function parseAddresses(raw) {
  const out = []
  for (const part of String(raw ?? '').split(/[,;]+/)) {
    const text = part.trim()
    if (text === '') continue
    const angle = text.match(/<([^<>\s@]+@[^<>\s@]+)>/i)
    const addr = (angle ? angle[1] : text).trim().toLowerCase()
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) && !out.includes(addr)) out.push(addr)
  }
  return out
}

function allAddressesAllowed(to, cc, bcc, allowed) {
  const set = new Set((Array.isArray(allowed) ? allowed : []).map(a => String(a).toLowerCase()))
  if (set.size === 0) return false
  const parts = [to, cc, bcc].flatMap(raw => String(raw ?? '').split(/[,;]+/)).map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return false
  for (const part of parts) {
    const angle = part.match(/<([^<>\s@]+@[^<>\s@]+)>/i)
    const addr = (angle ? angle[1] : part).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) || !set.has(addr)) return false
  }
  return true
}

export function install(rt, host) {
  const { state } = rt
  const sessions = new Map()
  const sessionGen = new Map()
  const connecting = new Map()
  const adding = new Map()
  const refreshing = new Map()
  let googleDiscovery

  const invalidateSession = async (id) => {
    sessionGen.set(id, (sessionGen.get(id) ?? 0) + 1)
    connecting.delete(id)
    const old = sessions.get(id)
    if (old !== undefined) {
      sessions.delete(id)
      await old.close?.().catch(() => {})
    }
  }

  const accounts = () => state.connectors?.mail?.accounts ?? {}
  const accountList = () => Object.values(accounts())
  const hasAccounts = () => accountList().length > 0
  const accountOf = (ref) => {
    const list = accountList()
    if (ref === undefined || ref === '') return list.length === 1 ? list[0] : undefined
    return list.find(account => account.address.toLowerCase() === String(ref).toLowerCase() || account.id === ref)
  }

  const googleClient = () => ({
    id: process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_ID,
    secret: process.env.DS_BOT_GOOGLE_OAUTH_CLIENT_SECRET,
  })
  const googleReady = () => Boolean(googleClient().id && googleClient().secret)

  async function openImap(account, password, expectedGen) {
    const factory = rt.config.mail?.connect ?? connectImap
    let session
    session = await factory(account, { password, onGone: () => {
      if (sessions.get(account.id) === session) sessions.delete(account.id)
    } })
    if (session.usable === false) throw new Error('The mail connection closed during verification')
    if (expectedGen !== undefined && (sessionGen.get(account.id) ?? 0) !== expectedGen) {
      await session.close?.().catch(() => {})
      return undefined
    }
    sessions.set(account.id, session)
    return session
  }

  async function connect(account) {
    const key = account.id
    const wantKind = account.auth === 'google' ? 'gmail' : 'imap'
    const live = sessions.get(key)
    if (live !== undefined && live.usable !== false && (live.kind === undefined || live.kind === wantKind)) return live
    if (live !== undefined) {
      sessions.delete(key)
      await live.close?.()
    }
    const gen = sessionGen.get(key) ?? 0
    const inflight = connecting.get(key)
    if (inflight !== undefined && inflight.gen === gen) return inflight.promise
    const make = async () => {
      if (account.auth === 'google') {
        const tokenName = mailSecretName(account.address, 'TOKEN')
        if (typeof rt.resolveExternalForBot === 'function') {
          await rt.resolveExternalForBot(undefined, { names: [tokenName] }).catch(() => {})
        }
        if ((sessionGen.get(key) ?? 0) !== gen) {
          const latest = accounts()[key]
          if (latest !== undefined) return connect(latest)
          throw new Error('The mail account is gone')
        }
        const token = () => rt.secretValue(tokenName)
        const session = connectGmail(account, { token, fetch: rt.config.mail?.fetch, refresh: () => refreshGoogle(accounts()[key] ?? account) })
        sessions.set(key, session)
        return session
      }
      const passwordName = mailSecretName(account.address, 'PASSWORD')
      if (typeof rt.resolveExternalForBot === 'function') {
        await rt.resolveExternalForBot(undefined, { names: [passwordName] }).catch(() => {})
      }
      if ((sessionGen.get(key) ?? 0) !== gen) {
        const latest = accounts()[key]
        if (latest !== undefined) return connect(latest)
        throw new Error('The mail account is gone')
      }
      const password = rt.secretValue(passwordName)
      if (password === undefined) throw new Error(`The password for ${account.address} is not saved`)
      const session = await openImap(account, password, gen)
      if (session === undefined) {
        const latest = accounts()[key]
        if (latest !== undefined) return connect(latest)
        throw new Error('The mail account is gone')
      }
      return session
    }
    const entry = { gen, promise: null }
    entry.promise = make()
    connecting.set(key, entry)
    try {
      return await entry.promise
    } finally {
      if (connecting.get(key) === entry) connecting.delete(key)
    }
  }

  async function resolveGoogleDiscovery() {
    if (googleDiscovery !== undefined) return googleDiscovery
    const found = await rediscover(
      { authorizationServerUrl: GOOGLE_ISSUER, resource: undefined, scope: GOOGLE_SCOPES },
      { fetch: rt.config.mail?.fetch },
    )
    if (found.metadata?.token_endpoint) {
      googleDiscovery = found
      return found
    }
    // Without metadata the OAuth SDK falls back to accounts.google.com/token, which returns 400.
    return {
      authorizationServerUrl: GOOGLE_ISSUER,
      metadata: {
        issuer: GOOGLE_ISSUER,
        token_endpoint: GOOGLE_TOKEN_ENDPOINT,
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      },
      resource: undefined,
      scope: GOOGLE_SCOPES,
    }
  }

  // Gmail tokens refresh through the same OAuth rules as connectors.
  async function refreshGoogle(account) {
    if (disposed) return false
    if (rt.readOnly?.() !== undefined) { await rt.loadSecrets?.(); return false }
    const key = account.id ?? account.address
    if (refreshing.has(key)) return refreshing.get(key)
    const run = (async () => {
      const tokenName = mailSecretName(account.address, 'TOKEN')
      const refreshName = mailSecretName(account.address, 'REFRESH')
      const liveAccount = () => (account.id !== undefined ? accounts()[account.id] : undefined)
      const hadLive = liveAccount() !== undefined
      const gone = () => disposed || (hadLive && liveAccount() === undefined)
      if (typeof rt.resolveExternalForBot === 'function') {
        await rt.resolveExternalForBot(undefined, { names: [refreshName] }).catch(() => {})
      }
      if (gone()) return false
      const tokenBefore = rt.secretValue(tokenName)
      const refresh = rt.secretValue(refreshName)
      if (typeof refresh !== 'string' || refresh === '') {
        const target = liveAccount() ?? account
        target.error = 'Sign in again'
        await rt.save?.().catch(() => {})
        rt.warn('ds-bot: connector mail token refresh failed (client: manual/Google; missing refresh token)')
        return false
      }
      const rotated = () => rt.secretValue(refreshName) !== refresh || rt.secretValue(tokenName) !== tokenBefore
      try {
        const client = googleClient()
        const discovery = await resolveGoogleDiscovery()
        if (gone()) return false
        const tokens = await refreshTokens(
          discovery,
          { client_id: client.id, client_secret: client.secret },
          refresh,
          { scope: GOOGLE_SCOPES, fetch: rt.config.mail?.fetch },
        )
        if (gone()) return false
        if (rotated()) return Boolean(rt.secretValue(tokenName))
        await host.secrets.writeSecret(tokenName, tokens.access_token, `Mailbox ${account.address}`)
        if (typeof tokens.refresh_token === 'string' && tokens.refresh_token !== '') {
          await host.secrets.writeSecret(refreshName, tokens.refresh_token, `Mailbox ${account.address}`).catch(() => {
            rt.warn('ds-bot: connector mail refresh token rotation save failed (client: manual/Google)')
          })
        }
        if (gone()) return false
        const target = liveAccount() ?? account
        if (target.error !== undefined) {
          delete target.error
          await rt.save?.().catch(() => {})
        }
        rt.warn('ds-bot: connector mail token refresh succeeded (client: manual/Google)')
        return true
      } catch (error) {
        if (gone()) return false
        if (rotated()) return Boolean(rt.secretValue(tokenName))
        if (invalidGrant(error)) {
          const target = liveAccount() ?? account
          target.error = 'Sign in again'
          await rt.save?.().catch(() => {})
        }
        rt.warn('ds-bot: connector mail token refresh failed (client: manual/Google; %s)', invalidGrant(error) ? 'invalid_grant' : 'refresh error')
        return false
      }
    })()
    refreshing.set(key, run)
    try { return await run } finally { refreshing.delete(key) }
  }

  const workDir = (exec) => {
    try { return rt.sessionFolder?.(exec.agent?.session ?? exec.agent) } catch { return undefined }
  }

  const insideRoot = (root, inside) => {
    const prefix = root.endsWith(sep) ? root : root + sep
    return inside !== root && inside.startsWith(prefix)
  }

  const resolveAttachments = async (dir, names) => {
    const out = []
    for (const name of names ?? []) {
      if (dir === undefined) throw new Error(`Attachment ${name} is outside the working folder`)
      const root = realpathSync(dir)
      const inside = realpathSync(resolve(root, name))
      if (!insideRoot(root, inside)) throw new Error(`Attachment ${name} is outside the working folder`)
      if (!statSync(inside).isFile()) throw new Error(`Attachment ${name} must be a regular file`)
      // O_NONBLOCK prevents opening a FIFO/named pipe from hanging; O_NOFOLLOW blocks a symlink swap after realpathSync.
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0)
      const handle = await openFile(inside, flags)
      try {
        const info = await handle.stat()
        if (!info.isFile()) throw new Error(`Attachment ${name} must be a regular file`)
        out.push({ filename: name, content: await handle.readFile() })
      } finally {
        await handle.close().catch(() => {})
      }
    }
    return out
  }

  const toolExec = async (exec, args, run) => {
    await rt.load()
    const self = rt.selfOf(exec.agent?.id)
    const bot = rt.botOf(self)
    if (!bot) return 'Only Bots on the team can use the mail tools.'
    if ((state.connectors?.mail?.offFor ?? []).includes(bot.id)) return 'The mailbox is turned off for you.'
    const account = accountOf(args.account)
    if (account === undefined) return accountList().length === 0 ? 'No mail account is added yet.' : `Name the account: ${accountList().map(a => a.address).join(', ')}`
    let session
    try {
      session = await connect(account)
      return await run(session, account, bot)
    } catch (error) {
      const stale = session ?? sessions.get(account.id)
      if (sessions.get(account.id) === stale) sessions.delete(account.id)
      void stale?.close?.().catch(() => {})
      throw error
    }
  }

  const tools = [
    defineTool({
      name: 'mail_search',
      description: 'Search mail in a connected mailbox. Returns matching messages with uid, from, to, subject, and date.',
      parameters: {
        account: { type: 'string', description: 'Account address; needed only when more than one is added' },
        from: { type: 'string' }, to: { type: 'string' }, subject: { type: 'string' }, text: { type: 'string' },
        since: { type: 'string', description: 'ISO date' }, before: { type: 'string', description: 'ISO date' },
        unread: { type: 'boolean' }, folder: { type: 'string', description: 'Folder name, default INBOX' },
        limit: { type: 'number', description: 'Max results, default 20' },
      },
      output,
      async execute(args, exec) {
        return toolExec(exec, args, async (session) => {
          const rows = await session.search({ folder: args.folder, from: args.from, to: args.to, subject: args.subject, text: args.text, since: args.since, before: args.before, unread: args.unread === true, limit: args.limit ?? 20 })
          if (rows.length === 0) return 'No matching mail.'
          return rows.map(row => `- [${row.uid}] ${row.date} ${row.from} → ${row.to} — ${row.subject}${row.seen ? '' : ' (unread)'}${row.flagged ? ' ★' : ''}`).join('\n')
        })
      },
    }),
    defineTool({
      name: 'mail_read',
      description: 'Read one message or its whole thread: headers, text body, and attachment names. save_attachments writes the files into your working folder.',
      parameters: {
        account: { type: 'string', description: 'Account address; needed only when more than one is added' },
        uid: { type: 'string', required: true, description: 'Message uid from mail_search' },
        folder: { type: 'string' }, thread: { type: 'boolean' },
        save_attachments: { type: 'boolean', description: 'Save every attachment into your working folder' },
      },
      output,
      async execute(args, exec) {
        return toolExec(exec, args, async (session) => {
          const { messages } = await session.read({ uid: String(args.uid), folder: args.folder, thread: args.thread === true })
          const saved = []
          if (args.save_attachments === true) {
            const dir = workDir(exec)
            const taken = new Set()
            const safe = (raw) => {
              let name = basename(String(raw ?? '')).replace(/[\0-\x1f\\]/g, '_').replace(/^\.+/, '') || 'attachment'
              while (taken.has(name)) name = `_${name}`
              taken.add(name)
              return name
            }
            for (const message of messages) {
              for (const attachment of message.attachments ?? []) {
                if (dir === undefined) break
                const name = safe(attachment.filename)
                await session.saveAttachment({ uid: message.uid, folder: message.folder, filename: attachment.filename, to: join(dir, name) })
                saved.push(name)
              }
            }
          }
          const body = messages.map(message => [
            `From: ${message.from}\nTo: ${message.to}${message.cc ? `\nCc: ${message.cc}` : ''}\nDate: ${message.date}\nSubject: ${message.subject}`,
            message.attachments?.length ? `Attachments: ${message.attachments.map(a => `${a.filename} (${a.size} bytes)`).join(', ')}` : '',
            message.text,
          ].filter(Boolean).join('\n')).join('\n\n---\n\n')
          return saved.length > 0 ? `${body}\n\nSaved attachments: ${saved.join(', ')}` : body
        })
      },
    }),
    defineTool({
      name: 'mail_draft',
      description: 'Save a draft in the mailbox Drafts folder. It is not sent.',
      parameters: {
        account: { type: 'string' },
        to: { type: 'string', required: true }, cc: { type: 'string' }, bcc: { type: 'string' },
        subject: { type: 'string', required: true }, body: { type: 'string', required: true },
      },
      output,
      async execute(args, exec) {
        return toolExec(exec, args, async (session, account) => {
          await session.draft({ to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, text: args.body })
          return `Draft saved in ${account.address}'s Drafts folder. It was not sent.`
        })
      },
    }),
    defineTool({
      name: 'mail_send',
      description: 'Send an email. The user sees a card in your own chat with the full message and must press Send; nothing goes out before that. Showing the card ends your turn; a note arrives with the answer.',
      parameters: {
        account: { type: 'string' },
        to: { type: 'string', required: true }, cc: { type: 'string' }, bcc: { type: 'string' },
        subject: { type: 'string', required: true }, body: { type: 'string', required: true },
        attachments: { type: 'array', items: { type: 'string' }, description: 'File names in your working folder' },
        reply_to: { type: 'string', description: 'Message uid this answers' },
      },
      output,
      async execute(args, exec) {
        await rt.load()
        const self = rt.selfOf(exec.agent?.id)
        const bot = rt.botOf(self)
        if (!bot) return 'Only Bots on the team can use mail_send.'
        if ((state.connectors?.mail?.offFor ?? []).includes(bot.id)) return 'The mailbox is turned off for you.'
        const account = accountOf(args.account)
        if (account === undefined) return accountList().length === 0 ? 'No mail account is added yet.' : `Name the account: ${accountList().map(a => a.address).join(', ')}`
        if (rt.taskOwners?.has(exec.agent?.id)) return 'Background tasks cannot show send confirmation cards. Draft it with mail_draft or report back to your own chat so it can confirm with the user.'
        if (rt.groupOwners.has(exec.agent?.id)) return 'Send cards only work in your own chat. Draft it here with mail_draft, or call mail_send in your own chat.'
        if (!rt.chatOwners.has(exec.agent?.id)) return 'Send cards only work in your current own chat.'
        const readOnly = rt.readOnly()
        if (readOnly !== undefined) return `No card can be shown now. ${readOnly}`
        const dir = workDir(exec)
        const bad = (args.attachments ?? []).map(String).filter(name => name !== '').filter((name) => {
          if (dir === undefined) return true
          try {
            const root = realpathSync(dir)
            const inside = realpathSync(resolve(root, name))
            return !insideRoot(root, inside) || !statSync(inside).isFile()
          } catch { return true }
        })
        if (bad.length > 0) return `Attachments must be files in your working folder: ${bad.join(', ')} is not.`
        const list = (state.mailRequests ??= {})[bot.id] ??= []
        const request = {
          id: randomUUID(),
          ...(exec.callId ? { callId: exec.callId } : {}),
          sessionId: exec.agent?.id,
          account: account.id,
          to: String(args.to ?? ''), cc: String(args.cc ?? ''), bcc: String(args.bcc ?? ''),
          subject: String(args.subject ?? ''), body: String(args.body ?? ''),
          attachments: (Array.isArray(args.attachments) ? args.attachments : []).map(String).filter(name => name !== ''),
          dir,
          attachmentDetails: (Array.isArray(args.attachments) ? args.attachments : []).map(String).filter(name => name !== '').map((name) => {
            try { return { name, size: statSync(join(dir, name)).size } } catch { return { name } }
          }),
          replyTo: args.reply_to ? String(args.reply_to) : undefined,
          status: 'pending', askedAt: Date.now(),
        }
        const skipDraft = !bot.private && (
          (state.connectors?.mail?.noDraftFor ?? []).includes(bot.id)
          || allAddressesAllowed(request.to, request.cc, request.bcc, state.connectors?.mail?.allowedRecipients)
        )
        if (skipDraft) {
          const session = await connect(account)
          const attachments = await resolveAttachments(dir, request.attachments)
          await session.send({ to: request.to, cc: request.cc || undefined, bcc: request.bcc || undefined, subject: request.subject, text: request.body, attachments, ...(request.replyTo ? { inReplyTo: request.replyTo } : {}) })
          request.status = 'sent'
          request.settledAt = Date.now()
          list.push(request)
          while (list.length > MAX_REQUESTS) { const at = list.findIndex(entry => entry.status !== 'pending'); list.splice(at === -1 ? 0 : at, 1) }
          await rt.save()
          return `Sent "${request.subject}" to ${request.to} from ${account.address}.`
        }
        for (const old of list) if (old.status === 'pending') { old.status = 'canceled'; old.settledAt = Date.now() }
        list.push(request)
        while (list.length > MAX_REQUESTS) { const at = list.findIndex(entry => entry.status !== 'pending'); list.splice(at === -1 ? 0 : at, 1) }
        await rt.save()
        exec.concludeTurn?.()
        return `The send card for "${request.subject}" is on screen. Nothing is sent until the user presses Send; a note arrives with the answer.`
      },
    }),
    defineTool({
      name: 'mail_update',
      description: 'Mark a message read or unread, flag or unflag it, or move it to another folder or the Trash. Mail is never deleted permanently.',
      parameters: {
        account: { type: 'string' },
        uid: { type: 'string', required: true }, folder: { type: 'string' },
        seen: { type: 'boolean' }, flagged: { type: 'boolean' },
        move: { type: 'string', description: 'Folder name, or "trash"' },
      },
      output,
      async execute(args, exec) {
        return toolExec(exec, args, async (session) => {
          await session.update({ uid: String(args.uid), folder: args.folder, seen: args.seen, flagged: args.flagged, move: args.move })
          return 'Done.'
        })
      },
    }),
  ]

  // Mail tools are registered only while at least one account exists.
  let toolsOn = false
  const syncTools = () => {
    const want = hasAccounts()
    if (want === toolsOn) return
    toolsOn = want
    for (const tool of tools) {
      if (want) rt.addTeamTool?.(tool)
      else rt.removeTeamTool?.(tool.name)
    }
  }

  const tell = async (botId, text) => {
    if (rt.botOf(botId) === undefined) return
    await rt.deliver({ toId: botId, role: 'mail', text }).catch(error => rt.warn('ds-bot: mail note to %s failed: %s', botId, error))
  }

  const applyRules = (patch) => {
    const mail = state.connectors?.mail ?? {}
    let allowed = [...(mail.allowedRecipients ?? [])]
    let noDraft = [...(mail.noDraftFor ?? [])]
    const addAddrs = (raw) => {
      for (const addr of parseAddresses(Array.isArray(raw) ? raw.join(', ') : raw)) {
        if (!allowed.includes(addr)) allowed.push(addr)
      }
    }
    const dropAddrs = (raw) => {
      const drop = new Set(parseAddresses(Array.isArray(raw) ? raw.join(', ') : raw))
      allowed = allowed.filter(addr => !drop.has(addr))
    }
    if (patch.mode === 'allow-recipient') {
      addAddrs(patch.recipients ?? patch.address ?? '')
      if (typeof patch.botId === 'string') noDraft = noDraft.filter(id => id !== patch.botId)
    } else if (patch.mode === 'no-draft') {
      if (typeof patch.botId === 'string' && rt.botOf(patch.botId) && !noDraft.includes(patch.botId)) noDraft.push(patch.botId)
    } else if (patch.mode === 'require-approval') {
      if (typeof patch.botId === 'string') noDraft = noDraft.filter(id => id !== patch.botId)
      if (patch.recipients || patch.address) dropAddrs(patch.recipients ?? patch.address)
    }
    if (patch.addRecipient) addAddrs(patch.addRecipient)
    if (patch.removeRecipient) dropAddrs(patch.removeRecipient)
    if (typeof patch.botId === 'string' && typeof patch.noDraft === 'boolean') {
      noDraft = patch.noDraft
        ? (rt.botOf(patch.botId) && !noDraft.includes(patch.botId) ? [...noDraft, patch.botId] : noDraft)
        : noDraft.filter(id => id !== patch.botId)
    }
    state.connectors = {
      ...(state.connectors ?? {}),
      mail: { ...mail, allowedRecipients: allowed, noDraftFor: noDraft },
    }
  }

  const endpoints = {
    async 'mail-account-add'(body) {
      const address = String(body.address ?? '').trim().toLowerCase()
      if (body.google === true) {
        if (!googleReady()) throw new Error('Google sign-in is not available in this build')
        if (address !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('Enter an email address')
        return beginGoogle(address)
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('Enter an email address')
      if (adding.has(address)) return adding.get(address)
      const pending = (async () => {
        const passwordRef = typeof body.secretRef === 'string' ? body.secretRef.trim() : typeof body.passwordRef === 'string' ? body.passwordRef.trim() : ''
        const password = String(body.password ?? '').trim()
        if (passwordRef !== '' || matchSecretRefs(password).length > 0) {
          throw new Error('One-time secret-ref handles can only be consumed by Bot host tools (such as save_capability), not via HTTP endpoints.')
        }
        if (password === '') throw new Error('Enter the authorization code or app password')
        const preset = presetOf(address)
        const provider = typeof body.provider === 'string' ? body.provider : preset?.id ?? 'other'
        const chosen = PRESETS.find(p => p.id === provider)
        const imap = chosen && provider !== 'other' ? chosen.imap : { host: String(body.imapHost ?? '').trim(), port: Number(body.imapPort) || 993, secure: body.imapTls !== false }
        const smtp = chosen && provider !== 'other' ? chosen.smtp : { host: String(body.smtpHost ?? '').trim(), port: Number(body.smtpPort) || 465, secure: body.smtpTls !== false }
        if (imap.host === '' || smtp.host === '') throw new Error('Enter the IMAP and SMTP hosts')
        if (rt.readOnly() !== undefined) throw new Error(rt.readOnly())
        const existing = accountOf(address)
        const id = existing?.id ?? `m${randomUUID().slice(0, 8)}`
        const account = { ...existing, id, address, provider, auth: 'password', imap, smtp, createdAt: existing?.createdAt ?? Date.now() }
        delete account.error
        // Log in once before saving, so a bad password never lands in state.
        const old = sessions.get(id)
        let session
        try {
          session = await openImap(account, password)
        } catch (error) {
          throw new Error(mailError(error))
        }
        await old?.close?.().catch(() => {})
        try {
          await host.secrets.writeSecret(mailSecretName(address, 'PASSWORD'), password, `Mailbox ${address}`)
          state.connectors = { ...(state.connectors ?? {}), mail: { ...state.connectors?.mail, accounts: { ...accounts(), [id]: account } } }
          await rt.save()
        } catch (error) {
          if (sessions.get(id) === session) sessions.delete(id)
          await session.close?.()
          throw error
        }
        syncTools()
        return mailView()
      })()
      adding.set(address, pending)
      try { return await pending } finally { adding.delete(address) }
    },
    async 'mail-account-remove'(body) {
      const account = accountOf(body.id ?? body.address)
      if (account === undefined) throw new Error('No such account')
      await rt.loadSecrets()
      // Secrets are per address; a duplicate row from before adds were merged still needs them.
      const shared = accountList().some(other => other.id !== account.id && other.address === account.address)
      if (!shared) for (const suffix of ['PASSWORD', 'TOKEN', 'REFRESH']) {
        const name = mailSecretName(account.address, suffix)
        if (rt.secretValue(name) !== undefined) await rt.secretEndpoint('secret-delete', { name }).catch(() => {})
      }
      const rest = { ...accounts() }
      delete rest[account.id]
      state.connectors = { ...state.connectors, mail: { ...state.connectors.mail, accounts: rest } }
      await rt.save()
      await invalidateSession(account.id)
      dropGooglePending(account.address)
      syncTools()
      return mailView()
    },
    async 'mail-rule-set'(body) {
      applyRules(body ?? {})
      await rt.save()
      return mailView()
    },
    async 'mail-send-answer'(body) {
      const found = (() => {
        for (const [botId, list] of Object.entries(state.mailRequests ?? {})) {
          const request = list.find(entry => entry.id === String(body.requestId ?? ''))
          if (request !== undefined) return { botId, request }
        }
        return undefined
      })()
      if (found === undefined || found.request.status !== 'pending') throw new Error('This card was already answered')
      const { botId, request } = found
      if (body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) {
        if (typeof body.fields.to === 'string' && body.fields.to.trim() !== '') request.to = body.fields.to.trim()
        if (typeof body.fields.cc === 'string') request.cc = body.fields.cc.trim()
        if (typeof body.fields.bcc === 'string') request.bcc = body.fields.bcc.trim()
        if (typeof body.fields.subject === 'string') request.subject = body.fields.subject.trim()
        if (typeof body.fields.body === 'string') request.body = body.fields.body
      }
      if (typeof body.rule === 'string') {
        applyRules({ mode: body.rule, botId, recipients: [request.to, request.cc, request.bcc].filter(Boolean).join(', ') })
      }
      if (body.choice !== 'send') {
        request.status = 'canceled'; request.settledAt = Date.now()
        await rt.save()
        await tell(botId, `The user canceled sending "${request.subject}". Nothing was sent.`)
        return true
      }
      const account = accounts()[request.account]
      if (account === undefined) {
        request.status = 'failed'; request.settledAt = Date.now()
        await rt.save()
        await tell(botId, `The account for "${request.subject}" is gone, so nothing was sent.`)
        return true
      }
      try {
        const session = await connect(account)
        const attachments = await resolveAttachments(request.dir, request.attachments)
        await session.send({ to: request.to, cc: request.cc || undefined, bcc: request.bcc || undefined, subject: request.subject, text: request.body, attachments, ...(request.replyTo ? { inReplyTo: request.replyTo } : {}) })
        request.status = 'sent'; request.settledAt = Date.now()
        await rt.save()
        await tell(botId, `The user sent "${request.subject}" to ${request.to} from ${account.address}.`)
      } catch (error) {
        request.status = 'failed'; request.settledAt = Date.now()
        request.error = host.reason(error)
        await rt.save()
        await tell(botId, `Sending "${request.subject}" failed: ${request.error}. You can try mail_send again.`)
      }
      return true
    },
    async 'mail-sign-in-code'(body) {
      return googleCode(body)
    },
  }

  // --- Google sign-in ------------------------------------------------------

  let disposed = false
  const SIGN_IN_TIMEOUT_MS = 10 * 60_000
  const googlePendings = new Map()
  const activeGoogleListeners = new Set()
  const closeGoogleListener = (listener, { immediate = false, response } = {}) => {
    if (!listener) return
    listener.close()
    if (immediate) {
      listener.closeAllConnections?.()
      return
    }
    listener.closeIdleConnections?.()
    let scheduled = false
    const scheduleForceClose = () => {
      if (scheduled) return
      scheduled = true
      const grace = setTimeout(() => listener.closeAllConnections?.(), 250)
      grace.unref?.()
      listener.once('close', () => clearTimeout(grace))
    }
    if (response && !response.writableFinished) {
      response.once('finish', scheduleForceClose)
      response.once('close', scheduleForceClose)
    } else {
      scheduleForceClose()
    }
  }
  const dropGooglePending = key => {
    const pending = googlePendings.get(key)
    if (pending === undefined) return
    googlePendings.delete(key)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    closeGoogleListener(pending.listener, { immediate: true })
  }
  async function beginGoogle(address) {
    if (disposed) throw new Error('Mail connector is closed')
    if (rt.readOnly?.() !== undefined) throw new Error(rt.readOnly())
    const client = googleClient()
    const discovery = await discover(GOOGLE_ISSUER, { originFallback: true, fetch: rt.config.mail?.fetch ?? fetch })
    if (disposed) throw new Error('Mail connector is closed')
    if (discovery.metadata?.token_endpoint) {
      googleDiscovery = { authorizationServerUrl: discovery.authorizationServerUrl, metadata: discovery.metadata, resource: undefined, scope: GOOGLE_SCOPES }
    }
    dropGooglePending(address)
    const pending = { discovery, address: address || undefined, key: address }
    googlePendings.set(address, pending)
    let listener
    try {
      const { createServer } = await import('node:http')
      if (disposed) throw new Error('Mail connector is closed')
      listener = createServer((req, res) => {
        req.on('error', () => res.destroy())
        res.on('error', () => req.destroy())
        let url
        try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch { res.writeHead(400); res.end(); return }
        if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
        if (!url.searchParams.get('code')) {
          res.end('<p style="font-family:sans-serif">Google sign-in did not finish — go back to DS Bot and try again.</p>')
          rt.warn('ds-bot: mail Google sign-in failed: %s', url.searchParams.get('error') ?? 'no code')
          return
        }
        res.end('<p style="font-family:sans-serif">Signed in — you can close this tab.</p>')
        void googleCode({ address, input: url.toString() }, { response: res }).catch(error => rt.warn('ds-bot: mail Google sign-in failed: %s', host.reason(error)))
      })
      activeGoogleListeners.add(listener)
      listener.once('close', () => activeGoogleListeners.delete(listener))
      listener.on('error', error => {
        if (listener.listening) rt.warn('ds-bot: mail Google sign-in listener failed: %s', error?.code ?? 'error')
      })
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
      if (disposed || googlePendings.get(address) !== pending) {
        closeGoogleListener(listener, { immediate: true })
        if (disposed) throw new Error('Mail connector is closed')
        return mailView()
      }
      pending.listener = listener
      pending.redirectUri = `http://127.0.0.1:${listener.address().port}/callback`
      const state = randomUUID()
      const { url, codeVerifier } = await beginBrowser(discovery, { client_id: client.id, client_secret: client.secret }, pending.redirectUri, { state, scope: GOOGLE_SCOPES })
      if (disposed || googlePendings.get(address) !== pending) {
        closeGoogleListener(listener, { immediate: true })
        if (disposed) throw new Error('Mail connector is closed')
        return mailView()
      }
      const authUrl = new URL(url)
      authUrl.searchParams.set('access_type', 'offline')
      authUrl.searchParams.set('prompt', 'consent')
      if (address) authUrl.searchParams.set('login_hint', address)
      pending.codeVerifier = codeVerifier
      pending.state = state
      pending.url = authUrl.toString()
      pending.timer = setTimeout(() => dropGooglePending(address), SIGN_IN_TIMEOUT_MS)
      pending.timer.unref?.()
    } catch (error) {
      closeGoogleListener(listener, { immediate: true })
      if (googlePendings.get(address) === pending) dropGooglePending(address)
      throw error
    }
    return mailView()
  }
  async function googleCode(body, { response } = {}) {
    if (rt.readOnly?.() !== undefined) throw new Error(rt.readOnly())
    const address = String(body.address ?? '').toLowerCase()
    const pending = googlePendings.get(address) ?? [...googlePendings.values()][0]
    if (pending === undefined) throw new Error('No Google sign-in is waiting')
    const input = String(body.input ?? '').trim()
    const url = /^https?:/i.test(input) ? new URL(input) : undefined
    const code = url ? url.searchParams.get('code') : input
    if (!code) throw new Error('The address has no code')
    const given = url?.searchParams.get('state')
    if (given !== null && pending.state !== undefined && given !== pending.state) throw new Error('The sign-in answer is not for this attempt')
    googlePendings.delete(pending.key ?? pending.address)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    closeGoogleListener(pending.listener, { response })
    const client = googleClient()
    const tokens = await exchange(pending.discovery, { client_id: client.id, client_secret: client.secret }, { code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri, iss: url?.searchParams.get('iss') ?? undefined }, { fetch: rt.config.mail?.fetch })
    if (disposed) throw new Error('Mail connector is closed')
    // Prefer the email Google actually authorized; fall back to the form address only if userinfo is unavailable.
    const email = await googleEmail(tokens.access_token).catch((error) => {
      if (pending.address) return pending.address
      throw error
    })
    if (disposed) throw new Error('Mail connector is closed')
    const existing = accountOf(email)
    const id = existing?.id ?? `g${randomUUID().slice(0, 8)}`
    const account = { id, address: email, provider: 'gmail', auth: 'google', createdAt: existing?.createdAt ?? Date.now() }
    await host.secrets.writeSecret(mailSecretName(email, 'TOKEN'), tokens.access_token, `Mailbox ${email}`)
    if (typeof tokens.refresh_token === 'string' && tokens.refresh_token !== '') {
      await host.secrets.writeSecret(mailSecretName(email, 'REFRESH'), tokens.refresh_token, `Mailbox ${email}`)
    }
    state.connectors = { ...(state.connectors ?? {}), mail: { ...state.connectors?.mail, accounts: { ...accounts(), [id]: account } } }
    await invalidateSession(id)
    await rt.save()
    if (existing?.auth === 'password') {
      const passName = mailSecretName(email, 'PASSWORD')
      const shared = accountList().some(other => other.id !== id && other.auth === 'password' && mailSecretName(other.address, 'PASSWORD') === passName)
      if (!shared && rt.secretValue(passName) !== undefined) await rt.secretEndpoint?.('secret-delete', { name: passName }).catch(() => {})
    }
    syncTools()
    return mailView()
  }
  async function googleEmail(token) {
    const response = await (rt.config.mail?.fetch ?? fetch)('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`Google userinfo answered ${response.status}`)
    }
    const body = await response.json().catch(() => ({}))
    if (typeof body.email !== 'string' || body.email.trim() === '') throw new Error('Google did not say which account this is')
    return body.email.trim().toLowerCase()
  }

  const mailView = () => ({
    accounts: accountList().map(account => ({
      id: account.id, address: account.address, provider: account.provider, auth: account.auth,
      state: account.error ? 'error' : 'ready',
      ...(account.error ? { error: account.error } : {}),
    })),
    google: googleReady(),
    allowedRecipients: state.connectors?.mail?.allowedRecipients ?? [],
    noDraftFor: state.connectors?.mail?.noDraftFor ?? [],
    ...(googlePendings.size > 0 ? { pending: [...googlePendings.values()].map(p => ({ kind: 'browser', url: p.url, address: p.address })) } : {}),
  })

  syncTools()

  return {
    hasAccounts,
    mailView,
    connect,
    async endpoint(name, body) {
      await rt.loadSecrets()
      if (!endpoints[name]) throw new Error(`Unknown endpoint ${name}`)
      return endpoints[name](body ?? {})
    },
    async dispose() {
      disposed = true
      const live = [...sessions.values()]
      sessions.clear()
      for (const pending of googlePendings.values()) {
        if (pending.timer !== undefined) clearTimeout(pending.timer)
        closeGoogleListener(pending.listener, { immediate: true })
      }
      googlePendings.clear()
      const listeners = Array.from(activeGoogleListeners)
      activeGoogleListeners.clear()
      for (const listener of listeners) {
        closeGoogleListener(listener, { immediate: true })
      }
      await Promise.all(live.map(session => session.close?.().catch(() => {})))
    },
    _internals: { sessions, refreshGoogle, mailSecretName },
  }
}

function mailError(error) {
  const text = String(error?.responseText ?? error?.message ?? error)
  if (/Unsafe Login/i.test(text)) return 'The mail service refused the login (Unsafe Login). Enable IMAP/SMTP in the mailbox settings and use its authorization code, not the account password.'
  if (error?.authenticationFailed === true || /Login fail|authentication|invalid credentials|535|534/i.test(text)) return 'The password was refused. Use the mailbox app password or authorization code, not the account password.'
  const unreachable = /\b(?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|ENOTFOUND|EAI_AGAIN)\b\s*(\S+)?/.exec(text)
  if (unreachable) return unreachable[1] ? `Could not reach the mail server at ${unreachable[1]}. Check the server address.` : 'Could not reach the mail server. Check the server address.'
  return text.slice(0, 300)
}

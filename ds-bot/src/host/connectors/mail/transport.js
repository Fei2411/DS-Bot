// Mail transports. `connectAccount(account, deps)` returns one account session
// behind a small interface the tools and tests share; tests inject fakes
// through rt.config.mail.connect.
import { Socket } from 'node:net'
import { IMAP_ID } from './presets.js'

// IMAP + SMTP (imapflow + nodemailer). One live IMAP connection per account is
// kept by the caller (QQ throttles frequent logins); on a dropped connection the
// caller reconnects once.
export const imapOptions = (account, deps = {}) => ({
  host: account.imap.host, port: account.imap.port, secure: account.imap.secure !== false,
  auth: { user: account.address, pass: deps.password },
  // RFC 2971: 163/126 refuse logins without the client identity.
  id: IMAP_ID,
  logger: false,
  socketTimeout: 60_000,
})

export async function connectImap(account, deps = {}) {
  const { ImapFlow } = deps.modules ?? await import('imapflow')
  const nodemailer = deps.modules?.nodemailer ?? await import('nodemailer')
  const imap = new ImapFlow(imapOptions(account, deps))
  let gone = false
  let smtp
  const sockets = new Set()
  const retire = () => {
    if (gone) return
    gone = true
    imap.close()
    for (const socket of sockets) socket.destroy()
    smtp?.close()
    deps.onGone?.()
  }
  imap.on('error', retire)
  imap.on('close', retire)
  smtp = nodemailer.createTransport({
    host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure === true,
    requireTLS: account.smtp.starttls === true,
    auth: { user: account.address, pass: deps.password },
    // Nodemailer's close() does not cancel a non-pooled verify(). Own its sockets
    // through the transport hook so an IMAP failure also cancels that login.
    getSocket(options, done) {
      if (gone) { done(new Error('The mail connection is closed')); return }
      const socket = new Socket()
      sockets.add(socket)
      let answered = false
      const fail = error => { if (!answered) { answered = true; done(error) } }
      socket.once('error', fail)
      socket.on('error', retire)
      socket.once('close', () => {
        sockets.delete(socket)
        fail(new Error('The SMTP connection closed'))
      })
      // Preserve Nodemailer's documented default connection timeout.
      socket.setTimeout(options.connectionTimeout ?? 120_000, () => socket.destroy(new Error('SMTP connection timeout')))
      socket.connect({ host: options.host, port: options.port }, () => {
        if (answered) return
        answered = true
        socket.setTimeout(0)
        done(null, { connection: socket })
      })
    },
  })
  smtp.on('error', retire)
  try {
    await Promise.all([
      imap.connect().then(() => { if (gone) imap.close() }),
      smtp.verify().then(() => { if (gone) smtp.close() }),
    ])
    if (gone) throw new Error('The mail connection closed during verification')
  } catch (error) {
    retire()
    throw error
  }

  const folders = async () => {
    const list = await imap.list()
    const pick = (use, names) => list.find(box => box.specialUse === use)?.path
      ?? list.find(box => names.some(name => box.path.toLowerCase() === name))?.path
    return {
      inbox: 'INBOX',
      drafts: pick('\\Drafts', ['drafts', 'draft']),
      trash: pick('\\Trash', ['trash', 'deleted messages', 'deleted', '已删除']),
    }
  }
  let folderCache
  const special = async () => (folderCache ??= await folders())

  const toRow = (msg, folder) => ({
    uid: msg.uid, folder,
    from: msg.envelope?.from?.map(a => a.address ?? a.name).join(', ') ?? '',
    to: msg.envelope?.to?.map(a => a.address ?? a.name).join(', ') ?? '',
    subject: msg.envelope?.subject ?? '',
    date: msg.envelope?.date?.toISOString?.() ?? '',
    seen: msg.flags?.has('\\Seen') === true,
    flagged: msg.flags?.has('\\Flagged') === true,
  })

  const fetchParsedLocked = async (uid, folder) => {
    const message = await imap.fetchOne(uid, { source: true, envelope: true, bodyStructure: true }, { uid: true })
    if (message === false) throw new Error('No such message')
    // Keep optional mail decoding out of plugin activation.
    const { simpleParser } = await import('mailparser')
    const parsed = await simpleParser(message.source)
    return {
      uid, folder,
      messageId: parsed.messageId ?? message.envelope?.messageId ?? '',
      subject: parsed.subject ?? '',
      from: parsed.from?.text ?? '',
      to: parsed.to?.text ?? '',
      cc: parsed.cc?.text ?? '',
      date: parsed.date?.toISOString?.() ?? '',
      text: parsed.text ?? '',
      references: Array.isArray(parsed.references) ? parsed.references : (parsed.references ? [parsed.references] : []),
      attachments: (parsed.attachments ?? []).map((a, i) => ({ filename: a.filename ?? `attachment-${i + 1}`, size: a.size ?? 0, partId: a.partId })),
      _inReplyTo: parsed.inReplyTo ?? message.envelope?.inReplyTo ?? '',
      _parsed: parsed,
    }
  }

  const parseMessage = async (uid, folder) => {
    const lock = await imap.getMailboxLock(folder)
    try {
      return await fetchParsedLocked(uid, folder)
    } finally { lock.release() }
  }

  return {
    kind: 'imap',
    get usable() { return !gone && imap.usable },
    async close() { try { if (!gone) await imap.logout() } catch { /* dropped */ } finally { retire() } },
    async search({ folder = 'INBOX', from, to, subject, text, since, before, unread, limit = 20 }) {
      const query = {}
      if (from) query.from = from
      if (to) query.to = to
      if (subject) query.subject = subject
      if (text) query.text = text
      if (since) query.since = new Date(since)
      if (before) query.before = new Date(before)
      if (unread) query.seen = false
      const lock = await imap.getMailboxLock(folder)
      try {
        const uids = await imap.search(query, { uid: true })
        const wanted = (Array.isArray(uids) ? uids : []).slice(-limit)
        if (wanted.length === 0) return []
        const rows = []
        for await (const msg of imap.fetch(wanted, { envelope: true, flags: true }, { uid: true })) rows.push(toRow(msg, folder))
        return rows
      } finally { lock.release() }
    },
    async read({ uid, folder = 'INBOX', thread = false }) {
      const lock = await imap.getMailboxLock(folder)
      try {
        const main = await fetchParsedLocked(uid, folder)
        if (!thread) return { messages: [strip(main)] }
        const MAX_THREAD_SCAN = 200
        const MAX_THREAD_MESSAGES = 50
        const MAX_THREAD_SEED_IDS = 10
        const refs = (main.references ?? []).filter(Boolean)
        const allSeedIds = new Set([main.messageId, main._inReplyTo, ...refs].filter(Boolean))
        const querySeedIds = []
        const addSeed = (id) => {
          if (!id || querySeedIds.includes(id) || querySeedIds.length >= MAX_THREAD_SEED_IDS) return
          querySeedIds.push(id)
        }
        addSeed(main.messageId)
        addSeed(main._inReplyTo)
        if (refs.length > 0) addSeed(refs[0])
        for (let i = refs.length - 1; i >= 1 && querySeedIds.length < MAX_THREAD_SEED_IDS; i -= 1) {
          addSeed(refs[i])
        }
        const candidateUids = new Map()
        let searched = false
        if (typeof imap.search === 'function') {
          if (querySeedIds.length > 0) {
            const rejectedHeaders = new Set()
            const headerNames = ['references', 'in-reply-to', 'message-id']
            for (const id of querySeedIds) {
              for (const headerName of headerNames) {
                if (rejectedHeaders.has(headerName)) continue
                try {
                  const hits = await imap.search({ header: { [headerName]: id } }, { uid: true })
                  searched = true
                  if (Array.isArray(hits)) for (const hit of hits) candidateUids.set(String(hit), hit)
                } catch {
                  // Stop repeating SEARCH HEADER queries for a header type this server rejects.
                  rejectedHeaders.add(headerName)
                }
              }
            }
          } else {
            const baseSubject = main.subject.replace(/^(?:\s*(?:re|fwd|fw)\s*:\s*)+/i, '').trim()
            if (baseSubject !== '') {
              try {
                const hits = await imap.search({ subject: baseSubject }, { uid: true })
                searched = true
                if (Array.isArray(hits)) for (const hit of hits) candidateUids.set(String(hit), hit)
              } catch { /* server may not support subject search */ }
            }
          }
        }
        const uidKey = String(uid)
        let fetchRange = null
        let fetchOptions
        if (searched) {
          candidateUids.delete(uidKey)
          const list = [...candidateUids.values()].slice(-MAX_THREAD_MESSAGES)
          if (list.length > 0) {
            fetchRange = list
            fetchOptions = { uid: true }
          }
        } else {
          const total = Number(imap.mailbox?.exists)
          fetchRange = Number.isFinite(total) && total > MAX_THREAD_SCAN
            ? `${Math.max(1, total - MAX_THREAD_SCAN + 1)}:*`
            : '1:*'
        }
        const relatedUids = []
        if (fetchRange !== null && typeof imap.fetch === 'function') {
          const ids = new Set(allSeedIds)
          for await (const msg of imap.fetch(fetchRange, { envelope: true }, fetchOptions)) {
            const mid = msg.envelope?.messageId
            const inReply = msg.envelope?.inReplyTo
            const matches = (inReply !== undefined && ids.has(inReply))
              || (mid !== undefined && ids.has(mid))
              || (Array.isArray(fetchRange) && candidateUids.has(String(msg.uid)))
            if (matches && String(msg.uid) !== uidKey) {
              relatedUids.push(msg.uid)
              if (mid) ids.add(mid)
              if (inReply) ids.add(inReply)
              if (relatedUids.length >= MAX_THREAD_MESSAGES) break
            }
          }
        }
        const related = []
        for (const relUid of relatedUids) related.push(await fetchParsedLocked(relUid, folder))
        related.sort((a, b) => String(a.date).localeCompare(String(b.date)))
        return { messages: [strip(main), ...related.map(strip)] }
      } finally { lock.release() }
    },
    async saveAttachment({ uid, folder = 'INBOX', filename, to }) {
      const message = await parseMessage(uid, folder)
      const part = message._parsed.attachments.find(a => (a.filename ?? '') === filename) ?? message._parsed.attachments[0]
      if (part === undefined) throw new Error('No such attachment')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(to, part.content)
      return { path: to, filename: part.filename ?? filename, bytes: part.size ?? part.content.length }
    },
    async draft({ to, cc, bcc, subject, text }) {
      const { drafts } = await special()
      if (drafts === undefined) throw new Error('This account has no Drafts folder')
      const raw = await compose(account.address, { to, cc, bcc, subject, text })
      await imap.append(drafts, raw, ['\\Seen'])
      return { folder: drafts }
    },
    async send({ to, cc, bcc, subject, text, attachments = [], inReplyTo, references }) {
      const info = await smtp.sendMail({
        from: account.address, to, cc, bcc, subject, text,
        ...(inReplyTo ? { inReplyTo, references: references ?? [inReplyTo] } : {}),
        attachments,
      })
      return { messageId: info.messageId }
    },
    async update({ uid, folder = 'INBOX', seen, flagged, move }) {
      const lock = await imap.getMailboxLock(folder)
      try {
        if (seen !== undefined) await (seen ? imap.messageFlagsAdd(uid, ['\\Seen'], { uid: true }) : imap.messageFlagsRemove(uid, ['\\Seen'], { uid: true }))
        if (flagged !== undefined) await (flagged ? imap.messageFlagsAdd(uid, ['\\Flagged'], { uid: true }) : imap.messageFlagsRemove(uid, ['\\Flagged'], { uid: true }))
        if (move !== undefined) {
          const { trash } = await special()
          const target = move === 'trash' ? trash : move
          if (target === undefined) throw new Error('This account has no Trash folder')
          await imap.messageMove(uid, target, { uid: true })
        }
      } finally { lock.release() }
    },
  }
}

const strip = ({ _parsed, _inReplyTo, ...message }) => message

const compose = async (from, { to, cc, bcc, subject, text }) => {
  const MailComposer = (await import('nodemailer/lib/mail-composer')).default
  return await new MailComposer({ from, to, cc, bcc, subject, text }).compile().build()
}

// Gmail REST API backend for accounts signed in with Google. Same interface.
export function connectGmail(account, deps = {}) {
  const send = async (path, init = {}, retried = false) => {
    const response = await (deps.fetch ?? fetch)(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${deps.token()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
    if (response.status === 401 && !retried && deps.refresh) {
      await response.body?.cancel?.().catch(() => {})
      if (await deps.refresh() === true) return send(path, init, true)
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`Gmail answered ${response.status}`)
    }
    return response.json().catch(() => ({}))
  }
  const header = (list, name) => list?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
  const decode = data => data === undefined ? '' : Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  const walk = (part, out = { text: '', html: '', attachments: [] }) => {
    if (part === undefined) return out
    const mime = String(part.mimeType ?? '').toLowerCase()
    if (!part.filename && mime === 'text/plain' && part.body?.data) out.text += decode(part.body.data)
    else if (!part.filename && mime === 'text/html' && part.body?.data) out.html += decode(part.body.data)
    if (part.filename) out.attachments.push({ filename: part.filename, size: part.body?.size ?? 0, attachmentId: part.body?.attachmentId })
    for (const child of part.parts ?? []) walk(child, out)
    return out
  }
  const toMessage = (full) => {
    const headers = full.payload?.headers ?? []
    const body = walk(full.payload)
    return {
      uid: full.id, folder: 'gmail', messageId: header(headers, 'Message-ID'),
      subject: header(headers, 'Subject'), from: header(headers, 'From'), to: header(headers, 'To'), cc: header(headers, 'Cc'),
      date: header(headers, 'Date'), text: body.text.trim() !== '' ? body.text : (body.html ? htmlToText(body.html) : body.text), attachments: body.attachments, threadId: full.threadId,
      references: [header(headers, 'References'), header(headers, 'In-Reply-To')].filter(Boolean),
    }
  }
  return {
    kind: 'gmail',
    async close() {},
    async search({ folder, from, to, subject, text, since, before, unread, limit = 20 }) {
      const q = [
        from ? `from:${from}` : '', to ? `to:${to}` : '', subject ? `subject:${subject}` : '',
        text ?? '', since ? `after:${Math.floor(new Date(since).getTime() / 1000)}` : '', before ? `before:${Math.floor(new Date(before).getTime() / 1000)}` : '',
        unread ? 'is:unread' : '', folder && folder !== 'INBOX' ? `in:${folder}` : '',
      ].filter(Boolean).join(' ')
      const list = await send(`/messages?${new URLSearchParams({ q, maxResults: String(limit) })}`)
      const rows = []
      for (const ref of list.messages ?? []) {
        const full = await send(`/messages/${ref.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`)
        const headers = full.payload?.headers ?? []
        rows.push({ uid: full.id, folder: 'gmail', from: header(headers, 'From'), to: header(headers, 'To'), subject: header(headers, 'Subject'), date: header(headers, 'Date'), seen: !(full.labelIds ?? []).includes('UNREAD'), flagged: (full.labelIds ?? []).includes('STARRED') })
      }
      return rows
    },
    async read({ uid, thread = false }) {
      const full = await send(`/messages/${uid}?format=full`)
      const main = toMessage(full)
      if (!thread) return { messages: [main] }
      const all = await send(`/threads/${full.threadId}?format=full`)
      const messages = (all.messages ?? []).map(toMessage)
      messages.sort((a, b) => String(a.date).localeCompare(String(b.date)))
      return { messages: messages.length > 0 ? messages : [main] }
    },
    async saveAttachment({ uid, filename, to }) {
      const full = await send(`/messages/${uid}?format=full`)
      const { attachments } = walk(full.payload)
      const part = attachments.find(a => a.filename === filename) ?? attachments[0]
      if (part === undefined) throw new Error('No such attachment')
      const data = await send(`/messages/${uid}/attachments/${part.attachmentId}`)
      const { writeFile } = await import('node:fs/promises')
      await writeFile(to, Buffer.from(String(data.data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
      return { path: to, filename: part.filename, bytes: part.size }
    },
    async draft(args) { return gmailDraft(send, account.address, args) },
    async send(args) { return gmailSend(send, account.address, args) },
    async update({ uid, seen, flagged, move }) {
      if (move === 'trash' || move === 'TRASH') { await send(`/messages/${uid}/trash`, { method: 'POST' }); return }
      const add = [], remove = []
      if (seen === true) remove.push('UNREAD')
      if (seen === false) add.push('UNREAD')
      if (flagged === true) add.push('STARRED')
      if (flagged === false) remove.push('STARRED')
      if (move !== undefined) { remove.push('INBOX'); add.push(String(move).toUpperCase()) }
      await send(`/messages/${uid}/modify`, { method: 'POST', body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) })
    },
  }
}

const HTML_ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function stripHtmlBlock(source, tag) {
  // ASCII-only lowercasing preserves 1:1 string indices even around Unicode characters like 'İ'.
  const lower = source.replace(/[A-Z]/g, c => c.toLowerCase())
  const open = `<${tag}`
  const close = `</${tag}`
  let out = ''
  let pos = 0
  while (pos < source.length) {
    const start = lower.indexOf(open, pos)
    if (start === -1) { out += source.slice(pos); break }
    const next = lower[start + open.length]
    if (next !== undefined && !/[\s>/]/.test(next)) {
      out += source.slice(pos, start + open.length)
      pos = start + open.length
      continue
    }
    out += source.slice(pos, start)
    const openEnd = lower.indexOf('>', start + open.length)
    if (openEnd === -1) break
    if (lower[openEnd - 1] === '/') {
      pos = openEnd + 1
      continue
    }
    const endTag = lower.indexOf(close, openEnd + 1)
    if (endTag === -1) break
    const closeEnd = lower.indexOf('>', endTag + close.length)
    pos = closeEnd === -1 ? source.length : closeEnd + 1
  }
  return out
}
const decodeHtmlEntities = (text) => text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (full, hex, dec, name) => {
  if (hex !== undefined) {
    const n = parseInt(hex, 16)
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : full
  }
  if (dec !== undefined) {
    const n = Number(dec)
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : full
  }
  return HTML_ENTITIES[name.toLowerCase()] ?? full
})
const htmlToText = (html) => decodeHtmlEntities(
  stripHtmlBlock(stripHtmlBlock(String(html ?? ''), 'style'), 'script')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:td|th)\s*>/gi, '\t')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ''),
)
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const gmailRaw = async (from, { to, cc, bcc, subject, text, attachments = [], inReplyTo, references }) => {
  const MailComposer = (await import('nodemailer/lib/mail-composer')).default
  const list = Array.isArray(attachments) ? attachments : []
  const raw = await new MailComposer({
    from, to, cc, bcc, subject, text,
    ...(list.length > 0 ? { attachments: list } : {}),
    ...(inReplyTo ? { inReplyTo, references: references ?? [inReplyTo] } : {}),
  }).compile().build()
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const gmailDraft = async (send, from, args) => {
  const raw = await gmailRaw(from, args)
  const draft = await send('/drafts', { method: 'POST', body: JSON.stringify({ message: { raw } }) })
  return { folder: 'DRAFT', id: draft.id }
}
const gmailSend = async (send, from, args) => {
  const raw = await gmailRaw(from, args)
  const sent = await send('/messages/send', { method: 'POST', body: JSON.stringify({ raw }) })
  return { messageId: sent.id }
}

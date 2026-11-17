import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { connectImap } from '../src/host/connectors/mail/transport.js'

const execFileP = promisify(execFile)
const account = {
  address: 'test@invalid.test',
  imap: { host: '127.0.0.1', port: 1 },
  smtp: { host: '127.0.0.1', port: 1 },
}

const transport = ({ connect = async () => {}, verify = async () => {} } = {}) => {
  let imap
  class ImapFlow extends EventEmitter {
    usable = false
    closed = false
    constructor() { super(); imap = this }
    async connect() { await connect(); this.usable = true }
    close() { this.closed = true; this.usable = false; this.emit('close') }
    async logout() { this.close() }
  }
  const smtp = new EventEmitter()
  smtp.verify = verify
  smtp.closed = false
  smtp.close = () => { smtp.closed = true }
  return { modules: { ImapFlow, nodemailer: { createTransport: () => smtp } }, get imap() { return imap }, smtp }
}

test('idle IMAP errors and close retire the session without escaping', async () => {
  const fake = transport()
  let gone = 0
  const session = await connectImap(account, { modules: fake.modules, onGone: () => { gone += 1 } })
  assert.equal(session.usable, true)
  assert.doesNotThrow(() => fake.imap.emit('error', new Error('Socket timeout')))
  assert.equal(session.usable, false)
  fake.imap.emit('close')
  assert.equal(gone, 1)
  assert.equal(fake.smtp.closed, true)
})

test('SMTP errors cannot escape and close both transports', async () => {
  const fake = transport()
  const session = await connectImap(account, { modules: fake.modules })
  assert.doesNotThrow(() => fake.smtp.emit('error', new Error('SMTP dropped')))
  assert.equal(session.usable, false)
  assert.equal(fake.imap.closed, true)
  assert.equal(fake.smtp.closed, true)
})

test('IMAP connect and SMTP verify start together', async () => {
  const imapGate = Promise.withResolvers()
  const smtpStarted = Promise.withResolvers()
  const fake = transport({ connect: () => imapGate.promise, verify: async () => { smtpStarted.resolve() } })
  const pending = connectImap(account, { modules: fake.modules })
  try {
    await Promise.race([smtpStarted.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP waited for IMAP')), 100))])
  } finally { imapGate.resolve(); await (await pending).close() }
})

for (const side of ['IMAP', 'SMTP']) {
  test(`${side} verification failure closes both transports, including a late connection`, async () => {
    const gate = Promise.withResolvers()
    const fail = async () => { throw new Error(`${side} refused`) }
    const fake = transport({
      connect: side === 'IMAP' ? fail : () => gate.promise,
      verify: side === 'SMTP' ? fail : () => gate.promise,
    })
    const pending = connectImap(account, { modules: fake.modules })
    try {
      await assert.rejects(Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error('verification did not reject')), 100)),
      ]), new RegExp(`${side} refused`))
    } finally { gate.resolve(); await pending.catch(() => {}) }
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fake.imap.closed, true)
    assert.equal(fake.imap.usable, false)
    assert.equal(fake.smtp.closed, true)
  })
}

test('an IMAP failure cancels a real nodemailer verification socket', async (t) => {
  const accepted = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const server = createServer(socket => {
    socket.on('error', () => {})
    socket.on('close', () => closed.resolve())
    accepted.resolve()
    // Deliberately never send an SMTP greeting.
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const fake = transport({ connect: async () => { await accepted.promise; throw new Error('IMAP refused') } })
  const nodemailer = await import('nodemailer')
  await assert.rejects(connectImap({
    ...account, smtp: { host: '127.0.0.1', port: server.address().port, secure: false },
  }, { modules: { ImapFlow: fake.modules.ImapFlow, nodemailer } }), /IMAP refused/)
  await closed.promise
})

test('a verified SMTP transport opens a fresh socket when sending', async (t) => {
  let connections = 0
  const server = createServer(socket => {
    connections += 1
    socket.on('error', () => {})
    socket.write('220 fake SMTP\r\n')
    let data = ''
    let body = false
    socket.on('data', chunk => {
      data += chunk.toString()
      let end
      while ((end = data.indexOf('\r\n')) !== -1) {
        const line = data.slice(0, end)
        data = data.slice(end + 2)
        if (body) {
          if (line === '.') { body = false; socket.write('250 queued\r\n') }
        } else if (line.startsWith('DATA')) { body = true; socket.write('354 send data\r\n') }
        else if (line.startsWith('QUIT')) socket.end('221 bye\r\n')
        else socket.write('250 OK\r\n')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const fake = transport()
  const nodemailer = await import('nodemailer')
  const session = await connectImap({
    ...account, smtp: { host: '127.0.0.1', port: server.address().port, secure: false },
  }, { modules: { ImapFlow: fake.modules.ImapFlow, nodemailer } })
  t.after(() => session.close())
  await session.send({ to: 'other@invalid.test', subject: 'Test', text: 'body' })
  assert.equal(connections, 2)
  assert.equal(session.usable, true)
})

test('loading the plugin does not load mailparser', async () => {
  const script = `
    import { registerHooks } from 'node:module'
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'mailparser') throw new Error('mailparser loaded at import time')
      return next(specifier, context)
    } })
    await import(${JSON.stringify(new URL('../src/host/connectors/mail/transport.js', import.meta.url).href)})
  `
  await execFileP(process.execPath, ['--input-type=module', '-e', script])
})

test('a mail is parsed by mailparser, loaded on the first read', async () => {
  const fake = transport()
  const source = Buffer.from('From: a@b.test\r\nTo: c@d.test\r\nSubject: =?GBK?B?1tDOxA==?=\r\nMessage-ID: <1@b.test>\r\n\r\nhello')
  fake.modules.ImapFlow.prototype.getMailboxLock = async () => ({ release() {} })
  fake.modules.ImapFlow.prototype.fetchOne = async () => ({ source, envelope: {} })
  const session = await connectImap(account, { ...fake, password: 'x' })
  const { messages } = await session.read({ uid: 1 })
  assert.equal(messages[0].subject, '中文')
  await session.close()
})

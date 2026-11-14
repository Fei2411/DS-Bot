// Matrix: talk to a Bot from any Matrix homeserver over the Client-Server API.
// The adapter owns the wire: one /sync long-poll loop reads rooms, the first sync
// after a start delivers whatever arrived while the connection was off, invites are
// joined automatically, a room is a direct chat when it is in m.direct or holds two
// members, and every other room is a group (the channel asks for an @ there).
// Text goes out as m.room.message; files are uploaded to the media repository first
// and then sent as m.file / m.image.
const SYNC_TIMEOUT = 30_000
const TEXT_LIMIT = 32_000
const SEEN_LIMIT = 2_000
const RETRY_MS = 5_000

const trimSlash = value => String(value ?? '').replace(/\/+$/, '')
const enc = value => encodeURIComponent(String(value ?? ''))
const bearer = fields => ({
  authorization: `Bearer ${String(fields.accessToken ?? '').trim()}`,
  'content-type': 'application/json',
})

// A homeserver in plain HTTP would send the access token in the clear over the network.
const secureBase = (value) => {
  const raw = String(value ?? '').trim()
  if (raw === '') throw new Error('A homeserver URL is required')
  const url = new URL(raw)
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The homeserver URL must start with https:// — an http:// homeserver would send the access token in the clear')
  }
  return trimSlash(raw)
}

async function call(env, fields, path, { method = 'GET', body } = {}) {
  const response = await env.fetch(`${secureBase(fields.homeserver)}${path}`, {
    method,
    headers: bearer(fields),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = {}
  try { json = text === '' ? {} : JSON.parse(text) } catch { json = {} }
  if (!response.ok) {
    const error = new Error(String(json.error ?? `Matrix answered ${response.status}`))
    error.status = response.status
    error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429
    throw error
  }
  return json
}

// mxc://server/media → the authenticated download endpoint of the same homeserver.
const mediaUrl = (fields, mxc) => {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(String(mxc ?? ''))
  return match === null ? undefined : `${secureBase(fields.homeserver)}/_matrix/client/v1/media/download/${enc(match[1])}/${enc(match[2])}`
}

export default {
  id: 'matrix',

  async check(fields, env) {
    const me = await call(env, fields, '/_matrix/client/v3/account/whoami')
    const userId = String(me.user_id ?? fields.userId ?? '')
    return { account: { id: userId, name: userId } }
  },

  connect(fields, env, handlers) {
    let stopped = false
    let generation = 0
    let since
    let me = String(fields.userId ?? '').trim()
    let localpart = me.startsWith('@') ? me.slice(1).split(':')[0] : me
    let txn = 0
    const directs = new Set()
    const seen = new Set()
    const titles = new Map()
    // A room's kind outlives the sync that told us: an incremental sync carries no
    // member events, so the count seen earlier is what keeps a group a group.
    const kinds = new Map()

    const remember = (id) => {
      if (id === undefined || id === '') return false
      if (seen.has(id)) return false
      seen.add(id)
      if (seen.size > SEEN_LIMIT) seen.clear()
      return true
    }

    const loadDirects = async () => {
      try {
        const data = await call(env, fields, `/_matrix/client/v3/user/${enc(me)}/account_data/m.direct`)
        for (const rooms of Object.values(data ?? {})) {
          if (Array.isArray(rooms)) for (const room of rooms) directs.add(String(room))
        }
      } catch { /* a homeserver without m.direct has no direct chats yet */ }
    }

    const joinRoom = async (roomId) => {
      try {
        await call(env, fields, `/_matrix/client/v3/join/${enc(roomId)}`, { method: 'POST', body: {} })
      } catch (error) {
        env.log?.warn?.('ds-bot im: matrix could not join %s: %s', roomId, error?.message ?? error)
      }
    }

    // A whole word, so a Bot called "bot" is not mentioned by "robot".
    const speaksTo = (text) => {
      if (localpart === '') return false
      const wanted = localpart.toLowerCase()
      return String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).includes(wanted)
    }

    // A message's files and images: attachments carry a media id, never bytes, so
    // every one is fetched through the authenticated download endpoint.
    const readAttachments = async (content) => {
      const images = []
      const files = []
      const url = content?.url ?? content?.file?.url
      if (typeof url !== 'string' || url === '') return { images, files }
      const http = mediaUrl(fields, url)
      if (http === undefined) return { images, files }
      const name = String(content?.body ?? 'file')
      try {
        const response = await env.fetch(http, { headers: { authorization: `Bearer ${String(fields.accessToken ?? '').trim()}` } })
        if (!response.ok) throw new Error(`media answered ${response.status}`)
        const data = Buffer.from(await response.arrayBuffer())
        if (data.length === 0) return { images, files }
        const mime = String(content?.info?.mimetype ?? response.headers?.get?.('content-type') ?? '')
        if (String(content?.msgtype) === 'm.image' || mime.startsWith('image/')) {
          images.push({ mediaType: mime.startsWith('image/') ? mime : 'image/jpeg', data: data.toString('base64') })
        } else {
          files.push({ name, data })
        }
      } catch (error) {
        env.log?.warn?.('ds-bot im: matrix attachment not fetched: %s', error?.message ?? error)
      }
      return { images, files }
    }

    const handleInvite = async (roomId, room) => {
      const events = room?.invite_state?.events ?? []
      if (events.some(event => event?.type === 'm.room.member' && event.state_key === me && event.content?.membership === 'invite')) await joinRoom(roomId)
    }

    const handleRoom = async (roomId, room) => {
      if (stopped) return
      const state = room?.state?.events ?? []
      for (const event of state) {
        if (event?.type === 'm.room.name' && typeof event.content?.name === 'string') titles.set(roomId, event.content.name)
        if (event?.type === 'm.room.member' && event.state_key === me && event.content?.membership === 'invite') await joinRoom(roomId)
      }
      const joined = state.filter(event => event?.type === 'm.room.member' && event.content?.membership === 'join')
      // Only state events say who is in the room. Without them a room keeps the kind
      // it was given, and an unknown room is a group: a group message needs an @.
      if (directs.has(roomId)) kinds.set(roomId, 'direct')
      else if (joined.length > 0) kinds.set(roomId, joined.length <= 2 ? 'direct' : 'group')
      const kind = kinds.get(roomId) ?? 'group'
      for (const event of room?.timeline?.events ?? []) {
        if (stopped) return
        if (event?.type !== 'm.room.message') continue
        const sender = String(event.sender ?? '')
        if (sender === me || !remember(event.event_id)) continue
        const content = event.content ?? {}
        const text = String(content.body ?? '').trim()
        const { images, files } = await readAttachments(content)
        if (text === '' && images.length === 0 && files.length === 0) continue
        const mentions = content['m.mentions']?.user_ids
        const mentioned = kind === 'direct'
          || (Array.isArray(mentions) && mentions.map(String).includes(me))
          || speaksTo(text)
        await handlers.onMessage({
          chat: { key: roomId, kind, title: titles.get(roomId) ?? '' },
          sender: { id: sender, name: sender },
          text,
          images,
          files,
          mentioned,
          messageId: String(event.event_id ?? ''),
        })
      }
    }

    // Every batch, first one included: a Bot that was off during a message still answers it.
    const drain = async (data) => {
      for (const [roomId, room] of Object.entries(data.rooms?.join ?? {})) {
        if (stopped) return
        await handleRoom(roomId, room)
      }
      for (const [roomId, room] of Object.entries(data.rooms?.invite ?? {})) {
        if (stopped) return
        await handleInvite(roomId, room)
      }
    }

    const start = async () => {
      const gen = generation
      handlers.onStatus({ state: 'connecting' })
      await loadDirects()
      const first = await call(env, fields, '/_matrix/client/v3/sync?timeout=0')
      me = String(me === '' ? first.user_id ?? me : me)
      localpart = me.startsWith('@') ? me.slice(1).split(':')[0] : me
      await drain(first)
      if (typeof first.next_batch === 'string') since = first.next_batch
      if (stopped || generation !== gen) return false
      handlers.onStatus({ state: 'ready', account: { id: me, name: me } })
      return true
    }

    const loop = async () => {
      const gen = generation
      // A homeserver that is down when the Bot starts is not a reason to stay off.
      while (!stopped && generation === gen) {
        try {
          const who = await call(env, fields, '/_matrix/client/v3/account/whoami')
          me = String(who.user_id ?? me)
          localpart = me.startsWith('@') ? me.slice(1).split(':')[0] : me
          if (await start()) break
          return
        } catch (error) {
          if (stopped || generation !== gen) return
          handlers.onStatus({ state: 'retrying', error: String(error?.message ?? error) })
          await new Promise(done => setTimeout(done, RETRY_MS))
        }
      }
      while (!stopped && generation === gen) {
        try {
          const query = `/_matrix/client/v3/sync?timeout=${SYNC_TIMEOUT}${since === undefined ? '' : `&since=${enc(since)}`}`
          const data = await call(env, fields, query)
          if (stopped || generation !== gen) return
          await drain(data)
          if (typeof data.next_batch === 'string') since = data.next_batch
        } catch (error) {
          if (stopped || generation !== gen) return
          handlers.onStatus({ state: 'retrying', error: String(error?.message ?? error) })
          await new Promise(done => setTimeout(done, RETRY_MS))
        }
      }
    }

    const sendMessage = async (roomId, content) => {
      const path = `/_matrix/client/v3/rooms/${enc(roomId)}/send/m.room.message/${enc(`ds-bot-${Date.now()}-${(txn += 1)}`)}`
      return call(env, fields, path, { method: 'PUT', body: content })
    }

    const upload = async (file) => {
      const name = String(file?.name ?? 'file')
      const response = await env.fetch(`${secureBase(fields.homeserver)}/_matrix/media/v3/upload?filename=${enc(name)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${String(fields.accessToken ?? '').trim()}`,
          'content-type': String(file?.mediaType ?? 'application/octet-stream'),
        },
        body: Buffer.from(file?.data ?? []),
      })
      const json = await response.json().catch(() => ({}))
      if (!response.ok || typeof json.content_uri !== 'string') throw new Error(`matrix upload answered ${response.status}`)
      return json.content_uri
    }

    void loop()

    return {
      send: async (chat, { text, files }) => {
        let rest = String(text ?? '')
        let messageId
        while (rest.length > 0) {
          const chunk = rest.slice(0, TEXT_LIMIT)
          rest = rest.slice(TEXT_LIMIT)
          if (chunk.trim() === '') continue
          const sent = await sendMessage(chat.key, { msgtype: 'm.text', body: chunk })
          messageId = String(sent?.event_id ?? messageId ?? '')
        }
        for (const file of files ?? []) {
          try {
            const url = await upload(file)
            const data = Buffer.from(file?.data ?? [])
            const mime = String(file?.mediaType ?? 'application/octet-stream')
            const sent = await sendMessage(chat.key, {
              msgtype: mime.startsWith('image/') ? 'm.image' : 'm.file',
              body: String(file?.name ?? 'file'),
              url,
              info: { mimetype: mime, size: data.length },
            })
            messageId = String(sent?.event_id ?? messageId ?? '')
          } catch (error) {
            env.log?.warn?.('ds-bot im: matrix file not sent: %s', error?.message ?? error)
          }
        }
        return { messageId }
      },
      stop: () => {
        stopped = true
        generation += 1
      },
    }
  },
}

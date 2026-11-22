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
import { SOURCE_KIND } from '../constants.js'
import { extractLocalMarkdownImages, prepareOutboundReply } from './outbound-images.js'
import { adapters } from './platforms/index.js'
import { imViewChoices } from './view-choices.js'
import { imViewFormText, isLegacyImViewFormAnswer, parseImViewForm } from './view-form.js'

const RECONCILE_MS = 15_000
const RUNTIME_SAVE_MS = 400
const RECENT_VIEW_CODES_KEEP = 100
const VIEW_REPLY_VERSION = 2
const RETRY_MS = 5_000
// A send that keeps failing is given up on, with a bounded backoff, so one broken
// message cannot hold every later message in the same chat forever (#1417).
const RETRY_MAX_MS = 30_000
const SEND_ATTEMPTS = 4
const TYPING_MS = 4_000
const CONSUMED_REQUESTS_KEEP = 200
const WEIXIN_REQUESTS_KEEP = 200
const NUMBERS = /^\s*\d+(\s+\d+)*\s*$/
// A quoted reply is answered with the message it quotes: the last messages sent
// to a chat are kept by the ids the platform named them, and only their start.
const SENT_KEEP = 20
const SENT_TEXT_LIMIT = 1_000
const QUOTE_LIMIT = 500
// A platform may report several id aliases and a long text. Bound each entry
// too, so no single message can by itself fill the whole store.
const SENT_ID_LIMIT = 16
const SENT_ID_LEN = 100
// The runtime file is written as one blob. Keep the whole sent-message store
// bounded even with many chats, so a connection with lots of chats cannot grow
// it without limit (#1306 review).
const SENT_STORE_LIMIT = 200_000

const secretField = key => key.replace(/[A-Z]/g, char => `_${char}`).toUpperCase()

export function install(rt) {
  const { ctx, state } = rt
  const imDir = join(rt.home, 'im')
  const langKey = () => {
    const label = String(rt.uiLanguage?.() ?? '')
    if (label.startsWith('Traditional Chinese')) return 'zh-TW'
    if (label.startsWith('Chinese')) return 'zh'
    if (label.startsWith('Japanese')) return 'ja'
    if (label.startsWith('Korean')) return 'ko'
    if (label.startsWith('Spanish')) return 'es'
    if (label.startsWith('French')) return 'fr'
    if (label.startsWith('German')) return 'de'
    return 'en'
  }
  const text = (key, values = {}) => {
    const lang = langKey()
    const table = {
      en: {
        requested: 'A connection request was sent to DS Bot; allow it in Settings → IM on the computer.',
        unbound: 'This IM bot is not bound to a Bot yet; pick one in DS Bot Settings → IM.',
        unboundGroup: 'This group is not bound yet; pick a group or a Bot for it in DS Bot Settings → IM.',
        connected: `Connected — you can talk to ${values.target} now.`,
        stopped: 'Stopped.',
        idle: 'Nothing is running.',
        stale: 'This card was already answered.',
        noFile: 'This file cannot be sent here; send it on the computer.',
        greeting: `Hello, I am ${values.name}.`,
        question: `${values.bot} asks: `,
        approval: `${values.bot} asks for approval: `,
        secretAsk: `${values.bot} needs the key ${values.name} — fill it on the computer or the phone app.`,
        viewShow: `${values.bot} shared a card — answer it on the computer or the phone app.`,
        answered: 'answered',
        numbers: 'reply with the number',
        numbersMulti: 'reply with the numbers, separated by spaces',
        quoteEarlier: 'Replying to an earlier message:',
        quoteMissing: 'Replying to an earlier message (its text is not available).',
        allow: 'Allow once',
        reject: 'Reject',
      },
      zh: {
        requested: '已向 DS Bot 发出连接请求，请在电脑上的 DS Bot 设置 → IM 里允许。',
        unbound: '这个 IM 机器人还没绑定 Bot，请在 DS Bot 设置 → IM 里选一个。',
        unboundGroup: '这个群还没绑定，请在 DS Bot 设置 → IM 里给它选一个群或 Bot。',
        connected: `已连接，现在可以和 ${values.target} 说话了。`,
        stopped: '已停下。',
        idle: '现在没有在做的活。',
        stale: '这张卡已经答过了。',
        noFile: '这个文件发不过去，请在电脑上发。',
        greeting: `你好，我是 ${values.name}。`,
        question: `${values.bot} 问你：`,
        approval: `${values.bot} 请你审批：`,
        secretAsk: `${values.bot} 要密钥 ${values.name}，请在电脑或手机 App 上填。`,
        viewShow: `${values.bot} 发了一个卡片，请在电脑或手机 App 上回复。`,
        answered: '已答',
        numbers: '回复编号',
        numbersMulti: '回复编号，多选用空格隔开',
        quoteEarlier: '引用了一条更早的消息：',
        quoteMissing: '引用了一条更早的消息（内容不可见）。',
        allow: '允许一次',
        reject: '拒绝',
      },
      'zh-TW': {
        requested: '已向 DS Bot 發出連線請求，請在電腦上的 DS Bot 設定 → IM 裡允許。',
        unbound: '這個 IM 機器人還沒綁定 Bot，請在 DS Bot 設定 → IM 裡選一個。',
        unboundGroup: '這個群還沒綁定，請在 DS Bot 設定 → IM 裡給它選一個群或 Bot。',
        connected: `已連線，現在可以和 ${values.target} 說話了。`,
        stopped: '已停下。',
        idle: '現在沒有在做的活。',
        stale: '這張卡已經答過了。',
        noFile: '這個檔案傳不過去，請在電腦上傳。',
        greeting: `你好，我是 ${values.name}。`,
        question: `${values.bot} 問你：`,
        approval: `${values.bot} 請你審批：`,
        secretAsk: `${values.bot} 要金鑰 ${values.name}，請在電腦或手機 App 上填。`,
        viewShow: `${values.bot} 發了一個卡片，請在電腦或手機 App 上回覆。`,
        answered: '已答',
        numbers: '回覆編號',
        numbersMulti: '回覆編號，多選用空格隔開',
        quoteEarlier: '引用了更早的一則訊息：',
        quoteMissing: '引用了更早的一則訊息（內容不可見）。',
        allow: '允許一次',
        reject: '拒絕',
      },
      ja: {
        requested: 'DS Bot に接続リクエストを送信しました。PC の DS Bot 設定 → IM で許可してください。',
        unbound: 'この IM ボットはまだ Bot に紐付けられていません。DS Bot 設定 → IM で選択してください。',
        unboundGroup: 'このグループはまだ紐付けられていません。DS Bot 設定 → IM でグループまたは Bot を選択してください。',
        connected: `接続しました。${values.target} と話せます。`,
        stopped: '停止しました。',
        idle: '実行中のタスクはありません。',
        stale: 'このカードは回答済みです。',
        noFile: 'このファイルはここでは送信できません。PC から送信してください。',
        greeting: `こんにちは、${values.name} です。`,
        question: `${values.bot} からの質問：`,
        approval: `${values.bot} からの承認リクエスト：`,
        secretAsk: `${values.bot} がシークレット ${values.name} を必要としています。PC またはスマホアプリで入力してください。`,
        viewShow: `${values.bot} がカードを共有しました。PC またはスマホアプリで回答してください。`,
        answered: '回答済み',
        numbers: '番号を返信',
        numbersMulti: '番号をスペース区切りで返信',
        quoteEarlier: '以前のメッセージへの返信です：',
        quoteMissing: '以前のメッセージへの返信です（本文は取得できませんでした）。',
        allow: '1回許可',
        reject: '拒否',
      },
      ko: {
        requested: 'DS Bot에 연결 요청을 보냈습니다. 컴퓨터의 DS Bot 설정 → IM에서 허용해 주세요.',
        unbound: '이 IM 봇은 아직 Bot에 연결되지 않았습니다. DS Bot 설정 → IM에서 선택해 주세요.',
        unboundGroup: '이 그룹은 아직 연결되지 않았습니다. DS Bot 설정 → IM에서 그룹이나 Bot을 선택해 주세요.',
        connected: `연결되었습니다. 이제 ${values.target}와(과) 대화할 수 있습니다.`,
        stopped: '중지되었습니다.',
        idle: '진행 중인 작업이 없습니다.',
        stale: '이미 응답한 카드입니다.',
        noFile: '이 파일은 여기서 보낼 수 없습니다. 컴퓨터에서 보내 주세요.',
        greeting: `안녕하세요, ${values.name}입니다.`,
        question: `${values.bot}의 질문: `,
        approval: `${values.bot}의 승인 요청: `,
        secretAsk: `${values.bot}에서 시크릿 ${values.name}이(가) 필요합니다. 컴퓨터나 휴대폰 앱에서 입력해 주세요.`,
        viewShow: `${values.bot}에서 카드를 보냈습니다. 컴퓨터나 휴대폰 앱에서 응답해 주세요.`,
        answered: '응답함',
        numbers: '번호로 답장',
        numbersMulti: '공백으로 구분하여 번호로 답장',
        quoteEarlier: '이전 메시지에 대한 답장입니다: ',
        quoteMissing: '이전 메시지에 대한 답장입니다(본문을 가져올 수 없습니다).',
        allow: '한 번 허용',
        reject: '거부',
      },
      es: {
        requested: 'Se envió una solicitud de conexión a DS Bot; permítela en Ajustes → IM en el ordenador.',
        unbound: 'Este bot de IM aún no está vinculado a un Bot; elige uno en Ajustes de DS Bot → IM.',
        unboundGroup: 'Este grupo aún no está vinculado; elige un grupo o un Bot en Ajustes de DS Bot → IM.',
        connected: `Conectado — ya puedes hablar con ${values.target}.`,
        stopped: 'Detenido.',
        idle: 'No hay nada en curso.',
        stale: 'Esta tarjeta ya fue respondida.',
        noFile: 'Este archivo no se puede enviar por aquí; envíalo desde el ordenador.',
        greeting: `Hola, soy ${values.name}.`,
        question: `${values.bot} pregunta: `,
        approval: `${values.bot} pide aprobación: `,
        secretAsk: `${values.bot} necesita la clave ${values.name} — rellénala en el ordenador o en la app móvil.`,
        viewShow: `${values.bot} compartió una tarjeta — respóndela en el ordenador o en la app móvil.`,
        answered: 'respondido',
        numbers: 'responde con el número',
        numbersMulti: 'responde con los números separados por espacios',
        quoteEarlier: 'Respondiendo a un mensaje anterior: ',
        quoteMissing: 'Respondiendo a un mensaje anterior (su texto no está disponible).',
        allow: 'Permitir una vez',
        reject: 'Rechazar',
      },
      fr: {
        requested: 'Une demande de connexion a été envoyée à DS Bot ; autorisez-la dans Paramètres → IM sur l’ordinateur.',
        unbound: 'Ce bot IM n’est pas encore lié à un Bot ; choisissez-en un dans Paramètres DS Bot → IM.',
        unboundGroup: 'Ce groupe n’est pas encore lié ; choisissez un groupe ou un Bot dans Paramètres DS Bot → IM.',
        connected: `Connecté — vous pouvez maintenant parler à ${values.target}.`,
        stopped: 'Arrêté.',
        idle: 'Rien n’est en cours.',
        stale: 'Cette carte a déjà reçu une réponse.',
        noFile: 'Ce fichier ne peut pas être envoyé ici ; envoyez-le depuis l’ordinateur.',
        greeting: `Bonjour, je suis ${values.name}.`,
        question: `${values.bot} demande : `,
        approval: `${values.bot} demande une approbation : `,
        secretAsk: `${values.bot} a besoin de la clé ${values.name} — renseignez-la sur l’ordinateur ou l’application mobile.`,
        viewShow: `${values.bot} a partagé une carte — répondez-y sur l’ordinateur ou l’application mobile.`,
        answered: 'répondu',
        numbers: 'répondez avec le numéro',
        numbersMulti: 'répondez avec les numéros séparés par des espaces',
        quoteEarlier: 'Réponse à un message précédent : ',
        quoteMissing: 'Réponse à un message précédent (son texte n’est pas disponible).',
        allow: 'Autoriser une fois',
        reject: 'Refuser',
      },
      de: {
        requested: 'Eine Verbindungsanfrage wurde an DS Bot gesendet; erlaube sie am Computer unter Einstellungen → IM.',
        unbound: 'Dieser IM-Bot ist noch keinem Bot zugewiesen; wähle einen in den DS Bot-Einstellungen → IM.',
        unboundGroup: 'Diese Gruppe ist noch nicht zugewiesen; wähle eine Gruppe oder einen Bot in den DS Bot-Einstellungen → IM.',
        connected: `Verbunden — du kannst jetzt mit ${values.target} sprechen.`,
        stopped: 'Gestoppt.',
        idle: 'Aktuell läuft nichts.',
        stale: 'Diese Karte wurde bereits beantwortet.',
        noFile: 'Diese Datei kann hier nicht gesendet werden; sende sie am Computer.',
        greeting: `Hallo, ich bin ${values.name}.`,
        question: `${values.bot} fragt: `,
        approval: `${values.bot} bittet um Freigabe: `,
        secretAsk: `${values.bot} benötigt den Schlüssel ${values.name} — gib ihn am Computer oder in der Smartphone-App ein.`,
        viewShow: `${values.bot} hat eine Karte geteilt — beantworte sie am Computer oder in der Smartphone-App.`,
        answered: 'beantwortet',
        numbers: 'mit der Nummer antworten',
        numbersMulti: 'mit durch Leerzeichen getrennten Nummern antworten',
        quoteEarlier: 'Antwort auf eine frühere Nachricht: ',
        quoteMissing: 'Antwort auf eine frühere Nachricht (ihr Text ist nicht verfügbar).',
        allow: 'Einmal erlauben',
        reject: 'Ablehnen',
      },
    }
    return (table[lang] ?? table.en)[key] ?? key
  }

  // ---------------------------------------------------------------- runtime file
  const runtimes = new Map() // id → { data: {runtime, cards, sent}, timer }
  const resendCards = new WeakSet()
  const runtimeOf = async (id) => {
    let held = runtimes.get(id)
    if (held !== undefined) return held
    let data
    try {
      data = JSON.parse(await readFile(join(imDir, `${id}.json`), 'utf8'))
    } catch { data = undefined }
    const cards = data?.cards !== null && typeof data?.cards === 'object' ? data.cards : {}
    let viewCodeSeq = Number.isSafeInteger(data?.viewCodeSeq) && data.viewCodeSeq > 0 ? data.viewCodeSeq : 0
    const previousCodes = Object.values(data?.viewCodes ?? {}).flat().concat(Object.values(data?.viewCodeHighWater ?? {}))
    for (const number of previousCodes) {
      if (!Number.isSafeInteger(number) || number < 1) continue
      viewCodeSeq = Math.max(viewCodeSeq, number)
    }
    for (const entries of Object.values(cards)) {
      for (const entry of entries) {
        const code = /^V([1-9]\d*)$/.exec(entry.code ?? '')
        const number = code === null ? 0 : Number(code[1])
        if (code !== null && Number.isSafeInteger(number)) {
          viewCodeSeq = Math.max(viewCodeSeq, number)
        }
        const incomplete = entry.delivered === false || entry.delivered !== true && entry.messageId === undefined
        if (code !== null && entry.answer === undefined && (entry.replyVersion !== VIEW_REPLY_VERSION || incomplete)) resendCards.add(entry)
      }
    }
    const hasLegacyCutoff = Number.isSafeInteger(data?.legacyViewCodeCutoff) && data.legacyViewCodeCutoff >= 0
    held = {
      data: {
        runtime: data?.runtime !== null && typeof data?.runtime === 'object' ? data.runtime : {},
        cards,
        sent: data?.sent !== null && typeof data?.sent === 'object' ? data.sent : {},
        viewCodeSeq,
        legacyViewCodeCutoff: hasLegacyCutoff ? data.legacyViewCodeCutoff : viewCodeSeq,
      },
      timer: undefined,
    }
    runtimes.set(id, held)
    if (!hasLegacyCutoff) await writeRuntime(id)
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
  const writeRuntime = (id) => {
    const held = runtimes.get(id)
    if (held === undefined || rt.readOnly() !== undefined) return Promise.resolve()
    held.write = (held.write ?? Promise.resolve()).catch(() => {}).then(() => persistRuntime(id, held))
    return held.write
  }
  const persistRuntime = async (id, held) => {
    await mkdir(imDir, { recursive: true })
    const temp = join(imDir, `${id}.${process.pid}.tmp`)
    // `sent` only exists for platforms that can quote (weixin): a runtime file
    // with no recorded messages is written exactly like an older one, without
    // the empty object. Reading still defaults a missing `sent` to {}.
    const { runtime, cards, sent } = held.data
    const data = Object.keys(sent).length > 0 ? { runtime, cards, sent } : { runtime, cards }
    if (held.data.viewCodeSeq > 0) data.viewCodeSeq = held.data.viewCodeSeq
    data.legacyViewCodeCutoff = held.data.legacyViewCodeCutoff
    try {
      await writeFile(temp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
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
  // The connection runtime file: adapter state, the sent cards and, on platforms
  // that quote, the messages last sent to each chat. Written as one file, so it
  // all has to stay small.
  const dataOf = async (id) => (await runtimeOf(id)).data
  // Sent cards: cardKey → [{ chatKey, messageId, answer? }]. Persisted so a restart
  // does not send a card twice; an `answer` marks it settled from this side.
  const markCard = async (id, cardKey, chatKey, messageId, body) => {
    const data = await dataOf(id)
    const entries = data.cards[cardKey] ?? []
    const held = entries.find(entry => entry.chatKey === chatKey)
    if (held !== undefined) {
      held.messageId = messageId ?? held.messageId
      held.text = body ?? held.text
      held.delivered = true
    } else {
      entries.push({ chatKey, messageId, text: body })
    }
    data.cards[cardKey] = entries
    scheduleWrite(id)
    if (held?.code !== undefined) await writeRuntime(id)
  }
  const unmarkCard = async (id, cardKey, chatKey) => {
    const data = await dataOf(id)
    const entries = data.cards[cardKey]
    if (entries === undefined) return
    const kept = entries.filter(entry => entry.chatKey !== chatKey)
    if (kept.length === entries.length) return
    if (kept.length === 0) delete data.cards[cardKey]
    else data.cards[cardKey] = kept
    scheduleWrite(id)
  }
  const settleCard = async (id, cardKey, answer) => {
    const data = await dataOf(id)
    const entries = data.cards[cardKey]
    if (entries === undefined) return
    for (const entry of entries) entry.answer ??= answer
    scheduleWrite(id)
  }
  // What was sent to a chat, by the ids the platform gave back: a quoted reply
  // names one of those ids, and the Bot has to see the message it answers. A
  // long reply goes out as several platform messages with an id each, so a
  // platform that reports them gets one entry per part — quoting a later chunk
  // then shows that chunk, not the start of the reply. The reply can come long
  // after the send, so this lives in the runtime file.
  const rememberSent = async (id, chatKey, text, sent) => {
    const parts = Array.isArray(sent?.parts) && sent.parts.length > 0
      ? sent.parts
      : [{ ids: [sent?.messageId, ...(Array.isArray(sent?.ids) ? sent.ids : [])], text }]
    const at = Date.now()
    const entries = []
    for (const part of parts) {
      const ids = []
      for (const value of Array.isArray(part?.ids) ? part.ids : []) {
        const one = String(value ?? '').trim().slice(0, SENT_ID_LEN)
        if (one !== '' && !ids.includes(one)) ids.push(one)
        if (ids.length >= SENT_ID_LIMIT) break
      }
      const body = String(part?.text ?? '').slice(0, SENT_TEXT_LIMIT).trim()
      if (ids.length === 0 || body === '') continue
      entries.push({ ids, text: body, at })
    }
    if (entries.length === 0) return
    const data = await dataOf(id)
    const kept = data.sent[chatKey] ?? []
    data.sent[chatKey] = [...kept, ...entries].slice(-SENT_KEEP)
    capSentStore(data.sent)
    scheduleWrite(id)
  }
  // The runtime file is one blob, so bound the whole sent store, not just each
  // chat's list. Collect every entry with its age and drop the oldest first —
  // a chat's last message is the one a quoted reply is most likely to name, so
  // it must survive even when older chats have to go. A single entry is already
  // bounded above (text, id count and id length), so the store always converges.
  const capSentStore = (sent) => {
    let size = JSON.stringify(sent).length
    if (size <= SENT_STORE_LIMIT) return
    const byAge = []
    for (const [chatKey, list] of Object.entries(sent)) {
      if (!Array.isArray(list)) continue
      for (const entry of list) byAge.push({ chatKey, entry, age: Number(entry?.at) || 0 })
    }
    byAge.sort((a, b) => a.age - b.age)
    for (const { chatKey, entry } of byAge) {
      if (size <= SENT_STORE_LIMIT) break
      const list = sent[chatKey]
      const at = list.indexOf(entry)
      if (at === -1) continue
      list.splice(at, 1)
      size = JSON.stringify(sent).length
    }
    for (const [chatKey, list] of Object.entries(sent)) {
      if (Array.isArray(list) && list.length === 0) delete sent[chatKey]
    }
  }
  // The text a quoted reply answers: the first of its ids that names a message
  // this chat sent, else the text the platform kept of that message. An id only
  // ever matches a message this connection actually sent there, so a wrong one
  // cannot pull in another chat's text.
  const quotedText = async (conn, chatKey, quote) => {
    const ids = (Array.isArray(quote?.ids) ? quote.ids : [])
      .map(value => String(value ?? '').trim()).filter(value => value !== '')
    if (ids.length > 0) {
      const data = await dataOf(conn.id)
      const entries = data.sent[chatKey] ?? []
      for (const id of ids) {
        const found = entries.find(entry => entry.ids.includes(id))
        if (found !== undefined) return found.text
      }
    }
    return typeof quote?.text === 'string' ? quote.text.trim() : ''
  }
  // Several answers in a row look alike; the quoted message is what tells the
  // Bot which one the user means. Shown as a Markdown quote ahead of the reply.
  const composeQuoted = (body, quoted) => {
    const full = String(quoted).trim()
    const shown = full.length > QUOTE_LIMIT ? `${full.slice(0, QUOTE_LIMIT)}…` : full
    const head = shown === ''
      ? text('quoteMissing')
      : `${text('quoteEarlier')}\n${shown.split('\n').map(line => (line === '' ? '>' : `> ${line}`)).join('\n')}`
    return body === '' ? head : `${head}\n\n${body}`
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
  // The reason a request failed, with the chain under it: `fetch failed` alone
  // hides the DNS, TLS or connection error that the user needs (#1120).
  const reasonOf = (error) => {
    const parts = []
    for (let at = error, depth = 0; at !== undefined && at !== null && depth < 4; at = at.cause, depth += 1) {
      const text = typeof at === 'string' ? at : at?.message
      if (typeof text === 'string' && text.trim() !== '' && !parts.includes(text.trim())) parts.push(text.trim())
    }
    return parts.length === 0 ? 'The connection failed' : parts.join(': ')
  }

  // The reason can quote the request URL, and a platform URL carries the token:
  // keep the secret field values, also as they appear in a URL, out of the text before it
  // reaches the UI or the log.
  const scrub = (text, fields, platform) => {
    let out = text
    for (const field of platform.fields) {
      const value = fields[field.key]
      if (!field.secret || typeof value !== 'string' || value.length < 4) continue
      for (const form of new Set([value, encodeURIComponent(value)])) out = out.split(form).join('***')
    }
    return out
  }
  const checkAccount = async (platform, fields, env) => {
    try {
      return await adapters[platform.id].check(fields, env)
    } catch (error) {
      throw new Error(scrub(rt.redactSecrets(reasonOf(error)), fields, platform))
    }
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
  /** @type {Map<string, {handle:any, queues:Map<string, {jobs:any[], retry?:any}>}>} */
  const runners = new Map()
  const statuses = new Map()
  /** @type {Map<string, Map<string, {state:string, error?:string, at:number}>>} */
  const sendStatuses = new Map()
  const failedSends = new Map()
  const pendingSends = new Map()
  const setPendingSend = (id, chatKey, entry) => {
    let chats = pendingSends.get(id)
    if (chats === undefined) pendingSends.set(id, chats = new Map())
    chats.set(chatKey, entry)
  }
  const clearPendingSend = (id, chatKey, entry) => {
    if (entry === undefined) return
    const chats = pendingSends.get(id)
    if (chats?.get(chatKey) === entry) {
      chats.delete(chatKey)
      if (chats.size === 0) pendingSends.delete(id)
    }
    entry.resolve()
  }
  const failedFor = (id, chatKey) => {
    let chats = failedSends.get(id)
    if (chats === undefined) failedSends.set(id, chats = new Map())
    let jobs = chats.get(chatKey)
    if (jobs === undefined) chats.set(chatKey, jobs = [])
    return jobs
  }
  const setStatus = (id, next) => {
    // Adapter errors can echo platform responses that quote the token; keep them out of the UI and logs.
    if (typeof next.error === 'string' && next.error !== '') return statuses.set(id, { ...next, error: rt.redactSecrets(next.error), at: Date.now() })
    return statuses.set(id, { ...next, at: Date.now() })
  }
  const setSendStatus = (id, chatKey, next) => {
    if (next === undefined) {
      const byChat = sendStatuses.get(id)
      if (byChat === undefined) return
      byChat.delete(chatKey)
      if (byChat.size === 0) sendStatuses.delete(id)
      return
    }
    let byChat = sendStatuses.get(id)
    if (byChat === undefined) sendStatuses.set(id, byChat = new Map())
    const error = typeof next.error === 'string' && next.error !== '' ? rt.redactSecrets(next.error) : next.error
    byChat.set(chatKey, { ...next, error, at: Date.now() })
  }
  const combinedStatus = (id) => {
    const adapter = statuses.get(id)
    if (adapter?.state === 'error' || adapter?.state === 'off') return adapter
    const byChat = sendStatuses.get(id)
    if (byChat !== undefined && byChat.size > 0) {
      let picked
      for (const entry of byChat.values()) {
        if (picked === undefined || (picked.state !== 'error' && entry.state === 'error') || (picked.state === entry.state && entry.at > picked.at)) {
          picked = entry
        }
      }
      if (picked !== undefined && (picked.state === 'error' || adapter === undefined || adapter.state === 'ready' || adapter.state === 'connecting')) {
        return picked
      }
    }
    return adapter
  }
  const targetsOf = (conn) => {
    const out = []
    for (const [chatKey, chat] of Object.entries(conn.chats ?? {})) {
      const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
      out.push({ chatKey, chat, target })
    }
    return out
  }

  // ------------------------------------------------------------ reply origin
  // A reply leaves the app only for the chat that asked for the turn that produced it.
  // An IM message starts a turn carrying the request it came in on; every other way a
  // turn starts — the Web UI, a peer Bot's message, a scheduled task, work picked up
  // after a restart — has no IM origin, and its replies, views and cards stay in the app.
  // Nothing is persisted: after a restart there is no origin, so nothing goes out. A
  // Bot's origin lives until its turn ends, a conflicting IM source joins it, or a
  // background result with no known owner enters it. A group's own Session ends its
  // relay turn at once while its members keep working, so its origin lives until a
  // new round starts in the group or the user is unpaired. A request lives until its
  // message is admitted, however long it waits in the queue behind a busy Bot.
  const paired = (conn, senderId) => (conn.paired ?? []).some(entry => entry.id === senderId)
  // Session id → the chat its running turn came from.
  const origins = new Map()
  const mixed = new Set()

  // The target a chat currently points at, as a comparable string. A direct chat falls
  // back to the connection's Bot; an unbound group chat has no target.
  const bindingOf = (conn, chatKey) => {
    const chat = conn?.chats?.[chatKey]
    if (chat === undefined) return undefined
    const target = chat.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
    if (target?.botId !== undefined) return `bot:${target.botId}`
    if (target?.roomId !== undefined) return `room:${target.roomId}`
    return undefined
  }
  // Turns that may be a member's late result waking a group up again: wait for the first
  // message of the turn before dropping the chat's origin (see the turn/start handler).
  const pendingReset = new Set()
  // Request id of an IM message → the chat it came from, until that message shows up.
  const requests = new Map()
  const consumedRequests = new Set()
  const withheldOrigins = new Map()
  // IM origin held across a part switch until the resumed/handoff message opens.
  const resumedOrigins = new Map()
  const holdImOrigin = (sessionId) => {
    if (sessionId === undefined || mixed.has(sessionId)) return undefined
    const entry = origins.get(sessionId)
    if (entry === undefined) return undefined
    const token = randomUUID()
    resumedOrigins.set(token, { ...entry, activeOn: sessionId })
    return token
  }
  const captureImOrigin = (sessionId) => {
    if (sessionId === undefined || mixed.has(sessionId)) return undefined
    const entry = origins.get(sessionId)
    if (entry === undefined) return undefined
    return { connId: entry.connId, chatKey: entry.chatKey, senderId: entry.senderId, ...(entry.binding !== undefined ? { binding: entry.binding } : {}) }
  }
  const originFromSaved = (entry) => {
    if (entry?.connId === undefined || entry?.chatKey === undefined) return undefined
    const conn = Object.values(connections()).find(item => item.id === entry.connId)
    if (conn === undefined || !runners.has(conn.id)) return undefined
    if (entry.senderId !== undefined && !paired(conn, entry.senderId)) return undefined
    const chat = conn.chats?.[entry.chatKey]
    if (chat === undefined) return undefined
    if (entry.binding === undefined || bindingOf(conn, entry.chatKey) !== entry.binding) return undefined
    return { conn, chatKey: entry.chatKey, chat }
  }
  const peekImOrigin = (sessionId, token) => {
    const entry = token === undefined ? undefined : resumedOrigins.get(token)
    if (entry === undefined) return
    claimOrigin(sessionId, entry.connId, entry.chatKey, entry.senderId, entry.binding)
    if (!mixed.has(sessionId)) entry.activeOn = sessionId
  }
  const dropImOrigin = (token) => {
    if (token !== undefined) resumedOrigins.delete(token)
  }
  const detachHeldOrigin = (sessionId) => {
    for (const held of resumedOrigins.values()) if (held.activeOn === sessionId) held.activeOn = undefined
  }
  const claimOrigin = (sessionId, connId, chatKey, senderId, binding) => {
    if (sessionId === undefined || connId === undefined) return
    if (mixed.has(sessionId)) {
      if (!withheldOrigins.has(sessionId)) withheldOrigins.set(sessionId, false)
      return
    }
    const previous = origins.get(sessionId)
    if (previous !== undefined && (previous.connId !== connId || previous.chatKey !== chatKey || previous.senderId !== senderId)) {
      dropOrigin(sessionId)
      return
    }
    for (const [token, held] of resumedOrigins) {
      if (held.activeOn === sessionId && (held.connId !== connId || held.chatKey !== chatKey || held.senderId !== senderId)) {
        resumedOrigins.delete(token)
      }
    }
    let bound = binding
    if (bound === undefined) {
      const conn = Object.values(connections()).find(item => item.id === connId)
      bound = conn === undefined ? undefined : bindingOf(conn, chatKey)
    }
    origins.set(sessionId, { connId, chatKey, senderId, binding: bound, at: Date.now() })
  }
  const forgetHeldOrigins = (sessionId) => {
    for (const [token, held] of resumedOrigins) if (held.activeOn === sessionId) resumedOrigins.delete(token)
  }
  const dropOrigin = (sessionId) => {
    if (origins.has(sessionId) && !withheldOrigins.has(sessionId)) withheldOrigins.set(sessionId, false)
    origins.delete(sessionId)
    mixed.add(sessionId)
    forgetHeldOrigins(sessionId)
  }
  const resetOrigin = (sessionId) => {
    origins.delete(sessionId)
    mixed.delete(sessionId)
    withheldOrigins.delete(sessionId)
  }
  const warnWithheldOrigin = (sessionId) => {
    if (withheldOrigins.get(sessionId) !== false) return
    withheldOrigins.set(sessionId, true)
    rt.warn('ds-bot: IM reply withheld: turn origin was dropped or mixed')
  }
  const clearImOrigin = (sessionId) => {
    resetOrigin(sessionId)
    detachHeldOrigin(sessionId)
  }
  /**
   * The connection and chat a Session's replies go to, or undefined when nothing may
   * leave: no origin, its connection gone, its chat gone, the user who asked no longer
   * paired, or the chat no longer pointing at the target whose turn asked. A card goes
   * out on this connection alone.
   */
  const originOf = (sessionId) => {
    const entry = sessionId === undefined ? undefined : origins.get(sessionId)
    if (entry === undefined) return undefined
    const conn = Object.values(connections()).find(item => item.id === entry.connId)
    if (conn === undefined || !runners.has(conn.id)) return undefined
    if (entry.senderId !== undefined && !paired(conn, entry.senderId)) return undefined
    const chat = conn.chats?.[entry.chatKey]
    if (chat === undefined) return undefined
    // The chat may have been unbound or pointed at another Bot or group while the work
    // it started keeps running; that work's late lines must not follow the old origin.
    if (entry.binding === undefined || bindingOf(conn, entry.chatKey) !== entry.binding) return undefined
    return { conn, chatKey: entry.chatKey, chat, senderId: entry.senderId, binding: entry.binding }
  }
  rt.roomHasImOrigin = roomId => originOf(rt.roomOf(roomId)?.sessionId ?? roomId) !== undefined
  const cardOrigin = (sessionId, card) => {
    const owner = rt.groupOwners.get(sessionId)
    if (owner === undefined) {
      if (mixed.has(sessionId)) return undefined
      return card.imOrigin === undefined ? originOf(sessionId) : originFromSaved(card.imOrigin)
    }
    const roomSid = rt.roomOf(owner.roomId)?.sessionId ?? owner.roomId
    if (mixed.has(roomSid)) return undefined
    return originFromSaved(card.imOrigin)
  }
  const canAnswerCard = (sessionId, card, conn, chat) => {
    if (!rt.groupOwners.has(sessionId) && card.imOrigin === undefined) return true
    const origin = cardOrigin(sessionId, card)
    return origin !== undefined && origin.conn.id === conn.id && origin.chatKey === chat.key
  }
  const rememberRequest = (requestId, conn, chatKey, senderId, roomCardOrigin) => {
    // The binding is captured when the message arrives, not when it is admitted: a chat
    // rebound while the message waits in the queue still answers the target that asked.
    requests.set(requestId, { connId: conn.id, chatKey, senderId, binding: bindingOf(conn, chatKey), at: Date.now(), ...(roomCardOrigin === undefined ? {} : { roomCardOrigin }) })
  }
  const restoreCardRoomOrigin = (sessionId, saved) => {
    const owner = rt.groupOwners.get(sessionId)
    if (owner === undefined || saved === undefined) return
    const room = rt.roomOf(owner.roomId)
    const roomSid = room?.sessionId ?? owner.roomId
    if (originFromSaved(saved) === undefined) {
      dropOrigin(roomSid)
      return
    }
    const live = origins.get(roomSid)
    if (live === undefined && !mixed.has(roomSid) && rt.roomActive?.(owner.roomId) !== true) {
      claimOrigin(roomSid, saved.connId, saved.chatKey, saved.senderId, saved.binding)
    } else if (live !== undefined && (live.connId !== saved.connId || live.chatKey !== saved.chatKey)) {
      dropOrigin(roomSid)
    }
  }
  // The Session a Bot writes into now, for a card that carries no Session of its own.
  const chatOfBot = botId => rt.botOf(botId) === undefined ? undefined : rt.chatOf(botId)
  // A card answered here continues that turn: its replies belong to this chat too.
  const claimChat = (conn, chat, senderId) => {
    const target = conn.chats?.[chat.key]?.target ?? (chat.kind === 'direct' ? { botId: conn.botId } : undefined)
    const sessionId = target?.roomId !== undefined ? (rt.roomOf(target.roomId)?.sessionId ?? target.roomId) : chatOfBot(target?.botId)
    claimOrigin(sessionId, conn.id, chat.key, senderId)
  }

  const failClass = (error) => {
    if (error?.permanent === true || (typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 429)) return 'permanent'
    if (error?.unknown === true || error?.stopped === true) return 'drop'
    return 'retry'
  }

  const enqueue = (conn, chatKey, job) => {
    const runner = runners.get(conn.id)
    if (runner === undefined) {
      void Promise.resolve(job.onDrop?.()).catch(() => {})
      return
    }
    let queue = runner.queues.get(chatKey)
    if (queue === undefined) runner.queues.set(chatKey, queue = { jobs: [] })
    job.attempts = 0
    queue.jobs.push(job)
    if (!queue.draining && queue.jobs.length === 1) void drain(conn, chatKey)
  }
  const failMessage = error => String(error?.message ?? error).slice(0, 300)
  const retainFailed = (id, chatKey, job, errorText, insertBefore) => {
    const list = failedFor(id, chatKey)
    const idx = insertBefore !== undefined ? list.indexOf(insertBefore) : -1
    if (idx !== -1) list.splice(idx, 0, job)
    else list.push(job)
    setSendStatus(id, chatKey, { state: 'error', error: errorText })
  }
  const clearSettledSendStatus = (id, chatKey, runner, settled) => {
    if (connections()[id] === undefined || (failedSends.get(id)?.get(chatKey)?.length ?? 0) > 0) return
    const current = runners.get(id)
    const activeDone = !runner.stopped && current === runner
    const waiterDone = settled?.waiter !== undefined && current === settled.waiter.runner && (current.queues.get(chatKey)?.jobs.length ?? 0) === 0
    if (activeDone || waiterDone) setSendStatus(id, chatKey, undefined)
  }
  const drain = async (conn, chatKey) => {
    const runner = runners.get(conn.id)
    const queue = runner?.queues.get(chatKey)
    // A reserved slot has no handle until connect() lands; start() re-kicks
    // anything queued in the meantime.
    if (runner?.handle === undefined || queue === undefined || queue.draining) return
    // Only a platform that hands back a quoted reply (the adapter's `quote`
    // flag, weixin today) needs what it sent kept; elsewhere the reply text
    // would sit in the runtime file and never be read.
    const remembersSent = adapters[conn.platform]?.quote === true
    clearTimeout(queue.retry)
    queue.retry = undefined
    queue.draining = true
    try {
      while (!runner.stopped && queue.jobs.length > 0) {
        const prior = pendingSends.get(conn.id)?.get(chatKey)
        if (prior !== undefined) {
          await prior.promise
          continue
        }
        const job = queue.jobs[0]
        queue.sending = true
        let sent
        try {
          if (job.image !== undefined) {
            if (typeof runner.handle.sendImage !== 'function') {
              throw Object.assign(new Error('This IM platform cannot send images'), { permanent: true })
            }
            sent = await runner.handle.sendImage(job.chat, job.image)
          } else {
            sent = await runner.handle.send(job.chat, job)
          }
        } catch (error) {
          queue.sending = false
          // A partial send (e.g. WeChat accepted earlier chunks before one failed)
          // carries the delivered parts on the error. Remember them so quoting a
          // delivered message still works, without treating the send as successful.
          if (remembersSent && Array.isArray(error?.parts) && error.parts.length > 0) {
            await rememberSent(conn.id, chatKey, job.text, { parts: error.parts }).catch(e => rt.warn('ds-bot: im partial sent message not remembered: %s', e))
          }
          const settled = queue.stoppedSend
          queue.stoppedSend = undefined
          const how = failClass(error)
          if (runner.stopped || connections()[conn.id] === undefined) {
            queue.jobs.shift()
            const waiter = settled?.waiter
            const replay = waiter !== undefined && !waiter.runner.stopped && runners.get(conn.id) === waiter.runner ? waiter : undefined
            if (connections()[conn.id] === undefined || stopped || how === 'drop') {
              await Promise.resolve(job.onDrop?.()).catch(() => {})
              clearSettledSendStatus(conn.id, chatKey, runner, settled)
              clearPendingSend(conn.id, chatKey, settled)
            } else if (replay !== undefined) {
              let nextQueue = replay.runner.queues.get(chatKey)
              if (nextQueue === undefined) replay.runner.queues.set(chatKey, nextQueue = { jobs: [] })
              job.attempts = 0
              nextQueue.jobs.unshift(job)
              clearPendingSend(conn.id, chatKey, settled)
              if (!nextQueue.draining) void drain(replay.conn, chatKey)
            } else {
              retainFailed(conn.id, chatKey, job, failMessage(error), settled?.firstRetained ?? queue.firstRetained)
              clearPendingSend(conn.id, chatKey, settled)
            }
            break
          }
          if (how === 'retry') {
            job.attempts += 1
            if (job.attempts < SEND_ATTEMPTS) {
              const backoff = Math.min(RETRY_MS * 2 ** (job.attempts - 1), RETRY_MAX_MS)
              const asked = Number(error?.retryAfter) > 0 ? Math.min(error.retryAfter * 1000, RETRY_MAX_MS) : backoff
              setSendStatus(conn.id, chatKey, { state: 'retrying', error: failMessage(error) })
              queue.retry = setTimeout(() => { void drain(conn, chatKey) }, asked)
              queue.retry.unref?.()
              return
            }
            // A failed job keeps its delivery callback: Try again resumes the same
            // message and card instead of dropping it or creating a second card.
            queue.jobs.shift()
            retainFailed(conn.id, chatKey, job, `Send failed after ${job.attempts} attempts: ${failMessage(error)}`)
            rt.warn('ds-bot: im send to %s failed after %d attempts: %s', chatKey, job.attempts, failMessage(error))
            continue
          }
          queue.jobs.shift()
          if (how === 'permanent') {
            retainFailed(conn.id, chatKey, job, failMessage(error))
            rt.warn('ds-bot: im send to %s failed: %s', chatKey, failMessage(error))
          } else {
            await Promise.resolve(job.onDrop?.()).catch(() => {})
            clearSettledSendStatus(conn.id, chatKey, runner, undefined)
          }
          continue
        }
        queue.sending = false
        queue.jobs.shift()
        // Failing to remember the message must not look like a failed send: it
        // would be retried and the chat would get the message twice.
        if (remembersSent) {
          await rememberSent(conn.id, chatKey, job.text, sent).catch(error => rt.warn('ds-bot: im sent message not remembered: %s', error))
        }
        const settled = queue.stoppedSend
        queue.stoppedSend = undefined
        if (connections()[conn.id] !== undefined) {
          await Promise.resolve(job.after?.(sent)).catch(error => rt.warn('ds-bot: im card delivery not remembered: %s', error))
        }
        clearSettledSendStatus(conn.id, chatKey, runner, settled)
        clearPendingSend(conn.id, chatKey, settled)
        if (runner.stopped || runners.get(conn.id) !== runner) break
      }
    } finally {
      queue.sending = false
      queue.draining = false
    }
  }
  // Per-chat staging chain: keeps async local-image resolution ordered ahead of
  // subsequent replies and cards on the same chat without delaying plain-text sends.
  const outboundStages = new Map()
  const afterStage = (conn, chatKey, run) => {
    const stageKey = `${conn.id}:${chatKey}`
    const prev = outboundStages.get(stageKey) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(run)
    outboundStages.set(stageKey, next)
    const cleanup = () => { if (outboundStages.get(stageKey) === next) outboundStages.delete(stageKey) }
    next.then(cleanup, cleanup)
    return next
  }
  const enqueueAfterStage = (conn, chatKey, job) => {
    const stageKey = `${conn.id}:${chatKey}`
    if (!outboundStages.has(stageKey)) {
      enqueue(conn, chatKey, job)
      return
    }
    const runner = runners.get(conn.id)
    afterStage(conn, chatKey, () => {
      const liveConn = fresh(conn.id)
      if (stopped || liveConn === undefined || runners.get(conn.id) !== runner || runner?.stopped) {
        void Promise.resolve(job.onDrop?.()).catch(() => {})
        return
      }
      enqueue(liveConn, chatKey, job)
    })
  }
  const sendText = (conn, chat, body, buttons, after) => enqueueAfterStage(conn, chat.key, { chat, text: body, buttons, after })
  const sendTo = (conn, chatKey, chat, body, buttons, after) => enqueueAfterStage(conn, chatKey, { chat, text: body, buttons, after })
  const originStillValid = (connId, chatKey, runner, senderId, binding) => {
    const liveConn = fresh(connId)
    if (stopped || liveConn === undefined || runners.get(connId) !== runner || runner?.stopped) return undefined
    if (senderId !== undefined && !paired(liveConn, senderId)) return undefined
    if (liveConn.chats?.[chatKey] === undefined) return undefined
    if (binding !== undefined && bindingOf(liveConn, chatKey) !== binding) return undefined
    return liveConn
  }
  const sendReply = (origin, body, { sessionId, botId, prefix = '' } = {}) => {
    const { conn, chatKey, chat, senderId, binding } = origin
    const where = { key: chatKey, kind: chat.kind, title: chat.title }
    const stageKey = `${conn.id}:${chatKey}`
    const runner = runners.get(conn.id)
    const maybeImages = typeof rt.mobileEndpoint === 'function'
      && (typeof runner?.handle?.sendImage === 'function' || runner?.handle === undefined)
      && extractLocalMarkdownImages(body).length > 0
    if (!maybeImages && !outboundStages.has(stageKey)) {
      enqueue(conn, chatKey, { chat: where, text: `${prefix}${body}` })
      return
    }
    afterStage(conn, chatKey, async () => {
      const before = originStillValid(conn.id, chatKey, runner, senderId, binding)
      if (before === undefined) return
      if (!maybeImages || typeof runner?.handle?.sendImage !== 'function') {
        enqueue(before, chatKey, { chat: where, text: `${prefix}${body}` })
        return
      }
      const prepared = await prepareOutboundReply(body, {
        resolveImage: (path) => rt.mobileEndpoint('markdown-image', {
          sessionId,
          ...(botId !== undefined ? { botId } : {}),
          path,
        }),
      })
      for (const failure of prepared.failed) {
        rt.warn('ds-bot: im outbound image %s skipped: %s', failure.path, failure.reason)
      }
      const liveConn = originStillValid(conn.id, chatKey, runner, senderId, binding)
      if (liveConn === undefined) return
      const fullText = prepared.text !== '' ? `${prefix}${prepared.text}` : (prepared.images.length > 0 && prefix !== '' ? prefix.trimEnd() : '')
      if (fullText !== '') enqueue(liveConn, chatKey, { chat: where, text: fullText })
      for (const image of prepared.images) enqueue(liveConn, chatKey, { chat: where, image })
    })
  }

  // ----------------------------------------------------------------- inbound
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

  const rememberWeixinRequest = async (conn, requestId, chatKey, senderId) => {
    // DSH can restore its queued prompt after a restart. Commit the route
    // before handing it the request so the two cannot be saved in the wrong order.
    const entry = { chatKey, senderId, binding: bindingOf(conn, chatKey), pairedAt: conn.paired?.find(peer => peer.id === senderId)?.at }
    const recent = conn.weixinRequests = { ...conn.weixinRequests, [requestId]: entry }
    const ids = Object.keys(recent)
    for (let i = 0; i < ids.length - WEIXIN_REQUESTS_KEEP; i++) delete recent[ids[i]]
    try {
      await rt.save({ required: true })
    } catch (error) {
      delete conn.weixinRequests[requestId]
      throw error
    }
  }

  const weixinRequestOf = (source, sessionId) => {
    const rpcId = source?.rpcId
    if (typeof rpcId !== 'string' || !rpcId.startsWith('im:weixin:') || source.kind !== 'user' || source.principal !== undefined) return undefined
    for (const conn of Object.values(connections())) {
      if (conn.platform !== 'weixin' || conn.enabled === false) continue
      const entry = rt.own(conn.weixinRequests, rpcId)
      if (entry?.binding === undefined || bindingOf(conn, entry.chatKey) !== entry.binding) continue
      if (!conn.paired?.some(peer => peer.id === entry.senderId && peer.at === entry.pairedAt)) continue
      const target = resolveTarget(conn, conn.chats[entry.chatKey])
      if (target === undefined) continue
      const targetSession = target.botId !== undefined ? chatOfBot(target.botId) : rt.sessionOfRoom(rt.roomOf(target.roomId))
      if (targetSession === sessionId && (entry.consumedOn === undefined || entry.consumedOn === sessionId)) return { conn, entry }
    }
    return undefined
  }

  // One card this chat was sent and has not answered yet. A button names its own
  // card, so it must never fall through to a newer card of the same kind.
  const openCard = (conn, chatKey, cardKey) => {
    const binding = bindingOf(conn, chatKey)
    if (binding === undefined) return undefined
    const entries = runtimes.get(conn.id)?.data?.cards[cardKey]
    const entry = entries?.find(item => item.chatKey === chatKey && item.answer === undefined
      && (item.binding ?? legacyCardBinding(cardKey)) === binding)
    return entry === undefined ? undefined : { cardKey, entry }
  }
  const questionById = (id) => {
    for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
      if (question.id === id) return { sessionId, question }
    }
    return undefined
  }
  const viewById = id => {
    for (const [sessionId, view] of Object.entries(state.views ?? {})) {
      if (view.id === id) return { sessionId, view }
    }
    return undefined
  }
  const legacyCardBinding = cardKey => {
    const id = cardKey.slice(2)
    const found = cardKey.startsWith('q:') ? questionById(id)
      : cardKey.startsWith('v:') ? viewById(id)
        : rt.approvalsView?.().find(entry => entry.id === id)
    const card = found?.question ?? found?.view ?? found
    const sessionId = found?.sessionId
    if (card === undefined || card.imOrigin !== undefined || card.roomId !== undefined || rt.groupOwners.has(sessionId)) return undefined
    const botId = rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId
    return botId === undefined ? undefined : `bot:${botId}`
  }
  const answerViewCard = async (conn, chat, cardKey, index, senderId) => {
    if (openCard(conn, chat.key, cardKey) === undefined) return false
    const found = viewById(cardKey.slice(2))
    if (found === undefined) {
      await sendCardReply(conn, chat, text('stale'))
      return 'stale'
    }
    const choice = imViewChoices(found.view.view)[index]
    if (choice === undefined || found.view.issueDraft !== undefined) return false
    return submitViewCard(conn, chat, cardKey, found, choice, senderId)
  }
  const submitViewCard = async (conn, chat, cardKey, found, choice, senderId) => {
    if (openCard(conn, chat.key, cardKey) === undefined || found.view.issueDraft !== undefined) return false
    if (!canAnswerCard(found.sessionId, found.view, conn, chat)) return false
    const requestId = `im:${conn.platform}:${randomUUID()}`
    rememberRequest(requestId, conn, chat.key, senderId, found.view.imOrigin)
    try {
      await rt.answerView(found.sessionId, found.view.id, choice.action, choice.values, requestId)
      await settleCard(conn.id, cardKey, choice.label)
      await settledEdits(conn)
    } catch (error) {
      requests.delete(requestId)
      if (error?.code === 'bot/stale') {
        await settleCard(conn.id, cardKey, text('answered'))
        await sendCardReply(conn, chat, text('stale'))
        await settledEdits(conn)
        return 'stale'
      }
      throw error
    }
    return 'answered'
  }
  const answerViewCode = async (conn, chat, body, senderId) => {
    if (!/^[!/]card\b/i.test(body)) {
      const legacy = /^(V([1-9]\d*))(?=\s|$)/i.exec(body)
      if (legacy === null || !isLegacyImViewFormAnswer(body.slice(legacy[0].length))) return false
      const data = await dataOf(conn.id)
      if (Number(legacy[2]) > data.legacyViewCodeCutoff) return false
      await sendCardReply(conn, chat, `Card replies now start with !card — use !card ${legacy[1].toUpperCase()} … on the refreshed card.`)
      return true
    }
    const command = /^(?:!card|\/card(?:@\S+)?)\s+(V[1-9]\d*)(?=\s|$)/i.exec(body)
    if (command === null) {
      await sendCardReply(conn, chat, 'Invalid card reply. Use !card <code> followed by your answer.')
      return true
    }
    const code = command[1].toUpperCase()
    const answer = body.slice(command[0].length).replace(/^[ \t]+/, '')
    const data = runtimes.get(conn.id)?.data
    const binding = bindingOf(conn, chat.key)
    const held = data === undefined ? undefined : Object.entries(data.cards).find(([key, entries]) => key.startsWith('v:') && entries.some(entry => entry.code === code && entry.chatKey === chat.key))
    if (held === undefined) {
      await sendCardReply(conn, chat, 'This card is no longer answerable in this chat.')
      return true
    }
    const delivery = held[1].find(entry => entry.code === code && entry.chatKey === chat.key)
    if (binding === undefined || delivery.binding !== binding) {
      await sendCardReply(conn, chat, 'This card is no longer answerable in this chat.')
      return true
    }
    const found = viewById(held[0].slice(2))
    if (found === undefined || openCard(conn, chat.key, held[0]) === undefined
      || found.view.issueDraft !== undefined || !canAnswerCard(found.sessionId, found.view, conn, chat)) {
      await sendCardReply(conn, chat, text('stale'))
      return true
    }
    const parsed = parseImViewForm(found.view.view, answer)
    if (parsed.error !== undefined) {
      await sendCardReply(conn, chat, `Invalid view answer: ${parsed.error.slice(0, 180)}`)
      return true
    }
    try {
      const answered = await submitViewCard(conn, chat, held[0], found, parsed, senderId)
      if (answered === false) await sendCardReply(conn, chat, text('stale'))
    } catch (error) {
      if (error?.code !== 'bot/invalid') throw error
      await sendCardReply(conn, chat, `Invalid view answer: ${String(error.message).slice(0, 180)}`)
    }
    return true
  }
  // 'answered': the answer continued the turn the chat claimed. 'stale': the card was
  // gone and only the stale text was sent, so this chat claims nothing. false: the pick
  // was not an answer to this card at all.
  const answerQuestionCard = async (conn, chat, cardKey, labels, senderId) => {
    const held = openCard(conn, chat.key, cardKey)
    if (held === undefined) return false
    const found = questionById(held.cardKey.slice(2))
    if (found === undefined) {
      await sendCardReply(conn, chat, text('stale'))
      return 'stale'
    }
    const valid = labels.filter(label => (found.question.options ?? []).some(option => option.label === label))
    if (valid.length === 0) return false
    if (!canAnswerCard(found.sessionId, found.question, conn, chat)) return false
    const requestId = `im:${conn.platform}:${randomUUID()}`
    rememberRequest(requestId, conn, chat.key, senderId, found.question.imOrigin)
    try {
      await rt.answerQuestion(found.sessionId, found.question.id, { selected: valid }, requestId)
      await settleCard(conn.id, held.cardKey, valid.join(', '))
      await settledEdits(conn)
    } catch (error) {
      requests.delete(requestId)
      if (error?.code === 'bot/stale') {
        await settleCard(conn.id, held.cardKey, text('answered'))
        await sendCardReply(conn, chat, text('stale'))
        await settledEdits(conn)
        return 'stale'
      }
      throw error
    }
    return 'answered'
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
        return 'stale'
      }
      throw error
    }
    return 'answered'
  }
  const sendCardReply = async (conn, chat, body) => sendText(conn, { key: chat.key, kind: chat.kind, title: chat.title }, body)

  // The chat's newest still-open card, questions and approvals together: a bare
  // number answers whatever arrived last, not always a question.
  const newestOpenCard = (conn, chatKey) => {
    const data = runtimes.get(conn.id)?.data
    if (data === undefined) return undefined
    for (const cardKey of Object.keys(data.cards).reverse()) {
      if (!cardKey.startsWith('q:') && !cardKey.startsWith('a:') && !cardKey.startsWith('v:')) continue
      const entry = openCard(conn, chatKey, cardKey)?.entry
      if (entry === undefined) continue
      if (entry.numbered ?? !cardKey.startsWith('v:')) return { cardKey, entry }
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
    const raw = String(msg.text ?? '')
    const body = raw.trim()
    const chat = conn.chats[msg.chat.key]
    const target = resolveTarget(conn, chat)
    if (await answerViewCode(conn, msg.chat, raw.trimStart(), msg.sender.id)) return
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
          if (inRange) {
            const answered = await answerQuestionCard(conn, msg.chat, held.cardKey, picked.map(index => options[index - 1].label), msg.sender.id)
            if (answered !== false) return
          }
        }
      } else if (held !== undefined && held.cardKey.startsWith('v:') && picked.length === 1) {
        const found = viewById(held.cardKey.slice(2))
        if (found !== undefined && imViewChoices(found.view.view)[picked[0] - 1] !== undefined) {
          const answered = await answerViewCard(conn, msg.chat, held.cardKey, picked[0] - 1, msg.sender.id)
          if (answered !== false) return
        }
      } else if (held !== undefined && held.cardKey.startsWith('a:')
        && picked.length === 1 && (picked[0] === 1 || picked[0] === 2)
        && rt.approvalsView().some(entry => `a:${entry.id}` === held.cardKey)) {
        const answered = await answerApprovalCard(conn, msg.chat, held.cardKey, picked[0] === 1 ? 'allow' : 'reject')
        if (answered === 'answered') claimChat(conn, msg.chat, msg.sender.id)
        if (answered !== false) return
      }
    }
    if (target === undefined) {
      await sendText(conn, msg.chat, text(msg.chat.kind === 'group' ? 'unboundGroup' : 'unbound'))
      return
    }
    const sessionId = target.botId ?? target.roomId
    // The receipt has to sit on the Session that takes the message. A group's own
    // Session moves on to a fresh part (`room.sessionId`) while `room.id` stays the
    // first one, so uploading under the id leaves the receipt on a Session the
    // message never reaches and DSH drops the file (#1121).
    const uploadTo = target.botId !== undefined
      ? rt.chatOf(target.botId)
      : rt.sessionOfRoom(rt.roomOf(target.roomId))
    const content = []
    // A quoted reply goes in as the quoted message, then what the user said:
    // commands above are read from the reply alone.
    const quoted = msg.quote === undefined ? undefined : await quotedText(conn, msg.chat.key, msg.quote)
    const said = quoted === undefined ? body : composeQuoted(body, quoted)
    if (said !== '') content.push({ type: 'text', text: said })
    for (const image of msg.images ?? []) content.push({ type: 'image', mediaType: image.mediaType, data: image.data })
    const env = await envFor(conn)
    for (const file of msg.files ?? []) {
      try {
        const receiptId = await env.uploadFile(uploadTo, file)
        content.push({ type: 'file', receiptId })
      } catch {
        await sendText(conn, msg.chat, text('noFile'))
      }
    }
    if (content.length === 0) return
    const requestId = `im:${conn.platform}:${randomUUID()}`
    // The turn this starts belongs to this chat: its replies go back here and nowhere else.
    if (conn.platform === 'weixin') await rememberWeixinRequest(conn, requestId, msg.chat.key, msg.sender.id)
    else rememberRequest(requestId, conn, msg.chat.key, msg.sender.id)
    await rt.sendUser({ sessionId, content, requestId })
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
      const answered = await answerQuestionCard(conn, chat, cardKey, [label], action.sender.id)
      if (answered === false) await sendCardReply(conn, chat, text('stale'))
      return
    }
    if (data.startsWith('v:') && cut > 2) {
      const answered = /^\d+$/.test(choice) && await answerViewCard(conn, chat, cardKey, Number(choice), action.sender.id)
      if (answered === false) await sendCardReply(conn, chat, text('stale'))
      return
    }
    if (data.startsWith('a:') && cut > 2) {
      if (choice === 'allow' || choice === 'reject') {
        const answered = await answerApprovalCard(conn, chat, cardKey, choice)
        if (answered === 'answered') claimChat(conn, chat, action.sender.id)
        else if (answered === false) await sendCardReply(conn, chat, text('stale'))
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

  const sendCard = async (conn, cardKey, targets, body, buttons, numbered = false, tokenView) => {
    const data = await dataOf(conn.id)
    if (!runners.has(conn.id)) return
    const entries = data.cards[cardKey] = (data.cards[cardKey] ?? []).filter(entry => entry.binding !== undefined && (tokenView === undefined || entry.code !== undefined))
    const recorded = new Set(entries.filter(entry => !resendCards.has(entry)).map(entry => entry.chatKey))
    const pending = targets.filter(({ chatKey }) => !recorded.has(chatKey))
    if (pending.length === 0) return
    // Reserve pending chats synchronously before enqueueing so concurrent diffs cannot double-send.
    for (const { chatKey } of pending) {
      const interrupted = entries.find(entry => entry.chatKey === chatKey && resendCards.has(entry))
      if (interrupted !== undefined) {
        resendCards.delete(interrupted)
        if (tokenView !== undefined) {
          const replaced = interrupted.replyVersion !== VIEW_REPLY_VERSION ? 'This card replaces the earlier reply instructions.\n' : ''
          interrupted.replyVersion = VIEW_REPLY_VERSION
          interrupted.delivered = false
          interrupted.text = `${replaced}${body}\n${imViewFormText(tokenView, interrupted.code)}`
        }
        continue
      }
      const code = tokenView === undefined ? undefined : `V${++data.viewCodeSeq}`
      const message = code === undefined ? body : `${body}\n${imViewFormText(tokenView, code)}`
      entries.push({ chatKey, binding: bindingOf(conn, chatKey), numbered, messageId: undefined, text: message, ...(code === undefined ? {} : { code, delivered: false, replyVersion: VIEW_REPLY_VERSION }) })
    }
    scheduleWrite(conn.id)
    if (tokenView !== undefined) {
      try {
        await writeRuntime(conn.id)
      } catch (error) {
        await Promise.all(pending.map(({ chatKey }) => unmarkCard(conn.id, cardKey, chatKey)))
        throw error
      }
    }
    for (const { chatKey, chat } of pending) {
      if (tokenView !== undefined) {
        const found = viewById(cardKey.slice(2))
        const origin = found === undefined ? undefined : cardOrigin(found.sessionId, found.view)
        if (origin?.conn.id !== conn.id || origin.chatKey !== chatKey || openCard(conn, chatKey, cardKey) === undefined) {
          await unmarkCard(conn.id, cardKey, chatKey)
          continue
        }
      }
      const message = entries.find(entry => entry.chatKey === chatKey).text
      enqueueAfterStage(conn, chatKey, {
        chat: { key: chatKey, kind: chat.kind, title: chat.title },
        text: message,
        buttons,
        after: (sent) => markCard(conn.id, cardKey, chatKey, sent?.messageId, message),
        onDrop: () => unmarkCard(conn.id, cardKey, chatKey),
      })
    }
  }

  const diffCards = async () => {
    if (rt.readOnly() !== undefined) return
    for (const conn of Object.values(connections())) {
      const runner = runners.get(conn.id)
      if (runner === undefined) continue
      await dataOf(conn.id)
      // Questions: one card per open question id, on the connection whose chat asked.
      for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
        const cardKey = `q:${question.id}`
        const owner = rt.groupOwners.get(sessionId)
        const botId = owner?.botId ?? rt.chatOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)?.botId
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        // A card follows its own turn: only the chat that asked for it gets one.
        const origin = cardOrigin(sessionId, question)
        if (origin === undefined || origin.conn.id !== conn.id) continue
        const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.question(question) : undefined
        await sendCard(conn, cardKey, [{ chatKey: origin.chatKey, chat: origin.chat }], cardText.question(bot.name, question), buttons, true)
      }
      // Approvals: one card per open approval id, resent to chats whose earlier send dropped.
      for (const entry of rt.approvalsView?.() ?? []) {
        const cardKey = `a:${entry.id}`
        const bot = rt.botOf(entry.botId)
        // A task approval belongs strictly to the IM chat that started that task (never fall back to an unrelated foreground IM chat).
        const origin = entry.taskId !== undefined
          ? originFromSaved(rt.taskById?.(entry.taskId)?.task?.imOrigin)
          : originOf(entry.roomId !== undefined ? (rt.roomOf(entry.roomId)?.sessionId ?? entry.roomId) : chatOfBot(entry.botId))
        if (origin === undefined || origin.conn.id !== conn.id) continue
        const targets = [{ chatKey: origin.chatKey, chat: origin.chat }]
        const buttons = imPlatform(conn.platform)?.buttons === true ? cardButtons.approval(entry.id) : undefined
        await sendCard(conn, cardKey, targets, cardText.approval(bot?.name ?? '?', entry), buttons, true)
      }
      // Secret requests: text only — the key is typed on the computer or phone.
      for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        for (const request of list) {
          const cardKey = `s:${request.id}`
          if (request.status !== 'pending') continue
          const origin = originOf(chatOfBot(botId))
          if (origin === undefined || origin.conn.id !== conn.id) continue
          await sendCard(conn, cardKey, [{ chatKey: origin.chatKey, chat: origin.chat }], text('secretAsk', { bot: bot.name, name: request.name }))
        }
      }
      // Simple views use buttons or numbers; forms use an explicit delivery code.
      for (const [sessionId, view] of Object.entries(state.views ?? {})) {
        const cardKey = `v:${view.id}`
        const owner = rt.groupOwners.get(sessionId)
        const botId = owner?.botId ?? rt.chatOwners.get(sessionId)
        const bot = rt.botOf(botId)
        if (bot === undefined) continue
        const origin = cardOrigin(sessionId, view)
        if (origin === undefined || origin.conn.id !== conn.id) continue
        const form = viewCardText({ title: view.title, view: view.view })
        const choices = view.issueDraft === undefined ? imViewChoices(view.view) : []
        const picks = choices.length === 0 ? '' : `\n${choices.map((choice, index) => `${index + 1}. ${choice.label}`).join('\n')}\n(${text('numbers')})`
        const buttons = imPlatform(conn.platform)?.buttons === true && choices.length > 0
          ? choices.map((choice, index) => ({ data: `v:${view.id}:${index}`, label: choice.label })) : undefined
        await sendCard(conn, cardKey, [{ chatKey: origin.chatKey, chat: origin.chat }], `${text('viewShow', { bot: bot.name })}${form !== '' ? `\n${form}` : view.title ? `\n${view.title}` : ''}${picks}`, buttons, choices.length > 0,
          view.issueDraft === undefined && choices.length === 0 ? view.view : undefined)
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
        const recentCode = entries.some(entry => entry.code !== undefined && Number(entry.code.slice(1)) > data.viewCodeSeq - RECENT_VIEW_CODES_KEEP)
        if (droppable && !recentCode) {
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
          for (const { chatKey, chat, target } of targetsOf(fresh(conn.id) ?? conn)) {
            if (target !== undefined && busyOf(target)) void runner.handle.typing({ key: chat.key ?? chatKey, kind: chat.kind, title: chat.title }).catch?.(() => {})
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
    if (runner === undefined) {
      sendStatuses.delete(id)
      if (statuses.get(id)?.state !== 'error') setStatus(id, { state: 'off', at: Date.now() })
      return
    }
    runner.stopped = true
    if (runner.typing !== undefined) clearInterval(runner.typing)
    const dropOnly = stopped || connections()[id] === undefined
    if (dropOnly) {
      sendStatuses.delete(id)
    } else {
      const failed = failedSends.get(id)
      const byChat = sendStatuses.get(id)
      if (byChat !== undefined) {
        for (const chatKey of byChat.keys()) {
          if ((failed?.get(chatKey)?.length ?? 0) === 0) byChat.delete(chatKey)
        }
        if (byChat.size === 0) sendStatuses.delete(id)
      }
    }
    const dropped = []
    for (const [chatKey, queue] of runner.queues) {
      clearTimeout(queue.retry)
      queue.retry = undefined
      const rest = queue.jobs.splice(queue.sending ? 1 : 0)
      const pending = pendingSends.get(id)?.get(chatKey)
      if (!dropOnly && queue.sending && queue.stoppedSend === undefined) {
        let resolve
        const promise = new Promise((done) => { resolve = done })
        queue.stoppedSend = { firstRetained: rest[0], promise, resolve }
        setPendingSend(id, chatKey, queue.stoppedSend)
      }
      if (rest.length === 0) continue
      if (dropOnly) {
        for (const job of rest) dropped.push(Promise.resolve(job.onDrop?.()).catch(() => {}))
        continue
      }
      const prevError = sendStatuses.get(id)?.get(chatKey)?.error
      queue.firstRetained = rest[0]
      if (pending !== undefined) pending.firstRetained ??= rest[0]
      failedFor(id, chatKey).push(...rest)
      setSendStatus(id, chatKey, { state: 'error', error: prevError || 'Stopped before delivery' })
    }
    await Promise.all(dropped)
    await Promise.resolve(runner.handle?.stop?.()).catch(() => {})
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
      for (const id of [...statuses.keys()]) if (conns[id] === undefined) { statuses.delete(id); sendStatuses.delete(id) }
      for (const conn of Object.values(conns)) {
        if (conn.enabled === false || !runners.has(conn.id)) {
          if (statuses.get(conn.id)?.state !== 'error') setStatus(conn.id, { state: 'off', at: Date.now() })
        }
      }
      await diffCards()
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
      const { account } = await checkAccount(platform, fields, env)
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
        const { account } = await checkAccount(platform, check, env)
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
      failedSends.delete(id)
      sendStatuses.delete(id)
      for (const entry of pendingSends.get(id)?.values() ?? []) entry.resolve()
      pendingSends.delete(id)
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
        const chatKey = String(body.chatKey ?? '')
        delete conn.chats[chatKey]
        // The messages kept for quoting belong to that chat only.
        const data = await dataOf(conn.id)
        if (data.sent[chatKey] !== undefined) {
          delete data.sent[chatKey]
          scheduleWrite(conn.id)
        }
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
      if (statuses.get(conn.id)?.state !== 'ready') {
        if (runners.has(conn.id)) await stop(conn.id)
        await sync()
      }
      if (!runners.has(conn.id)) return true
      const chats = failedSends.get(conn.id)
      failedSends.delete(conn.id)
      const runner = runners.get(conn.id)
      for (const [chatKey, pending] of pendingSends.get(conn.id) ?? []) {
        pending.firstRetained = undefined
        pending.waiter = { conn, runner }
        setSendStatus(conn.id, chatKey, { state: 'retrying' })
      }
      for (const [chatKey, jobs] of chats ?? []) {
        setSendStatus(conn.id, chatKey, { state: 'retrying' })
        for (const job of jobs) enqueue(conn, chatKey, job)
      }
      for (const [chatKey, queue] of runner?.queues ?? []) {
        if (queue.retry === undefined || queue.draining || queue.jobs.length === 0) continue
        clearTimeout(queue.retry)
        queue.retry = undefined
        queue.jobs[0].attempts = 0
        setSendStatus(conn.id, chatKey, { state: 'retrying' })
        void drain(conn, chatKey)
      }
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
    if (endpoint !== 'im-retry') void sync()
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
    if (event.type === 'turn/start') {
      const room = rt.roomOf(session.id)
      if (room === undefined) {
        resetOrigin(session.id)
      } else {
        const working = rt.roomActive?.(room.id)
          || [...rt.groupOwners].some(([id, owner]) => owner.roomId === room.id && rt.live.get(id)?.turn !== undefined)
          || [...rt.switchJobs()].some(job => job.roomId === room.id)
        // A group's own Session can start a turn for the last member's late result after
        // its relay turn ended, when no work looks active. Keep the origin until the
        // turn's first message says whether it continues the work the chat asked for.
        if (!working) pendingReset.add(session.id)
      }
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (typeof source?.rpcId === 'string' && consumedRequests.has(source.rpcId)) return
      const savedRequest = weixinRequestOf(source, session.id)
      if (savedRequest?.entry.consumedOn !== undefined) return
      // Pure context notice injected before the user's message on a newly forked foreground;
      // never touch pendingReset or drop/mix the IM origin for this turn.
      if (source?.kind === SOURCE_KIND && source.role === 'task-handoff') {
        // intentionally ignored
      } else {
        const imOrigin = source?.imOrigin
        const rpcId = source?.rpcId
        // A late member result, part-switch handoff, or task report continues the work the chat asked for;
        // any other first message starts a fresh turn, which clears the previous turn's origin.
        const isTaskReport = source?.kind === SOURCE_KIND && source.role === 'task-report' && typeof source.taskId === 'string'
        if (pendingReset.delete(session.id) && !(typeof imOrigin === 'string' || isTaskReport || (source?.kind === SOURCE_KIND && source.role === 'post'))) {
          forgetHeldOrigins(session.id)
          resetOrigin(session.id)
        }
        if (source?.kind === 'tool-jobs' || source?.kind === 'subagent-settled') {
          // A job notice has no launch ID; a child ID can be reused by another subagent run.
          dropOrigin(session.id)
          const member = rt.groupOwners.get(session.id)
          if (member !== undefined) {
            const roomSid = rt.sessionOfRoom(rt.roomOf(member.roomId))
            if (roomSid !== undefined) {
              pendingReset.delete(roomSid)
              dropOrigin(roomSid)
            }
          }
        } else if (typeof imOrigin === 'string') {
          const resumed = resumedOrigins.get(imOrigin)
          resumedOrigins.delete(imOrigin)
          if (resumed === undefined) dropOrigin(session.id)
          else claimOrigin(session.id, resumed.connId, resumed.chatKey, resumed.senderId, resumed.binding)
        } else if (isTaskReport) {
          // Resolve the persisted task.imOrigin directly so deferred redelivery (turns.js)
          // and post-restart resends (inflight.json) never lose the IM chat claim.
          // For group tasks, `onRoomLine` reads `originOf(room.sessionId)`, so restore onto
          // the group's own Session without clobbering an unrelated live group origin.
          const saved = rt.taskById?.(source.taskId)?.task?.imOrigin
          if (typeof source.roomId === 'string' && source.roomId !== '') {
            const room = rt.roomOf(source.roomId)
            const roomSid = room === undefined ? undefined : rt.sessionOfRoom(room)
            if (roomSid !== undefined && originFromSaved(saved) !== undefined) {
              const live = origins.get(roomSid)
              const activeRound = rt.roomActive?.(room.id) === true
              if (live === undefined && !activeRound && !mixed.has(roomSid)) {
                // Restore after restart even while sibling tasks run, but never reopen
                // an active non-IM round or a round blocked by conflicting IM claims.
                claimOrigin(roomSid, saved.connId, saved.chatKey, saved.senderId, saved.binding)
              } else if (live !== undefined && (live.connId !== saved.connId || live.chatKey !== saved.chatKey)) {
                // A different IM chat currently owns the room; mix so neither chat sees the other's report.
                dropOrigin(roomSid)
              }
            } else if (roomSid !== undefined && (saved !== undefined || origins.has(roomSid))) {
              dropOrigin(roomSid)
            }
          } else if (originFromSaved(saved) === undefined) {
            if (saved !== undefined) dropOrigin(session.id)
          } else {
            claimOrigin(session.id, saved.connId, saved.chatKey, saved.senderId, saved.binding)
          }
        } else if (typeof rpcId === 'string' && rpcId.startsWith('im:')) {
          if (Number.isInteger(event.seq)) imVia.set(session.id, { ...imVia.get(session.id), [event.seq]: rpcId.split(':')[1] })
          // Unknown requests cannot claim a chat. Consumed requests are ignored above,
          // including redelivery after their turn ended; they must not claim it again.
          const asked = requests.get(rpcId)
          requests.delete(rpcId)
          if (savedRequest !== undefined) {
            const { conn, entry } = savedRequest
            entry.consumedOn = session.id
            void rt.save().catch(() => {})
            claimOrigin(session.id, conn.id, entry.chatKey, entry.senderId, entry.binding)
          } else if (asked === undefined) dropOrigin(session.id)
          else {
            consumedRequests.add(rpcId)
            if (consumedRequests.size > CONSUMED_REQUESTS_KEEP) consumedRequests.delete(consumedRequests.values().next().value)
            restoreCardRoomOrigin(session.id, asked.roomCardOrigin)
            claimOrigin(session.id, asked.connId, asked.chatKey, asked.senderId, asked.binding)
          }
        } else {
          // Non-IM input can join the turn, but cannot claim or withdraw its IM chat.
        }
      }
    }
    if (event.type === 'turn/end') {
      // A group's own Session ends its relay turn at once while its members keep
      // working and post later; only a Bot's turn ending ends the chat's claim. A
      // pending reset means the turn never got a message to classify, so apply it now.
      if (rt.roomOf(session.id) === undefined) {
        resetOrigin(session.id)
        detachHeldOrigin(session.id)
      } else if (pendingReset.delete(session.id)) {
        resetOrigin(session.id)
      }
    }
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined || rt.taskOwners?.has(session.id)) {
      // A group's own chat has no Bot of its own (onRoomLine handles it), and a background
      // task reports back through its foreground chat rather than streaming raw lines to IM.
      imVia.delete(session.id)
      return
    }
    const origin = originOf(session.id)
    for (const item of rt.displayItems(session.id, [event])) {
      if (item.kind !== 'bot' && item.kind !== 'view') continue
      if (origin === undefined) {
        warnWithheldOrigin(session.id)
        continue
      }
      const body = item.kind === 'bot' ? item.text : viewCardText({ title: item.title, view: item.view }) || (item.title ?? '')
      sendReply(origin, body, { sessionId: session.id, botId })
    }
  })

  rt.onRoomLine((room, line) => {
    if (line.questionId !== undefined || line.viewId !== undefined) return
    if (line.botId === undefined || line.kind !== undefined || typeof line.text !== 'string' || line.text.trim() === '') return
    const roomSessionId = room.sessionId ?? room.id
    const origin = originOf(roomSessionId)
    if (origin === undefined) {
      warnWithheldOrigin(roomSessionId)
      return
    }
    sendReply(origin, line.text, { sessionId: roomSessionId, botId: line.botId, prefix: `**${line.who}**: ` })
  })

  rt.onApproval((kind, data) => {
    if (kind === 'open') {
      void (async () => {
        const sessionId = data.roomId !== undefined ? (rt.roomOf(data.roomId)?.sessionId ?? data.roomId) : chatOfBot(data.botId)
        const origin = data.taskId !== undefined
          ? originFromSaved(rt.taskById?.(data.taskId)?.task?.imOrigin)
          : originOf(sessionId)
        if (origin === undefined) return
        const bot = rt.botOf(data.botId)
        const buttons = imPlatform(origin.conn.platform)?.buttons === true ? cardButtons.approval(data.id) : undefined
        await sendCard(origin.conn, `a:${data.id}`, [{ chatKey: origin.chatKey, chat: origin.chat }], cardText.approval(bot?.name ?? '?', data), buttons, true)
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
      resumedOrigins.clear()
      return Promise.all([...runners.keys()].map(stop)).then(async () => {
        for (const held of runtimes.values()) if (held.timer !== undefined) clearTimeout(held.timer)
        await Promise.all([...runtimes.keys()].map(writeRuntime)).catch(() => {})
      })
    }
  }, 'ds-bot: im')

  const imView = () => ({ connections: Object.values(connections()).map(viewOf), platforms: IM_PLATFORMS.filter(platform => adaptersFor().includes(platform.id)).map(platform => platform.id) })
  const imStatusView = () => Object.fromEntries([...new Set([...statuses.keys(), ...sendStatuses.keys()])].map((id) => {
    const status = combinedStatus(id)
    return [id, { state: status.state, ...(status.error !== undefined ? { error: status.error } : {}), at: status.at }]
  }))

  Object.assign(rt, { imView, imStatusView, imViaView, imEndpoint, holdImOrigin, peekImOrigin, dropImOrigin, captureImOrigin, clearImOrigin })
}

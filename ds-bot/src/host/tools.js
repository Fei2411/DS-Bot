// Team tools: the roster, bot-to-bot delegations & notes, group chat settings and posts,
// and question/view cards. Backed by `rt.coordDb` + `rt.kickScheduler()` + D1/D4 adapter.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readAvatar } from './avatar.js'
import {
  CATALOG_PACK_TOOLS,
  COLORS,
  EXTRA_COLORS,
  GROUP_ONLY_TOOLS,
  MESSAGE_INLINE_MAX,
  ROOM_MODES,
  SOURCE_KIND,
  TASK_HIDDEN_TEAM_TOOLS,
  TEXT_KEPT,
} from './constants.js'
import { within } from './folders.js'
import { missingFileRefs } from './claims.js'
import { absoluteLinks } from './links.js'
import { NAME_MAX } from './requests.js'
import { roomNote, roomRequest, waitsOnMember } from './room-message.js'
import { unquote } from './text.js'
import { foregroundAddress, ownChatSessions } from './threads.js'
import { mentionSpans } from '../shared/mentions.js'
import { plainToolSchema } from './tool-schema.js'
import { viewCardText } from './parts.js'
import { checkShownView, showViewDescription, showViewParameters } from 'deep-view/core'
import { BUILTIN_PACKS, install as installBuiltinPacks } from './builtin-packs.js'

export const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
export const GROUP_REF = { type: 'string', required: true, description: 'Exact group chat name from list_bots' }
const BLOCKING_QUESTION_TOOL = 'ask_user_question'
const GOAL_TOOLS = ['create_goal', 'update_goal', 'get_goal']
const DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'ralph', 'spawn_teammate', 'wait_agent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']
const HIDDEN_TOOL_GROUPS = [[BLOCKING_QUESTION_TOOL, ...GOAL_TOOLS], DELEGATION_TOOLS]
const HIDDEN_TOOLS = HIDDEN_TOOL_GROUPS.flat()
const HIDDEN_SECTIONS = new Set([...HIDDEN_TOOLS.map(name => `tool:${name}`), 'tool:goal', 'team:policy'])
const GOAL_REFUSAL = 'Bot chats do not run /goal. To give a group a goal, use Set a goal in its + menu.'
const SCHEDULE_TARGET_TOOLS = ['schedule_create', 'schedule_edit']
const TASK_HIDDEN_GLOBAL_TOOLS = ['browser_handoff', ...SCHEDULE_TARGET_TOOLS]
const MAIN_ONLY_TOOLS = BUILTIN_PACKS['team-admin'].tools
const RELAY_ONLY_TOOL = 'group_relay'
const SCHEDULE_TARGET_REFUSAL = 'A Bot’s scheduled tasks run in its own chat. Use target "this_session".'
const SCHEDULE_UPDATE_FIELDS = new Set(['id', 'action', 'title', 'prompt', 'rrule', 'target', 'active', 'expectedUpdatedAt'])
const DELEGATION_REFUSAL = 'Bots do not start subagents, teammates or workflows. Do the work yourself, or delegate it to another Bot with delegate_work.'
const MODE_PARAM = {
  type: 'string',
  enum: ROOM_MODES,
  description: '"everyone": every member answers a plain message in turn, admin first. "admin" (the default): a plain message goes to the admin, who calls others with @Name. @mentions always choose who answers.',
}
const WORK_DIR_PARAM = { type: 'string', description: 'Full path of the folder to work in, where commands and file tools start. Only when the user asks for it' }
const EXTRA_DIRS_PARAM = { type: 'array', items: { type: 'string' }, description: 'Full paths of more folders to work in besides the working folder, such as other projects; the file tools change files there without asking again. Replaces the list; an empty list removes them. Only when the user asks for it' }
const SECTION_PARAM = { type: 'string', description: 'Sidebar section name to group Bots and group chats that work on the same project together; creates the section if it does not exist' }
const AVATAR_PARAM = {
  type: 'string',
  description: 'Profile picture: a local image path (a relative path starts in your working folder) or a data URL. PNG, JPEG, WebP, or GIF; square, 256x256 recommended, up to 120 KB. Images are not resized.',
}
const WORKING_DIRECTORY_TOOL = 'working_directory'

const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export function install(rt) {
  const { ctx, state } = rt
  installBuiltinPacks(rt)

  const hasCoordDb = () => rt.coordDb != null && !rt.coordDb.isClosed?.()
  const writableCoordDb = () => hasCoordDb() && rt.coordDb.readonly !== true && rt.readOnly?.() === undefined

  const yieldTurn = (exec, reason) => {
    if (typeof rt.yieldToolTurn === 'function') rt.yieldToolTurn(exec, reason)
    else exec.concludeTurn?.()
  }

  const callerBot = exec => rt.botOf(rt.selfOf(exec.agent?.id))
  // A photo the user names for a Bot or a group: the same input and checks either way, and
  // never a file out of a private Bot's folder, which no other Bot reads from.
  const readPhoto = (input, exec) => readAvatar(String(input), {
    baseDir: rt.sessionFolder?.(exec.agent?.session ?? exec.agent),
    isData: rt.inData,
    isClosed: path => rt.privateOwnerOf?.(path, { self: rt.selfOf(exec.agent?.id) }),
  })
  const callerRoom = (exec) => {
    const roomId = (rt.groupOwners.get(exec.agent?.id) ?? rt.pastOwners?.get(exec.agent?.id))?.roomId
    return roomId ? { fromRoomId: roomId } : {}
  }
  const callerPart = (exec) => {
    const sessionId = exec.agent?.id
    return sessionId === undefined || callerRoom(exec).fromRoomId !== undefined ? {} : { fromPart: sessionId }
  }
  const callerImOrigin = (exec) => {
    const sessionId = exec.agent?.id
    if (sessionId === undefined) return undefined
    const taskOrigin = rt.taskBySession?.(sessionId)?.task?.imOrigin
    if (taskOrigin !== undefined) return taskOrigin
    const owner = rt.groupOwners.get(sessionId)
    if (owner !== undefined) {
      const room = rt.roomOf(owner.roomId)
      return room === undefined ? undefined : rt.captureImOrigin?.(rt.sessionOfRoom(room))
    }
    return rt.captureImOrigin?.(sessionId)
  }

  const sectionNameOf = id => (state.sections ?? []).find(sec => sec.id === id)?.name

  const roomLine = (room, self) => {
    const members = room.members.map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${bot.id === room.admin ? ' (admin)' : ''}${bot.id === self ? ' (you)' : ''}`)
    const section = sectionNameOf(room.sectionId)
    const parts = [
      `members: ${members.join(', ')}`,
      section ? `section: ${section}` : '',
      room.mode === 'admin' && room.admin ? 'plain messages go to the admin first' : 'every member replies in turn',
      room.notice ? `notice: ${room.notice.split('\n')[0].slice(0, 100)}` : '',
      room.workDir ? `members work in ${room.workDir} here` : '',
      room.extraDirs?.length ? `members also work in ${room.extraDirs.join(', ')} here` : '',
      room.permission ? `members work with the ${room.permission} permissions here` : '',
      room.goal !== undefined ? `goal: "${room.goal.title}" (${room.goal.status}${room.goal.status === 'active' || room.goal.status === 'paused' ? `, stage ${Math.min(room.goal.current + 1, room.goal.stages.length)}/${room.goal.stages.length}` : ''})` : '',
    ].filter(Boolean)
    return `- "${room.name}" — ${parts.join('; ')}`
  }
  const visibleRooms = self => Object.values(state.rooms).filter(room => rt.isMain(self) || room.members.includes(self))
  const teamNames = () => Object.values(state.bots).map(bot => bot.name).join(', ')
  const groupNames = self => visibleRooms(self).map(room => `"${room.name}"`).join(', ') || 'none'
  const pickRoom = (ref, self) => {
    const matches = rt.findRooms(ref).filter(room => visibleRooms(self).includes(room))
    if (matches.length === 1) return { room: matches[0] }
    if (matches.length > 1) return { error: `Several group chats are called "${unquote(ref)}". Rename one first.` }
    return { error: `No group chat called "${unquote(ref)}" that you can see. Groups: ${groupNames(self)}.` }
  }

  const botLine = (bot, self) => {
    if (bot.private === true && bot.id !== self) return `- ${bot.name} (${[bot.role, 'private Bot, closed to other Bots'].filter(Boolean).join(', ')})`
    const model = bot.appliedModel ?? bot.model
    const section = sectionNameOf(bot.sectionId)
    const tags = [bot.role, section ? `section "${section}"` : '', model ? `model ${model}` : '', bot.workDir ? `works in ${bot.workDir}` : '', bot.extraDirs?.length ? `also works in ${bot.extraDirs.join(', ')}` : '', rt.isMain(bot.id) ? 'Main Bot' : '', bot.private === true ? 'private' : '', bot.id === self ? 'you' : ''].filter(Boolean).join(', ')
    const job = bot.instructions ? ` — ${bot.instructions.split('\n')[0].slice(0, 120)}` : ''
    const now = bot.id === self ? '' : `\n  now: ${rt.statusOf(bot.id)}`
    return `- ${bot.name}${tags ? ` (${tags})` : ''}${job}${now}`
  }
  const listScope = (args, self) => {
    const all = Object.values(state.bots)
    const bot = args.bot ? rt.findBot(args.bot) : undefined
    if (args.bot && bot === undefined) return { error: `No Bot named ${args.bot}. Team: ${teamNames()}` }
    if (!args.group) {
      const rooms = visibleRooms(self).filter(room => bot === undefined || room.members.includes(bot.id))
      return { bots: bot ? [bot] : all, rooms, none: bot ? `Group chats: ${bot.name} is in none you can see.` : 'Group chats: none you can see.' }
    }
    const { room, error } = pickRoom(args.group, self)
    if (error !== undefined) return { error }
    const members = all.filter(member => room.members.includes(member.id))
    if (bot !== undefined && !room.members.includes(bot.id)) return { error: `${bot.name} is not in group "${room.name}". Members: ${members.map(member => member.name).join(', ')}` }
    return { bots: bot ? [bot] : members, rooms: [room] }
  }

  rt.teamTools.push(defineTool({
    name: 'list_bots',
    description: 'List every Bot on the user\'s team with its role, what it does and what it is doing right now, and the group chats you can see. Give bot or group to list only that Bot or that group\'s members; with both, the Bot must be in the group.',
    parameters: {
      bot: { type: 'string', description: 'Exact name of one Bot to list, with the group chats you can see that it is in' },
      group: { type: 'string', description: 'Exact group chat name: list only its members and that group' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (Object.keys(state.bots).length === 0) return 'No Bots yet.'
      const { bots, rooms, none, error } = listScope(args, self)
      if (error !== undefined) return error
      return [
        'Bots:',
        ...bots.map(bot => botLine(bot, self)),
        '',
        rooms.length === 0 ? none : 'Group chats:',
        ...rooms.map(room => roomLine(room, self)),
      ].join('\n')
    },
  }))

  const activeSessions = (botId) => {
    const bot = rt.botOf(botId)
    const own = bot === undefined ? [rt.chatOf(botId)] : ownChatSessions(bot)
    const running = [...new Set([...own, ...rt.groupSessionsOf(botId)])]
      .filter(sessionId => sessionId !== undefined && rt.live.get(sessionId)?.turn !== undefined)
    return { running, idle: running.length === 0 }
  }
  const whereOf = (sessionId) => {
    const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
    if (room) return `group "${room.name}"`
    if (rt.taskOwners?.has(sessionId)) return 'a background task'
    return 'its own chat'
  }
  const refuse = (message) => { throw new Error(message) }

  // Active works in `rt.coordDb` that the calling turn is executing.
  const worksOf = (exec) => {
    const sid = exec.agent?.id
    const turn = rt.live.get(sid)
    const task = rt.taskBySession?.(sid)?.task
    const taskWork = task?.workId ?? task?.exchangeId
    const dbWork = rt.resolveWorkForSession?.(sid, { ensureForeground: false })?.workId
    return [...new Set([rt.workOf?.(turn?.info), taskWork, dbWork].filter(Boolean))]
  }
  const tooLong = text => `Not sent: the message has ${text.length} characters, more than ${MESSAGE_INLINE_MAX}, and this DeepSeek Harness cannot send it as a file. Write it to a file in your working folder and send its path instead.`

  const groupRefusal = (room, sender, target) => {
    if (room.members.includes(target.id)) return undefined
    const add = rt.isMain(sender.id) || rt.isAdminOf(room, sender.id) ? ', or add it yourself with update_group first' : ''
    return `Not sent: ${target.name} is not in "${room.name}", and work for this group stays in it. Ask the user to add ${target.name} to the group${add}.`
  }

  const callInGroup = async (room, sender, target, message, follows, { worked = false, callerExchangeId, callerId, parentBatchKey, parentWorkId, returnAddress } = {}) => {
    if (waitsOnMember(rt.coordDb ?? state.roomBatches, room.id, sender.id, target.id, { callerWorkId: parentWorkId })) {
      refuse(`Not sent: ${target.name} is already waiting for your result. Write the result or blocking question in your reply, or use ask_back.`)
    }
    const call = `@${target.name}`
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const alreadyCalls = mentionSpans(message, everyone).some(span => !span.all && span.bot?.id === target.id)
    const posted = await rt.postToRoom(room, sender, alreadyCalls ? message : `${call} ${message}`, {
      progress: true,
      explicitDelegate: true,
      ...(worked ? { worked: true } : {}),
      ...(callerExchangeId ? { callerExchangeId } : {}),
      ...(callerId ? { callerId } : {}),
      ...(parentBatchKey ? { parentBatchKey } : {}),
      ...(parentWorkId ? { parentWorkId } : {}),
      ...(returnAddress ? { returnAddress } : {}),
      route: { ...roomRequest([target.id]), expectsResult: true, ...(follows ? { follows } : {}) },
    })
    if (posted?.paused === true) {
      return `Paused in "${room.name}": no progress detected on this chain. The call to ${target.name} waits until the user continues or writes in the group.`
    }
    return `Called ${target.name} in "${room.name}". Its result returns in the group. Nothing went to its own chat.`
  }

  const calledInPosts = new Map()
  const keptUp = new Map()
  const turnOf = exec => rt.live.get(exec.agent?.id)?.turn

  const upstreamRefusal = (exec, sender, target, said, args) => {
    const plain = `Not sent: ${target.name} is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back.`
    const turn = rt.live.get(exec.agent?.id)
    const workId = rt.workOf?.(turn?.info) ?? rt.resolveWorkForSession?.(exec.agent?.id, { ensureForeground: false })?.workId
    const resolved = workId ? rt.resolveWork?.(workId) : undefined
    const asker = resolved !== undefined && rt.ownsWork?.(sender.id, workId) ? rt.botOf(resolved.work.from) : undefined
    const answers = asker !== undefined && (args.deliver_to ?? args.reply_to) !== 'user' && args.when !== 'queue' && rt.upstreamOf([workId]).has(target.id)
    if (!answers) return `${plain} Finish the work and end your turn; to ask ${target.name} a blocking question, call ask_back.`
    const to = asker.id === target.id ? target.name : `${asker.name} as your answer, and reaches ${target.name} with ${asker.name}'s answer`
    if (turn?.texts?.slice(turn.shown ?? 0).join('').trim() !== '') {
      return `${plain} Your message was not kept: this turn already wrote text, and that goes up to ${to}. Write the message in your final answer, or call ask_back if you need input.`
    }
    const before = keptUp.get(exec.agent?.id)
    const again = before?.turn === turn?.turn && before?.work === workId
    const replacedEarlier = !again && rt.hasHeldWork?.(workId) === true
    const text = again ? `${before.text}\n\n${said}` : said
    for (const [id, kept] of keptUp) if (rt.live.get(id)?.turn !== kept.turn) keptUp.delete(id)
    keptUp.set(exec.agent?.id, { turn: turn?.turn, work: workId, text: text.slice(0, TEXT_KEPT + 1) })
    rt.holdWork?.(workId, text)
    const cut = text.length > TEXT_KEPT
    const kept = again
      ? `Your message was kept as your answer, after what was kept before in this turn${cut ? `, but only the first ${TEXT_KEPT} characters of all of it` : ''}.`
      : replacedEarlier
        ? `${cut ? `Only its first ${TEXT_KEPT} characters were` : 'Your message was'} kept as your answer, in place of what was kept for this work before this turn.`
        : `${cut ? `Only its first ${TEXT_KEPT} characters were` : 'Your message was'} kept as your answer.`
    const whole = cut ? ' To send all of it, write it in full as your answer.' : ''
    return `${plain} ${kept}${whole} If you end your turn without writing any text, ${cut ? 'that part' : 'it'} goes up to ${to}; any text you write for this work from now on goes up instead.`
  }

  // Sends a zero-wake silent note via `rt.coordDb` + `rt.dispatchNote` (D1).
  async function sendSilentNote({ senderId, senderName, targetId, targetSession, role = 'note', text, files = [], length, workRef, senderAddress, dedupKey }) {
    const exchangeId = randomUUID()
    const key = dedupKey ?? `${role}:${exchangeId}`
    const targetAddr = foregroundAddress(targetId)
    const resolvedSession = targetSession ?? rt.resolveLogicalSession?.(targetAddr) ?? rt.chatOf(targetId)
    const header = role === 'cancelled'
      ? `[Work${workRef ? ` #${workRef}` : ''} cancelled by ${senderName} · no reply needed]`
      : role === 'stopped'
        ? `[Stopped by ${senderName} · no reply needed]`
        : `[Note from ${senderName} · FYI only, no reply needed]`
    const renderedText = `${header}\n${text}`
    const message = createUserMessage({
      content: [
        { type: 'text', text: renderedText },
        ...(files ?? []).map(attachment => ({ type: 'file', attachment })),
      ],
      source: {
        kind: SOURCE_KIND,
        form: 'relay',
        role,
        exchangeId,
        senderName,
        silent: true,
        ...(senderId ? { senderSessionId: senderId } : {}),
        ...(workRef ? { workRef } : {}),
      },
    })
    const fgWork = writableCoordDb() ? rt.ensureForegroundWorkForBot?.(targetId) : undefined
    const notePayload = {
      role,
      text,
      renderedText,
      ...(files.length > 0 ? { files } : {}),
      ...(length !== undefined ? { length } : {}),
      ...(workRef ? { workRef } : {}),
      fromId: senderId,
      fromName: senderName,
      toId: targetId,
      exchangeId,
    }
    if (typeof rt.dispatchNote === 'function') {
      await rt.dispatchNote(targetAddr, message, {
        ...(fgWork ? { workId: fgWork.workId } : {}),
        ...(resolvedSession ? { sessionId: resolvedSession } : {}),
        senderAddress: senderAddress ?? (senderId ? foregroundAddress(senderId) : 'system:user'),
        senderBotId: senderId,
        dedupKey: key,
        idempotencyKey: key,
        bodyPreview: oneLine(text, 400),
        payload: notePayload,
      })
      rt.recordPairExchange?.({
        id: exchangeId,
        from: senderId,
        to: targetId,
        role,
        text,
        sessionId: resolvedSession,
        workRef,
        length,
        files,
      })
      return exchangeId
    }
    if (fgWork !== undefined) {
      rt.coordDb.receiveMessage({
        workId: fgWork.workId,
        kind: 'note',
        dedupKey: key,
        senderAddress: senderAddress ?? (senderId ? foregroundAddress(senderId) : 'system:user'),
        senderBotId: senderId,
        bodyPreview: oneLine(text, 400),
        payload: notePayload,
        wake: false,
      })
    }
    return rt.deliver({
      ...(senderId ? { fromId: senderId } : { fromName: senderName }),
      toId: targetId,
      ...(resolvedSession ? { sessionId: resolvedSession } : {}),
      text,
      files,
      ...(length !== undefined ? { length } : {}),
      role,
      wake: false,
      ...(workRef ? { workRef } : {}),
      exchangeId,
    })
  }

  // Dispatches a delegated work request in a single atomic SQLite transaction + `rt.kickScheduler()`.
  async function dispatchDelegation({ sender, target, text, fromSessionId, fromPart, parentWorkId, imOrigin, follows, toUser = false, when = 'now', request }) {
    const status = rt.statusOf(target.id)
    const long = await rt.attachLong(text, `Work from ${sender.name}.txt`)
    if (long === undefined) {
      if (request !== undefined) request.unsent = true
      return tooLong(text)
    }
    const exchangeId = randomUUID()
    const senderReturn = rt.returnAddress?.({ sessionId: fromSessionId, fromPart, botId: sender.id, workId: parentWorkId })
      ?? foregroundAddress(sender.id)

    if (writableCoordDb() && typeof rt.kickScheduler === 'function') {
      if (toUser) {
        const fgTarget = rt.ensureForegroundWorkForBot?.(target.id)
        if (fgTarget === undefined) refuse(`Unknown Bot ${target.name}.`)
        rt.coordDb.receiveMessage({
          workId: fgTarget.workId,
          kind: 'request',
          dedupKey: request?.dedupKey ?? `delegate_user:${exchangeId}`,
          senderAddress: senderReturn,
          senderBotId: sender.id,
          bodyPreview: oneLine(text, 400),
          payload: {
            role: 'request',
            audience: 'user',
            fromId: sender.id,
            fromName: sender.name,
            toId: target.id,
            text: long.text,
            renderedText: `[Work from ${sender.name} · the user sees your reply here]\n${long.text}`,
            source: {
              senderName: sender.name,
              audience: 'user',
              ...(follows ? { follows } : {}),
            },
            ...(long.files?.length ? { files: long.files } : {}),
            ...(long.length !== undefined ? { length: long.length } : {}),
            ...(follows ? { follows } : {}),
            exchangeId,
          },
          priority: 'foreground',
          wake: true,
        })
        rt.recordPairExchange?.({
          id: exchangeId,
          from: sender.id,
          to: target.id,
          role: 'request',
          text: long.text,
          sessionId: rt.chatOf(target.id),
          follows,
          length: long.length,
          files: long.files,
          audience: 'user',
        })
        await rt.kickScheduler({ botId: target.id, workId: fgTarget.workId })
        return `Delegated to ${target.name}. It will answer the user in its own chat; nothing comes back to you, so point the user to ${target.name}'s chat instead of relaying.`
      }

      const targetChat = rt.chatOf(target.id)
      // Decide BEFORE `openCall` whether this delegation will run in a dedicated `bot-handoff`
      // background task session. If so, defer enqueuing `ready` (`wake: false`) until the task
      // session is created and bound via `rebindSession`, preventing any concurrent `kickScheduler`
      // tick from stealing the work onto the busy foreground chat `targetChat` during `await`.
      const willSpawnPeerTask = when !== 'queue' && targetChat !== undefined && rt.shouldSpawnPeerTask?.(target, targetChat) === true
      let created
      try {
        created = rt.openCall({
          workId: exchangeId,
          parentWorkId,
          callerBotId: sender.id,
          calleeBotId: target.id,
          returnAddr: senderReturn,
          title: text,
          imOrigin,
          ...(willSpawnPeerTask ? {} : { sessionId: targetChat }),
          priority: when === 'queue' ? 'background' : 'interactive',
          initialMessage: {
            dedupKey: request?.dedupKey ?? `call:${exchangeId}:request`,
            senderAddress: senderReturn,
            senderBotId: sender.id,
            bodyPreview: oneLine(text, 400),
            ...(willSpawnPeerTask ? { wake: false } : {}),
            payload: {
              role: 'request',
              fromId: sender.id,
              fromName: sender.name,
              toId: target.id,
              ...(fromPart ? { fromPart } : {}),
              text: long.text,
              source: {
                senderName: sender.name,
                ...(fromPart ? { senderPart: fromPart } : {}),
                ...(follows ? { follows } : {}),
              },
              ...(long.files?.length ? { files: long.files } : {}),
              ...(long.length !== undefined ? { length: long.length } : {}),
              ...(follows ? { follows } : {}),
              when,
              exchangeId,
            },
          },
          meta: { ...(fromPart ? { fromPart } : {}), when },
        })
      } catch (error) {
        if (error?.code === 'coordination/wait_cycle') {
          if (request !== undefined) request.unsent = true
          refuse(`Not sent: ${target.name} is already waiting on your work chain. Finish your work and reply, or use ask_back to ask a blocking question.`)
        }
        if (error?.code === 'coordination/privacy_escalation') {
          if (request !== undefined) request.unsent = true
          refuse(`Not sent: privacy boundary prevents delegating this work to ${target.name}.`)
        }
        throw error
      }

      // If target Bot's foreground chat is busy (and not `when: 'queue'` or local CLI),
      // bind this delegation to an isolated `bot-handoff` background task session before
      // enqueuing it onto the scheduler, keeping the user's foreground chat untouched.
      let boundSessionId = targetChat
      let spawnedTask
      if (willSpawnPeerTask) {
        try {
          spawnedTask = await rt.spawnBotHandoffTask?.(target, targetChat, {
            fromBot: sender,
            fromPart,
            parentWork: parentWorkId,
            imOrigin,
            follows,
            text: long.text,
            files: long.files,
            length: long.length,
            exchangeId,
            reuseWork: true,
            deliver: false,
          })
        } catch (error) {
          rt.dropWork?.(created.workId)
          throw error
        }
        if (spawnedTask?.sessionId) boundSessionId = spawnedTask.sessionId
        else if (targetChat) rt.coordDb.rebindSession(created.workId, targetChat)
        rt.coordDb.requeueInterruptedWork(created.workId, { reason: 'bot_handoff_bound' })
      }

      try {
        await rt.recordPairExchange?.({
          id: exchangeId,
          from: sender.id,
          to: target.id,
          role: 'request',
          text: long.text,
          sessionId: boundSessionId,
          workRef: created.workRef,
          follows,
          length: long.length,
          files: long.files,
          work: created.workId,
        })
      } catch (error) {
        rt.dropWork?.(created.workId)
        throw error
      }

      try {
        await rt.kickScheduler({ botId: target.id, workId: created.workId, throwOnError: true })
      } catch (error) {
        if (error?.code !== 'EIO') {
          const w = rt.coordDb?.getWork?.(created.workId)
          if (error?.delivered !== true && w !== undefined && w.status !== 'running' && w.status !== 'needs_verification' && w.activeDeliveryKey === null) {
            rt.dropWork?.(created.workId)
          }
          throw error
        }
      }
      const label = created.workRef ? ` work #${created.workRef}` : ''
      const parentResolved = parentWorkId ? rt.resolveWork?.(parentWorkId) : undefined
      const asker = parentResolved !== undefined && rt.ownsWork?.(sender.id, parentWorkId) ? rt.botOf(parentResolved.work.from)?.name : undefined
      const sent = spawnedTask !== undefined
        ? `Delegated${label} to ${target.name} (started in a background task while its foreground chat is busy). Its result returns automatically and closes${label || ' the work'} when done; do not wait or poll.`
        : when === 'queue'
          ? `Queued${label} for ${target.name}: it will run and return the result once done. Do not wait or poll.`
          : `Delegated${label} to ${target.name}. Its result returns automatically and closes${label || ' the work'} when done; do not wait or poll.`
      const notes = [
        status === 'idle' ? '' : `${target.name} now: ${status}.`,
        asker ? `When you have handed on everything, end your turn: each completed sub-work brings you back, and your answer goes to ${asker} once all of it is back.` : '',
      ].filter(Boolean)
      const out = [sent, ...notes].join(' ')
      const chat = rt.chatOf(target.id)
      const elsewhere = activeSessions(target.id).running.filter(sessionId => sessionId !== chat)
      if (elsewhere.length === 0) return out
      const stop = rt.isMain(sender.id) ? ' If it must not go on there, use stop_bot.' : ''
      return `${out} This request does not reach its work in ${elsewhere.map(whereOf).join(' and ')}.${stop}`
    }

    // Fallback when `rt.coordDb` / `rt.kickScheduler` are absent (narrow unit tests).
    const opened = toUser ? undefined : rt.openWork?.(exchangeId, { from: sender.id, to: target.id, parent: parentWorkId, ...(fromPart ? { fromPart } : {}), ...(imOrigin ? { imOrigin } : {}), goal: text })
    const workRef = opened?.ref
    await rt.deliver({
      fromId: sender.id,
      toId: target.id,
      ...(fromPart ? { fromPart } : {}),
      text: long.text,
      files: long.files,
      length: long.length,
      role: 'request',
      ...(follows ? { follows } : {}),
      steer: when !== 'queue' && !toUser,
      exchangeId,
      ...(workRef ? { workRef } : {}),
      ...(toUser ? { audience: 'user' } : {}),
    })
    return toUser
      ? `Delegated to ${target.name}. It will answer the user in its own chat; nothing comes back to you.`
      : `Delegated${workRef ? ` work #${workRef}` : ''} to ${target.name}. Its result returns automatically when done; do not wait or poll.`
  }

  // Prevents concurrent resume-work clicks from double-resuming the same paused work.
  const resumingWorks = new Set()
  async function resumePausedWork(id) {
    const rawKey = String(id ?? '').trim()
    if (rawKey === '' || resumingWorks.has(rawKey)) return false
    resumingWorks.add(rawKey)
    try {
      await rt.load()
      const dbWork = rt.coordDb?.getWork?.(rawKey) ?? rt.resolveWork?.(rawKey)?.work
      if (dbWork?.roomId && dbWork?.originKind === 'group' && typeof rt.resumeRoomPause === 'function') {
        return await rt.resumeRoomPause(dbWork.roomId, { workId: dbWork.workId }) === true
      }
      const res = rt.resumeWork?.(rawKey, { resumeChain: true, resetProgress: true, reason: 'user_resume' })
      return res?.resumed === true
    } finally {
      resumingWorks.delete(rawKey)
    }
  }

  async function cancelWorkByUser(id, reason = 'Cancelled by the user.') {
    await rt.load()
    const resolved = rt.resolveWork?.(id)
    if (resolved === undefined) return false
    const snapshot = rt.cancelWork?.(resolved.id, { by: 'user', reason, cascadeChildren: true })
    if (snapshot === undefined) return false
    await rt.abortWorkExecution?.(resolved.id, { reason, by: 'user', cascadeChildren: true }).catch(() => {})
    if (snapshot.to && rt.botOf(snapshot.to) !== undefined && snapshot.state !== 'paused') {
      await sendSilentNote({
        senderName: 'The user',
        targetId: snapshot.to,
        targetSession: snapshot.toSession,
        role: 'cancelled',
        text: reason,
        workRef: snapshot.ref,
        dedupKey: `cancel:${resolved.id}`,
      }).catch(error => rt.warn?.('ds-bot: silent cancel notice failed: %s', error))
    }
    void rt.kickScheduler?.().catch(() => {})
    return true
  }

  // --- Collaboration & Interactive Tools ---

  rt.teamTools.push(defineTool({
    name: 'delegate_work',
    description: 'Delegate a concrete task or specific question to another Bot on the team, opening a tracked work (#W…) whose final reply returns automatically and closes the work. NEVER use this for thanks, acknowledgements, wrap-ups, or "收工/待命" — use note_bot for silent FYI updates, or cancel_work to stop open work. With deliver_to "user", the Bot answers the user directly in its own chat and nothing returns to you. Do not delegate back to a Bot already waiting on your work. In a group chat it calls a member of that group like "@Name".',
    parameters: {
      to: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      goal: { type: 'string', required: true, description: 'Self-contained task to execute or specific question to answer; the other Bot cannot see this conversation' },
      follow_up_to: { type: 'string', description: 'For a distinct task prompted by a completed result, cite the reference in this turn (e.g. W7 in chat, G12 in a group). Acknowledgements are not follow-ups.' },
      deliver_to: {
        type: 'string',
        enum: ['me', 'user'],
        description: '"me" (default): the result returns to you and closes the work (hidden from the user). "user": the Bot answers the user directly in its own chat and nothing returns to you.',
      },
      when: {
        type: 'string',
        enum: ['now', 'queue'],
        description: '"now" (default): starts promptly as an independent work. "queue": schedules at background priority. With deliver_to "user" the request goes to the target\'s foreground chat.',
      },
      request_id: {
        type: 'string',
        description: `Your own name for this request, up to ${NAME_MAX} characters, so a repeat with the same goal is not sent twice. A request_id names one request: with other content it is refused.`,
      },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined) return 'Only Bots on the team can use delegate_work.'
      const target = rt.findBot(args.to)
      if (target === undefined) return `No Bot named ${args.to}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`
      if (target.id === sender.id) return 'You cannot delegate work to yourself.'
      const rawGoal = String(args.goal ?? args.message ?? '')
      if (rawGoal.trim() === '') return 'Specify a concrete goal or question to delegate.'
      const name = typeof args.request_id === 'string' ? args.request_id.trim() : ''
      if (name.length > NAME_MAX) return `The request_id is ${name.length} characters long; a request name is at most ${NAME_MAX}.`
      const text = absoluteLinks(rawGoal, rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      const taskRoomId = rt.taskOwners?.get(exec.agent?.id)?.roomId
      if (taskRoomId !== undefined) {
        refuse('Background tasks in a group chat cannot call delegate_work directly. Finish your work and mention @Name in your final reply so it goes to the group.')
      }
      const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
      const deliverTo = args.deliver_to === 'user' || args.reply_to === 'user' ? 'user' : 'me'
      const when = args.when === 'queue' ? 'queue' : 'now'
      const trigger = rt.live.get(exec.agent?.id)?.info
      const resultRef = trigger?.resultRef ?? (trigger?.role === 'reply' ? trigger.workRef ?? rt.workRefOf?.(trigger.replyTo) ?? trigger.replyTo : undefined)
      const followUp = String(args.follow_up_to ?? '').trim().replace(/^#/, '').toUpperCase()
      const request = name === '' ? undefined : rt.requestIdentity({
        caller: sender.id,
        context: room === undefined ? 'chat' : `room:${room.id}`,
        name,
        payload: {
          to: target.id,
          goal: rawGoal.replace(/\r\n?/g, '\n').trim(),
          deliver_to: deliverTo,
          when,
          ...(followUp ? { followUp } : {}),
        },
      })
      const answer = (outcome) => {
        if (outcome.status === 'replay') return outcome.receipt
        if (outcome.status === 'conflict') refuse(`Not sent: request_id "${name}" was already used for a different request. A request_id names one request; send this one under a new name.`)
        if (outcome.status === 'uncertain') refuse(`Not sent again: the outcome of request_id "${name}" is not known (the delivery failed, or DS Bot restarted while it was in flight), so it was not sent again. Check whether ${target.name} got it before sending it under a new name.`)
        if (outcome.status === 'expired') return `Nothing was sent again: request_id "${name}" was admitted before, but its receipt is no longer kept, so only the fact that it was sent is left. Send the work under a new request_id if it must be done again.`
        if (outcome.status === 'readonly') refuse(`Not sent: this window cannot save the Bot team, so it cannot record the request_id "${name}". Send it from the window that owns the team, or leave the request_id out.`)
        return outcome.receipt
      }
      if (request !== undefined) {
        const seen = await rt.knownRequest(request)
        if (seen !== undefined) return answer(seen)
      }
      const fromResult = (trigger?.role === 'reply' || Boolean(trigger?.resultRef)) && !trigger?.work
      const userTurn = rt.live.get(exec.agent?.id)?.userInput === true
      if (fromResult && !userTurn && resultRef !== undefined) {
        if (!followUp) {
          refuse(`Not sent: this is a result, not a new request. Report it to the user or leave a silent note. Only for a distinct next task, cite ${resultRef} in follow_up_to.`)
        }
        if (followUp !== resultRef.toUpperCase()) {
          refuse(`Not sent: follow_up_to must identify the completed work that opened this turn (${resultRef}).`)
        }
      }
      if (room !== undefined) {
        const refusal = groupRefusal(room, sender, target)
        if (refusal !== undefined) refuse(refusal)
        const activeWorks = worksOf(exec)
        if (waitsOnMember(rt.coordDb ?? state.roomBatches, room.id, sender.id, target.id, { callerWorkId: activeWorks[0] }) || rt.upstreamOf(activeWorks).has(target.id)) {
          refuse(`Not sent: ${target.name} is already waiting for your result. Write the result or blocking question in your reply.`)
        }
        const callerWorked = (rt.live.get(exec.agent?.id)?.workToolCount ?? 0) > 0
        const parentBatchKey = rt.activeRoomBatchKey?.(exec.agent?.id, trigger)
        const parentWorkId = activeWorks[0]
        const retAddr = rt.returnAddress?.({ sessionId: exec.agent?.id, botId: sender.id, roomId: room.id, workId: parentWorkId })
        const send = async () => {
          const receipt = await callInGroup(room, sender, target, text.trim(), followUp, {
            worked: callerWorked,
            callerExchangeId: trigger?.exchangeId,
            callerId: trigger?.askedBy,
            ...(parentBatchKey ? { parentBatchKey } : {}),
            ...(parentWorkId ? { parentWorkId } : {}),
            ...(retAddr ? { returnAddress: retAddr } : {}),
          })
          rt.markExplicitRoomCall?.(trigger?.exchangeId, target.id)
          return receipt
        }
        return request === undefined ? await send() : answer(await rt.admitRequest(request, send))
      }
      const posted = calledInPosts.get(exec.agent?.id)
      const postedIn = posted !== undefined && posted.turn === turnOf(exec) ? posted.calls.get(target.id) : undefined
      if (postedIn !== undefined) refuse(`Not sent: you called ${target.name} in "${postedIn}" in this turn, and it works on that there. Send each task one way only; to add to it, post in that group.`)
      const works = worksOf(exec)
      if (rt.upstreamOf(works).has(target.id)) return upstreamRefusal(exec, sender, target, text.trim(), { reply_to: deliverTo, when })
      const send = async () => {
        const toUser = deliverTo === 'user'
        const parentWorkId = toUser ? undefined : (works[0] ?? rt.resolveWorkForSession?.(exec.agent?.id)?.workId)
        const imOrigin = !toUser ? callerImOrigin(exec) : undefined
        const fromPart = callerPart(exec).fromPart
        return dispatchDelegation({
          sender,
          target,
          text,
          fromSessionId: exec.agent?.id,
          fromPart,
          parentWorkId,
          imOrigin,
          follows: followUp || undefined,
          toUser,
          when,
          request,
        })
      }
      return request === undefined ? await send() : answer(await rt.admitRequest(request, send))
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'ask_back',
    description: 'While doing a delegated work (#W…), ask the calling Bot a blocking question or request a decision without closing the work. Your turn yields immediately until the caller calls answer_work or cancel_work.',
    parameters: {
      question: { type: 'string', required: true, description: 'Specific question or decision needed to continue this work' },
      work_id: { type: 'string', description: 'Optional work ref (e.g. W1) or id; defaults to the work this turn is handling' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined) return 'Only Bots on the team can use ask_back.'
      const question = String(args.question ?? '').trim()
      if (question === '') return 'Write the question you need answered.'
      const turn = rt.live.get(exec.agent?.id)
      const explicit = typeof args.work_id === 'string' && args.work_id.trim() !== '' ? args.work_id.trim() : undefined
      const resolved = explicit !== undefined
        ? rt.resolveWork?.(explicit)
        : (() => {
            const active = rt.workOf?.(turn?.info) ?? rt.resolveWorkForSession?.(exec.agent?.id, { ensureForeground: false })?.workId
            return active ? rt.resolveWork?.(active) : undefined
          })()
      if (resolved === undefined) {
        const closed = explicit !== undefined ? rt.closedWorkOf?.(explicit) : undefined
        if (closed !== undefined) refuse(`Work #${closed.ref ?? closed.id} is already ${closed.status}; you cannot ask back on a closed work.`)
        refuse('No open delegated work found for this turn.')
      }
      if (resolved.work.to !== sender.id) refuse(`Work #${resolved.work.ref ?? resolved.id} is not assigned to you.`)
      const caller = rt.botOf(resolved.work.from)
      if (caller === undefined) refuse('The calling Bot is no longer on the team.')
      const body = absoluteLinks(question, rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      const long = await rt.attachLong(body, `Question from ${sender.name}.txt`)
      if (long === undefined) return tooLong(body)
      const outcome = rt.askBackWork?.(resolved.id, question, {
        bodyPreview: oneLine(body, 400),
        payload: {
          role: 'ask_back',
          askWork: resolved.id,
          ...(resolved.work.ref ? { workRef: resolved.work.ref } : {}),
          fromId: sender.id,
          fromName: sender.name,
          toId: caller.id,
          text: long.text,
          ...(long.files?.length ? { files: long.files } : {}),
          ...(long.length !== undefined ? { length: long.length } : {}),
        },
      })
      if (outcome?.error === 'ask_cycle') {
        refuse(`Cannot ask ${caller.name} back because it is already waiting on a question to you. Ask the user directly instead.`)
      }
      if (outcome?.error !== undefined) {
        refuse(`Cannot ask back on work #${resolved.work.ref ?? resolved.id}: ${outcome.error}.`)
      }
      if (turn !== undefined) turn.askedBackWork = resolved.id
      rt.recordPairExchange?.({
        id: outcome?.wait?.waitId ?? randomUUID(),
        from: sender.id,
        to: caller.id,
        role: 'ask_back',
        text: long.text,
        workRef: resolved.work.ref,
        length: long.length,
        files: long.files,
        work: resolved.id,
      })
      if (typeof rt.kickScheduler === 'function') {
        await rt.kickScheduler({ botId: caller.id, workId: outcome.targetWorkId })
      }
      yieldTurn(exec, 'waiting_ask_back')
      const ref = resolved.work.ref ? `#${resolved.work.ref}` : resolved.id
      return `Sent your question on work ${ref} to ${caller.name}. Your turn is paused until ${caller.name} calls answer_work or cancel_work.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'answer_work',
    description: 'Answer a teammate\'s ask_back question on a work you delegated (#W…), resuming that work.',
    parameters: {
      answer: { type: 'string', required: true, description: 'The information or decision needed to unblock the teammate' },
      work_id: { type: 'string', description: 'Optional work ref (e.g. W1) or id; defaults to the question waiting on you' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined) return 'Only Bots on the team can use answer_work.'
      const answerText = String(args.answer ?? '').trim()
      if (answerText === '') return 'Write the answer to send.'
      const turn = rt.live.get(exec.agent?.id)
      const explicit = typeof args.work_id === 'string' && args.work_id.trim() !== '' ? args.work_id.trim() : undefined
      let resolved
      if (explicit !== undefined) {
        resolved = rt.resolveWork?.(explicit)
      } else if (turn?.info?.askWork !== undefined) {
        resolved = rt.resolveWork?.(turn.info.askWork)
      } else {
        const waiting = rt.needInputWorksFor?.(sender.id) ?? []
        if (waiting.length === 1) resolved = waiting[0]
        else if (waiting.length > 1) refuse(`Multiple works need your answer (${waiting.map(item => `#${item.work.ref ?? item.id}`).join(', ')}); pass work_id.`)
      }
      if (resolved === undefined) {
        const closed = explicit !== undefined ? rt.closedWorkOf?.(explicit) : undefined
        if (closed !== undefined) refuse(`Work #${closed.ref ?? closed.id} is already ${closed.status}; do not reply to a closed work.`)
        refuse('No work is currently waiting for your answer.')
      }
      if (resolved.work.from !== sender.id) refuse(`Work #${resolved.work.ref ?? resolved.id} was not delegated by you.`)
      if (resolved.work.state !== 'need_input') {
        refuse(`Work #${resolved.work.ref ?? resolved.id} is ${resolved.work.state}, not waiting for an answer.`)
      }
      const worker = rt.botOf(resolved.work.to)
      if (worker === undefined) refuse('The assigned Bot is no longer on the team.')
      const body = absoluteLinks(answerText, rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      const long = await rt.attachLong(body, `Answer from ${sender.name}.txt`)
      if (long === undefined) return tooLong(body)
      const senderAddr = rt.returnAddress?.({ sessionId: exec.agent?.id, botId: sender.id }) ?? foregroundAddress(sender.id)
      const outcome = rt.answerWork?.(resolved.id, long.text, {
        senderBotId: sender.id,
        senderAddress: senderAddr,
        payload: {
          role: 'answer',
          work: resolved.id,
          ...(resolved.work.ref ? { workRef: resolved.work.ref } : {}),
          fromId: sender.id,
          fromName: sender.name,
          toId: worker.id,
          text: long.text,
          ...(long.files?.length ? { files: long.files } : {}),
          ...(long.length !== undefined ? { length: long.length } : {}),
        },
      })
      if (outcome?.error !== undefined) refuse(`Could not answer work #${resolved.work.ref ?? resolved.id}: ${outcome.error}.`)
      rt.recordPairExchange?.({
        id: `answer:${outcome?.wait?.waitId ?? randomUUID()}`,
        from: sender.id,
        to: worker.id,
        role: 'answer',
        text: long.text,
        sessionId: resolved.work.toSession,
        workRef: resolved.work.ref,
        length: long.length,
        files: long.files,
        work: resolved.id,
      })
      if (typeof rt.kickScheduler === 'function') {
        await rt.kickScheduler({ botId: worker.id, workId: resolved.id })
      }
      const ref = resolved.work.ref ? `#${resolved.work.ref}` : resolved.id
      return `Answered ${worker.name} on work ${ref}; it will resume and return the result when done. Reply [PASS] if nothing needs to be told to the user.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'cancel_work',
    description: 'Silently cancel an open, waiting, or paused work you delegated (#W… or Bot name). Aborts in-flight execution and records the reason in the Bot\'s context WITHOUT waking it to reply.',
    parameters: {
      target: { type: 'string', required: true, description: 'Work ref (e.g. W1), work id, or exact Bot name from list_bots' },
      reason: { type: 'string', description: 'Optional brief reason why the work is no longer needed' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined) return 'Only Bots on the team can use cancel_work.'
      const key = String(args.target ?? '').trim()
      if (key === '') return 'Specify a work ref (e.g. W1) or Bot name to cancel.'
      const reason = String(args.reason ?? '').trim()
      const byRef = rt.resolveWork?.(key)
      let matches = []
      if (byRef !== undefined) {
        if (byRef.work.from !== sender.id && !rt.isMain(sender.id)) {
          refuse(`Only ${rt.botOf(byRef.work.from)?.name ?? 'the caller'} or a Main Bot can cancel work #${byRef.work.ref ?? byRef.id}.`)
        }
        matches = [byRef]
      } else {
        const closed = rt.closedWorkOf?.(key)
        if (closed !== undefined) return `Work #${closed.ref ?? closed.id} is already ${closed.status}; nothing left to cancel.`
        const bot = rt.findBot(key)
        if (bot === undefined) return `No open work or Bot named "${key}".`
        matches = rt.openWorksBetween?.(sender.id, bot.id) ?? []
        if (matches.length === 0 && rt.isMain(sender.id) && hasCoordDb()) {
          matches = rt.coordDb.listWorks({ botId: bot.id, activeOnly: true, limit: 100 })
            .filter(w => w.kind !== 'foreground' && w.originKind !== 'request_dedup')
            .map(w => rt.resolveWork?.(w.workId))
            .filter(Boolean)
        }
        if (matches.length === 0) return `No open delegated work for ${bot.name}; nothing to cancel (do not send a wrap-up request).`
      }
      const cancelledRefs = []
      const senderAddr = rt.returnAddress?.({ sessionId: exec.agent?.id, botId: sender.id })
      for (const item of matches) {
        const snapshot = rt.cancelWork?.(item.id, { by: sender.id, reason, cascadeChildren: true })
        if (snapshot === undefined) continue
        cancelledRefs.push(snapshot.ref ? `#${snapshot.ref}` : snapshot.id)
        await rt.abortWorkExecution?.(item.id, { reason, by: sender.id, sender, cascadeChildren: true }).catch(() => {})
        if (snapshot.to && rt.botOf(snapshot.to) !== undefined && snapshot.state !== 'paused') {
          const note = reason || `Work ${snapshot.ref ? `#${snapshot.ref} ` : ''}was cancelled.`
          await sendSilentNote({
            senderId: sender.id,
            senderName: sender.name,
            senderAddress: senderAddr,
            targetId: snapshot.to,
            targetSession: snapshot.toSession,
            role: 'cancelled',
            text: note,
            workRef: snapshot.ref,
            dedupKey: `cancel:${item.id}`,
          }).catch(error => rt.warn?.('ds-bot: silent cancel notice failed: %s', error))
        }
      }
      void rt.kickScheduler?.().catch(() => {})
      return `Cancelled ${cancelledRefs.join(', ')} silently. The Bot was not woken and will not reply.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'note_bot',
    description: 'Leave a one-way silent FYI note in another Bot\'s context WITHOUT waking it or triggering a reply. Use this for wrap-ups, status updates, or facts the Bot only needs next time it works.',
    parameters: {
      to: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      note: { type: 'string', required: true, description: 'Factual note to leave silently (no reply will come back)' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined) return 'Only Bots on the team can use note_bot.'
      const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
      if (room !== undefined) refuse('In a group chat, write a normal message without @Name so members see it without waking anyone.')
      const target = rt.findBot(args.to)
      if (target === undefined) return `No Bot named ${args.to}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`
      if (target.id === sender.id) return 'You cannot leave a note for yourself.'
      const rawNote = String(args.note ?? '').trim()
      if (rawNote === '') return 'Write a note to leave.'
      const text = absoluteLinks(rawNote, rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      const long = await rt.attachLong(text, `Note from ${sender.name}.txt`)
      if (long === undefined) return tooLong(text)
      await sendSilentNote({
        senderId: sender.id,
        senderName: sender.name,
        senderAddress: rt.returnAddress?.({ sessionId: exec.agent?.id, botId: sender.id }),
        targetId: target.id,
        role: 'note',
        text: long.text,
        files: long.files,
        length: long.length,
      })
      return `Left a silent note for ${target.name}. It was not woken and will not reply; it will read this note next time it works.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'stop_bot',
    description: 'Main Bot only. Stop another Bot\'s running turn, background tasks, and open delegated works immediately. Logs why silently in its context without waking it to reply.',
    parameters: {
      bot: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      reason: { type: 'string', description: 'Why it was stopped; logged silently for its next run' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined || !rt.isMain(sender.id)) refuse('Only a Main Bot can stop other Bots.')
      const target = rt.findBot(args.bot)
      if (target === undefined) refuse(`No Bot named ${args.bot}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`)
      if (target.id === sender.id) refuse('You cannot stop yourself.')
      const { running } = activeSessions(target.id)
      const activeTasks = (target.tasks ?? []).filter(task => task && ['running', 'waiting_work', 'waiting_approval'].includes(task.status))
      const openWorks = hasCoordDb()
        ? rt.coordDb.listWorks({ botId: target.id, activeOnly: true, limit: 200 })
            .filter(w => w.kind !== 'foreground' && w.originKind !== 'request_dedup')
        : []
      if (running.length === 0 && activeTasks.length === 0 && openWorks.length === 0) {
        refuse(`${target.name} is not running right now, so there is nothing to stop. Use delegate_work to assign work.`)
      }
      const why = String(args.reason ?? '').trim() || `Stopped by ${sender.name}; previous turn was ended on purpose.`
      for (const work of openWorks) {
        rt.cancelWork?.(work.workId, { by: sender.id, reason: why, cascadeChildren: true })
        await rt.abortWorkExecution?.(work.workId, { reason: why, by: sender.id, sender, cascadeChildren: true }).catch(() => {})
      }
      const nonTaskRunning = running.filter(sessionId => !rt.taskOwners?.has(sessionId))
      const places = nonTaskRunning.map(whereOf)
      if (activeTasks.length > 0) {
        await rt.stopAllTasksOfBot?.(target, why)
        places.push(`${activeTasks.length} background task${activeTasks.length === 1 ? '' : 's'}`)
      }
      for (const sessionId of nonTaskRunning) {
        const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
        agent?.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })
      }
      if (places.length === 0 && openWorks.length > 0) {
        places.push(`${openWorks.length} open work${openWorks.length === 1 ? '' : 's'}`)
      }
      await sendSilentNote({
        senderId: sender.id,
        senderName: sender.name,
        senderAddress: rt.returnAddress?.({ sessionId: exec.agent?.id, botId: sender.id }),
        targetId: target.id,
        role: 'stopped',
        text: why,
      }).catch(error => rt.warn?.('ds-bot: silent stop notice failed: %s', error))
      void rt.kickScheduler?.().catch(() => {})
      return `Stopped ${target.name} in ${places.join(' and ')}. The reason was logged silently; ${target.name} was not woken to reply.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'create_bot',
    description: 'Main Bot only. Create a new Bot on the user\'s team. It appears in the sidebar and greets the user.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short display name, e.g. "Researcher" or "Editor"' },
      role: { type: 'string', required: true, description: 'Two-to-four character role label shown under the name' },
      instructions: { type: 'string', required: true, description: 'What this Bot is responsible for and how it should work' },
      brief: { type: 'string', description: 'Why the user wants it, passed to the new Bot as its first context' },
      model: { type: 'string', description: 'Model the Bot runs on, as provider/model or a model id. Only when the user names one; otherwise the team default model from DS Bot settings, or the model you run on.' },
      effort: { type: 'string', description: 'Thinking level for the model, as list_bot_models shows it. Only when the user names one.' },
      work_dir: WORK_DIR_PARAM,
      section: SECTION_PARAM,
      avatar: AVATAR_PARAM,
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (!rt.isMain(rt.selfOf(exec.agent?.id))) return 'Only the Main Bot can create Bots. Ask the Main Bot instead.'
      try {
        const avatar = args.avatar ? await readPhoto(args.avatar, exec) : undefined
        const workDir = args.work_dir ? await rt.cleanWorkDir(args.work_dir) : undefined
        const name = String(args.name ?? '').trim()
        await rt.approveFolder(exec, { path: workDir, who: { en: `the new Bot ${name}`, zh: `新 Bot ${name} ` } })
        const creator = callerBot(exec)
        const served = new Set((await rt.catalog()).filter(entry => entry.needsKey !== true && rt.isLocalAgentRef?.(entry.ref) !== true).map(entry => entry.ref))
        const fallback = [state.prefs.defaultBotModel, creator?.model].find(ref => ref && served.has(ref))
        const model = args.model || fallback
        const bot = await rt.createBot({ name: args.name, role: args.role, instructions: args.instructions, brief: args.brief, avatar: avatar === undefined ? undefined : { image: avatar }, model, workDir, effort: args.effort, section: args.section, createdBy: creator?.id })
        return `Created ${bot.name}${workDir ? `, working in ${workDir}` : ''}. It is greeting the user now.`
      } catch (error) {
        return `Could not create the Bot: ${error.message}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'update_bot',
    description: 'Change a Bot\'s name, role, color, profile picture, model, thinking level, working folder, extra folders, or instructions. Every Bot may change itself; only a Main Bot may change another Bot.',
    parameters: {
      bot: { type: 'string', description: 'Current name of the Bot to change; leave out to change yourself' },
      name: { type: 'string', description: 'New name' },
      role: { type: 'string', description: 'New role label' },
      instructions: { type: 'string', description: 'Replacement instructions' },
      color: { type: 'string', description: `One of ${[...COLORS, ...EXTRA_COLORS].join(', ')}` },
      avatar: { ...AVATAR_PARAM, description: `${AVATAR_PARAM.description} An empty string removes the photo and shows the Bot's character again.` },
      model: { type: 'string', description: 'Move the Bot to another model, as provider/model or a model id. It stays on what it runs on: only the user moves a Bot between DS Bot models and a local agent CLI, or between two CLIs, in its settings.' },
      effort: { type: 'string', description: 'Thinking level for the Bot\'s model, as list_bot_models shows; an empty string returns to the model\'s default' },
      work_dir: { ...WORK_DIR_PARAM, description: `${WORK_DIR_PARAM.description}; an empty string returns it to the team workspace` },
      extra_dirs: EXTRA_DIRS_PARAM,
      section: { ...SECTION_PARAM, description: `${SECTION_PARAM.description}; an empty string removes the Bot from its section (Main Bot only)` },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const caller = rt.botOf(self)
      if (caller === undefined) return 'Only Bots on the team can use update_bot.'
      const bot = args.bot ? rt.findBot(args.bot) : caller
      if (bot === undefined) return `No Bot named ${args.bot}.`
      if (bot.id !== caller.id && !rt.isMain(self)) return 'Only a Main Bot can change another Bot. Leave out bot to change yourself, or ask a Main Bot with delegate_work.'
      try {
        const { name: newName, role, instructions, color, model, effort, section } = args
        let image
        if (args.avatar !== undefined) {
          const input = typeof args.avatar === 'string' ? args.avatar.trim() : args.avatar
          image = input === null || input === '' ? null : await readPhoto(input, exec)
        }
        const moving = typeof args.work_dir === 'string'
        const workDir = moving ? await rt.cleanWorkDir(args.work_dir) : undefined
        if (moving && workDir !== bot.workDir) await rt.approveFolder(exec, { path: workDir, botId: bot.id, who: { en: bot.name, zh: ` ${bot.name} ` } })
        const extraDirs = args.extra_dirs === undefined ? undefined : await rt.cleanExtraDirs(args.extra_dirs)
        if (extraDirs !== undefined) await rt.approveExtraDirs(exec, { paths: extraDirs, before: bot.extraDirs, botId: bot.id, extra: true, who: { en: bot.name, zh: ` ${bot.name} ` } })
        const avatar = image === undefined ? undefined : { ...rt.botOf(bot.id)?.avatar, image }
        const next = await rt.updateBot(bot.id, { name: newName, role, instructions, color, ...(avatar !== undefined ? { avatar } : {}), ...(model ? { model } : {}), ...(effort === undefined ? {} : { effort }), ...(section === undefined ? {} : { section }), ...(moving ? { workDir: workDir ?? '' } : {}), ...(extraDirs === undefined ? {} : { extraDirs }) }, self, exec.agent?.id)
        const extras = extraDirs === undefined ? '' : extraDirs.length === 0 ? (bot.id === caller.id ? ' You have no extra folders now.' : ' It has no extra folders now.') : ` ${bot.id === caller.id ? 'You' : 'It'} also work${bot.id === caller.id ? '' : 's'} in ${extraDirs.join(', ')}.`
        if (!moving) return `Updated ${next.name}.${extras}`
        const folder = workDir ?? 'the team workspace'
        return bot.id === caller.id ? `Updated ${next.name}. From your next step on, you work in ${folder}.${extras}` : `Updated ${next.name}. It now works in ${folder}.${extras}`
      } catch (error) {
        return `Could not update the Bot: ${error.message}`
      }
    },
  }))

  ctx.on('tools/execute', async (exec, next) => {
    const cd = exec.name === WORKING_DIRECTORY_TOOL && typeof exec.arguments?.cd === 'string' ? exec.arguments.cd : ''
    const session = exec.agent?.session
    if (cd === '' || session === undefined) return next()
    await rt.load()
    const bot = callerBot(exec)
    if (bot === undefined) return next()
    const taskEntry = rt.taskBySession?.(exec.agent.id)?.task
    const room = rt.roomOf(rt.groupOwners.get(exec.agent.id)?.roomId ?? taskEntry?.roomId)
    const taskDir = taskEntry?.workDir !== undefined ? (taskEntry.workDir ?? undefined) : rt.workDirOf({ botId: bot.id, roomId: room?.id })
    const home = taskDir ?? rt.teamFolder()
    const target = await rt.folderAt(rt.sessionFolder(session), cd)
    if (target === undefined || !(await rt.isFolder(target)) || home === undefined || within(target, await rt.real(home))) return next()
    for (const dir of rt.extraDirsOf({ botId: bot.id, roomId: room?.id })) {
      if (within(target, await rt.real(dir))) return next()
    }
    if (room?.workDir) throw new Error(`Every member of "${room.name}" works in ${room.workDir} here, so you stay inside it. The user or a Main Bot can change the group's folder.`)
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(`Your working folder cannot change now: ${readOnly}`)
    if (unquote(target) !== target) throw new Error(`${JSON.stringify(target)} cannot be a working folder: its name starts or ends with a space or a quote mark.`)
    const workDir = await rt.workFolder(target)
    if (taskEntry !== undefined) {
      if (bot.private === true && bot.workDir !== undefined && !within(target, await rt.real(bot.workDir))) {
        throw new Error(`${bot.name} is a private Bot and its background tasks must stay inside ${bot.workDir}.`)
      }
      await rt.checkPrivacyChange(bot, { moving: true, workDir })
      await rt.approveFolder(exec, { path: workDir, sessions: [exec.agent.id], who: { en: `${bot.name}'s background task`, zh: `${bot.name} 的后台任务` } })
      const result = await next()
      if (result?.isError !== true) {
        taskEntry.workDir = workDir ?? null
        await rt.save()
      }
      return result
    }
    if (room !== undefined) {
      await rt.checkPrivacyChange(bot, { moving: true, workDir })
      await rt.approveFolder(exec, { path: workDir, places: [{ sessionId: exec.agent.id, preset: room.permission ?? bot.permission }], who: { en: bot.name, zh: ` ${bot.name} ` } })
      const result = await next()
      if (result?.isError !== true) {
        ;(room.memberDirs ??= {})[bot.id] = workDir ?? null
        await rt.save()
      }
      return result
    }
    await rt.approveFolder(exec, { path: workDir, botId: bot.id, who: { en: bot.name, zh: ` ${bot.name} ` } })
    const result = await next()
    if (result?.isError !== true) await rt.updateBot(bot.id, { workDir: workDir ?? '' }, rt.selfOf(exec.agent?.id))
    return result
  })

  rt.teamTools.push(defineTool({
    name: 'list_bot_models',
    description: 'List the models a Bot can run on, as provider/model refs for create_bot and update_bot. A model in use also lists the thinking levels it serves.',
    parameters: {},
    output,
    async execute() {
      const models = await rt.catalog({ fresh: true })
      if (models.length === 0) return 'No models are configured. Ask the user to add one in Settings → Models.'
      const fallback = rt.defaultRef()
      return models.map((entry) => {
        const levels = entry.reasoning?.efforts?.map(effort => effort.id) ?? []
        const thinking = levels.length > 0 ? `, thinking: ${levels.join(', ')}${entry.reasoning.defaultEffort === undefined ? '' : ` (default: ${entry.reasoning.defaultEffort})`}` : ''
        const local = rt.isLocalAgentRef?.(entry.ref) === true ? `, runs on the local agent ${entry.providerName}` : ''
        return `- ${entry.ref}${entry.name !== entry.id ? ` (${entry.name})` : ''}${local}${entry.input?.includes('image') ? ', reads images' : ''}${entry.ref === fallback ? ', default' : ''}${thinking}`
      }).join('\n')
    },
  }))

  const nameList = value => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、]/) : [])
    .map(item => String(item ?? '').trim()).filter(Boolean)
  const resolveBots = (refs) => {
    const bots = []
    const unknown = []
    for (const ref of nameList(refs)) {
      const bot = rt.findBot(ref)
      if (bot === undefined) unknown.push(ref)
      else if (!bots.includes(bot)) bots.push(bot)
    }
    return { bots, unknown }
  }

  rt.teamTools.push(defineTool({
    name: 'create_group',
    description: 'Main Bot only. Create a group chat with the user and some Bots. You join it as its admin unless you name another member.',
    parameters: {
      members: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact names of the other Bots to add; you are added automatically' },
      name: { type: 'string', description: 'Group name; defaults to the member names' },
      notice: { type: 'string', description: 'Shared instructions every member reads before speaking in this group; at most 2000 characters' },
      avatar: { ...AVATAR_PARAM, description: `${AVATAR_PARAM.description} Optional; without one the group shows its members.` },
      admin: { type: 'string', description: 'Member who leads the group; defaults to you' },
      mode: MODE_PARAM,
      section: SECTION_PARAM,
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can create group chats. Ask a Main Bot instead.'
      const { bots, unknown } = resolveBots(args.members)
      if (unknown.length > 0) return `No Bot named ${unknown.join(', ')}. Team: ${teamNames()}`
      const admin = args.admin ? rt.findBot(args.admin) : rt.botOf(self)
      if (admin === undefined) return `No Bot named ${args.admin}. Team: ${teamNames()}`
      const members = [...new Set([self, ...bots.map(bot => bot.id), admin.id])]
      try {
        const hadRooms = Object.keys(state.rooms).length > 0
        const given = typeof args.avatar === 'string' ? args.avatar.trim() : ''
        const photo = given === '' ? undefined : { image: await readPhoto(given, exec) }
        const room = await rt.createRoom({ members, name: args.name, avatar: photo, notice: args.notice, mode: args.mode, admin: admin.id, section: args.section, createdBy: self })
        if (!hadRooms) rt.refreshToolScopeForSession?.(exec.agent?.id)
        return `Created group "${room.name}" with ${room.members.map(id => rt.botOf(id).name).join(', ')}. ${admin.id === self ? 'You are' : `${admin.name} is`} its admin. It is in the user's sidebar; use post_to_group to start a discussion there.`
      } catch (error) {
        return `Could not create the group: ${error.message}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'update_group',
    description: 'Change a group chat: rename it, set its notice or photo, add or remove members, change its admin or reply mode. Main Bots may change any group; a group\'s admin may change its own group.',
    parameters: {
      group: GROUP_REF,
      name: { type: 'string', description: 'New group name; an empty string names it after its members again' },
      avatar: { ...AVATAR_PARAM, description: `${AVATAR_PARAM.description} An empty string removes the photo and shows the members again.` },
      notice: { type: 'string', description: 'Replacement notice, the shared instructions every member reads; an empty string clears it; at most 2000 characters' },
      add_members: { type: 'array', items: { type: 'string' }, description: 'Exact names of Bots to add' },
      remove_members: { type: 'array', items: { type: 'string' }, description: 'Exact names of Bots to remove' },
      admin: { type: 'string', description: 'Member to make the admin; "none" leaves the group without one (Main Bots only)' },
      mode: MODE_PARAM,
      work_dir: { ...WORK_DIR_PARAM, description: `${WORK_DIR_PARAM.description}. Every member works there in this group; an empty string lets each member work in its own folder again (Main Bots only)` },
      extra_dirs: { ...EXTRA_DIRS_PARAM, description: `${EXTRA_DIRS_PARAM.description}. Every member also works there in this group (Main Bots only)` },
      section: { ...SECTION_PARAM, description: `${SECTION_PARAM.description}; an empty string removes the group from its section (Main Bots only)` },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use update_group.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      const moving = typeof args.work_dir === 'string'
      if ((moving || args.extra_dirs !== undefined) && !rt.isMain(self)) return `Only a Main Bot can set the folder of "${room.name}".`
      if (args.section !== undefined && !rt.isMain(self)) return `Only a Main Bot can move "${room.name}" between sidebar sections.`
      const add = resolveBots(args.add_members)
      const remove = resolveBots(args.remove_members)
      const unknown = [...add.unknown, ...remove.unknown]
      if (unknown.length > 0) return `No Bot named ${unknown.join(', ')}. Team: ${teamNames()}`
      let admin
      if (args.admin !== undefined && args.admin !== '') {
        if (/^(none|nobody|null|无|没有)$/i.test(String(args.admin).trim())) admin = null
        else {
          admin = rt.findBot(args.admin)?.id
          if (admin === undefined) return `No Bot named ${args.admin}. Team: ${teamNames()}`
        }
      }
      try {
        let photo
        if (args.avatar !== undefined) {
          const input = typeof args.avatar === 'string' ? args.avatar.trim() : args.avatar
          photo = input === null || input === '' ? null : { image: await readPhoto(input, exec) }
        }
        const workDir = moving ? await rt.cleanWorkDir(args.work_dir) : undefined
        const targetDir = moving ? workDir : room.workDir
        const removing = new Set(remove.bots.map(bot => bot.id))
        const joining = add.bots.filter(bot => !room.members.includes(bot.id) && !removing.has(bot.id))
        if (moving && workDir !== room.workDir && workDir !== undefined) {
          const members = [...room.members.filter(id => !removing.has(id)), ...joining.map(bot => bot.id)]
          await rt.approveFolder(exec, { path: workDir, room, botIds: members, who: { en: `every member of "${room.name}"`, zh: `群聊「${room.name}」的成员` } })
        } else if (joining.length > 0 && targetDir !== undefined) {
          const names = joining.map(bot => bot.name)
          await rt.approveFolder(exec, { path: targetDir, room, botIds: joining.map(bot => bot.id), who: { en: names.join(', '), zh: ` ${names.join('、')} ` } })
        }
        const extraDirs = args.extra_dirs === undefined ? undefined : await rt.cleanExtraDirs(args.extra_dirs)
        if (extraDirs !== undefined) {
          const members = [...room.members.filter(id => !removing.has(id)), ...joining.map(bot => bot.id)]
          await rt.approveExtraDirs(exec, { paths: extraDirs, before: room.extraDirs, room, botIds: members, who: { en: `every member of "${room.name}"`, zh: `群聊「${room.name}」的成员` } })
        }
        const kept = (extraDirs ?? room.extraDirs ?? []).filter(path => (room.extraDirs ?? []).includes(path))
        if (joining.length > 0 && kept.length > 0) {
          const names = joining.map(bot => bot.name)
          await rt.approveExtraDirs(exec, { paths: kept, room, botIds: joining.map(bot => bot.id), who: { en: names.join(', '), zh: ` ${names.join('、')} ` } })
        }
        if (targetDir === undefined && room.permission !== undefined) {
          const exposed = moving && room.workDir !== undefined
            ? [...new Set([...room.members.filter(id => !removing.has(id)), ...joining.map(bot => bot.id)])].map(id => rt.botOf(id)).filter(Boolean)
            : joining
          for (const bot of exposed) {
            if (!(moving && room.workDir !== undefined) && Object.hasOwn(room.memberDirs ?? {}, bot.id)) continue
            const who = { en: bot.name, zh: ` ${bot.name} ` }
            if (bot.workDir) await rt.approveFolder(exec, { path: bot.workDir, room, botIds: [bot.id], who })
            if (!rt.onLocalAgent(bot)) {
              await rt.approveExtraDirs(exec, { paths: bot.extraDirs ?? [], before: extraDirs ?? room.extraDirs, room, botIds: [bot.id], who })
            }
          }
        }
        const { room: next, changes } = await rt.updateRoom(room.id, {
          name: args.name,
          notice: args.notice,
          mode: args.mode,
          admin,
          add: add.bots.map(bot => bot.id),
          remove: remove.bots.map(bot => bot.id),
          ...(args.section === undefined ? {} : { section: args.section }),
          ...(moving ? { workDir: workDir ?? '' } : {}),
          ...(extraDirs === undefined ? {} : { extraDirs }),
          ...(photo === undefined ? {} : { avatar: photo }),
        }, self)
        return changes.length === 0 ? `Nothing changed in "${next.name}".` : `Updated "${next.name}": ${changes.join('; ')}.`
      } catch (failure) {
        return `Could not update "${room.name}": ${failure.message}`
      }
    },
  }))

  const todoCount = (room) => {
    const todos = room.todos ?? []
    const open = todos.filter(item => item.done !== true).length
    return { todos, open, done: todos.length - open }
  }
  const todoLines = (room) => {
    const { todos, open, done } = todoCount(room)
    if (todos.length === 0) return `The shared to-do list of "${room.name}" is empty. Add one with action "add".`
    const order = [...todos].sort((a, b) => Number(a.done === true) - Number(b.done === true) || (a.createdAt ?? 0) - (b.createdAt ?? 0))
    return [
      `Shared to-do list of "${room.name}" (${open} open, ${done} done):`,
      ...order.map(item => `- [${item.done === true ? 'x' : ' '}] ${item.text} (todo ${item.id.slice(0, 8)})`),
    ].join('\n')
  }
  const findTodo = (room, ref) => {
    const wanted = String(ref ?? '').trim()
    if (wanted === '') return { error: 'Which to-do? Pass the id from the list.' }
    const exact = (room.todos ?? []).find(item => item.id === wanted)
    if (exact !== undefined) return { todo: exact }
    const matches = (room.todos ?? []).filter(item => item.id.startsWith(wanted))
    if (matches.length === 1) return { todo: matches[0] }
    if (matches.length > 1) return { error: `Several to-dos start with "${wanted}". Use a longer id.` }
    return { error: `No to-do with id "${wanted}" on the list.` }
  }

  rt.teamTools.push(defineTool({
    name: 'group_todo',
    description: 'The shared to-do list of a group chat. Every member reads and changes the same list, and the user sees it in the group\'s details. List it, add one item, tick an item done or not done, remove one item, or clear the completed items. The list holds at most 100 items; when it is full, remove an item or clear completed ones before adding. Nothing is dropped on its own. Add, remove, or clear only what the user asked for.',
    parameters: {
      group: GROUP_REF,
      action: {
        type: 'string',
        enum: ['list', 'add', 'check', 'remove', 'clear'],
        required: true,
        description: '"list" reads the list; "add" adds one item with text; "check" ticks one item by id, or unticks it with done: false; "remove" deletes one item by id; "clear" deletes every completed item',
      },
      text: { type: 'string', description: 'The to-do item, one line, at most 200 characters (action "add")' },
      id: { type: 'string', description: 'The to-do id from the list, or its first characters (action "check" or "remove")' },
      done: { type: 'boolean', description: 'true ticks the item, false unticks it; defaults to true (action "check")' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use a group to-do list.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      const action = String(args.action ?? '').trim()
      if (action === 'list') return todoLines(room)
      try {
        if (action === 'add') {
          const item = await rt.addRoomTodo(room.id, args.text, self)
          const { open } = todoCount(room)
          return `Added "${item.text}" to the shared to-do list of "${room.name}" (${open} open, todo ${item.id.slice(0, 8)}).`
        }
        if (action === 'check') {
          const found = findTodo(room, args.id)
          if (found.error) return found.error
          const item = await rt.setRoomTodoDone(room.id, found.todo.id, args.done === undefined ? true : args.done === true, self)
          const { open } = todoCount(room)
          return `${item.done === true ? 'Ticked' : 'Unticked'} "${item.text}" (${open} open).`
        }
        if (action === 'remove') {
          const found = findTodo(room, args.id)
          if (found.error) return found.error
          const item = await rt.removeRoomTodo(room.id, found.todo.id)
          const { open } = todoCount(room)
          return `Removed "${item.text}" from the shared to-do list of "${room.name}" (${open} open).`
        }
        if (action === 'clear') {
          const removed = await rt.clearDoneRoomTodos(room.id)
          const { open } = todoCount(room)
          if (removed.length === 0) return `No completed to-dos to clear on "${room.name}" (${open} open).`
          const noun = removed.length === 1 ? 'to-do' : 'to-dos'
          return `Cleared ${removed.length} completed ${noun} from "${room.name}" (${open} open).`
        }
        return 'Use action "list", "add", "check", "remove" or "clear".'
      } catch (failure) {
        return `Could not change the to-do list of "${room.name}": ${failure.message}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'delete_group',
    description: 'Main Bot only. Delete a group chat; its history is archived. Only when the user asks.',
    parameters: { group: GROUP_REF },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can delete group chats.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      if (rt.roomBusy(room.id)) return `"${room.name}" is in the middle of a round. Delete it after the round ends.`
      await rt.deleteRoom(room.id)
      return `Deleted "${room.name}". Its history is archived.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'post_to_group',
    description: 'Post into a group chat as yourself. Main Bots may post into any group; others only into their groups. A notice never wakes anyone. To ask for work, address members with @Name, or use intent "request" as Main Bot or admin to start a discussion. The final outcome of a request comes back once the group finishes; set report_back false to leave it in the group.',
    parameters: {
      group: GROUP_REF,
      message: { type: 'string', required: true, description: 'What to say; write "@Name" to choose who answers, and a name without "@" to only mention a member' },
      intent: { type: 'string', enum: ['notice', 'request'], description: 'A notice is visible but never calls members, even if the body contains @names. A request invites answers. Without named members, explicitly use request to open a discussion.' },
      report_back: { type: 'boolean', description: 'Send the group\'s final replies back to you as a new message once its work finishes (default true when your post calls members; set false for a one-way notice)' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const sender = rt.botOf(self)
      if (sender === undefined) return 'Only Bots on the team can use post_to_group.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      const member = !rt.isMain(self) && !rt.isAdminOf(room, self)
      const info = rt.live.get(exec.agent?.id)?.info
      if (info?.role === 'room' && info.roomId === room.id) return `You are speaking in "${room.name}" right now. Write your message as your reply instead.`
      const folder = rt.sessionFolder?.(exec.agent?.session ?? exec.agent)
      const text = absoluteLinks(String(args.message ?? '').trim(), folder)
      if (text === '') return 'Write a message to post.'
      const spans = mentionSpans(text, room.members.map(rt.botOf).filter(Boolean))
      const named = []
      for (const span of spans) {
        if (span.bot && span.bot.id !== self && !named.includes(span.bot.id)) named.push(span.bot.id)
      }
      const mentions = { ids: named, all: spans.some(span => span.all === true) }
      const receipt = info?.role === 'report' && info.roomId === room.id
      const notice = args.intent === 'notice' || (args.intent !== 'request'
        && (receipt || (args.report_back !== true && named.length === 0 && !(mentions.all && !member))))
      if (notice && args.report_back === true) return 'A notice calls nobody and cannot report back. Use intent "request" to ask for work.'
      if (!notice && member && named.length === 0 && args.report_back === true) {
        return 'Nobody would answer: your post only calls the members you name. Write "@Name" for each member who should answer, or post with report_back: false.'
      }
      const reportBack = !notice && !(member && named.length === 0) && args.report_back !== false
      const long = await rt.attachLong(text, `Post from ${sender.name}.txt`)
      if (long === undefined) return tooLong(text)

      const taskOwner = rt.taskOwners?.get(exec.agent?.id)
      const fromTaskId = reportBack && taskOwner !== undefined ? taskOwner.taskId : undefined
      const activeWork = reportBack ? rt.resolveWorkForSession?.(exec.agent?.id) : undefined
      const parentWorkId = activeWork?.workId
      const callerReturn = rt.returnAddress?.({ sessionId: exec.agent?.id, botId: self, workId: parentWorkId })
      const reportId = reportBack ? randomUUID() : undefined
      const sub = reportBack ? reportId : undefined
      const callerOrigin = callerImOrigin(exec)
      const imOrigin = reportBack ? callerOrigin : undefined
      const missingFiles = folder === undefined ? [] : missingFileRefs(text, folder)
      const claims = missingFiles.length > 0 ? { missingFiles } : undefined

      try {
        await rt.postToRoom(room, sender, long.text, {
          mentions,
          externalPost: true,
          ...(notice ? { route: roomNote(), quiet: true } : named.length > 0 ? { route: roomRequest(named) } : {}),
          ...(claims ? { claims } : {}),
          ...(callerOrigin ? { callerOrigin } : {}),
          ...(reportBack ? {
            reportBack: true,
            reportId,
            ...(parentWorkId ? { parentWorkId } : {}),
            ...(callerReturn ? { returnAddress: callerReturn } : {}),
            ...(fromTaskId ? { fromTaskId } : {}),
            ...(imOrigin ? { imOrigin } : {}),
            ...callerRoom(exec),
            ...callerPart(exec),
          } : {}),
          ...(member ? { member: true } : {}),
          ...(sub ? { sub } : {}),
          ...(long.length ? { length: long.length } : {}),
        }, long.files)
      } catch (failure) {
        if (failure?.delivered !== true && reportId !== undefined) {
          rt.dropRoomReport?.(reportId)
        }
        return `Could not post in "${room.name}": ${failure.message}`
      }
      if (member && named.length === 0) return `Posted in "${room.name}", where the user and its members read it. Nobody answers it: your post only calls the members you name with @Name.`
      if (notice) return `Posted in "${room.name}" as a notice. Nobody answers it.`
      if (named.length > 0) {
        const turn = turnOf(exec)
        const earlier = calledInPosts.get(exec.agent?.id)
        const calls = new Map(earlier !== undefined && earlier.turn === turn ? earlier.calls : [])
        for (const id of named) calls.set(id, room.name)
        calledInPosts.set(exec.agent?.id, { turn, calls })
      }
      const parentResolved = parentWorkId ? rt.resolveWork?.(parentWorkId) : undefined
      const asker = parentResolved !== undefined && rt.ownsWork?.(self, parentWorkId) ? rt.botOf(parentResolved.work.from)?.name : undefined
      const waits = asker ? ` End your turn when you have handed on everything: the replies bring you back to this work, and your answer goes to ${asker} once all of it is back.` : ''
      return `Posted in "${room.name}". Members reply there, where the user reads them${reportBack ? '; their final outcome also comes back to you as a new message once the group finishes' : ', and nothing comes back to you'}.${waits}`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'ask_user',
    description: 'Show the user a short multiple-choice question card in the chat (in your own chat, the user can also type their own answer). Group cards accept listed choices only; do not set allowCustom in a group. Calling it ends your turn; the chosen answer arrives later as the user\'s next message.',
    parameters: {
      question: { type: 'string', required: true, description: 'One short question' },
      options: {
        type: 'array',
        required: true,
        description: 'Two to four answers',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true, description: 'Short answer shown on the option' },
            description: { type: 'string', description: 'Optional one-line explanation under the label' },
          },
        },
      },
      detail: { type: 'string', description: 'Optional one-line context shown under the question' },
      multiSelect: { type: 'boolean', description: 'Allow choosing several options' },
      allowCustom: { type: 'boolean', description: 'Also offer a field for an answer in the user\'s own words' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      if (rt.taskOwners?.has(id)) return 'Background tasks cannot show question cards directly. Put the question in your reply so it goes back to your own chat, where you can ask the user and start a follow-up task if needed.'
      const owner = rt.groupOwners.get(id)
      if (owner !== undefined && !rt.roomHasImOrigin?.(owner.roomId)) return 'Question cards only work in your own chat. In a group, ask in your message instead.'
      if (owner !== undefined && args.allowCustom === true) return 'Group question cards accept listed choices only. Call ask_user with allowCustom: false, or ask for free text in your message instead.'
      if (owner === undefined && !rt.chatOwners.has(id)) return `Only Bots on the team can use ask_user. Use ${BLOCKING_QUESTION_TOOL} if it is available in this session, or ask the user in your reply.`
      const options = (Array.isArray(args.options) ? args.options : [])
        .map(option => (typeof option === 'string' ? { label: option } : option ?? {}))
        .map(option => ({
          label: String(option.label ?? '').trim(),
          ...(option.description ? { description: String(option.description).trim() } : {}),
        }))
        .filter(option => option.label !== '')
        .slice(0, 6)
      if (options.length === 0) return 'Give at least one option.'
      const prevQuestion = rt.own(state.questions, id)
      if (prevQuestion !== undefined && ((prevQuestion.callSessionId ?? id) !== id || prevQuestion.callId !== exec.callId)) {
        rt.closeCard(id, prevQuestion, 'dismissed')
      }
      const card = {
        id: randomUUID(),
        ...(exec.callId ? { callId: exec.callId } : {}),
        question: String(args.question ?? '').trim(),
        ...(args.detail ? { detail: String(args.detail).trim() } : {}),
        options,
        multiSelect: args.multiSelect === true,
        ...(args.allowCustom === true ? { allowCustom: true } : {}),
        ...(owner === undefined ? {} : { imOrigin: rt.captureImOrigin?.(rt.roomOf(owner.roomId)?.sessionId ?? owner.roomId) }),
        askedAt: Date.now(),
      }
      state.questions[id] = card
      if (owner !== undefined) {
        rt.logRoom(rt.roomOf(owner.roomId), { who: rt.botOf(owner.botId).name, botId: owner.botId, questionId: card.id, text: `Asked: ${card.question}\n${options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')}` })
      }
      if (writableCoordDb()) {
        const work = rt.resolveWorkForSession?.(id)
        if (work !== undefined) {
          rt.coordDb.transaction(() => {
            if (prevQuestion?.id) {
              rt.coordDb.resolveWait({
                workId: work.workId,
                kind: 'user_question',
                targetId: `question:${prevQuestion.id}`,
                status: 'cancelled',
                resolution: { reason: 'dismissed' },
              })
            }
            rt.coordDb.addWait({
              workId: work.workId,
              kind: 'user_question',
              targetId: `question:${card.id}`,
              required: true,
              meta: { cardKind: 'question', sessionId: id, questionId: card.id, callId: exec.callId ?? null, question: card.question },
            })
          })
        }
      }
      await rt.save()
      yieldTurn(exec, 'waiting_user_question')
      return 'The card is on screen; the user\'s answer arrives as their next message.'
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'show_view',
    description: `${showViewDescription({ where: 'your own chat or an IM-origin group' })} IM forms and multi-select views show instructions for replying with !card <code> and typed values. Group replies must mention the Bot. Bare codes never answer cards.`,
    parameters: {
      ...showViewParameters,
      report_issue: { type: 'string', description: 'Only for DS Bot issue approval: use the exact arguments from prepare_ds_bot_issue' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      if (rt.taskOwners?.has(id)) return 'Background tasks cannot show view cards directly. Report the data or question back to your own chat, where you can show a view to the user.'
      const owner = rt.groupOwners.get(id)
      if (owner !== undefined && !rt.roomHasImOrigin?.(owner.roomId)) return 'View cards only work in your own chat. In a group, ask in your message instead.'
      if (owner === undefined && !rt.chatOwners.has(id)) return `Only Bots on the team can use show_view. Use ${BLOCKING_QUESTION_TOOL} if it is available in this session, or ask the user in your reply.`
      const checked = checkShownView(args.title, args.view)
      if (checked.error !== undefined) return checked.error
      const title = checked.title
      const view = checked.view
      if (owner !== undefined && args.report_issue !== undefined) return 'Issue reports only work in your own chat.'
      if (!checked.interactive && args.await_reply === true) return 'This view has nothing to submit; call show_view with await_reply: false.'
      if (checked.interactive && args.await_reply === false) return 'This view has controls to submit, so it waits for the user\'s answer; call show_view without await_reply: false.'
      const issueDraft = args.report_issue === undefined ? undefined : rt.claimIssueDraft?.(id, args.report_issue, checked)
      if (args.report_issue !== undefined && issueDraft === undefined) return 'This draft changed or expired. Call prepare_ds_bot_issue again and use its exact arguments.'
      const awaitReply = args.await_reply ?? checked.interactive
      if (!awaitReply) {
        if (owner !== undefined) {
          rt.logRoom(rt.roomOf(owner.roomId), { who: rt.botOf(owner.botId).name, botId: owner.botId, text: viewCardText({ title, view }) || title })
          await rt.save()
        }
        return 'The view is on screen.'
      }
      const imOrigin = rt.captureImOrigin?.(owner === undefined ? id : rt.roomOf(owner.roomId)?.sessionId ?? owner.roomId)
      const prevView = rt.own(state.views, id)
      if (prevView !== undefined && ((prevView.callSessionId ?? id) !== id || prevView.callId !== exec.callId)) {
        rt.closeCard(id, prevView, 'dismissed')
      }
      const card = {
        id: randomUUID(),
        ...(exec.callId ? { callId: exec.callId } : {}),
        title,
        view,
        ...(issueDraft === undefined ? {} : { issueDraft }),
        ...(imOrigin === undefined ? {} : { imOrigin }),
        askedAt: Date.now(),
      }
      state.views[id] = card
      if (owner !== undefined) {
        rt.logRoom(rt.roomOf(owner.roomId), { who: rt.botOf(owner.botId).name, botId: owner.botId, viewId: card.id, text: viewCardText({ title, view }) || title })
      }
      if (writableCoordDb()) {
        const work = rt.resolveWorkForSession?.(id)
        if (work !== undefined) {
          rt.coordDb.transaction(() => {
            if (prevView?.id) {
              rt.coordDb.resolveWait({
                workId: work.workId,
                kind: 'user_question',
                targetId: `view:${prevView.id}`,
                status: 'cancelled',
                resolution: { reason: 'dismissed' },
              })
            }
            rt.coordDb.addWait({
              workId: work.workId,
              kind: 'user_question',
              targetId: `view:${card.id}`,
              required: true,
              meta: { cardKind: 'view', sessionId: id, viewId: card.id, callId: exec.callId ?? null, title },
            })
          })
        }
      }
      await rt.save()
      yieldTurn(exec, 'waiting_user_view')
      return 'The view is on screen; the user\'s answer arrives as their next message.'
    },
  }))

  // --- Tool Scoping & Masking ---

  const scopeOf = id => rt.toolScopeForTurn?.(id) ?? {
    main: rt.isMain(rt.selfOf(id)),
    hasRooms: Object.keys(state.rooms ?? {}).length > 0,
    inRoom: rt.roomsOf?.(rt.selfOf(id))?.length > 0,
    isGroup: rt.groupOwners?.has(id) === true,
    isTask: rt.taskOwners?.has(id) === true,
    hasTaskRoom: rt.taskOwners?.get(id)?.roomId !== undefined,
    hasPacks: (rt.botOf(rt.selfOf(id))?.packs?.length ?? 0) > 0 || rt.hasLoadedPacks?.(id) === true,
  }
  const scopeKeyOf = (id) => {
    const s = scopeOf(id)
    return `${s.main ? 1 : 0}:${s.hasRooms ? 1 : 0}:${s.inRoom ? 1 : 0}:${s.isGroup ? 1 : 0}:${s.isTask ? 1 : 0}:${s.hasTaskRoom ? 1 : 0}:${s.hasPacks ? 1 : 0}`
  }

  const hiddenTeamToolsFor = (id) => {
    const hidden = new Set()
    if (!rt.isBotSession(id)) return hidden
    const s = scopeOf(id)
    hidden.add(RELAY_ONLY_TOOL)
    if (!s.main) {
      for (const name of MAIN_ONLY_TOOLS) hidden.add(name)
      if (!s.inRoom) {
        for (const name of GROUP_ONLY_TOOLS) hidden.add(name)
      }
    } else if (!s.hasRooms) {
      for (const name of GROUP_ONLY_TOOLS) hidden.add(name)
      hidden.add('delete_group')
    }
    if (s.isGroup) {
      hidden.add('prepare_ds_bot_issue')
    }
    if (s.isTask) {
      for (const name of TASK_HIDDEN_TEAM_TOOLS) hidden.add(name)
      if (s.hasTaskRoom) hidden.add('delegate_work')
    }
    if (!s.hasPacks) {
      for (const name of CATALOG_PACK_TOOLS) hidden.add(name)
    }
    return hidden
  }
  const hiddenSessionTools = (id) => {
    const hidden = hiddenTeamToolsFor(id)
    if (!rt.isBotSession(id)) return hidden
    for (const name of rt.hiddenBuiltinTools(id)) hidden.add(name)
    if (scopeOf(id).isTask) {
      for (const name of TASK_HIDDEN_GLOBAL_TOOLS) hidden.add(name)
    }
    return hidden
  }

  const scoped = new Map()
  const disposeScopedTool = (held, name) => {
    const dispose = held.toolLifts?.get(name)
    held.toolLifts?.delete(name)
    if (typeof dispose === 'function') {
      const idx = held.disposers.indexOf(dispose)
      if (idx !== -1) held.disposers.splice(idx, 1)
    }
    held.added?.delete(name)
    held.unlisted?.delete(name)
    if (typeof dispose === 'function') {
      try { dispose() } catch { /* already disposed */ }
    }
  }
  const unscope = (id) => {
    const held = scoped.get(id)
    if (held === undefined) return
    scoped.delete(id)
    clearTimeout(held.retryTimer)
    for (const lift of held.taskGlobalLifts ?? []) { try { lift() } catch { /* already lifted */ } }
    held.taskGlobalLifts = []
    held.taskGlobalDenied = new Set()
    for (const lift of held.connectorLifts ?? []) { try { lift() } catch { /* already lifted */ } }
    held.connectorLifts = []
    for (const lift of held.pluginLifts ?? []) { try { lift() } catch { /* already lifted */ } }
    held.pluginLifts = []
    for (const dispose of held.disposers) {
      try { dispose() } catch (error) { rt.warn('ds-bot: a scoped tool of %s was not removed: %s', id, error) }
    }
  }
  const syncScopedSession = (id) => {
    if (id === undefined) return
    const held = scoped.get(id)
    if (held?.agent !== undefined) hideBotUnusedTools(held.agent)
  }
  const syncScopedTools = () => {
    for (const id of scoped.keys()) {
      if (!rt.isBotSession(id) && rt.roomOf(id) === undefined) unscope(id)
    }
    const seen = new Set()
    for (const agent of ctx.get?.('agents')?.list?.() ?? []) {
      if (agent?.session?.id !== undefined) seen.add(agent.session.id)
      hideBotUnusedTools(agent)
    }
    for (const [id, held] of scoped) {
      if (!seen.has(id) && held.agent !== undefined) hideBotUnusedTools(held.agent)
    }
  }
  ctx.effect(() => () => { for (const id of scoped.keys()) unscope(id) }, 'ds-bot: scoped team tools')

  const retryBotTools = (agent, held) => {
    if (held.retryTimer !== undefined || (held.retries ?? 0) >= 5) return
    held.retryTimer = setTimeout(() => {
      held.retryTimer = undefined
      held.retries = (held.retries ?? 0) + 1
      if (scoped.get(agent.session?.id) !== held) return
      shareBotTools(agent)
    }, 1000)
    held.retryTimer.unref?.()
  }

  const registerless = new WeakSet()
  const shareBotTools = (agent) => {
    if (agent === undefined) return
    const id = agent.session?.id
    const owns = rt.isBotSession(id)
    const relayOnly = !owns && rt.roomOf(id) !== undefined
    const wanted = owns || relayOnly
    let held = scoped.get(id)
    const self = owns ? rt.botOf(rt.selfOf(id)) : undefined
    const localBot = rt.isLocalAgentRef?.(self?.model ?? self?.appliedModel) === true
    if (held !== undefined && (!wanted || held.agent !== agent || held.relay !== relayOnly || (held.tools === true && held.local !== localBot))) {
      unscope(id)
      held = undefined
    }
    if (!wanted) return
    if (held === undefined) {
      held = { agent, relay: relayOnly, tools: false, restricted: false, disposers: [], unlisted: new Set() }
      scoped.set(id, held)
      agent.ctx?.effect?.(() => () => { if (scoped.get(id) === held) unscope(id) })
    }
    const botId = owns ? rt.selfOf(id) : undefined
    const scopedDenied = botId ? (rt.pluginDeniedRules?.(botId)?.scopedDenied ?? new Set()) : new Set()
    const hiddenScoped = relayOnly ? null : hiddenTeamToolsFor(id)
    const scopeKey = relayOnly ? 'relay' : scopeKeyOf(id)
    if (held?.tools === true) {
      if (!relayOnly && held.scopeKey !== scopeKey) {
        held.scopeKey = scopeKey
        for (const name of held.added ?? []) {
          if (hiddenScoped.has(name)) disposeScopedTool(held, name)
        }
      }
      for (const def of [...rt.teamTools, ...(localBot ? (rt.localAgentTools ?? []) : [])]) {
        if (relayOnly && def.name !== 'group_relay') continue
        if (!relayOnly && hiddenScoped.has(def.name)) continue
        if (!relayOnly && scopedDenied.has(def.name)) {
          ;(held.pluginHiddenScoped ??= new Set()).add(def.name)
          continue
        }
        if (held.added?.has(def.name) === true) continue
        try {
          const dispose = agent.ctx.tools.register(def)
          if (typeof dispose === 'function') {
            ;(held.toolLifts ??= new Map()).set(def.name, dispose)
            held.disposers.push(dispose)
          }
          ;(held.added ??= new Set()).add(def.name)
          held.unlisted.add(def.name)
        } catch (error) {
          if (/already registered/i.test(String(error?.message ?? error))) continue
          if (held.missed?.has(def.name) === true) continue
          ;(held.missed ??= new Set()).add(def.name)
          rt.warn('ds-bot: team tool %s not added to %s: %s', def.name, id, error)
        }
      }
      if ([...rt.teamTools, ...(localBot ? (rt.localAgentTools ?? []) : [])].some(def => (!relayOnly || def.name === 'group_relay') && (relayOnly || !hiddenScoped.has(def.name)) && !scopedDenied.has(def.name) && !held.added?.has(def.name))) {
        retryBotTools(agent, held)
      } else {
        clearTimeout(held.retryTimer)
        held.retryTimer = undefined
      }
      return
    }
    if (typeof agent.ctx?.tools?.register !== 'function') {
      if (!registerless.has(agent)) {
        registerless.add(agent)
        rt.warn('ds-bot: %s needs the team tools but its Agent cannot register them yet', id)
      }
      retryBotTools(agent, held)
      return
    }
    const disposers = []
    const failed = []
    const registered = []
    for (const def of [...rt.teamTools, ...(localBot ? (rt.localAgentTools ?? []) : [])]) {
      if (relayOnly && def.name !== 'group_relay') continue
      if (!relayOnly && hiddenScoped.has(def.name)) continue
      if (!relayOnly && scopedDenied.has(def.name)) {
        ;(held.pluginHiddenScoped ??= new Set()).add(def.name)
        continue
      }
      try {
        const dispose = agent.ctx.tools.register(def)
        if (typeof dispose === 'function') {
          disposers.push(dispose)
          held.toolLifts ??= new Map()
          held.toolLifts.set(def.name, dispose)
        }
        registered.push(def.name)
      } catch (error) {
        failed.push(`${def.name}: ${error.message ?? error}`)
      }
    }
    held.agent = agent
    held.relay = relayOnly
    held.tools = true
    held.local = localBot
    held.scopeKey = scopeKey
    held.disposers.push(...disposers)
    held.added = new Set(registered)
    scoped.set(id, held)
    for (const name of registered) held.unlisted.add(name)
    if (failed.length > 0) rt.warn('ds-bot: team tools not served to %s: %s', id, failed.join('; '))
    if (failed.length > 0) retryBotTools(agent, held)
    else {
      clearTimeout(held.retryTimer)
      held.retryTimer = undefined
    }
  }

  const addTeamTool = (def) => {
    if (rt.teamTools.some(tool => tool.name === def.name)) return
    rt.teamTools.push(def)
    for (const [id, held] of scoped) {
      if (held.relay || held.tools !== true || held.added?.has(def.name) || typeof held.agent?.ctx?.tools?.register !== 'function') continue
      if (hiddenTeamToolsFor(id).has(def.name)) continue
      const botId = rt.selfOf(id)
      if (botId && rt.pluginDeniedRules?.(botId)?.scopedDenied?.has(def.name)) {
        ;(held.pluginHiddenScoped ??= new Set()).add(def.name)
        continue
      }
      try {
        const dispose = held.agent.ctx.tools.register(def)
        if (typeof dispose === 'function') {
          held.disposers.push(dispose)
          ;(held.toolLifts ??= new Map()).set(def.name, dispose)
        }
        ;(held.added ??= new Set()).add(def.name)
        held.unlisted.add(def.name)
      } catch { /* an agent that refuses it simply lacks the tool */ }
    }
  }
  const removeTeamTool = (name) => {
    const at = rt.teamTools.findIndex(tool => tool.name === name)
    if (at !== -1) rt.teamTools.splice(at, 1)
    for (const [id, held] of scoped) {
      const dispose = held.toolLifts?.get(name)
      if (typeof dispose === 'function') {
        const index = held.disposers.indexOf(dispose)
        if (index !== -1) held.disposers.splice(index, 1)
        try { dispose() } catch (error) { rt.warn('ds-bot: a scoped tool %s of %s was not removed: %s', name, id, error) }
      }
      held.toolLifts?.delete(name)
      held.added?.delete(name)
      held.unlisted.delete(name)
    }
  }

  const maskConnectorTools = (agent, held) => {
    if (typeof agent.ctx?.tools?.restrict !== 'function' || typeof ctx.tools?.schemas !== 'function') return
    const botId = rt.selfOf(agent.session?.id)
    const prefixes = rt.connectorOffFor?.(botId) ?? []
    if (prefixes.length === 0 && (held.connectorLifts?.length ?? 0) === 0 && (held.connectorDenied?.size ?? 0) === 0) return
    const served = new Set([...ctx.tools.schemas(agent).map(schema => schema.name), ...(held.connectorDenied ?? [])])
    const deny = new Set()
    const groups = []
    for (const prefix of prefixes) {
      const names = [...served].filter(name => !deny.has(name) && name.startsWith(prefix))
      if (names.length === 0) continue
      groups.push(names)
      for (const name of names) deny.add(name)
    }
    const before = held.connectorDenied ?? new Set()
    if (deny.size === before.size && [...deny].every(name => before.has(name))) return
    for (const lift of held.connectorLifts ?? []) { try { lift() } catch { /* already lifted */ } }
    held.connectorLifts = []
    held.connectorDenied = deny
    for (const names of groups) {
      try {
        const lift = agent.ctx.tools.restrict({ deny: names })
        if (typeof lift === 'function') held.connectorLifts.push(lift)
      } catch {
        for (const name of names) {
          try {
            const lift = agent.ctx.tools.restrict({ deny: [name] })
            if (typeof lift === 'function') held.connectorLifts.push(lift)
          } catch { /* a scoped name cannot be restricted; connectors are global */ }
        }
      }
    }
  }
  const maskingPlugins = new WeakSet()
  const maskPluginTools = (agent, held) => {
    if (maskingPlugins.has(agent)) return
    maskingPlugins.add(agent)
    try {
      const botId = rt.selfOf(agent.session?.id)
      const rules = rt.pluginDeniedRules?.(botId)
      const prefixes = rules?.prefixes ?? []
      const exact = rules?.exact ?? []
      const scopedDenied = rules?.scopedDenied ?? new Set()
      const protectedTools = rules?.protectedTools ?? new Set()

      if (held.tools === true && !held.relay && typeof agent.ctx?.tools?.register === 'function') {
        const hiddenScoped = (held.pluginHiddenScoped ??= new Set())
        const hiddenTeam = hiddenTeamToolsFor(agent.session?.id)
        for (const def of rt.teamTools) {
          const shouldHide = scopedDenied.has(def.name)
          const hasLift = held.toolLifts?.has(def.name) === true
          if (shouldHide) {
            hiddenScoped.add(def.name)
            if (hasLift) disposeScopedTool(held, def.name)
          } else if (hiddenScoped.has(def.name)) {
            hiddenScoped.delete(def.name)
            if (!hiddenTeam.has(def.name) && !held.added?.has(def.name)) {
              try {
                const dispose = agent.ctx.tools.register(def)
                if (typeof dispose === 'function') {
                  held.disposers.push(dispose)
                  ;(held.toolLifts ??= new Map()).set(def.name, dispose)
                }
                ;(held.added ??= new Set()).add(def.name)
                held.unlisted?.add(def.name)
              } catch { /* ignore if unavailable */ }
            }
          }
        }
      }

      if (typeof agent.ctx?.tools?.restrict !== 'function' || typeof ctx.tools?.schemas !== 'function') return
      if (prefixes.length === 0 && exact.length === 0 && (held.pluginLifts?.length ?? 0) === 0 && (held.pluginDenied?.size ?? 0) === 0) return
      const served = new Set([...ctx.tools.schemas(agent).map(schema => schema.name), ...(held.pluginDenied ?? [])])
      const deny = new Set()
      for (const name of exact) {
        if (served.has(name) && !held.added?.has(name)) deny.add(name)
      }
      for (const prefix of prefixes) {
        if (!prefix) continue
        for (const name of served) {
          if (deny.has(name) || protectedTools.has(name) || held.added?.has(name)) continue
          if (name.startsWith(prefix)) deny.add(name)
        }
      }
      const before = held.pluginDenied ?? new Set()
      if (deny.size === before.size && [...deny].every(name => before.has(name))) return

      const prevLifts = held.pluginLifts ?? []
      held.pluginLifts = []
      held.pluginDenied = new Set()
      for (const lift of prevLifts) { try { lift() } catch { /* already lifted */ } }

      if (deny.size === 0) return
      const names = [...deny]
      const applied = new Set()
      try {
        const lift = agent.ctx.tools.restrict({ deny: names })
        if (typeof lift === 'function') held.pluginLifts.push(lift)
        for (const name of names) applied.add(name)
      } catch {
        for (const name of names) {
          try {
            const lift = agent.ctx.tools.restrict({ deny: [name] })
            if (typeof lift === 'function') held.pluginLifts.push(lift)
            applied.add(name)
          } catch { /* scoped tool cannot be restricted via inherited deny */ }
        }
      }
      held.pluginDenied = applied
    } finally {
      maskingPlugins.delete(agent)
    }
  }
  const maskingTaskGlobals = new WeakSet()
  const maskTaskGlobalTools = (agent, held) => {
    if (maskingTaskGlobals.has(agent)) return
    if (typeof agent.ctx?.tools?.restrict !== 'function' || typeof ctx.tools?.schemas !== 'function') return
    const id = agent.session?.id
    const isTask = rt.isBotSession(id) && scopeOf(id).isTask
    if (!isTask && (held.taskGlobalLifts?.length ?? 0) === 0 && (held.taskGlobalDenied?.size ?? 0) === 0) return
    maskingTaskGlobals.add(agent)
    try {
      const served = new Set([...ctx.tools.schemas(agent).map(schema => schema.name), ...(held.taskGlobalDenied ?? [])])
      const deny = new Set()
      if (isTask) {
        for (const name of TASK_HIDDEN_GLOBAL_TOOLS) {
          if (served.has(name) && !held.added?.has(name)) deny.add(name)
        }
      }
      const before = held.taskGlobalDenied ?? new Set()
      if (deny.size === before.size && [...deny].every(name => before.has(name))) return
      const prevLifts = held.taskGlobalLifts ?? []
      held.taskGlobalLifts = []
      held.taskGlobalDenied = new Set()
      for (const lift of prevLifts) { try { lift() } catch { /* already lifted */ } }
      if (deny.size === 0) return
      const names = [...deny]
      const applied = new Set()
      try {
        const lift = agent.ctx.tools.restrict({ deny: names })
        if (typeof lift === 'function') held.taskGlobalLifts.push(lift)
        for (const name of names) applied.add(name)
      } catch {
        for (const name of names) {
          try {
            const lift = agent.ctx.tools.restrict({ deny: [name] })
            if (typeof lift === 'function') held.taskGlobalLifts.push(lift)
            applied.add(name)
          } catch { /* scoped tool cannot be restricted via inherited deny */ }
        }
      }
      held.taskGlobalDenied = applied
    } finally {
      maskingTaskGlobals.delete(agent)
    }
  }
  const reapplyToolMasks = () => {
    for (const held of scoped.values()) {
      if (held.agent === undefined) continue
      try { rt.refreshShellShadows?.(held.agent) } catch (error) { rt.warn('ds-bot: shell shadow refresh failed: %s', error) }
      try { maskTaskGlobalTools(held.agent, held) } catch (error) { rt.warn('ds-bot: task tool mask failed: %s', error) }
      try { maskConnectorTools(held.agent, held) } catch (error) { rt.warn('ds-bot: connector mask failed: %s', error) }
      try { maskPluginTools(held.agent, held) } catch (error) { rt.warn('ds-bot: plugin mask failed: %s', error) }
    }
  }

  const maskHiddenTools = (agent, held, served) => {
    const groups = HIDDEN_TOOL_GROUPS.map(group => group.filter(name => served.has(name))).filter(group => group.length > 0)
    if (groups.length === 0) return
    held.restricted = true
    for (const deny of groups) {
      try {
        const lift = agent.ctx.tools.restrict({ deny })
        if (typeof lift === 'function') held.disposers.push(lift)
      } catch {
        for (const name of deny) {
          try {
            const lift = agent.ctx.tools.restrict({ deny: [name] })
            if (typeof lift === 'function') held.disposers.push(lift)
          } catch { /* Expected for names in the Agent's own scope. */ }
        }
      }
    }
  }

  const hideBotUnusedTools = (agent) => {
    try {
      rt.scopeCodeMode?.(agent)
    } catch (error) {
      rt.warn?.('ds-bot: scoping code-mode for %s failed: %s', agent?.session?.id, error)
    }
    shareBotTools(agent)
    const id = agent?.session?.id
    const shadows = rt.shadowShells?.(agent) ?? []
    if (shadows.length > 0) {
      const held = scoped.get(id) ?? { relay: false, tools: false, restricted: false, disposers: [], unlisted: new Set() }
      held.agent = agent
      held.disposers.push(...shadows)
      scoped.set(id, held)
    }
    if (agent === undefined || !rt.isBotSession(id)) return
    const held = scoped.get(id) ?? { relay: false, tools: false, restricted: false, disposers: [], unlisted: new Set() }
    held.agent = agent
    scoped.set(id, held)
    if (held.restricted !== true && typeof agent.ctx?.tools?.restrict === 'function') {
      maskHiddenTools(agent, held, new Set(ctx.tools.schemas(agent).map(schema => schema.name)))
    }
    maskTaskGlobalTools(agent, held)
    maskConnectorTools(agent, held)
    maskPluginTools(agent, held)
  }
  ctx.on('tools/change', () => {
    reapplyToolMasks()
    rt.notifyLocalAgentToolsChanged?.()
  })
  ctx.tools.guard((exec) => {
    if (!rt.isBotSession(exec.agent?.id)) return undefined
    if (exec.name === BLOCKING_QUESTION_TOOL) return `Bots cannot use ${BLOCKING_QUESTION_TOOL}. Ask with ask_user in your own chat, or ask in your reply.`
    const botId = rt.selfOf(exec.agent?.id)
    if (botId && rt.isPluginToolBlockedForBot?.(botId, exec.name)) {
      return `Tool "${exec.name}" is disabled for this Bot by the current plugin configuration.`
    }
    if (rt.taskOwners?.has(exec.agent?.id)) {
      if (exec.name === 'browser_handoff') return 'Background tasks cannot hand the browser to the user. Report back to your own chat so it can ask the user to take over.'
      if (SCHEDULE_TARGET_TOOLS.includes(exec.name)) return 'Background tasks cannot create or change schedules on a temporary task session. Report back to your own chat so it can manage schedules there.'
    }
    if (exec.name === 'schedule_edit' && exec.arguments?.action === 'update') {
      const unsupported = Object.keys(exec.arguments).filter(field => !SCHEDULE_UPDATE_FIELDS.has(field))
      if (unsupported.length > 0) return `These schedule_edit fields are not editable: ${unsupported.join(', ')}. To change frequency, send rrule with a DTSTART anchor in the intended time zone followed by an RRULE line (for example, "DTSTART;TZID=Asia/Taipei:20261118T090000\nRRULE:FREQ=HOURLY;INTERVAL=3"); this converts the task to kind rrule.`
    }
    const target = exec.arguments?.target
    if (SCHEDULE_TARGET_TOOLS.includes(exec.name) && target !== undefined && target !== 'this_session') return SCHEDULE_TARGET_REFUSAL
    return DELEGATION_TOOLS.includes(exec.name) ? DELEGATION_REFUSAL : undefined
  })
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await rt.load()
      hideBotUnusedTools(agent)
      scoped.get(agent?.session?.id)?.unlisted?.clear()
    } catch (error) {
      rt.warn('ds-bot: hiding %s on agent/created failed: %s', HIDDEN_TOOLS.join(', '), error)
    }
  })

  const filterAssembled = (agent, id, assembled) => {
    if (!rt.isBotSession(id) || assembled === undefined || assembled === null) return assembled
    const hidden = new Set([...HIDDEN_TOOLS, ...hiddenSessionTools(id)])
    const localCli = rt.contextRuntime?.isLocal?.(agent?.session ?? id) === true
    const bridged = localCli ? new Set([...rt.teamTools.map(def => def.name), 'approve_agent_action']) : undefined
    const dropTool = tool => hidden.has(tool?.name)
    const dropSection = (section) => {
      const name = section?.name
      if (HIDDEN_SECTIONS.has(name)) return true
      if (typeof name === 'string' && name.startsWith('tool:')) {
        const toolName = name.slice(5)
        if (hidden.has(toolName)) return true
        // Local agent CLIs use their own file/shell/search tools and only receive
        // DS Bot's bridged team tools over MCP; strip DSH's built-in tool prose.
        if (bridged !== undefined && !bridged.has(toolName)) return true
      }
      return false
    }
    const filterTools = Array.isArray(assembled.tools) && assembled.tools.some(dropTool)
    const filterSections = Array.isArray(assembled.sections) && assembled.sections.some(dropSection)
    if (!filterTools && !filterSections) return assembled
    return {
      ...assembled,
      ...filterTools ? { tools: assembled.tools.filter(tool => !dropTool(tool)) } : {},
      ...filterSections ? { sections: assembled.sections.filter(section => !dropSection(section)) } : {},
    }
  }

  ctx.on('system-prompt/assemble', async function scopeTeamTools(_assembly, context, next) {
    const agent = context?.agent
    if (agent === undefined) return next()
    const id = agent.session?.id ?? agent.id
    try {
      await rt.load()
      hideBotUnusedTools(agent)
    } catch (error) {
      rt.warn('ds-bot: scoping the tools of %s failed: %s', id, error)
    }
    let assembled = await next()
    const held = scoped.get(id)
    if (held?.unlisted !== undefined && held.unlisted.size > 0) {
      if (!Array.isArray(assembled?.tools)) {
        held.unlisted.clear()
      } else {
        const pending = [...held.unlisted]
        held.unlisted.clear()
        if (!(assembled.tools.length === 1 && assembled.tools[0].name === 'run_code') && typeof ctx.tools?.schemas === 'function') {
          try {
            const wanted = new Set(pending)
            const current = new Map(ctx.tools.schemas(agent).filter(schema => wanted.has(schema.name)).map(schema => [schema.name, schema]))
            let changed = false
            const tools = assembled.tools.map((tool) => {
              const schema = current.get(tool.name)
              if (schema === undefined) return tool
              changed = true
              return schema
            })
            const present = new Set(assembled.tools.map(tool => tool.name))
            for (const name of pending) {
              if (present.has(name) || !current.has(name)) continue
              changed = true
              tools.push(current.get(name))
            }
            if (changed) assembled = { ...assembled, tools }
          } catch (error) {
            rt.warn('ds-bot: listing the scoped tools of %s failed: %s', id, error)
          }
        }
      }
    }
    return filterAssembled(agent, id, assembled)
  })

  const plainSchemas = new WeakMap()
  ctx.on('llm/stream', function plainConnectorSchemas(options, next) {
    if (!Array.isArray(options.tools)) return next()
    let changed = false
    const tools = options.tools.map((tool) => {
      if (!tool.name?.startsWith('mcp__') || tool.parameters === undefined) return tool
      let entry = plainSchemas.get(tool.parameters)
      if (entry === undefined) {
        const plain = plainToolSchema(tool.parameters)
        entry = { plain, same: JSON.stringify(plain) === JSON.stringify(tool.parameters) }
        plainSchemas.set(tool.parameters, entry)
        plainSchemas.set(plain, { plain, same: true })
      }
      if (entry.same) return tool
      changed = true
      return { ...tool, parameters: entry.plain }
    })
    return changed ? ctx.llm.stream({ ...options, tools }) : next()
  })

  let goals = null
  const attachGoals = (sub) => {
    const own = sub.goals
    goals = own
    sub.effect(() => () => { if (goals === own) goals = null }, 'ds-bot: goal service')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['goals'], attachGoals)
  else if (ctx.get?.('goals') !== undefined) attachGoals({ goals: ctx.get('goals'), effect: (execute, label) => ctx.effect(execute, label) })
  const blockGoal = async (sessionId) => {
    const service = goals
    if (service === null) return
    try {
      const agent = await rt.resolveAgent(sessionId)
      const goal = service.get(agent)
      if (goal?.phase !== 'active') return
      service.block(agent, { id: goal.id, revision: goal.revision }, { code: 'not-supported', message: GOAL_REFUSAL })
    } catch (error) {
      rt.warn('ds-bot: blocking the goal in %s failed: %s', sessionId, error)
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      const id = session?.id
      if (id !== undefined) {
        calledInPosts.delete(id)
        keptUp.delete(id)
      }
      return
    }
    if (event.type !== 'goal/change' || event.data?.goal?.phase !== 'active') return
    const id = session?.id
    if (!rt.isBotSession(id) && rt.roomOf(id) === undefined) return
    setTimeout(() => void blockGoal(id), 0)
  })
  ctx.on?.('agent/disposed', ({ agent }) => {
    const id = agent?.id
    if (id === undefined) return
    calledInPosts.delete(id)
    keptUp.delete(id)
  })

  rt.teamTools.push(defineTool({
    name: 'list_capabilities',
    description: 'List shared MCP servers, skills, and packs, plus the capabilities attached to you.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const bot = rt.botOf(self)
      if (!bot) return 'Only Bots on the team can use list_capabilities.'
      const items = Object.values(state.capabilities?.items ?? {})
      if (items.length === 0) return 'No shared capabilities are saved yet.'
      const statuses = rt.capabilityStatusesView()[bot.id] ?? {}
      const lines = items.map((item) => {
        const extra = item.kind === 'pack' ? `; includes ${(item.items ?? []).join(', ') || 'nothing'}`
          : item.kind === 'mcp' && item.transport === 'stdio' ? `; ${item.approved ? 'allowed' : 'needs user approval'}` : ''
        const itemStatus = statuses[item.name]
        const st = itemStatus ? ` (${itemStatus.state}${itemStatus.error ? `: ${itemStatus.error}` : ''})` : ''
        const status = bot.capabilities?.includes(item.name) ? `; attached to you${st}` : ''
        return `- ${item.name} (${item.kind})${item.description ? ` — ${item.description}` : ''}${extra}${status}`
      })
      return ['Shared capabilities:', ...lines].join('\n')
    },
  }))
  rt.teamTools.push(defineTool({
    name: 'save_capability',
    description: 'Create or update a shared MCP server, skill, or pack. Changes apply from your next message.',
    parameters: {
      name: { type: 'string', required: true, description: 'Lowercase letters, digits, and single hyphens, up to 32 characters; "github" is reserved' },
      kind: { type: 'string', required: true, enum: ['mcp', 'skill', 'pack'] },
      description: { type: 'string', description: 'What this capability provides' },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'How to reach an MCP server: a local command or an HTTP URL' },
      command: { type: 'string', description: 'Program that starts a local MCP server' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments for command; write $DSH_SECRET_<NAME> or a one-time secret-ref:<32hex> handle instead of a raw key' },
      env: { type: 'object', additionalProperties: true, description: 'Environment variables for command; write $DSH_SECRET_<NAME> or a one-time secret-ref:<32hex> handle to insert a secret instead of the value' },
      url: { type: 'string', description: 'MCP server URL; write $DSH_SECRET_<NAME> or a one-time secret-ref:<32hex> handle in the path or query to insert a secret, URL-encoded. Prefer headers for keys' },
      headers: { type: 'object', additionalProperties: true, description: 'HTTP headers; write $DSH_SECRET_<NAME> or a one-time secret-ref:<32hex> handle to insert a secret instead of the value' },
      content: { type: 'string', description: 'Skill instructions' },
      items: { type: 'array', items: { type: 'string' }, description: 'MCP server and skill names in the pack' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(self)) return 'Only Bots on the team can use save_capability.'
      try {
        const item = await rt.capabilitySave(args, { botId: self })
        const approval = item.kind === 'mcp' && item.transport === 'stdio' && !item.approved
          ? ' The user must allow this MCP server in DS Bot settings before it can work.'
          : ''
        return `Saved ${item.name}. Bots with it attached use the change from their next message.${approval}`
      } catch (error) { return error.message }
    },
  }))
  rt.teamTools.push(defineTool({
    name: 'delete_capability',
    description: 'Remove a shared capability and detach it from every Bot and pack.',
    parameters: { name: { type: 'string', required: true } },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(self)) return 'Only Bots on the team can use delete_capability.'
      try {
        await rt.capabilityDelete(args.name, { botId: self })
        return `Deleted ${args.name}; it was removed from every Bot and pack. The change applies from their next message.`
      } catch (error) { return error.message }
    },
  }))
  for (const [name, endpoint, verb] of [['attach_capability', 'attach', 'Attached'], ['detach_capability', 'detach', 'Detached']]) {
    rt.teamTools.push(defineTool({
      name,
      description: `${verb} a shared capability to yourself, or to another Bot if you are a Main Bot.`,
      parameters: {
        name: { type: 'string', required: true, description: 'Capability name from list_capabilities' },
        bot: { type: 'string', description: 'Optional Bot name; only a Main Bot may change another Bot' },
        ...(endpoint === 'attach' ? { mode: { type: 'string', enum: ['always', 'catalog'], description: 'Always on (default), or available through use_pack' } } : {}),
      },
      output,
      async execute(args, exec) {
        await rt.load()
        const self = rt.selfOf(exec.agent?.id)
        if (!rt.botOf(self)) return `Only Bots on the team can use ${name}.`
        try {
          const result = await rt.changeCapabilityAttachment(endpoint, args, self)
          const attached = rt.own(state.capabilities.items, args.name)
          const members = attached?.kind === 'pack'
            ? (attached.items ?? []).map(child => rt.own(state.capabilities.items, child)).filter(Boolean)
            : attached ? [attached] : []
          const approvals = members
            .filter(item => item.kind === 'mcp' && item.transport === 'stdio' && item.approved !== true)
            .map(item => ` The user must allow ${item.name} in DS Bot settings before it can work.`)
            .join('')
          return `${verb} ${args.name} ${args.bot ? `to ${result.bot}` : 'to yourself'}. Changes apply from ${result.bot}'s next message.${endpoint === 'attach' ? approvals : ''}`
        } catch (error) { return error.message }
      },
    }))
  }

  for (const name of ['use_pack', 'drop_pack']) {
    rt.teamTools.push(defineTool({
      name,
      description: name === 'use_pack' ? 'Load a feature pack from your catalog for this session. Waits for mounting; ready tools are available at the next step.' : 'Drop a session-loaded feature pack at the end of this turn.',
      parameters: {
        name: { type: 'string', required: true },
        ...(name === 'use_pack' ? { reason: { type: 'string', description: 'Why this task needs the pack' } } : {}),
      },
      output,
      async execute(args, exec) {
        try {
          return await rt[name === 'use_pack' ? 'usePack' : 'dropPack'](exec.agent?.session?.id ?? exec.agent?.id, args.name)
        } catch (error) { return error.message }
      },
    }))
  }

  const hiddenToolsFor = id => new Set([...HIDDEN_TOOLS, ...hiddenSessionTools(id)])
  Object.assign(rt, {
    pickRoom,
    hideBotUnusedTools,
    syncScopedTools,
    syncScopedSession,
    hiddenTeamToolsFor,
    hiddenSessionTools,
    hiddenToolsFor,
    addTeamTool,
    removeTeamTool,
    reapplyToolMasks,
    resumePausedWork,
    cancelWorkByUser,
  })
}

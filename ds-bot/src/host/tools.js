// Team tools: the roster, bot-to-bot messages, group chat settings and posts, and the
// question and view cards. Group rounds and reading chats are in groups.js.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readAvatar } from './avatar.js'
import { CATALOG_PACK_TOOLS, COLORS, EXTRA_COLORS, GROUP_ONLY_TOOLS, isAckLikeText, MESSAGE_INLINE_MAX, ROOM_MODES, TASK_HIDDEN_TEAM_TOOLS, TEXT_KEPT } from './constants.js'
import { within } from './folders.js'
import { missingFileRefs } from './claims.js'
import { absoluteLinks } from './links.js'
import { NAME_MAX } from './requests.js'
import { roomRequest, roomNote, waitsOnMember } from './room-message.js'
import { unquote } from './text.js'
import { ownChatSessions, returnAddress, threadCurrentOfPart } from './threads.js'
import { mentionSpans } from '../shared/mentions.js'
import { plainToolSchema } from './tool-schema.js'
import { viewCardText } from './parts.js'
import { checkShownView, showViewDescription, showViewParameters } from 'deep-view/core'
import { BUILTIN_PACKS, install as installBuiltinPacks } from './builtin-packs.js'

export const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
export const GROUP_REF = { type: 'string', required: true, description: 'Exact group chat name from list_bots' }
const BLOCKING_QUESTION_TOOL = 'ask_user_question'
// DS Bot has its own group goals; DSH's session goal still does not survive conversation parts.
const GOAL_TOOLS = ['create_goal', 'update_goal', 'get_goal']
// DSH's delegation tools start child agents the user cannot watch or stop, and they
// end with the conversation part that started them; Bots hand work to other Bots.
// Agent Teams' teammates are such children too (#973).
const DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'ralph', 'spawn_teammate', 'wait_agent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update']
// restrict() refuses a whole list when one name is registered in the Agent's own
// scope, so each group is masked on its own.
const HIDDEN_TOOL_GROUPS = [[BLOCKING_QUESTION_TOOL, ...GOAL_TOOLS], DELEGATION_TOOLS]
const HIDDEN_TOOLS = HIDDEN_TOOL_GROUPS.flat()
// The guidance DSH writes into the prompt for the hidden tools. Agent Teams makes
// every root Session a Team Lead and tells it to spawn teammates in `team:policy`;
// its `team:identity` context is required, so DSH puts it back after any filter.
const HIDDEN_SECTIONS = new Set([...HIDDEN_TOOLS.map(name => `tool:${name}`), 'tool:goal', 'team:policy'])
const GOAL_REFUSAL = 'Bot chats do not run /goal. To give a group a goal, use Set a goal in its + menu.'
// DSH 0.2.2's schedule tools can deliver to a new Session, which is outside the team and
// has no Bot; a Bot's tasks deliver to its own chat, which DS Bot moves on with each part.
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

export function install(rt) {
  const { ctx, state } = rt
  installBuiltinPacks(rt)

  const callerBot = (exec) => rt.botOf(rt.selfOf(exec.agent?.id))
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
  // The part of its own chat the caller speaks from, so a reply comes back to that part
  // of the thread (a Bot can work in a background part while the user reads another).
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
  // Main Bots see every group; other Bots see the groups they are in.
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
    // A private Bot is only named to the others: not what it does, where, or what now.
    if (bot.private === true && bot.id !== self) return `- ${bot.name} (${[bot.role, 'private Bot, closed to other Bots'].filter(Boolean).join(', ')})`
    const model = bot.appliedModel ?? bot.model
    const section = sectionNameOf(bot.sectionId)
    const tags = [bot.role, section ? `section "${section}"` : '', model ? `model ${model}` : '', bot.workDir ? `works in ${bot.workDir}` : '', bot.extraDirs?.length ? `also works in ${bot.extraDirs.join(', ')}` : '', rt.isMain(bot.id) ? 'Main Bot' : '', bot.private === true ? 'private' : '', bot.id === self ? 'you' : ''].filter(Boolean).join(', ')
    const job = bot.instructions ? ` — ${bot.instructions.split('\n')[0].slice(0, 120)}` : ''
    const now = bot.id === self ? '' : `\n  now: ${rt.statusOf(bot.id)}`
    return `- ${bot.name}${tags ? ` (${tags})` : ''}${job}${now}`
  }
  // The Bots and group chats list_bots shows: the whole team, one Bot, one group's
  // members, or one Bot that must be in that group.
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

  // Sessions a Bot is running in right now: every live part of its own chat (a part it
  // opened while it was busy runs there too) plus each group Session with a live turn.
  // An idle Bot reports no running Session.
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

  // A tool that throws shows as failed in the chat, instead of as sent or stopped.
  const refuse = (message) => { throw new Error(message) }

  // The works (handoffs.js) the calling turn does: what it answers, any background task
  // work node it runs inside, and the requests that joined it.
  const worksOf = (exec) => {
    const sid = exec.agent?.id
    const turn = rt.live.get(sid)
    const task = rt.taskBySession?.(sid)?.task
    const taskWork = task?.workId ?? task?.exchangeId
    return [...new Set([rt.workOf(turn?.info), taskWork, ...(turn?.joined ?? []).map(joined => rt.workOf(joined.info))].filter(Boolean))]
  }
  const tooLong = text => `Not sent: the message has ${text.length} characters, more than ${MESSAGE_INLINE_MAX}, and this DeepSeek Harness cannot send it as a file. Write it to a file in your working folder and send its path instead.`

  // Work for a group stays in it: from a group Session, message_bot calls a member there
  // exactly as an "@Name" line would, and never reaches a Bot outside the group.
  const groupRefusal = (room, sender, target) => {
    if (room.members.includes(target.id)) return undefined
    const add = rt.isMain(sender.id) || rt.isAdminOf(room, sender.id) ? ', or add it yourself with update_group first' : ''
    return `Not sent: ${target.name} is not in "${room.name}", and work for this group stays in it. Ask the user to add ${target.name} to the group${add}.`
  }

  const callInGroup = async (room, sender, target, message, follows, { worked = false, callerExchangeId, callerId, parentBatchKey } = {}) => {
    if (waitsOnMember(state.roomBatches, room.id, sender.id, target.id)) refuse(`Not sent: ${target.name} is already waiting for your result. Write the result or blocking question in your reply.`)
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
      route: { ...roomRequest([target.id]), expectsResult: true, ...(follows ? { follows } : {}) },
    })
    if (posted?.paused === true) {
      return `Paused in "${room.name}": consecutive handoffs without running a work tool reached the loop guard. The call to ${target.name} waits until the user continues or writes in the group.`
    }
    return `Called ${target.name} in "${room.name}". Its result returns in the group. Nothing went to its own chat.`
  }

  // The Bots each Session's post_to_group called by name in its current turn, so that
  // turn does not also send them the same work in their own chats.
  const calledInPosts = new Map()
  // The refused messages each Session's current turn kept for its work.
  const keptUp = new Map()
  const turnOf = exec => rt.live.get(exec.agent?.id)?.turn

  // The refusal of a message to a Bot that waits for the caller's work. The model has
  // written the message by now, so when it can stand as the answer to the turn's own
  // work it is kept as what the Bot said for that work (handoffs.js answerText). That
  // answer goes to whoever asked for the work, also when the target is further up.
  const upstreamRefusal = (exec, sender, target, said, args) => {
    const plain = `Not sent: ${target.name} is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back.`
    const turn = rt.live.get(exec.agent?.id)
    const work = rt.workOf(turn?.info)
    const asker = rt.ownsWork(sender.id, work) ? rt.botOf(state.works[work].from) : undefined
    // A request that joined the turn is answered in a later turn, and a queued or
    // user-facing message is not an answer to this work.
    const answers = asker !== undefined && (args.deliver_to ?? args.reply_to) !== 'user' && args.when !== 'queue' && rt.upstreamOf([work]).has(target.id)
    if (!answers) return `${plain} Finish the work and end your turn; to ask ${target.name} something, end your turn with the question.`
    const to = asker.id === target.id ? target.name : `${asker.name} as your answer, and reaches ${target.name} with ${asker.name}'s answer`
    // The turn's reply is all the text it wrote, so text from before this call goes up
    // in place of a kept message.
    if (turn.texts.slice(turn.shown ?? 0).join('').trim() !== '') {
      return `${plain} Your message was not kept: this turn already wrote text, and that goes up to ${to}. Write the message in your final answer.`
    }
    // Messages refused in one turn add up, as the turn's texts do; a later turn's
    // replace what an earlier turn kept, as its reply would.
    const before = keptUp.get(exec.agent?.id)
    const again = before?.turn === turn.turn && before.work === work
    const replaced = !again && state.works[work].held !== undefined
    const text = again ? `${before.text}\n\n${said}` : said
    // Only turns still running are remembered, and only as much as holdWork keeps,
    // with one more character to tell that it was cut: Sessions of earlier parts
    // never end another turn that would clear them.
    for (const [id, kept] of keptUp) if (rt.live.get(id)?.turn !== kept.turn) keptUp.delete(id)
    keptUp.set(exec.agent?.id, { turn: turn.turn, work, text: text.slice(0, TEXT_KEPT + 1) })
    rt.holdWork(work, text)
    const cut = text.length > TEXT_KEPT
    const kept = again
      ? `Your message was kept as your answer, after what was kept before in this turn${cut ? `, but only the first ${TEXT_KEPT} characters of all of it` : ''}.`
      : `${cut ? `Only its first ${TEXT_KEPT} characters were` : 'Your message was'} kept as your answer${replaced ? ', in place of what was kept for this work before this turn' : ''}.`
    const whole = cut ? ' To send all of it, write it in full as your answer.' : ''
    return `${plain} ${kept}${whole} If you end your turn without writing any text, ${cut ? 'that part' : 'it'} goes up to ${to}; any text you write for this work from now on goes up instead.`
  }

  // Tracks works currently mid-dispatch or rolling back so startup orphan reconciliation
  // never closes a work during its openTaskPart/deliver/rollback await window.
  const dispatchingWorks = new Map()
  const beginDispatchWork = (id) => {
    if (typeof id !== 'string' || id === '') return
    dispatchingWorks.set(id, (dispatchingWorks.get(id) ?? 0) + 1)
  }
  const endDispatchWork = (id) => {
    if (typeof id !== 'string' || id === '') return
    const left = (dispatchingWorks.get(id) ?? 0) - 1
    if (left <= 0) dispatchingWorks.delete(id)
    else dispatchingWorks.set(id, left)
  }
  const isDispatchingWork = id => typeof id === 'string' && ((dispatchingWorks.get(id) ?? 0) > 0 || resumingWorks.has(id))

  // Each admission is a distinct assignment even when the target already has unread work;
  // only an explicit request_id retry or resumption reuses an existing assignment.
  async function dispatchDelegation({ sender, target, text, files = [], length, fromPart, parentWork, imOrigin, follows, toUser = false, when = 'now', request, existingWork, callerWorked = false }) {
    const chat = rt.chatOf(target.id)
    const agent = await rt.resolveAgent(chat)
    const status = rt.statusOf(target.id)
    const long = length !== undefined
      ? { text, files, length }
      : await rt.attachLong(text, `Work from ${sender.name}.txt`)
    if (long === undefined) { if (request !== undefined) request.unsent = true; return tooLong(text) }
    const working = rt.live.get(chat)?.turn !== undefined || agent.status === 'running'
    const exchangeId = existingWork?.id ?? randomUUID()
    beginDispatchWork(exchangeId)
    try {
      const spawnInBackground = working && !toUser && when !== 'queue'
        && rt.shouldMoveForeground?.(target, chat, { forPeer: true }) === true
        && typeof rt.spawnBotHandoffTask === 'function'
      if (spawnInBackground) {
        const prevState = existingWork?.work?.state
        const prevPaused = existingWork?.work?.paused
        if (existingWork !== undefined) {
          existingWork.work.state = 'open'
          delete existingWork.work.paused
          void rt.save().catch(() => {})
        }
        try {
          await rt.spawnBotHandoffTask(target, chat, {
            fromBot: sender,
            follows,
            fromPart,
            parentWork,
            ...(imOrigin ? { imOrigin } : {}),
            text: long.text,
            files: long.files,
            length: long.length,
            exchangeId,
            ...(existingWork !== undefined ? { reuseWork: true } : {}),
          })
        } catch (error) {
          if (existingWork !== undefined && error?.delivered !== true) {
            existingWork.work.state = prevState
            if (prevPaused !== undefined) existingWork.work.paused = prevPaused
            void rt.save().catch(() => {})
          }
          throw error
        }
        const ref = rt.workRefOf?.(exchangeId)
        const asker = rt.ownsWork(sender.id, parentWork) ? rt.botOf(state.works[parentWork].from)?.name : undefined
        const notes = [
          `Delegated${ref ? ` work #${ref}` : ''} to ${target.name} in a background task while its foreground chat is busy. Its result will return automatically when done; do not poll or message back to acknowledge.`,
          asker ? `When you have handed on everything, end your turn: each completed sub-work brings you back, and your answer goes to ${asker} once all of it is back.` : '',
        ].filter(Boolean)
        return notes.join(' ')
      }
      let workRef = existingWork?.work?.ref
      const prevState = existingWork?.work?.state
      const prevPaused = existingWork?.work?.paused
      if (existingWork !== undefined && !toUser) {
        existingWork.work.state = 'open'
        delete existingWork.work.paused
        void rt.save().catch(() => {})
      } else if (!toUser) {
        const opened = rt.openWork(exchangeId, { from: sender.id, to: target.id, parent: parentWork, ...(fromPart ? { fromPart } : {}), ...(imOrigin ? { imOrigin } : {}), goal: text })
        workRef = opened?.ref
      }
      try {
        await rt.deliver({
          fromId: sender.id,
          toId: target.id,
          ...(fromPart ? { fromPart } : {}),
          text: long.text,
          files: long.files,
          length: long.length,
          role: 'request',
          ...(follows ? { follows } : {}),
          steer: !working && when !== 'queue' && !toUser,
          exchangeId,
          ...(workRef ? { workRef } : {}),
          ...(toUser ? { audience: 'user' } : {}),
        })
      } catch (error) {
        if (error?.delivered === false) rt.forgetDelivery?.(exchangeId)
        if (existingWork !== undefined && !toUser) {
          if (error?.delivered !== true) {
            existingWork.work.state = prevState
            if (prevPaused !== undefined) existingWork.work.paused = prevPaused
            void rt.save().catch(() => {})
          }
        } else if (existingWork === undefined && !toUser && (error?.delivered === false || rt.botOf(target.id) === undefined)) {
          rt.dropWork(exchangeId)
        }
        throw error
      }
      if (toUser) {
        if (existingWork !== undefined) rt.dropWork?.(exchangeId)
        rt.noteWorkCompleted?.(sender.id, target.id, { worked: callerWorked, id: exchangeId, text })
      }
      const label = workRef ? ` work #${workRef}` : ''
      const sent = toUser
        ? `Delegated to ${target.name}. It will answer the user in its own chat; nothing comes back to you, so point the user to ${target.name}'s chat instead of relaying.`
        : working
          ? `Queued${label} for ${target.name}: it starts after its current work and returns the result once done. Do not wait or poll.`
          : `Delegated${label} to ${target.name}. Its result returns automatically and closes${label || ' the work'} when done; do not wait or poll.`
      const asker = rt.ownsWork(sender.id, parentWork) ? rt.botOf(state.works[parentWork].from)?.name : undefined
      const notes = [
        status === 'idle' ? '' : `${target.name} now: ${status}.`,
        asker ? `When you have handed on everything, end your turn: each completed sub-work brings you back, and your answer goes to ${asker} once all of it is back.` : '',
      ].filter(Boolean)
      const out = [sent, ...notes].join(' ')
      const elsewhere = activeSessions(target.id).running.filter(sessionId => sessionId !== chat)
      if (elsewhere.length === 0) return out
      const stop = rt.isMain(sender.id) ? ' If it must not go on there, use stop_bot.' : ''
      return `${out} This request does not reach its work in ${elsewhere.map(whereOf).join(' and ')}.${stop}`
    } finally {
      endDispatchWork(exchangeId)
    }
  }

  // Stops any in-flight turn, queued inbox item, or background handoff task for a
  // cancelled work, and injects a silent (zero-wake) cancellation notice into the target.
  async function abortWorkExecution(snapshot, { sender, reason = '' } = {}) {
    if (snapshot?.id !== undefined) {
      rt.forgetWorkDeliveries?.(snapshot.id)
      rt.forgetDelivery?.(snapshot.id)
    }
    if (snapshot?.to === undefined) return
    const target = rt.botOf(snapshot.to)
    if (target === undefined) return
    const note = reason.trim() || `Work ${snapshot.ref ? `#${snapshot.ref} ` : ''}was cancelled.`
    // Stop any running bot-handoff task or child task_start task linked to this work.
    for (const task of target.tasks ?? []) {
      if ((task?.exchangeId === snapshot.id || task?.parentWorkId === snapshot.id)
        && ['running', 'waiting_work', 'waiting_approval'].includes(task.status)) {
        await rt.stopTask?.(target.id, task.id, note).catch(() => {})
      }
    }
    const chat = rt.chatOf(target.id)
    const sessionIds = [...new Set([
      chat,
      ...(snapshot.toSession ? [threadCurrentOfPart(target, snapshot.toSession) ?? snapshot.toSession] : []),
    ].filter(Boolean))]
    let cancelledAny = false
    for (const sid of sessionIds) {
      const agent = await rt.resolveAgent(sid).catch(() => undefined)
      if (agent === undefined) continue
      const liveEntry = rt.live.get(sid)
      if (liveEntry?.turn !== undefined && rt.workOf?.(liveEntry.info) === snapshot.id) {
        agent.cancel({ kind: 'hook', reason: 'ds-bot/cancelled' })
        cancelledAny = true
      }
      for (const message of [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]) {
        if (message?.source?.exchangeId === snapshot.id || message?.source?.work === snapshot.id || message?.source?.askWork === snapshot.id) {
          agent.inbox?.remove?.(message.id)
        }
      }
    }
    // Only notify targets that actually received the work (a paused delegation was never sent).
    if (snapshot.state !== 'paused') {
      const cancelSession = snapshot.toSession
        ? (threadCurrentOfPart(target, snapshot.toSession) ?? snapshot.toSession)
        : undefined
      await rt.deliver({
        ...(sender?.id ? { fromId: sender.id } : { fromName: 'The user', ...(snapshot.from ? { pairFrom: snapshot.from } : {}) }),
        toId: target.id,
        ...(cancelSession ? { sessionId: cancelSession } : {}),
        text: note,
        role: 'cancelled',
        wake: false,
        afterCancel: cancelledAny,
        ...(snapshot.ref ? { workRef: snapshot.ref } : {}),
        exchangeId: randomUUID(),
      }).catch(error => rt.warn('ds-bot: silent cancel notice to %s failed: %s', target.name, error))
    }
  }

  // Prevents concurrent resume-work clicks from double-dispatching the same paused work.
  const resumingWorks = new Set()

  async function resumePausedWork(id) {
    const rawKey = String(id ?? '').trim()
    if (rawKey === '' || resumingWorks.has(rawKey)) return false
    resumingWorks.add(rawKey)
    let resolvedId
    try {
      await rt.load()
      const resolved = rt.resolveWork?.(rawKey)
      if (resolved === undefined || resolved.work.state !== 'paused' || resolved.work.paused === undefined) return false
      resolvedId = resolved.id
      if (resolvedId !== rawKey) {
        if (resumingWorks.has(resolvedId)) return false
        resumingWorks.add(resolvedId)
      }
      const { work } = resolved
      const paused = work.paused
      const sender = rt.botOf(work.from)
      const target = rt.botOf(work.to)
      if (sender === undefined || target === undefined) {
        rt.dropWork?.(resolved.id)
        return false
      }
      const prevRounds = work.rounds
      rt.resetPairLoop?.(work.from, work.to)
      work.rounds = 0
      if (paused.kind === 'ask_back') {
        work.state = 'need_input'
        work.question = paused.question?.slice(0, 400)
        delete work.paused
        await rt.save().catch(() => {})
        const backRoom = rt.roomOf(work.fromRoom)?.sessions?.[sender.id]
        const targetSession = backRoom ?? (work.fromPart ? threadCurrentOfPart(sender, work.fromPart) : undefined)
        const askExchangeId = randomUUID()
        try {
          await rt.deliver({
            fromId: target.id,
            toId: sender.id,
            ...(targetSession ? { sessionId: targetSession } : {}),
            text: paused.text ?? paused.question ?? '',
            ...(Array.isArray(paused.files) && paused.files.length > 0 ? { files: paused.files } : {}),
            ...(paused.length !== undefined ? { length: paused.length } : {}),
            role: 'ask_back',
            address: returnAddress(sender, work.fromPart, work.fromRoom),
            askWork: resolved.id,
            ...(work.parent ? { work: work.parent } : {}),
            ...(work.ref ? { workRef: work.ref } : {}),
            steer: false,
            exchangeId: askExchangeId,
          })
        } catch (error) {
          if (error?.delivered !== true) {
            if (error?.delivered === false) rt.forgetDelivery?.(askExchangeId)
            work.state = 'paused'
            work.paused = paused
            work.rounds = prevRounds
            delete work.question
            await rt.save().catch(() => {})
          }
          throw error
        }
        return true
      }
      try {
        await dispatchDelegation({
          sender,
          target,
          text: paused.text ?? work.goal ?? '',
          files: paused.files ?? [],
          length: paused.length,
          fromPart: work.fromPart,
          parentWork: work.parent,
          follows: paused.follows,
          ...(work.imOrigin ? { imOrigin: work.imOrigin } : {}),
          toUser: paused.toUser === true,
          when: paused.when ?? 'now',
          existingWork: resolved,
        })
      } catch (error) {
        if (error?.delivered !== true) {
          work.rounds = prevRounds
          await rt.save().catch(() => {})
        }
        throw error
      }
      return true
    } finally {
      resumingWorks.delete(rawKey)
      if (resolvedId !== undefined) resumingWorks.delete(resolvedId)
    }
  }

  async function cancelWorkByUser(id, reason = 'Cancelled by the user.') {
    await rt.load()
    const resolved = rt.resolveWork?.(id)
    if (resolved === undefined) return false
    const snapshot = rt.cancelWork?.(resolved.id, { by: 'user', reason })
    if (snapshot === undefined) return false
    await abortWorkExecution(snapshot, { reason })
    await rt.notifyParentCancelled?.(snapshot, { reason, byLabel: 'the user' })
    return true
  }

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
        description: '"now" (default): a busy Bot handles this in a background task or reads it at its next step. "queue": waits until its current work finishes. With deliver_to "user" the request always queues.',
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
        if (isAckLikeText(rawGoal)) {
          refuse('Not sent: an acknowledgement does not open a follow-up task. The work is already closed.')
        }
      }
      if (room !== undefined) {
        const refusal = groupRefusal(room, sender, target)
        if (refusal !== undefined) refuse(refusal)
        if (waitsOnMember(state.roomBatches, room.id, sender.id, target.id)) {
          refuse(`Not sent: ${target.name} is already waiting for your result. Write the result or blocking question in your reply.`)
        }
        const callerWorked = (rt.live.get(exec.agent?.id)?.workToolCount ?? 0) > 0
        const parentBatchKey = rt.activeRoomBatchKey?.(exec.agent?.id, trigger)
        const send = async () => {
          const receipt = await callInGroup(room, sender, target, text.trim(), followUp, {
            worked: callerWorked,
            callerExchangeId: trigger?.exchangeId,
            callerId: trigger?.askedBy,
            ...(parentBatchKey ? { parentBatchKey } : {}),
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
        const work = toUser ? undefined : works[0]
        const imOrigin = !toUser && work === undefined ? callerImOrigin(exec) : undefined
        const fromPart = callerPart(exec).fromPart
        const callerWorked = (rt.live.get(exec.agent?.id)?.workToolCount ?? 0) > 0
        const loop = rt.checkPairLoop?.(sender.id, target.id, { callerWorked, text, followUp: !!followUp }) ?? { ok: true }
        if (loop.blocked === 'already_paused') {
          if (request !== undefined) request.unsent = true
          return `Not sent: work ${loop.work?.ref ? `#${loop.work.ref}` : loop.id} between you and ${target.name} is already paused waiting for the user. Wait for the user to continue or cancel it.`
        }
        if (loop.pause !== undefined) {
          const long = await rt.attachLong(text, `Work from ${sender.name}.txt`)
          if (long === undefined) { if (request !== undefined) request.unsent = true; return tooLong(text) }
          const exchangeId = randomUUID()
          const created = rt.openWork(exchangeId, {
            from: sender.id,
            to: target.id,
            parent: work,
            ...(fromPart ? { fromPart } : {}),
            ...(imOrigin ? { imOrigin } : {}),
            goal: text,
            state: 'paused',
            paused: {
              reason: loop.pause,
              kind: 'delegate',
              text: long.text,
              files: long.files,
              length: long.length,
              when,
              ...(followUp ? { follows: followUp } : {}),
              ...(toUser ? { toUser: true } : {}),
              bounces: loop.bounces,
              at: Date.now(),
            },
          })
          const ref = created?.ref ? ` #${created.ref}` : ''
          if (loop.pause === 'idle_loop') {
            return `Paused work${ref} before waking ${target.name}: you and ${target.name} already went back and forth without running any work tools. If this is just a wrap-up or acknowledgement, stop here (reply [PASS]) or use note_bot for a silent update. Otherwise the user can click Continue on the pause card.`
          }
          return `Paused work${ref} before waking ${target.name}: the same assignment returned the same result ${loop.bounces} times. The user can click Continue on the pause card if that repetition is intentional.`
        }
        return dispatchDelegation({ sender, target, text, fromPart, parentWork: work, imOrigin, follows: followUp || undefined, toUser, when, request, callerWorked })
      }
      return request === undefined ? await send() : answer(await rt.admitRequest(request, send))
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'ask_back',
    description: 'While doing a delegated work (#W…), ask the calling Bot a blocking question or request a decision without closing the work. Your turn pauses until the caller calls answer_work or cancel_work.',
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
            const active = rt.workOf?.(turn?.info)
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
      const prevState = resolved.work.state
      const prevRounds = resolved.work.rounds
      const prevQuestion = resolved.work.question
      const prevPaused = resolved.work.paused
      const prevAskedBack = turn?.askedBackWork
      const outcome = rt.askBackWork?.(resolved.id, question, {
        worked: (turn?.workToolCount ?? 0) > 0,
        text: long.text,
        files: long.files,
        length: long.length,
      })
      if (outcome?.error !== undefined) refuse(`Cannot ask back on work #${resolved.work.ref ?? resolved.id}: ${outcome.error}.`)
      const ref = resolved.work.ref ? `#${resolved.work.ref}` : resolved.id
      if (outcome.status === 'paused') {
        if (turn !== undefined) turn.askedBackWork = resolved.id
        exec.concludeTurn?.()
        return `Paused your question on work ${ref} for the user: this work has already asked back ${outcome.work.rounds} times. End your turn and wait for the user to continue or cancel.`
      }
      const fromPart = resolved.work.fromPart
      const backRoom = rt.roomOf(resolved.work.fromRoom)?.sessions?.[caller.id]
      const targetSession = backRoom ?? (fromPart ? threadCurrentOfPart(caller, fromPart) : undefined)
      const askExchangeId = randomUUID()
      if (turn !== undefined) turn.askedBackWork = resolved.id
      try {
        await rt.deliver({
          fromId: sender.id,
          toId: caller.id,
          ...(targetSession ? { sessionId: targetSession } : {}),
          text: long.text,
          files: long.files,
          ...(long.length !== undefined ? { length: long.length } : {}),
          role: 'ask_back',
          address: returnAddress(caller, fromPart, resolved.work.fromRoom),
          askWork: resolved.id,
          ...(resolved.work.parent ? { work: resolved.work.parent } : {}),
          ...(resolved.work.ref ? { workRef: resolved.work.ref } : {}),
          steer: false,
          exchangeId: askExchangeId,
        })
      } catch (error) {
        if (error?.delivered !== true) {
          if (error?.delivered === false) rt.forgetDelivery?.(askExchangeId)
          if (turn !== undefined) turn.askedBackWork = prevAskedBack
          if (state.works?.[resolved.id] === resolved.work) {
            resolved.work.state = prevState
            resolved.work.rounds = prevRounds
            if (prevQuestion === undefined) delete resolved.work.question
            else resolved.work.question = prevQuestion
            if (prevPaused === undefined) delete resolved.work.paused
            else resolved.work.paused = prevPaused
            void rt.save().catch(() => {})
          }
        }
        throw error
      }
      exec.concludeTurn?.()
      return `Sent your question on work ${ref} to ${caller.name}. End your turn now without calling answer_work yourself; ${caller.name} will unblock you with answer_work.`
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
      if ((resolved.work.state ?? 'open') !== 'need_input') {
        refuse(`Work #${resolved.work.ref ?? resolved.id} is ${resolved.work.state ?? 'open'}, not waiting for an answer.`)
      }
      const worker = rt.botOf(resolved.work.to)
      if (worker === undefined) refuse('The assigned Bot is no longer on the team.')
      const body = absoluteLinks(answerText, rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      const long = await rt.attachLong(body, `Answer from ${sender.name}.txt`)
      if (long === undefined) return tooLong(body)
      const prevState = resolved.work.state
      const prevQuestion = resolved.work.question
      const prevWorked = resolved.work.worked
      beginDispatchWork(resolved.id)
      try {
        const outcome = rt.answerWork?.(resolved.id)
        if (outcome?.error !== undefined) refuse(`Could not answer work #${resolved.work.ref ?? resolved.id}: ${outcome.error}.`)
        const ref = resolved.work.ref ? `#${resolved.work.ref}` : resolved.id
        // If the work runs inside a bot-handoff background task, route the answer back to
        // that task's active segment rather than the worker's foreground chat.
        const taskTarget = resolved.work.toSession ? threadCurrentOfPart(worker, resolved.work.toSession) : undefined
        const answerExchangeId = randomUUID()
        try {
          await rt.deliver({
            fromId: sender.id,
            toId: worker.id,
            ...(taskTarget ? { sessionId: taskTarget } : {}),
            text: long.text,
            files: long.files,
            ...(long.length !== undefined ? { length: long.length } : {}),
            role: 'answer',
            address: resolved.work.toTaskId ? { taskId: resolved.work.toTaskId } : returnAddress(worker, resolved.work.toSession),
            work: resolved.id,
            ...(resolved.work.ref ? { workRef: resolved.work.ref } : {}),
            steer: false,
            exchangeId: answerExchangeId,
          })
        } catch (error) {
          if (error?.delivered !== true) {
            if (error?.delivered === false) rt.forgetDelivery?.(answerExchangeId)
            if (state.works?.[resolved.id] === resolved.work) {
              resolved.work.state = prevState
              if (prevQuestion === undefined) delete resolved.work.question
              else resolved.work.question = prevQuestion
              resolved.work.worked = prevWorked
              void rt.save().catch(() => {})
            }
          }
          throw error
        }
        return `Answered ${worker.name} on work ${ref}; it will resume and return the result when done. Reply [PASS] if nothing needs to be told to the user.`
      } finally {
        endDispatchWork(resolved.id)
      }
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
        const assigned = byRef.work.to === sender.id && byRef.work.ref !== undefined
        if (!assigned && byRef.work.from !== sender.id && !rt.isMain(sender.id)) {
          refuse(`Only the caller, the assigned Bot, or a Main Bot can cancel work #${byRef.work.ref ?? byRef.id}.`)
        }
        matches = [byRef]
      } else {
        const closed = rt.closedWorkOf?.(key)
        if (closed !== undefined) return `Work #${closed.ref ?? closed.id} is already ${closed.status}; nothing left to cancel.`
        const bot = rt.findBot(key)
        if (bot === undefined) return `No open work or Bot named "${key}".`
        matches = rt.openWorksBetween?.(sender.id, bot.id) ?? []
        if (matches.length === 0 && rt.isMain(sender.id)) {
          matches = Object.entries(state.works ?? {})
            .filter(([, work]) => work?.to === bot.id && work.child === undefined)
            .map(([id, work]) => ({ id, work }))
        }
        if (matches.length === 0) return `No open delegated work for ${bot.name}; nothing to cancel (do not send a wrap-up request).`
        if (matches.length > 1) {
          refuse(`Multiple assignments match ${bot.name}. Pass the work reference to stop only that assignment: ${matches.map(({ id, work }) => work.ref ?? id).join(', ')}.`)
        }
      }
      const cancelledRefs = []
      for (const item of matches) {
        const snapshot = rt.cancelWork?.(item.id, { by: sender.id, reason })
        if (snapshot === undefined) continue
        cancelledRefs.push(snapshot.ref ? `#${snapshot.ref}` : snapshot.id)
        await abortWorkExecution(snapshot, { sender, reason })
        await rt.notifyParentCancelled?.(snapshot, { reason, by: sender.id, bySession: exec.agent?.id, byLabel: sender.name })
      }
      return `Cancelled ${cancelledRefs.join(', ')} silently. The Bot was not woken and will not reply.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'note_bot',
    description: 'Send a one-way silent update without interrupting running commands or requesting a reply. In private chat, pass work_id to update a specific open delegation. In a group chat, the note is public to the group and reaches the addressed member at its next step on your open group assignment.',
    parameters: {
      to: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      note: { type: 'string', required: true, description: 'Factual note to leave silently (no reply will come back)' },
      work_id: { type: 'string', description: 'Optional open work reference (e.g. W7) to update only that work at its next step without stopping it' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined) return 'Only Bots on the team can use note_bot.'
      const room = rt.roomOf((rt.groupOwners.get(exec.agent?.id) ?? rt.taskOwners?.get(exec.agent?.id))?.roomId)
      const target = rt.findBot(args.to)
      if (target === undefined) return `No Bot named ${args.to}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`
      if (target.id === sender.id) return 'You cannot leave a note for yourself.'
      const rawNote = String(args.note ?? '').trim()
      if (rawNote === '') return 'Write a note to leave.'
      const text = absoluteLinks(rawNote, rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      const long = await rt.attachLong(text, `Note from ${sender.name}.txt`)
      if (long === undefined) return tooLong(text)
      const workId = typeof args.work_id === 'string' && args.work_id.trim() !== '' ? args.work_id.trim() : undefined
      if (room !== undefined || workId !== undefined) {
        return rt.enqueueWorkNote(workId, sender, target, long, room)
      }
      await rt.deliver({
        fromId: sender.id,
        toId: target.id,
        text: long.text,
        files: long.files,
        length: long.length,
        role: 'note',
        wake: false,
        exchangeId: randomUUID(),
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
      const openWorks = Object.entries(state.works ?? {}).filter(([, work]) => work?.to === target.id && work.child === undefined)
      if (running.length === 0 && activeTasks.length === 0 && openWorks.length === 0) refuse(`${target.name} is not running right now, so there is nothing to stop. Use delegate_work to assign work.`)
      const why = String(args.reason ?? '').trim() || `Stopped by ${sender.name}; previous turn was ended on purpose.`
      const cancelledSnapshots = []
      for (const [workId] of openWorks) {
        rt.forgetWorkDeliveries?.(workId)
        rt.forgetDelivery?.(workId)
        const snapshot = rt.cancelWork?.(workId, { by: sender.id, reason: why })
        if (snapshot !== undefined) cancelledSnapshots.push(snapshot)
      }
      // Separate non-task sessions before stopping tasks (stopping clears taskOwners).
      const nonTaskRunning = running.filter(sessionId => !rt.taskOwners?.has(sessionId))
      const places = nonTaskRunning.map(whereOf)
      if (activeTasks.length > 0) {
        await rt.stopAllTasksOfBot?.(target, why)
        places.push(`${activeTasks.length} background task${activeTasks.length === 1 ? '' : 's'}`)
      }
      for (const sessionId of nonTaskRunning) {
        const agent = await rt.resolveAgent(sessionId)
        agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })
      }
      if (cancelledSnapshots.length > 0) {
        const cancelledIds = new Set(cancelledSnapshots.map(item => item.id))
        const chat = rt.chatOf(target.id)
        const chatAgent = await rt.resolveAgent(chat).catch(() => undefined)
        for (const message of [...(chatAgent?.inbox?.nextStep ?? []), ...(chatAgent?.inbox?.nextTurn ?? [])]) {
          if (cancelledIds.has(message?.source?.exchangeId) || cancelledIds.has(message?.source?.work) || cancelledIds.has(message?.source?.askWork)) {
            chatAgent.inbox?.remove?.(message.id)
          }
        }
      }
      for (const snapshot of cancelledSnapshots) {
        await rt.notifyParentCancelled?.(snapshot, { reason: why, by: sender.id, bySession: exec.agent?.id, byLabel: sender.name })
      }
      if (places.length === 0 && openWorks.length > 0) places.push(`${openWorks.length} open work${openWorks.length === 1 ? '' : 's'}`)
      await rt.deliver({ fromId: sender.id, toId: target.id, ...callerPart(exec), text: why, role: 'stopped', wake: false, afterCancel: nonTaskRunning.length > 0 || activeTasks.length > 0, ...callerRoom(exec) })
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
        // Without a named model the team's default applies; without one the new Bot
        // takes its creator's: the DSH default may be a provider that has no key, and
        // then the new Bot fails on its first reply.
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
        // The photo rides on the Bot's other avatar fields, as the settings page's upload
        // does: setting one keeps a custom character, and clearing removes only the image.
        // They are read here, after the waits above, so a change made meanwhile stays.
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

  // DSH's working_directory changes a Session's folder in place, and the next part starts in
  // the Bot's working folder again. A Bot that changes to a folder outside its working folder
  // sets its working folder instead, with update_bot's checks, and goes on in a fresh part
  // there; a folder inside it, or inside one of its extra folders, only moves this Session
  // there. In a group without a folder of
  // its own the change holds only for that conversation: the Bot's folder, its other groups
  // and its own chat keep theirs (folders.js memberDirs).
  ctx.on('tools/execute', async (exec, next) => {
    // Resolved as DSH gets it, untrimmed, so that both mean the same folder.
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
    // An extra folder is one the Bot already works in, so only this Session moves there.
    for (const dir of rt.extraDirsOf({ botId: bot.id, roomId: room?.id })) {
      if (within(target, await rt.real(dir))) return next()
    }
    if (room?.workDir) throw new Error(`Every member of "${room.name}" works in ${room.workDir} here, so you stay inside it. The user or a Main Bot can change the group's folder.`)
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(`Your working folder cannot change now: ${readOnly}`)
    // Saved folders are trimmed like typed ones, so such a name would save another folder.
    if (unquote(target) !== target) throw new Error(`${JSON.stringify(target)} cannot be a working folder: its name starts or ends with a space or a quote mark.`)
    const workDir = await rt.workFolder(target)
    if (taskEntry !== undefined) {
      // A background task only widens its own Session and updates its own task.workDir
      // for rollover continuity (null means team workspace, like room.memberDirs); it
      // never rewrites room.memberDirs or the Bot's workDir, and a private Bot's tasks
      // stay inside the Bot's own folder (matching startTask).
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
      // The folder holds only for this group conversation, so only this Session's
      // writes widen; the private-Bot check is the one updateBot would run.
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
      // Only catalog entries that already carry `reasoning` (models a Bot runs on)
      // show levels; asking every model for its levels would take a call each.
      return models.map((entry) => {
        const levels = entry.reasoning?.efforts?.map(effort => effort.id) ?? []
        const thinking = levels.length > 0 ? `, thinking: ${levels.join(', ')}${entry.reasoning.defaultEffort === undefined ? '' : ` (default: ${entry.reasoning.defaultEffort})`}` : ''
        const local = rt.isLocalAgentRef?.(entry.ref) === true ? `, runs on the local agent ${entry.providerName}` : ''
        return `- ${entry.ref}${entry.name !== entry.id ? ` (${entry.name})` : ''}${local}${entry.input?.includes('image') ? ', reads images' : ''}${entry.ref === fallback ? ', default' : ''}${thinking}`
      }).join('\n')
    },
  }))

  // Group tools take Bot names as an array, or as one comma-separated string from
  // models that flatten it.
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
        // A Bot that joins a group with a folder works there from its first turn; when a
        // group has no folder of its own, its preset reaches each member's own folder.
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
        // A Bot that joins also gets the group's extra folders it keeps, so it asks for those too.
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
            // The group's preset reaches the member's extra folders too; a Bot on a
            // local agent keeps its own file permissions instead.
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

  // The shared to-do list of a group: open items first, then done ones, each with the
  // short id the check and remove actions take. Ids are UUIDs, and the first eight
  // characters are what the list shows; a prefix is accepted when it names exactly one item.
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
      // An ordinary member's post calls only the members it names (openingSpeakers).
      const member = !rt.isMain(self) && !rt.isAdminOf(room, self)
      const info = rt.live.get(exec.agent?.id)?.info
      if (info?.role === 'room' && info.roomId === room.id) return `You are speaking in "${room.name}" right now. Write your message as your reply instead.`
      const folder = rt.sessionFolder?.(exec.agent?.session ?? exec.agent)
      const text = absoluteLinks(String(args.message ?? '').trim(), folder)
      if (text === '') return 'Write a message to post.'
      // Counted on the whole message. A post past MESSAGE_INLINE_MAX keeps only its
      // first LONG_HEAD characters, and the round reads this list instead of that text.
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
      // Replies the poster waits for, while it works on what a Bot asked it for — or from
      // a background task that must stay open until the group replies — are tracked as work.
      const taskWork = rt.taskBySession?.(exec.agent?.id)?.task?.workId
      const work = reportBack ? worksOf(exec).find(id => rt.ownsWork(self, id) || id === taskWork) : undefined
      const taskOwner = rt.taskOwners?.get(exec.agent?.id)
      const trackTaskWait = reportBack && taskOwner !== undefined
      const fromTaskId = trackTaskWait ? taskOwner.taskId : undefined
      const sub = work !== undefined || trackTaskWait ? randomUUID() : undefined
      const reportId = reportBack ? (sub ?? randomUUID()) : undefined
      const callerOrigin = callerImOrigin(exec)
      const imOrigin = reportBack && work === undefined ? callerOrigin : undefined
      if (sub !== undefined) rt.openWork(sub, { from: self, room: room.id, ...(work !== undefined ? { parent: work } : {}), ...callerPart(exec), ...(imOrigin ? { imOrigin } : {}) })
      const missingFiles = folder === undefined ? [] : missingFileRefs(text, folder)
      const claims = missingFiles.length > 0 ? { missingFiles } : undefined
      try {
        // A post that wants the replies names the conversation it was written
        // from, so the report comes back there instead of the own chat.
        await rt.postToRoom(room, sender, long.text, { mentions, ...(notice ? { route: roomNote(), quiet: true } : {}), ...(claims ? { claims } : {}), ...(callerOrigin ? { callerOrigin } : {}), ...(reportBack ? { reportBack: true, reportId, ...(fromTaskId ? { fromTaskId } : {}), ...(imOrigin ? { imOrigin } : {}), ...callerRoom(exec), ...callerPart(exec) } : {}), ...(member ? { member: true } : {}), ...(sub ? { sub } : {}), ...(long.length ? { length: long.length } : {}) }, long.files)
      } catch (failure) {
        if (failure?.delivered !== true) {
          if (sub !== undefined) rt.dropWork(sub)
          if (reportId !== undefined) rt.dropRoomReport?.(reportId)
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
      const asker = sub === undefined ? undefined : rt.botOf(state.works[work]?.from)?.name
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
      // A card still open (the user has not written since; a Bot's message started this
      // turn) closes in the chat instead of vanishing from it (#2172).
      const prevQuestion = rt.own(state.questions, id)
      if (prevQuestion !== undefined && ((prevQuestion.callSessionId ?? id) !== id || prevQuestion.callId !== exec.callId)) {
        rt.closeCard(id, prevQuestion, 'dismissed')
      }
      state.questions[id] = {
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
      if (owner !== undefined) {
        rt.logRoom(rt.roomOf(owner.roomId), { who: rt.botOf(owner.botId).name, botId: owner.botId, questionId: state.questions[id].id, text: `Asked: ${state.questions[id].question}\n${options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')}` })
      }
      await rt.save()
      exec.concludeTurn?.()
      return 'The card is on screen; the user\'s answer arrives as their next message.'
    },
  }))

  // Scoped per Bot session, not global: another plugin's global show_view serves
  // the sessions ds-bot does not own, while this one shadows it inside them.
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
      // As with ask_user: an earlier view still open closes instead of vanishing (#2172).
      const prevView = rt.own(state.views, id)
      if (prevView !== undefined && ((prevView.callSessionId ?? id) !== id || prevView.callId !== exec.callId)) {
        rt.closeCard(id, prevView, 'dismissed')
      }
      state.views[id] = {
        id: randomUUID(),
        ...(exec.callId ? { callId: exec.callId } : {}),
        title,
        view,
        ...(issueDraft === undefined ? {} : { issueDraft }),
        ...(imOrigin === undefined ? {} : { imOrigin }),
        askedAt: Date.now(),
      }
      if (owner !== undefined) {
        rt.logRoom(rt.roomOf(owner.roomId), { who: rt.botOf(owner.botId).name, botId: owner.botId, viewId: state.views[id].id, text: viewCardText({ title, view }) || title })
      }
      await rt.save()
      exec.concludeTurn?.()
      return 'The view is on screen; the user\'s answer arrives as their next message.'
    },
  }))

  // The team tools live in each Session's own scope, never in the global layer:
  // a Bot's chat and a member's group Session get all of them, a group's own
  // Session gets only its relay, and a Session ds-bot does not own gets none —
  // so they never appear in a plain dsh conversation, and another plugin's
  // same-named global tool can neither collide with them at boot nor shadow
  // them inside these Sessions. What is scoped onto a Session is kept by its
  // disposers and goes with the ownership: indexSessions (store.js) runs
  // syncScopedTools on every save and adopt, so a deleted Bot's adopted
  // Session, a member who left, or a deleted group shows the plain dsh surface
  // again — and the unload effect lifts whatever is left. The same sync scopes
  // the live Agents back: a reload lifts their scope while they are still
  // live, and agent/created does not fire for them again, so without the walk
  // their next request would come without the team tools.
  const scopeOf = (id) => rt.toolScopeForTurn?.(id) ?? {
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

  // Team tools that have zero valid actions in this Bot Session's current role/context.
  // Permission checks in each tool's execute() and ctx.tools.guard remain intact as
  // defense-in-depth.
  const hiddenTeamToolsFor = (id) => {
    const hidden = new Set()
    if (!rt.isBotSession(id)) return hidden
    const s = scopeOf(id)
    // group_relay is only for a group chat's own Session (relayOnly), never a Bot Session.
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

  /** @type {Map<string, {agent: any, relay: boolean, tools: boolean, restricted: boolean, disposers: Array<() => void>, unlisted: Set<string>}>} */
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
    for (const lift of held.taskGlobalLifts ?? []) {
      try { lift() } catch { /* already lifted */ }
    }
    held.taskGlobalLifts = []
    held.taskGlobalDenied = new Set()
    for (const lift of held.connectorLifts ?? []) {
      try { lift() } catch { /* already lifted */ }
    }
    held.connectorLifts = []
    for (const lift of held.pluginLifts ?? []) {
      try { lift() } catch { /* already lifted */ }
    }
    held.pluginLifts = []
    for (const dispose of held.disposers) {
      try {
        dispose()
      } catch (error) {
        rt.warn('ds-bot: a scoped tool of %s was not removed: %s', id, error)
      }
    }
  }
  const syncScopedSession = (id) => {
    if (id === undefined) return
    const held = scoped.get(id)
    if (held?.agent !== undefined) hideBotUnusedTools(held.agent)
  }
  const syncScopedTools = () => {
    // unscope() deletes as it goes, which a Map keys iterator takes in stride.
    for (const id of scoped.keys()) {
      if (!rt.isBotSession(id) && rt.roomOf(id) === undefined) unscope(id)
    }
    // A reload lifts the scope of Agents that are still live, and an adopted
    // file can newly own one that already runs: scope each live Agent the team
    // owns before its next request. hideBotUnusedTools does nothing for a
    // Session that stays unowned, and nothing twice for one already scoped.
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

  // Warn once, but also retry independently of the next step.
  const registerless = new WeakSet()
  const shareBotTools = (agent) => {
    if (agent === undefined) return
    const id = agent.session?.id
    const owns = rt.isBotSession(id)
    const relayOnly = !owns && rt.roomOf(id) !== undefined
    const wanted = owns || relayOnly
    let held = scoped.get(id)
    // The local-agent tools (the CLI permission bridge) join the scope only of
    // a Bot whose route is a local agent; they are not in rt.teamTools. A Bot
    // can move onto or off a local route after its Agent exists.
    const self = owns ? rt.botOf(rt.selfOf(id)) : undefined
    const localBot = rt.isLocalAgentRef?.(self?.model ?? self?.appliedModel) === true
    // A Session that left the team, a scope of the wrong kind, a fresh Agent
    // for one Session, or a Bot that changed between a local route and a model
    // all start over; a wanted scope is registered again below.
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
    // A live Agent can be scoped while the modules that add tools are still installing:
    // loading the plugin again walks the live Agents from the load the memory module
    // starts, and the tools added after it (memory, secrets, connectors) would never
    // join that scope. Register what it is missing, so the next request is whole.
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
          // Recorded only once the Agent took it: one that failed is tried again at
          // the next assemble, so a reload cannot leave that tool out for good.
          ;(held.added ??= new Set()).add(def.name)
          held.unlisted.add(def.name)
        } catch (error) {
          // A name the replaced plugin's scope still holds reads as already
          // registered. It is left out of `added`, so the next assemble tries again
          // once that scope is released, and it is not reported as a new failure.
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
        // A tool another plugin already scoped onto this agent stays missing
        // rather than stopping the team; the rest still land.
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
    // A scope made outside creation never reached a collected tool list; the
    // assemble adds the pending names to the step's list once, then clears them.
    for (const name of registered) held.unlisted.add(name)
    if (failed.length > 0) rt.warn('ds-bot: team tools not served to %s: %s', id, failed.join('; '))
    if (failed.length > 0) retryBotTools(agent, held)
    else {
      clearTimeout(held.retryTimer)
      held.retryTimer = undefined
    }
  }

  // Tools joined after the first scoping (mail tools appear when the first
  // account is added) register into every held Agent and are offered once.
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
          // removeTeamTool lifts by name from toolLifts, matching both
          // shareBotTools registration paths.
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
    // Scoped registrations already handed out are disposed by name.
    for (const [id, held] of scoped) {
      const dispose = held.toolLifts?.get(name)
      if (typeof dispose === 'function') {
        const index = held.disposers.indexOf(dispose)
        if (index !== -1) held.disposers.splice(index, 1)
        try {
          dispose()
        } catch (error) {
          rt.warn('ds-bot: a scoped tool %s of %s was not removed: %s', name, id, error)
        }
      }
      held.toolLifts?.delete(name)
      held.added?.delete(name)
      held.unlisted.delete(name)
    }
  }

  // Per-Bot connector switches (state.connectors[id].offFor): deny the served
  // tools matching each off connector's prefix. Re-applied on tools/change.
  const maskConnectorTools = (agent, held) => {
    if (typeof agent.ctx?.tools?.restrict !== 'function' || typeof ctx.tools?.schemas !== 'function') return
    const botId = rt.selfOf(agent.session?.id)
    const prefixes = rt.connectorOffFor?.(botId) ?? []
    // Taking the served schemas is the expensive part: every schema is walked when the
    // tool scope is taken, and most Bots have no connector off.
    if (prefixes.length === 0 && (held.connectorLifts?.length ?? 0) === 0 && (held.connectorDenied?.size ?? 0) === 0) return
    // schemas(agent) omits tools our current mask already hid. Keep those names
    // while computing the next mask, or the next tools/change would lift it.
    const served = new Set([...ctx.tools.schemas(agent).map(schema => schema.name), ...(held.connectorDenied ?? [])])
    // One restrict() per connector: one per tool would take the scope once for each.
    // A tool two prefixes match is denied once, by the first prefix that names it.
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
        // A name in the Agent's own scope fails the whole list (restrict() masks
        // inherited tools only), so mask the rest one at a time.
        for (const name of names) {
          try {
            const lift = agent.ctx.tools.restrict({ deny: [name] })
            if (typeof lift === 'function') held.connectorLifts.push(lift)
          } catch { /* a scoped name cannot be restricted; connectors are global */ }
        }
      }
    }
  }
  // Plugin masks:
  // 1. Scoped team tools (`read_browser` when external browser is active, or per-Bot disabled
  //    native plugin tools) are mounted/unmounted directly on the Agent's own scope because
  //    DSH's `restrict()` only masks inherited global tools.
  // 2. Global external tools (inactive slot DSH bundles, pending-restart bundles, per-Bot
  //    disabled DSH/MCP plugins) are masked via `agent.ctx.tools.restrict()` with re-entrancy
  //    protection against synchronous `tools/change` emissions.
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

      // 1. Sync Agent-scoped team tools (`read_browser` and native plugin tools).
      // Only re-register tools that were explicitly hidden by plugin rules (`pluginHiddenScoped`)
      // so unrelated registration failures stay governed by `retryBotTools`.
      if (held.tools === true && !held.relay && typeof agent.ctx?.tools?.register === 'function') {
        const hiddenScoped = (held.pluginHiddenScoped ??= new Set())
        const hiddenTeam = hiddenTeamToolsFor(agent.session?.id)
        for (const def of rt.teamTools) {
          const shouldHide = scopedDenied.has(def.name)
          const hasLift = held.toolLifts?.has(def.name) === true
          if (shouldHide) {
            hiddenScoped.add(def.name)
            if (hasLift) {
              disposeScopedTool(held, def.name)
            }
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

      // 2. Mask inherited global tools via `agent.ctx.tools.restrict()`.
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

      // Clear state BEFORE invoking old lifts so synchronous `tools/change` cannot lose new lifts.
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

  // restrict() throws on a name this profile does not serve.
  const maskHiddenTools = (agent, held, served) => {
    const groups = HIDDEN_TOOL_GROUPS.map(group => group.filter(name => served.has(name))).filter(group => group.length > 0)
    if (groups.length === 0) return
    // Marked after one attempt even when a group fails, so a profile that can
    // never mask it is not re-masked on every resolve.
    held.restricted = true
    for (const deny of groups) {
      try {
        const lift = agent.ctx.tools.restrict({ deny })
        if (typeof lift === 'function') held.disposers.push(lift)
      } catch {
        // A name in the Agent's own scope fails the whole list (restrict() masks
        // inherited tools only), so mask the rest one at a time; what stays is
        // covered by the assembly filter and the guard.
        for (const name of deny) {
          try {
            const lift = agent.ctx.tools.restrict({ deny: [name] })
            if (typeof lift === 'function') held.disposers.push(lift)
          } catch {
            // Expected for names in the Agent's own scope.
          }
        }
      }
    }
  }

  // dsh's own question tool holds the turn open until the user answers, and every
  // message from another Bot or a group round queues behind it. Bot Sessions ask
  // through ask_user instead, so it is taken out of their tool list, as are the goal
  // and delegation tools. The restricts are kept with the Session's scope, so they
  // lift with it.
  const hideBotUnusedTools = (agent) => {
    try {
      rt.scopeCodeMode?.(agent)
    } catch (error) {
      rt.warn?.('ds-bot: scoping code-mode for %s failed: %s', agent?.session?.id, error)
    }
    shareBotTools(agent)
    const id = agent?.session?.id
    // The shell shadows go with the scope, so a reload or a Session that leaves
    // the team lifts them like the rest, and the Agent can be scoped again.
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
  // A new Bot, part, or group Session gets its Agent before ds-bot records it, so the
  // recording path resolves it again once the session is known as a Bot's; meanwhile
  // the guard refuses the question and delegation tools in any Bot Session, and a
  // goal made there is blocked.
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
  // Creation waits for this listener, so the Agent's first step already lacks the tool.
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await rt.load()
      hideBotUnusedTools(agent)
      // Creation runs before the first step collects the tool list, so the
      // names just registered will already be in it; nothing stays pending.
      scoped.get(agent?.session?.id)?.unlisted?.clear()
    } catch (error) {
      rt.warn('ds-bot: hiding %s on agent/created failed: %s', HIDDEN_TOOLS.join(', '), error)
    }
  })

  // The standard preset registers `subagent` (model selection) in each Agent's own
  // scope, where restrict() and a same-name section cannot reach it, so the host
  // assembly hook drops hidden tools and their guidance for that Bot Session.
  // restrict still masks what it can, so lookup and execution stay aligned, and the
  // guard refuses calls.
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
    // DSH 0.2.2 adds the tool list after this waterfall (#814), so only an
    // older assembly still carries tools to drop here.
    return {
      ...assembled,
      ...filterTools ? { tools: assembled.tools.filter(tool => !dropTool(tool)) } : {},
      ...filterSections ? { sections: assembled.sections.filter(section => !dropSection(section)) } : {},
    }
  }

  // A live Agent the creation path missed — after a restart, agent/created may
  // run before this plugin's listeners are back — is scoped by the load or
  // here, before the step's request. The request's tool list was collected
  // before this waterfall, so names scoped since are added now: a same-named
  // global entry is replaced by the scoped schema, and a PTC list that reaches
  // team tools through run_code is left alone.
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
      // DSH 0.2.2 collects the scoped tools itself after this waterfall (#814).
      if (!Array.isArray(assembled?.tools)) {
        held.unlisted.clear()
      } else {
        const pending = [...held.unlisted]
        // Cleared whatever happens below: the names are offered once, not on
        // every step.
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

  // DSH adds tools after system-prompt/assemble. Transform the final request through
  // its documented LLM waterfall; next() cannot accept replacement options.
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

  // The /goal command stays open in every Session, so a goal started in a Bot chat or a
  // group is blocked at once; DSH's round driver then starts no round for it.
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
    // block() appends to the same log, so it waits until every listener has seen this change.
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
      const lines = items.map(item => {
        const extra = item.kind === 'pack' ? `; includes ${(item.items ?? []).join(', ') || 'nothing'}`
          : item.kind === 'mcp' && item.transport === 'stdio' ? `; ${item.approved ? 'allowed' : 'needs user approval'}` : ''
        const itemStatus = statuses[item.name]
        const state = itemStatus ? ` (${itemStatus.state}${itemStatus.error ? `: ${itemStatus.error}` : ''})` : ''
        const status = bot.capabilities?.includes(item.name) ? `; attached to you${state}` : ''
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
  Object.assign(rt, { pickRoom, hideBotUnusedTools, syncScopedTools, syncScopedSession, hiddenTeamToolsFor, hiddenSessionTools, hiddenToolsFor, addTeamTool, removeTeamTool, reapplyToolMasks, resumePausedWork, isDispatchingWork, cancelWorkByUser, abortWorkExecution })
}

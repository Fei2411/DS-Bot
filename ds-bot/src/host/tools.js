// Team tools: the roster, bot-to-bot messages, group chat settings and posts, and the
// question card. Group rounds and reading chats are in groups.js.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { COLORS, EXTRA_COLORS, MAX_HOPS, MAX_UNREAD_REQUESTS, ROOM_BOT_ROUNDS, ROOM_MODES, SOURCE_KIND } from './constants.js'
import { unquote } from './text.js'

export const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
export const GROUP_REF = { type: 'string', required: true, description: 'Exact group chat name from list_bots' }
const BLOCKING_QUESTION_TOOL = 'ask_user_question'
// DS Bot carries no goal across conversation parts, so Bot Sessions do not run DSH goals.
const GOAL_TOOLS = ['create_goal', 'update_goal', 'get_goal']
const HIDDEN_TOOLS = [BLOCKING_QUESTION_TOOL, ...GOAL_TOOLS]
const GOAL_REFUSAL = 'DS Bot does not run goals. Ask the Bot in a message instead.'
const MODE_PARAM = {
  type: 'string',
  enum: ROOM_MODES,
  description: '"everyone": every member answers a plain message in turn, admin first. "admin" (the default): a plain message goes to the admin, who calls others with @Name. @mentions always choose who answers.',
}
const WORK_DIR_PARAM = { type: 'string', description: 'Full path of the folder to work in, where commands and file tools start. Only when the user asks for it' }

export function install(rt) {
  const { ctx, state } = rt

  const callerBot = (exec) => rt.botOf(rt.selfOf(exec.agent?.id))
  const callerRoom = (exec) => {
    const roomId = rt.groupOwners.get(exec.agent?.id)?.roomId
    return roomId ? { fromRoomId: roomId } : {}
  }

  const roomLine = (room, self) => {
    const members = room.members.map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${bot.id === room.admin ? ' (admin)' : ''}${bot.id === self ? ' (you)' : ''}`)
    const parts = [
      `members: ${members.join(', ')}`,
      room.mode === 'admin' && room.admin ? 'plain messages go to the admin first' : 'every member replies in turn',
      room.notice ? `notice: ${room.notice.split('\n')[0].slice(0, 100)}` : '',
      room.workDir ? `members work in ${room.workDir} here` : '',
    ].filter(Boolean)
    return `- "${room.name}" — ${parts.join('; ')}`
  }
  // Main Bots see every group; other Bots see the groups they are in.
  const visibleRooms = self => Object.values(state.rooms).filter(room => rt.isMain(self) || room.members.includes(self))

  ctx.tools.register(defineTool({
    name: 'list_bots',
    description: 'List every Bot on the user\'s team with its role and what it does, and the group chats you can see.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const lines = Object.values(state.bots).map(bot => {
        const model = bot.appliedModel ?? bot.model
        const tags = [bot.role, model ? `model ${model}` : '', bot.workDir ? `works in ${bot.workDir}` : '', rt.isMain(bot.id) ? 'Main Bot' : '', bot.id === self ? 'you' : ''].filter(Boolean).join(', ')
        const job = bot.instructions ? ` — ${bot.instructions.split('\n')[0].slice(0, 120)}` : ''
        return `- ${bot.name}${tags ? ` (${tags})` : ''}${job}`
      })
      if (lines.length === 0) return 'No Bots yet.'
      const rooms = visibleRooms(self)
      return [
        'Bots:',
        ...lines,
        '',
        rooms.length === 0 ? 'Group chats: none you can see.' : 'Group chats:',
        ...rooms.map(room => roomLine(room, self)),
      ].join('\n')
    },
  }))

  // Sessions a Bot is running in right now: its own chat plus each group Session
  // with a live turn. An idle Bot reports just its own chat.
  const activeSessions = (botId) => {
    const running = [...new Set([rt.chatOf(botId), ...rt.groupSessionsOf(botId)])]
      .filter(sessionId => rt.live.get(sessionId)?.turn !== undefined)
    return { running, idle: running.length === 0 }
  }
  const whereOf = (sessionId) => {
    const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
    return room ? `group "${room.name}"` : 'its own chat'
  }
  // Delivered but not read yet: no step or turn has taken them out of the inbox.
  const unreadRequests = agent => [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
    .filter(message => message.source?.kind === SOURCE_KIND && message.source.role === 'request').length

  // A tool that throws shows as failed in the chat, instead of as sent or stopped.
  const refuse = (message) => { throw new Error(message) }

  ctx.tools.register(defineTool({
    name: 'message_bot',
    description: 'Send a message to another Bot on the team. If that Bot is working, it reads your message at its next step and can change course, then answers once that work is done; if it is idle, it starts on it right away. Its reply arrives later as a new message to you; with reply_to "user" it answers the user in its own chat instead.',
    parameters: {
      to: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      message: { type: 'string', required: true, description: 'Self-contained message; the other Bot cannot see this conversation' },
      reply_to: {
        type: 'string',
        enum: ['me', 'user'],
        description: '"me" (default): the reply comes back to you and the user does not see it. "user": the Bot answers the user in its own chat, where the user reads it, and nothing comes back to you. Use "user" whenever the user wants to hear from that Bot directly or asks Bots to say something in their own chats.',
      },
      when: {
        type: 'string',
        enum: ['now', 'queue'],
        description: '"now" (default): a working Bot reads your message at its next step, between its current actions, and answers once its current work is done; use it for questions, information it needs, corrections and warnings. "queue": it reads your message only after its current work is done, as a separate task; use it only for a new task unrelated to what it is doing now. With reply_to "user" the message always queues.',
      },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined) return 'Only Bots on the team can use message_bot.'
      const target = rt.findBot(args.to)
      if (target === undefined) return `No Bot named ${args.to}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`
      if (target.id === sender.id) return 'You cannot message yourself.'
      const turn = rt.live.get(exec.agent?.id)
      const hop = Math.max(turn?.info?.hop ?? 0, ...(turn?.joined ?? []).map(joined => joined.info?.hop ?? 0))
      if (hop >= MAX_HOPS) return 'This chain of Bot messages is already long. Stop here and report to the user instead.'
      const chat = rt.chatOf(target.id)
      const unread = unreadRequests(await rt.resolveAgent(chat))
      if (unread >= MAX_UNREAD_REQUESTS) {
        refuse(`Not sent: ${target.name} has not read the last ${unread} messages from Bots yet, so it is most likely stuck, for example waiting for the user. Do not send it more; tell the user that ${target.name} is not responding.`)
      }
      const toUser = args.reply_to === 'user'
      const working = rt.live.get(chat)?.turn !== undefined
      const steer = args.when !== 'queue' && !toUser
      await rt.deliver({ fromId: sender.id, toId: target.id, text: args.message, role: 'request', hop, steer, ...(toUser ? { audience: 'user' } : callerRoom(exec)) })
      const sent = toUser
        ? `Delivered to ${target.name}. It will answer the user in its own chat; nothing comes back to you, so point the user to ${target.name}'s chat instead of relaying.`
        : working && steer
          ? `Delivered to ${target.name} while it is working: it reads your message at its next step and answers once that work is done. Its reply will arrive later as a new message; do not wait for it.`
          : working
            ? `Queued for ${target.name}: it reads your message after its current work. Its reply will arrive later as a new message; do not wait for it.`
            : `Delivered to ${target.name}. Its reply will arrive later as a new message; do not wait for it.`
      // "Delivered" only means it is in the inbox; say so when it may sit there a while.
      const notes = [
        rt.waitsForApproval?.(chat) ? `${target.name} is waiting for the user's approval, so it reads your message only after the user answers.` : '',
        unread > 0 ? `${target.name} has not read ${unread === 1 ? 'an earlier message' : `${unread} earlier messages`} from Bots yet.` : '',
      ].filter(Boolean)
      const status = notes.length === 0 ? sent : `${sent} ${notes.join(' ')}`
      // Messages reach a Bot's own chat only; work in a group goes on without them.
      const groups = activeSessions(target.id).running.filter(sessionId => sessionId !== chat)
      if (groups.length === 0) return status
      const stop = rt.isMain(sender.id) ? ' If it must not go on there, use stop_bot.' : ''
      return `${status} ${target.name} is also working in ${groups.map(whereOf).join(' and ')}; your message does not reach that work.${stop}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'stop_bot',
    description: 'Main Bot only. Stop another Bot\'s running turn immediately — when it must not finish a dangerous action and a message_bot warning is not enough. Its queued messages are dropped with the turn. It is then told why in a new turn, whose reply comes back to you.',
    parameters: {
      bot: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      reason: { type: 'string', description: 'Why it was stopped; it reads this afterwards' },
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
      if (running.length === 0) refuse(`${target.name} is not running right now, so there is nothing to stop. Use message_bot to reach it.`)
      for (const sessionId of running) {
        const agent = await rt.resolveAgent(sessionId)
        agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })
      }
      const why = String(args.reason ?? '').trim() || 'Stop what you are doing; the previous turn was ended on purpose. Acknowledge briefly.'
      await rt.deliver({ fromId: sender.id, toId: target.id, text: why, role: 'stopped', ...callerRoom(exec) })
      return `Stopped ${target.name} in ${running.map(whereOf).join(' and ')}. It is told why in a new turn, whose reply comes back to you.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'create_bot',
    description: 'Main Bot only. Create a new Bot on the user\'s team. It appears in the sidebar and greets the user.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short display name, e.g. "Researcher" or "Editor"' },
      role: { type: 'string', required: true, description: 'Two-to-four character role label shown under the name' },
      instructions: { type: 'string', required: true, description: 'What this Bot is responsible for and how it should work' },
      brief: { type: 'string', description: 'Why the user wants it, passed to the new Bot as its first context' },
      model: { type: 'string', description: 'Model the Bot runs on, as provider/model or a model id. Only when the user names one; otherwise the DSH default model.' },
      work_dir: WORK_DIR_PARAM,
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (!rt.isMain(rt.selfOf(exec.agent?.id))) return 'Only the Main Bot can create Bots. Ask the Main Bot instead.'
      try {
        const workDir = args.work_dir ? await rt.cleanWorkDir(args.work_dir) : undefined
        const name = String(args.name ?? '').trim()
        await rt.approveFolder(exec, { path: workDir, who: { en: `the new Bot ${name}`, zh: `新 Bot ${name} ` } })
        const bot = await rt.createBot({ ...args, workDir, createdBy: rt.selfOf(exec.agent.id) })
        return `Created ${bot.name}${workDir ? `, working in ${workDir}` : ''}. It is greeting the user now.`
      } catch (error) {
        return `Could not create the Bot: ${error.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_bot',
    description: 'Change a Bot\'s name, role, color, model, working folder, or instructions. Every Bot may change itself; only a Main Bot may change another Bot.',
    parameters: {
      bot: { type: 'string', description: 'Current name of the Bot to change; leave out to change yourself' },
      name: { type: 'string', description: 'New name' },
      role: { type: 'string', description: 'New role label' },
      instructions: { type: 'string', description: 'Replacement instructions' },
      color: { type: 'string', description: `One of ${[...COLORS, ...EXTRA_COLORS].join(', ')}` },
      model: { type: 'string', description: 'Move the Bot to another model, as provider/model or a model id' },
      work_dir: { ...WORK_DIR_PARAM, description: `${WORK_DIR_PARAM.description}; an empty string returns it to the team workspace` },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const caller = rt.botOf(self)
      if (caller === undefined) return 'Only Bots on the team can use update_bot.'
      const bot = args.bot ? rt.findBot(args.bot) : caller
      if (bot === undefined) return `No Bot named ${args.bot}.`
      if (bot.id !== caller.id && !rt.isMain(self)) return 'Only a Main Bot can change another Bot. Leave out bot to change yourself, or ask a Main Bot with message_bot.'
      try {
        const { name: newName, role, instructions, color, model } = args
        const moving = typeof args.work_dir === 'string'
        const workDir = moving ? await rt.cleanWorkDir(args.work_dir) : undefined
        if (moving && workDir !== bot.workDir) await rt.approveFolder(exec, { path: workDir, sessions: rt.sessionsOfBot(bot.id), who: { en: bot.name, zh: ` ${bot.name} ` } })
        const next = await rt.updateBot(bot.id, { name: newName, role, instructions, color, ...(model ? { model } : {}), ...(moving ? { workDir: workDir ?? '' } : {}) })
        if (!moving) return `Updated ${next.name}.`
        const folder = workDir ?? 'the team workspace'
        return bot.id === caller.id ? `Updated ${next.name}. From your next step on, you work in ${folder}.` : `Updated ${next.name}. It now works in ${folder}.`
      } catch (error) {
        return `Could not update the Bot: ${error.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_models',
    description: 'List the models a Bot can run on, as provider/model refs for create_bot and update_bot.',
    parameters: {},
    output,
    async execute() {
      const models = await rt.catalog()
      if (models.length === 0) return 'No models are configured. Ask the user to add one in Settings → Models.'
      const fallback = rt.defaultRef()
      return models.map(entry => `- ${entry.ref}${entry.name !== entry.id ? ` (${entry.name})` : ''}${entry.input?.includes('image') ? ', reads images' : ''}${entry.ref === fallback ? ', default' : ''}`).join('\n')
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
  const teamNames = () => Object.values(state.bots).map(bot => bot.name).join(', ')
  const groupNames = self => visibleRooms(self).map(room => `"${room.name}"`).join(', ') || 'none'
  const pickRoom = (ref, self) => {
    const matches = rt.findRooms(ref).filter(room => visibleRooms(self).includes(room))
    if (matches.length === 1) return { room: matches[0] }
    if (matches.length > 1) return { error: `Several group chats are called "${unquote(ref)}". Rename one first.` }
    return { error: `No group chat called "${unquote(ref)}" that you can see. Groups: ${groupNames(self)}.` }
  }

  ctx.tools.register(defineTool({
    name: 'create_group',
    description: 'Main Bot only. Create a group chat with the user and some Bots. You join it as its admin unless you name another member.',
    parameters: {
      members: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact names of the other Bots to add; you are added automatically' },
      name: { type: 'string', description: 'Group name; defaults to the member names' },
      notice: { type: 'string', description: 'Shared instructions every member reads before speaking in this group' },
      admin: { type: 'string', description: 'Member who leads the group; defaults to you' },
      mode: MODE_PARAM,
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
        const room = await rt.createRoom({ members, name: args.name, notice: args.notice, mode: args.mode, admin: admin.id, createdBy: self })
        return `Created group "${room.name}" with ${room.members.map(id => rt.botOf(id).name).join(', ')}. ${admin.id === self ? 'You are' : `${admin.name} is`} its admin. It is in the user's sidebar; use post_to_group to start a discussion there.`
      } catch (error) {
        return `Could not create the group: ${error.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_group',
    description: 'Change a group chat: rename it, set its notice, add or remove members, change its admin or reply mode. Main Bots may change any group; a group\'s admin may change its own group.',
    parameters: {
      group: GROUP_REF,
      name: { type: 'string', description: 'New group name; an empty string names it after its members again' },
      notice: { type: 'string', description: 'Replacement notice, the shared instructions every member reads; an empty string clears it' },
      add_members: { type: 'array', items: { type: 'string' }, description: 'Exact names of Bots to add' },
      remove_members: { type: 'array', items: { type: 'string' }, description: 'Exact names of Bots to remove' },
      admin: { type: 'string', description: 'Member to make the admin; "none" leaves the group without one (Main Bots only)' },
      mode: MODE_PARAM,
      work_dir: { ...WORK_DIR_PARAM, description: `${WORK_DIR_PARAM.description}. Every member works there in this group; an empty string lets each member work in its own folder again (Main Bots only)` },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use update_group.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      const moving = typeof args.work_dir === 'string'
      if (moving && !rt.isMain(self)) return `Only a Main Bot can set the folder of "${room.name}".`
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
        const workDir = moving ? await rt.cleanWorkDir(args.work_dir) : undefined
        // A Bot that joins a group with a folder works there from its first turn.
        const joining = add.bots.filter(bot => !room.members.includes(bot.id))
        if (moving && workDir !== room.workDir) {
          const members = [...room.members, ...joining.map(bot => bot.id)]
          await rt.approveFolder(exec, { path: workDir, sessions: members.map(id => room.sessions?.[id]).filter(Boolean), who: { en: `every member of "${room.name}"`, zh: `群聊「${room.name}」的成员` } })
        } else if (joining.length > 0) {
          const names = joining.map(bot => bot.name)
          await rt.approveFolder(exec, { path: room.workDir, sessions: joining.map(bot => room.sessions?.[bot.id]).filter(Boolean), who: { en: names.join(', '), zh: ` ${names.join('、')} ` } })
        }
        const { room: next, changes } = await rt.updateRoom(room.id, {
          name: args.name,
          notice: args.notice,
          mode: args.mode,
          admin,
          add: add.bots.map(bot => bot.id),
          remove: remove.bots.map(bot => bot.id),
          ...(moving ? { workDir: workDir ?? '' } : {}),
        }, self)
        return changes.length === 0 ? `Nothing changed in "${next.name}".` : `Updated "${next.name}": ${changes.join('; ')}.`
      } catch (failure) {
        return `Could not update "${room.name}": ${failure.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
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

  ctx.tools.register(defineTool({
    name: 'post_to_group',
    description: 'Post a message into a group chat as yourself. It starts a round: members reply in the group, where the user reads them. Main Bots may post into any group; an admin into its own group.',
    parameters: {
      group: GROUP_REF,
      message: { type: 'string', required: true, description: 'What to say; write "@Name" to choose who answers, and a name without "@" to only mention a member' },
      report_back: { type: 'boolean', description: 'Also send the members\' replies back to you as a new message when the round ends' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const sender = rt.botOf(self)
      if (sender === undefined) return 'Only Bots on the team can use post_to_group.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      if (!rt.isMain(self) && !rt.isAdminOf(room, self)) return `Only a Main Bot or the admin of "${room.name}" can post there. Use message_bot to reach its members.`
      const info = rt.live.get(exec.agent?.id)?.info
      if (info?.role === 'room' && info.roomId === room.id) return `You are speaking in "${room.name}" right now. Write your message as your reply instead.`
      if ((info?.hop ?? 0) >= MAX_HOPS) return 'This chain of Bot messages is already long. Stop here and report to the user instead.'
      const text = String(args.message ?? '').trim()
      if (text === '') return 'Write a message to post.'
      if ((room.botRounds ?? 0) >= ROOM_BOT_ROUNDS) return `Bots already started ${ROOM_BOT_ROUNDS} rounds in "${room.name}" since the user last spoke there. Wait for the user.`
      room.botRounds = (room.botRounds ?? 0) + 1
      await rt.save()
      const reportBack = args.report_back === true
      try {
        await rt.postToRoom(room, sender, text, { hop: info?.hop ?? 0, ...(reportBack ? { reportBack: true } : {}) })
      } catch (failure) {
        return `Could not post in "${room.name}": ${failure.message}`
      }
      return `Posted in "${room.name}". Members reply there, where the user reads them${reportBack ? '; their replies also come back to you as a new message when the round ends' : ', and nothing comes back to you'}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ask_user',
    description: 'Show the user a short multiple-choice question card in the chat (the user can also type their own answer). Calling it ends your turn; the chosen answer arrives later as the user\'s next message.',
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
      if (rt.groupOwners.has(id)) return 'Question cards only work in your own chat. In a group, ask in your message instead.'
      if (!rt.chatOwners.has(id)) return 'Only Bots on the team can use ask_user.'
      const options = (Array.isArray(args.options) ? args.options : [])
        .map(option => (typeof option === 'string' ? { label: option } : option ?? {}))
        .map(option => ({
          label: String(option.label ?? '').trim(),
          ...(option.description ? { description: String(option.description).trim() } : {}),
        }))
        .filter(option => option.label !== '')
        .slice(0, 6)
      if (options.length === 0) return 'Give at least one option.'
      // A hidden Bot-to-Bot turn shows none of its calls, so its card goes to the
      // composer dock, which takes questions without a call.
      const turn = rt.live.get(id)?.turn
      const hidden = turn !== undefined && (state.exchangeTurns[id] ?? []).includes(turn)
      state.questions[id] = {
        id: randomUUID(),
        ...(exec.callId && !hidden ? { callId: exec.callId } : {}),
        question: String(args.question ?? '').trim(),
        ...(args.detail ? { detail: String(args.detail).trim() } : {}),
        options,
        multiSelect: args.multiSelect === true,
        ...(args.allowCustom === true ? { allowCustom: true } : {}),
        askedAt: Date.now(),
      }
      await rt.save()
      exec.concludeTurn?.()
      return 'The card is on screen; the user\'s answer arrives as their next message.'
    },
  }))

  // dsh's own question tool holds the turn open until the user answers, and every
  // message from another Bot or a group round queues behind it. Bot Sessions ask
  // through ask_user instead, so the tool is taken out of their tool list, as are the
  // goal tools.
  const hiddenTools = new WeakSet()
  const hideBotUnusedTools = (agent) => {
    if (agent === undefined || hiddenTools.has(agent) || !rt.isBotSession(agent.session?.id)) return
    if (typeof agent.ctx?.tools?.restrict !== 'function') return
    try {
      // restrict() throws on a name this profile does not serve.
      const served = new Set(ctx.tools.schemas(agent).map(schema => schema.name))
      const deny = HIDDEN_TOOLS.filter(name => served.has(name))
      if (deny.length === 0) return
      agent.ctx.tools.restrict({ deny })
      hiddenTools.add(agent)
    } catch (error) {
      rt.warn('ds-bot: %s stay in the tool list of %s: %s', HIDDEN_TOOLS.join(', '), agent.session?.id, error)
    }
  }
  // A new Bot, part, or group Session gets its Agent before ds-bot records it, so the
  // list is only trimmed once ds-bot resolves that Agent again; meanwhile the guard
  // refuses the question tool in any Bot Session, and a goal made there is blocked.
  ctx.tools.guard(exec => (exec.name === BLOCKING_QUESTION_TOOL && rt.isBotSession(exec.agent?.id)
    ? `Bots cannot use ${BLOCKING_QUESTION_TOOL}. Ask with ask_user in your own chat, or ask in your reply.`
    : undefined))
  // Creation waits for this listener, so the Agent's first step already lacks the tool.
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await rt.load()
      hideBotUnusedTools(agent)
    } catch (error) {
      rt.warn('ds-bot: hiding %s on agent/created failed: %s', HIDDEN_TOOLS.join(', '), error)
    }
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
    if (event.type !== 'goal/change' || event.data?.goal?.phase !== 'active') return
    const id = session?.id
    if (!rt.isBotSession(id) && rt.roomOf(id) === undefined) return
    // block() appends to the same log, so it waits until every listener has seen this change.
    setTimeout(() => void blockGoal(id), 0)
  })

  ctx.tools.register(defineTool({
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
  ctx.tools.register(defineTool({
    name: 'save_capability',
    description: 'Create or update a shared MCP server, skill, or pack. Changes apply from your next message.',
    parameters: {
      name: { type: 'string', required: true, description: 'Lowercase letters, digits, and single hyphens, up to 32 characters; "github" is reserved' },
      kind: { type: 'string', required: true, enum: ['mcp', 'skill', 'pack'] },
      description: { type: 'string', description: 'What this capability provides' },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'How to reach an MCP server: a local command or an HTTP URL' },
      command: { type: 'string', description: 'Program that starts a local MCP server' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments for command' },
      env: { type: 'object', additionalProperties: true, description: 'Environment variables for command; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value' },
      url: { type: 'string', description: 'MCP server URL' },
      headers: { type: 'object', additionalProperties: true, description: 'HTTP headers; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value' },
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
  ctx.tools.register(defineTool({
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
    ctx.tools.register(defineTool({
      name,
      description: `${verb} a shared capability to yourself, or to another Bot if you are a Main Bot.`,
      parameters: {
        name: { type: 'string', required: true, description: 'Capability name from list_capabilities' },
        bot: { type: 'string', description: 'Optional Bot name; only a Main Bot may change another Bot' },
      },
      output,
      async execute(args, exec) {
        await rt.load()
        const self = rt.selfOf(exec.agent?.id)
        if (!rt.botOf(self)) return `Only Bots on the team can use ${name}.`
        try {
          const result = await rt.changeCapabilityAttachment(endpoint, args, self)
          const attached = state.capabilities.items[args.name]
          const members = attached?.kind === 'pack'
            ? (attached.items ?? []).map(child => state.capabilities.items[child]).filter(Boolean)
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

  Object.assign(rt, { pickRoom, hideBotUnusedTools })
}

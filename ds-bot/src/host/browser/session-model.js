import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { assembleLlmStream } from '../models.js'

const NO_SESSION_MODEL = 'browser_task needs a Bot session model'
const OMITTED_IMAGE = '[Browser screenshot omitted.]'

function routeOf(exec) {
  const session = exec?.agent?.session
  if (!session || typeof session.requestHeader !== 'function' || typeof session.id !== 'string') {
    throw new Error(NO_SESSION_MODEL)
  }
  let header
  try {
    header = session.requestHeader()
  } catch {
    throw new Error(NO_SESSION_MODEL)
  }
  if (!header?.config?.provider || !header.config.model) throw new Error(NO_SESSION_MODEL)
  return { session, header, sessionId: session.id }
}

function textParts(content) {
  if (Array.isArray(content)) return content.filter(part => part?.type === 'text').map(part => part.text ?? '')
  return [typeof content === 'string' ? content : String(content ?? '')]
}

function imageInput(part) {
  const url = part?.image_url?.url
  if (typeof url !== 'string') return undefined
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url)
  if (!match) return undefined
  return { mediaType: match[1].toLowerCase(), data: Buffer.from(match[2], 'base64'), name: 'Browser screenshot' }
}

function attachmentsOf(ctx) {
  try {
    return ctx.get?.('attachments') ?? ctx.attachments
  } catch {
    return ctx.attachments
  }
}

async function userContent(content, attachments, readsImages) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
  const blocks = []
  const pending = []
  let sawImage = false
  let rejectedImage = false
  for (const part of parts) {
    if (part?.type === 'text') {
      blocks.push({ type: 'text', text: String(part.text ?? '') })
      continue
    }
    if (part?.type === 'image_url') {
      sawImage = true
      if (!readsImages) {
        blocks.push({ type: 'text', text: OMITTED_IMAGE })
        rejectedImage = true
        continue
      }
      const input = imageInput(part)
      if (!input || typeof attachments?.saveImages !== 'function') {
        blocks.push({ type: 'text', text: OMITTED_IMAGE })
        rejectedImage = true
        continue
      }
      pending.push({ index: blocks.length, input })
      blocks.push(undefined)
      continue
    }
    if (part?.type) blocks.push({ type: 'text', text: String(part.text ?? '') })
  }
  if (pending.length > 0) {
    try {
      const refs = await attachments.saveImages(pending.map(item => item.input))
      pending.forEach((item, index) => {
        blocks[item.index] = { type: 'image', attachment: refs[index] }
      })
    } catch {
      pending.forEach(item => {
        blocks[item.index] = { type: 'text', text: OMITTED_IMAGE }
      })
      rejectedImage = true
    }
  }
  return { blocks: blocks.filter(Boolean), sawImage, rejectedImage }
}

function assistantContent(message, config) {
  const blocks = textParts(message.content)
    .filter(text => text !== '')
    .map(text => ({ type: 'text', text }))
  const reasoning = message.reasoning_content ?? message.reasoning
  if (typeof reasoning === 'string' && reasoning !== '') blocks.push({ type: 'reasoning', text: reasoning })
  for (const call of message.tool_calls ?? []) {
    const fn = call.function ?? {}
    const args = fn.arguments
    blocks.push({
      type: 'tool-call',
      id: String(call.id ?? ''),
      name: String(fn.name ?? ''),
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    })
  }
  return createAssistantMessage({
    content: blocks,
    source: { provider: config.provider, model: config.model },
  })
}

async function dshMessages(messages, attachments, config, readsImages) {
  const output = []
  let sawImage = false
  let rejectedImage = false
  for (const message of messages ?? []) {
    if (message.role === 'system') {
      output.push(createSystemMessage(textParts(message.content).join('\n')))
    } else if (message.role === 'user') {
      const content = await userContent(message.content, attachments, readsImages)
      output.push(createUserMessage({ content: content.blocks, source: { kind: 'user' } }))
      sawImage ||= content.sawImage
      rejectedImage ||= content.rejectedImage
    } else if (message.role === 'assistant') {
      output.push(assistantContent(message, config))
    } else if (message.role === 'tool') {
      output.push(createToolResultMessage({
        callId: String(message.tool_call_id ?? ''),
        content: textParts(message.content).map(text => ({ type: 'text', text })),
        isError: false,
      }))
    }
  }
  return { messages: output, sawImage, rejectedImage }
}

function driverTools(tools) {
  return (tools ?? []).map(tool => {
    const fn = tool.function ?? tool
    return {
      name: String(fn.name ?? ''),
      description: String(fn.description ?? ''),
      parameters: fn.parameters ?? {},
    }
  })
}

async function routeReadsImages(ctx, config, rt) {
  if (rt?.config?.textOnlyModels?.includes?.(`${config.provider}/${config.model}`)) return false
  if (typeof ctx.llm?.resolveModelInfo !== 'function') return true
  try {
    const info = await ctx.llm.resolveModelInfo(config.provider, config.model)
    return info.inputModalities === undefined || info.inputModalities.includes('image')
  } catch {
    return true
  }
}

export function sessionComplete(ctx, exec, rt) {
  return async ({ messages, tools }) => {
    const { header, sessionId } = routeOf(exec)
    const hasImages = (messages ?? []).some(message => (
      Array.isArray(message.content) && message.content.some(part => part?.type === 'image_url')
    ))
    const readsImages = hasImages ? await routeReadsImages(ctx, header.config, rt) : true
    const converted = await dshMessages(messages, attachmentsOf(ctx), header.config, readsImages)
    const requestMessages = typeof rt?.tagUsage === 'function'
      ? rt.tagUsage(converted.messages, { sessionId, kind: 'browser-task' })
      : converted.messages
    const callOptions = {
      ...header.config,
      messages: requestMessages,
      tools: driverTools(tools),
      sessionId,
      signal: exec.signal,
    }
    const assembler = await (rt?.assembleLlm ? rt.assembleLlm(callOptions) : assembleLlmStream(ctx, callOptions, { backoff: rt?.config?.llmRetryBackoff }))
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(finish.failure?.message ?? finish.kind)
    }
    const blocks = assembler.blocks()
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const reasoning = blocks.filter(block => block.type === 'reasoning').map(block => block.text).join('\n')
    const toolCalls = blocks.filter(block => block.type === 'tool-call').map(block => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    }))
    const message = { content: text }
    if (reasoning) message.reasoning_content = reasoning
    if (toolCalls.length > 0) message.tool_calls = toolCalls
    const vision = converted.sawImage
      ? converted.rejectedImage || !readsImages ? 'rejected' : 'accepted'
      : undefined
    return {
      choices: [{ message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : finish.kind === 'max-tokens' ? 'length' : 'stop' }],
      ...(vision ? { vision } : {}),
    }
  }
}

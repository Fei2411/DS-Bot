// Builds the summary tree behind the transcript. Summaries are derived data: a failed or
// oversize summary leaves its node unbuilt and is retried later, and the transcript it
// would cover is never touched.
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { DEFAULTS, part, utf8 } from './core.js'

const INSTRUCTION = [
  'Summarize the text below for a long-lived assistant\'s memory.',
  'Keep names, dates, numbers, decisions, preferences and open questions exactly.',
  'Write plain prose without a preamble. Stay under {bytes} bytes.',
].join(' ')

/** The next node to build: the lowest unbuilt leaf, else the first parent whose children exist. */
export function nextNode(ns) {
  const count = ns.events.length
  for (let i = 0; i < count; i += 1) if (!ns.has(part(0, i))) return part(0, i)
  for (let l = 1; 2 ** l <= count; l += 1) {
    for (let i = 0; (i + 1) * 2 ** l <= count; i += 1) {
      const p = part(l, i)
      if (!ns.has(p) && ns.children(p).every(child => ns.has(child))) return p
    }
  }
  return undefined
}

/**
 * Build one node. A leaf that already fits is kept verbatim; anything else goes to
 * `summarize(text, bytes, signal)`, retried with a tighter budget when it runs long.
 * @returns the saved node, or undefined when nothing was built.
 */
export async function buildOne(ns, summarize, { nodeBytes = DEFAULTS.nodeBytes, attempts = DEFAULTS.sizeAttempts, signal } = {}) {
  const p = nextNode(ns)
  if (p === undefined) return undefined
  const source = ns.source(p)
  if (source === undefined) return undefined
  let text = p.l === 0 && utf8(source) <= nodeBytes ? source : undefined
  for (let attempt = 0; text === undefined && attempt < attempts; attempt += 1) {
    const bytes = Math.floor(nodeBytes * (1 - attempt * 0.2))
    const out = String(await summarize(source, bytes, signal) ?? '').trim()
    if (out !== '' && utf8(out) <= nodeBytes) text = out
  }
  if (text === undefined) throw new Error(`optchat: summary for ${p.start}+${p.n} stayed over ${nodeBytes} bytes`)
  const node = { l: p.l, i: p.i, text }
  ns.saveNode(node)
  return node
}

/** Build until the tree is complete, the signal aborts or a summary fails. */
export async function buildAll(ns, summarize, options = {}) {
  let built = 0
  while (!options.signal?.aborted) {
    const node = await buildOne(ns, summarize, options)
    if (node === undefined) break
    built += 1
  }
  return built
}

/** A summarizer over DSH's public model service, without tools. */
export function llmSummarizer(llm, route) {
  return async (text, bytes, signal) => {
    const assembler = new BlockAssembler()
    const request = {
      provider: route.provider,
      model: route.model,
      system: INSTRUCTION.replace('{bytes}', String(bytes)),
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: Math.max(64, Math.ceil(bytes / 2)),
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of llm.stream(request)) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(`optchat: summarizer ${finish.kind}: ${finish.failure?.message ?? ''}`)
    return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
  }
}

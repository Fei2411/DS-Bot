// Non-interleaved steps pool their reasoning within each contiguous run between
// interleaved steps so thoughts neither drop nor duplicate across boundaries.
function reasoningRun(members, current) {
  const idx = members.findIndex(step => step.step === current.step)
  if (idx === -1) return [current]
  let start = idx
  while (start > 0 && !hasInterleavedBlocks(members[start - 1])) start -= 1
  let end = idx + 1
  while (end < members.length && !hasInterleavedBlocks(members[end])) end += 1
  return members.slice(start, end)
}

// Settled and live reasoning of every loaded step in a Turn, shown once on the last
// step that has reasoning: only steps with reasoning get a reasoning part to render
// it. Sitting under the Turn's tool lines keeps the row directly above the reply.
export function turnReasoning(steps, current) {
  if (hasInterleavedBlocks(current)) return ''
  const members = steps.length ? steps : [current]
  const run = reasoningRun(members, current)
  if (run.findLast(step => stepReasoning(step) !== '')?.step !== current.step) return ''
  return run.map(stepReasoning).filter(Boolean).join('\n\n')
}

// Whether `current` opens the Turn's reply in the chat: the first step with reply text,
// or — while the reasoning shows — the one that shows the Turn's reasoning, whichever
// comes first.
export function opensReply(steps, current, withReasoning = true) {
  const members = steps.length ? steps : [current]
  return members.find(step => texts(step).length > 0
    || (withReasoning && (hasInterleavedBlocks(step) ? stepReasoning(step) !== '' : turnReasoning(members, step) !== '')))?.step === current.step
}

// A step still streaming reasoning with no reply text yet is thinking: the row
// counts its clock from `step.time`, the time its first visible chunk arrived.
export const thinkingStep = steps => steps.find(thinkingLive)

const thinkingLive = step => step.status === 'running' && texts(step).length === 0 && step.blocks.some(block => block.kind === 'reasoning')

const texts = step => step.blocks.filter(block => block.kind === 'text' && block.text.trim() !== '')

// Reasoning can open with a `<signature>` block meant for the model, not the
// reader; DSH's chat hides it since 0.2.1-rc.5 and the Bot chat strips it the
// same way, keeping the raw record in the session.
const visibleReasoning = text => {
  if (text[0] !== '<') return text
  if ('<signature>'.startsWith(text)) return ''
  if (!text.startsWith('<signature>')) return text
  const end = text.indexOf('</signature>')
  return end === -1 ? '' : text.slice(end + '</signature>'.length).replace(/^(\r?\n)+/, '')
}

// A local agent's own tool calls ride its reasoning as lines that start with
// "▸ ". They show as activity rows of their step, not folded into the thought.
const ACTIVITY = '▸ '
const IGNORED_ACTIVITY = new Set(['userMessage', 'user_message', 'developerMessage', 'developer_message', 'contextCompaction', 'context_compaction'])
const isActivity = line => line.startsWith(ACTIVITY)

export function cleanActivityLine(raw) {
  const text = String(raw ?? '').trim()
  if (text === '' || IGNORED_ACTIVITY.has(text)) return ''
  const match = /^(?:\/\S+\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c\s+([\s\S]+)$/i.exec(text)
  if (!match) return text
  const body = match[1].trim()
  if ((body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'"))) {
    const quote = body[0]
    const inner = body.slice(1, -1)
    return quote === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner.replace(/'\\''/g, "'")
  }
  return body
}

const reasoningText = step => step.blocks.filter(block => block.kind === 'reasoning').map(block => visibleReasoning(block.text)).join('\n')
const stepReasoning = step => reasoningText(step).split('\n').filter(line => !isActivity(line)).join('\n').trim()
export const stepActivity = step => reasoningText(step).split('\n').filter(isActivity).map(line => cleanActivityLine(line.slice(ACTIVITY.length))).filter(Boolean)

// True when a local agent CLI spoke a text block first and then ran tools or
// thoughts inside the same step, so blocks must render in chronological order.
export function hasInterleavedBlocks(step) {
  let seenText = false
  for (const block of step.blocks ?? []) {
    if (block.kind === 'text' && block.text.trim() !== '') seenText = true
    else if (seenText && block.kind === 'reasoning' && visibleReasoning(block.text).trim() !== '') return true
  }
  return false
}

export function stepSegments(step) {
  const segments = []
  for (const block of step.blocks ?? []) {
    if (block.kind === 'text') {
      if (block.text.trim() === '') continue
      const last = segments.at(-1)
      if (last?.kind === 'text') last.texts.push(block.text)
      else segments.push({ kind: 'text', texts: [block.text] })
    } else if (block.kind === 'reasoning') {
      const raw = visibleReasoning(block.text)
      if (raw.trim() === '') continue
      const lines = raw.split('\n')
      const activity = lines.filter(isActivity).map(line => cleanActivityLine(line.slice(ACTIVITY.length))).filter(Boolean)
      const thought = lines.filter(line => !isActivity(line)).join('\n').trim()
      if (activity.length === 0 && thought === '') continue
      const last = segments.at(-1)
      if (last?.kind === 'process') {
        last.activity.push(...activity)
        if (thought) last.thought = last.thought ? `${last.thought}\n\n${thought}` : thought
      } else {
        segments.push({ kind: 'process', activity: [...activity], thought })
      }
    }
  }
  return segments
}

// Settled and live reasoning of every loaded step in a Turn, shown once on the last
// step that has reasoning: only steps with reasoning get a reasoning part to render
// it. Sitting under the Turn's tool lines keeps the row directly above the reply.
export function turnReasoning(steps, current) {
  const members = steps.length ? steps : [current]
  if (members.findLast(step => stepReasoning(step) !== '')?.step !== current.step) return ''
  return members.map(stepReasoning).filter(Boolean).join('\n\n')
}

// Whether `current` opens the Turn's reply in the chat: the first step with reply text,
// or — while the reasoning shows — the one that shows the Turn's reasoning, whichever
// comes first.
export function opensReply(steps, current, withReasoning = true) {
  const members = steps.length ? steps : [current]
  const reasoner = withReasoning ? members.findLast(step => stepReasoning(step) !== '') : undefined
  return members.find(step => texts(step).length > 0 || step === reasoner)?.step === current.step
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

const stepReasoning = step => step.blocks.filter(block => block.kind === 'reasoning').map(block => visibleReasoning(block.text)).join('\n').trim()

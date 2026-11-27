// Settled and live reasoning of every loaded step in a Turn, shown once on the last
// step that has reasoning: only steps with reasoning get a reasoning part to render
// it. Sitting under the Turn's tool lines keeps the row directly above the reply.
export function turnReasoning(steps, current) {
  const members = steps.length ? steps : [current]
  if (members.findLast(step => stepReasoning(step) !== '')?.step !== current.step) return ''
  return members.map(stepReasoning).filter(Boolean).join('\n\n')
}

// Local-agent activity lines across every loaded step in a Turn, collected once on
// the last step that has activity so a multi-step turn collapses into a single row.
export function turnActivity(steps, current) {
  const members = steps.length ? steps : [current]
  if (members.findLast(step => stepActivity(step).length > 0)?.step !== current.step) return []
  return members.flatMap(stepActivity)
}

// Whether `current` opens the Turn's reply in the chat: the first step with reply text,
// or — while the reasoning shows — the step that renders the Turn's reasoning or
// aggregated local-agent activity, whichever comes first.
export function opensReply(steps, current, withReasoning = true) {
  const members = steps.length ? steps : [current]
  const reasoner = withReasoning ? members.findLast(step => stepReasoning(step) !== '') : undefined
  const actor = withReasoning ? members.findLast(step => stepActivity(step).length > 0) : undefined
  return members.find(step => texts(step).length > 0 || step === reasoner || step === actor)?.step === current.step
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
// "▸ ". They collapse into one activity row for the turn when thinking is shown,
// and feed the live activity indicator while the step is still running.
const ACTIVITY = '▸ '
const isActivity = line => line.startsWith(ACTIVITY)
const reasoningText = step => step.blocks.filter(block => block.kind === 'reasoning').map(block => visibleReasoning(block.text)).join('\n')
const stepReasoning = step => reasoningText(step).split('\n').filter(line => !isActivity(line)).join('\n').trim()
export const stepActivity = step => reasoningText(step).split('\n').filter(isActivity).map(line => line.slice(ACTIVITY.length).trim()).filter(Boolean)

// The latest in-flight CLI activity of a running step: present only while the trailing
// non-empty block is reasoning and its last non-empty line is an activity line, so the
// live indicator steps aside as soon as thought prose or reply text resumes.
export function stepLiveActivity(step) {
  const blocks = step?.blocks ?? []
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.kind === 'tool-call') return undefined
    if (block?.kind === 'text') {
      if (String(block.text ?? '').trim() !== '') return undefined
      continue
    }
    if (block?.kind !== 'reasoning') continue
    const lines = visibleReasoning(String(block.text ?? '')).split('\n').map(line => line.trim()).filter(Boolean)
    if (lines.length === 0) continue
    const last = lines.at(-1)
    return isActivity(last) ? last.slice(ACTIVITY.length).trim() || undefined : undefined
  }
  return undefined
}

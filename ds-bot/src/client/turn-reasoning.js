// The first loaded assistant owns one disclosure for the whole Turn. Keeping that
// owner while later steps arrive preserves expansion and the shimmer animation.
export function turnReasoning(steps, current) {
  const members = steps.length ? steps : [current]
  if (members[0].step !== current.step) return { text: '', running: false }
  const last = members.at(-1)
  return {
    text: members.map(step => step.blocks.filter(block => block.kind === 'reasoning').map(block => block.text).join('\n'))
      .filter(text => text.trim() !== '').join('\n\n'),
    running: last.status === 'running' && last.blocks.at(-1)?.kind === 'reasoning',
  }
}

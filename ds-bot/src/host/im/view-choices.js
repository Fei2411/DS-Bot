import { validateViewAnswer } from 'deep-view/core'

export function imViewChoices(view) {
  const nodes = []
  const visit = node => {
    nodes.push(node)
    if (node.type === 'stack' || node.type === 'row') node.children.forEach(visit)
  }
  visit(view)
  if (nodes.some(node => ['number', 'slider', 'toggle', 'form'].includes(node.type))) return []
  if (nodes.some(node => node.type === 'options' && node.multi === true)) return []
  const inputs = nodes.filter(node => node.type === 'choice')
  if (inputs.length > 1) return []
  const choices = []
  for (const node of nodes) {
    if (node.type === 'confirm') {
      choices.push({ label: node.confirmLabel ?? 'Confirm', action: node.id, values: { confirmed: true } },
        { label: node.cancelLabel ?? 'Cancel', action: node.id, values: { confirmed: false } })
    } else if (node.type === 'options') {
      choices.push(...node.options.map(option => ({ label: option.label, action: node.id, values: { selected: [option.label] } })))
    } else if (node.type === 'submit') {
      choices.push({ label: node.label ?? 'Submit', action: node.id, values: {} })
    }
  }
  const expanded = inputs.length === 0 ? choices : choices.flatMap(choice => inputs[0].options.map(option => ({
    ...choice,
    label: `${choice.label}: ${option.label}`,
    values: { ...choice.values, inputs: { [inputs[0].id]: option.value ?? option.label } },
  })))
  return expanded.filter(choice => validateViewAnswer(view, choice.action, choice.values).error === undefined)
}

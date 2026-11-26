import { inputDefault, validateViewAnswer } from 'deep-view/core'

function schema(view) {
  const actions = []
  const fields = []
  const visit = node => {
    if (node.type === 'stack' || node.type === 'row') return node.children.forEach(visit)
    if (['number', 'slider', 'toggle', 'choice'].includes(node.type)) fields.push({ node })
    if (node.type === 'form') {
      actions.push({ node, label: node.submitLabel ?? 'Submit', values: {} })
      for (const field of node.fields) fields.push({ node: field, form: node.id })
    } else if (node.type === 'submit') actions.push({ node, label: node.label ?? 'Submit', values: {} })
    else if (node.type === 'confirm') {
      actions.push({ node, label: node.confirmLabel ?? 'Confirm', values: { confirmed: true } },
        { node, label: node.cancelLabel ?? 'Cancel', values: { confirmed: false } })
    } else if (node.type === 'options') {
      if (node.multi === true) actions.push({ node, label: 'Select options', values: {} })
      else for (const option of node.options) actions.push({ node, label: option.label, values: { selected: [option.label] } })
    }
  }
  visit(view)
  return { actions, fields }
}

export function imViewFormText(view, code) {
  const { actions, fields } = schema(view)
  const lines = [`Card ${code} — answer with !card ${code}`]
  for (const [index, action] of actions.entries()) {
    lines.push(`${actions.length > 1 ? `${index + 1}. ` : ''}${action.label}`)
    if (action.node.type === 'options' && action.node.multi === true) {
      lines.push(`Options (select at least 1): ${action.node.options.map((option, i) => `${i + 1}=${option.label}`).join('; ')}`)
    }
  }
  for (const [index, { node, form }] of fields.entries()) {
    const type = form === undefined ? node.type : node.multiline ? 'multiline text' : 'text'
    const details = [type]
    if (node.min !== undefined) details.push(`min ${node.min}`)
    if (node.max !== undefined) details.push(`max ${node.max}`)
    if (node.step !== undefined) details.push(`step ${node.step}`)
    if (node.type === 'choice') details.push(node.options.map((option, i) => `${i + 1}=${option.label}`).join('; '))
    if (node.type === 'toggle') details.push('yes/no, true/false, on/off')
    if (form !== undefined && actions.length > 1) details.push(`action ${actions.findIndex(action => action.node.id === form) + 1}`)
    if (node.readOnly === true) details.push('read-only')
    details.push(`default ${JSON.stringify(form === undefined ? inputDefault(node) : node.value ?? '')}`)
    lines.push(`${index + 1}: ${node.label} (${details.join('; ')})`)
  }
  if (actions.some(action => action.node.type === 'form' && action.node.cancelLabel)) lines.push(`Cancel: !card ${code} cancel (choose an action first if there are several forms)`)
  const first = actions[0]
  const picks = first?.node.type === 'options' && first.node.multi === true ? ' 1' : ''
  const index = fields.findIndex(field => field.form === undefined || field.form === first?.node.id)
  const field = fields[index]
  const sample = field === undefined ? '' : field.form !== undefined ? field.node.value || 'example'
    : field.node.type === 'toggle' ? 'yes' : field.node.type === 'choice' ? '1' : inputDefault(field.node)
  lines.push(`Reply example: !card ${code}${actions.length > 1 ? ' 1' : ''}${picks}${field === undefined ? '' : `\\n${index + 1}: ${String(sample).replaceAll('\n', '\\n')}`} (\\n means a new line)`)
  lines.push('In groups, mention the Bot before !card. Bare codes never answer cards.')
  if (fields.length > 0) lines.push('Use <n>: <value> lines; values continue until the next numbered line. Omitted inputs and fields use defaults.')
  return lines.join('\n')
}

export function isLegacyImViewFormAnswer(text) {
  const [head, ...lines] = text.replaceAll('\r\n', '\n').split('\n')
  const command = head.trim()
  if (/^\d+:/.test(command)) return true
  if (command !== '' && !/^(?:\d[\d, \t]*|(?:\d+[ \t]+)?cancel)$/i.test(command)) return false
  const fields = lines.join('\n').trimStart()
  return fields === '' || /^\d+:/.test(fields)
}

export function parseImViewForm(view, text) {
  const { actions, fields } = schema(view)
  const [head, ...lines] = text.replaceAll('\r\n', '\n').split('\n')
  const tokens = head.trim() === '' ? [] : head.trim().split(/\s+/)
  let action
  if (tokens[0]?.toLowerCase() === 'cancel') {
    const cancellable = actions.filter(item => item.node.type === 'form' && item.node.cancelLabel)
    if (cancellable.length !== 1) return { error: 'Choose the form action number before cancel.' }
    action = cancellable[0]
  } else if (actions.length === 1) action = actions[0]
  else {
    const index = tokens.shift()
    if (!/^[1-9]\d*$/.test(index ?? '')) return { error: 'Choose an action number.' }
    action = actions[Number(index) - 1]
  }
  if (action === undefined) return { error: 'Unknown action number.' }
  const values = { ...action.values }
  const canceled = tokens[0]?.toLowerCase() === 'cancel'
  if (canceled) {
    if (tokens.length !== 1 || lines.some(line => line.trim() !== '') || action.node.type !== 'form' || !action.node.cancelLabel) return { error: 'This action cannot be canceled.' }
    values.canceled = true
  } else if (action.node.type === 'options' && action.node.multi === true) {
    const picks = tokens.join(' ')
    if (!/^\d+(?:(?:\s*,\s*|\s+)\d+)*$/.test(picks)) return { error: 'Select option numbers separated by spaces or commas.' }
    const indices = picks.split(/[\s,]+/).map(Number)
    if (indices.some(index => action.node.options[index - 1] === undefined)) return { error: 'An option number is out of range.' }
    values.selected = indices.map(index => action.node.options[index - 1].label)
  } else if (tokens.length > 0) return { error: 'Put field values on numbered lines: <n>: <value>.' }

  const given = new Map()
  let current
  for (const line of lines) {
    const match = /^(\d+):[ \t]?(.*)$/.exec(line)
    if (match !== null) {
      const index = Number(match[1]) - 1
      const field = fields[index]
      if (field === undefined || (field.form !== undefined && field.form !== action.node.id)) return { error: 'Unknown field number for this action.' }
      if (given.has(index)) return { error: 'Each field number may appear only once.' }
      current = index
      given.set(index, match[2])
    } else if (current !== undefined) given.set(current, `${given.get(current)}\n${line}`)
    else if (line.trim() !== '') return { error: 'Start each field with <n>: <value>.' }
  }
  const inputs = {}
  const formValues = {}
  for (const [index, { node, form }] of fields.entries()) {
    const sent = given.get(index)
    if (form !== undefined) {
      if (form === action.node.id && !canceled) formValues[node.id] = node.readOnly === true ? node.value ?? '' : sent ?? node.value ?? ''
      continue
    }
    let value = inputDefault(node)
    if (sent !== undefined) {
      const raw = sent.trim()
      if (node.type === 'number' || node.type === 'slider') {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) || !Number.isFinite(Number(raw))) return { error: `${node.label}: enter a number.` }
        value = Number(raw)
      } else if (node.type === 'toggle') {
        if (!/^(?:yes|no|true|false|on|off)$/i.test(raw)) return { error: `${node.label}: use yes/no, true/false or on/off.` }
        value = /^(yes|true|on)$/i.test(raw)
      } else {
        const option = node.options.find(item => item.label === raw) ?? (/^[1-9]\d*$/.test(raw) ? node.options[Number(raw) - 1] : undefined)
        if (option === undefined) return { error: `${node.label}: choose an option number or exact label.` }
        value = option.value ?? option.label
      }
    }
    inputs[node.id] = value
  }
  if (Object.keys(inputs).length > 0) values.inputs = inputs
  if (action.node.type === 'form' && !canceled) values.fields = formValues
  const checked = validateViewAnswer(view, action.node.id, values)
  return checked.error === undefined ? { action: action.node.id, values: checked, label: canceled ? 'Canceled' : action.label } : { error: checked.error }
}

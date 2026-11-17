import { fromMarkdown } from 'mdast-util-from-markdown'

export function replyImages(text) {
  text = String(text ?? '')
  const nodes = []
  const visit = node => {
    nodes.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(fromMarkdown(text))
  const definitions = new Map()
  for (const node of nodes) if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
  const images = []
  const replacements = []
  for (const node of nodes) {
    if (node.type !== 'image' && node.type !== 'imageReference') continue
    const path = node.type === 'image' ? node.url : definitions.get(node.identifier)?.url
    if (!path || /^[\\/]{2}/.test(path) || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) && !/^file:\/\//i.test(path))) continue
    const label = node.alt ?? ''
    images.push({ path, label: label || 'Image' })
    replacements.push({ start: node.position.start.offset, end: node.position.end.offset, label })
  }
  // Source offsets avoid replacing identical literal examples elsewhere in the reply.
  let body = text
  for (const change of replacements.reverse()) body = body.slice(0, change.start) + change.label + body.slice(change.end)
  return { text: body, images }
}

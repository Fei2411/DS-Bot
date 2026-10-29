import { fromMarkdown } from 'mdast-util-from-markdown'
import { math } from 'micromark-extension-math'
import { mathFromMarkdown } from 'mdast-util-math'

const options = { extensions: [math()], mdastExtensions: [mathFromMarkdown()] }

function formula(node, source) {
  if (node.type === 'math') return { source, tex: node.value }
  if (node.type === 'code' && /^(?:latex|tex|math)$/i.test(node.lang ?? '')) {
    const raw = node.value
    const tex = raw.trim().replace(/^\$\$\s*([\s\S]*?)\s*\$\$$/, '$1').replace(/^\\\[\s*([\s\S]*?)\s*\\\]$/, '$1')
    return { source: raw, tex }
  }
  if (node.type === 'paragraph') {
    const match = /^(?:\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\])$/.exec(source.trim())
    if (match) return { source, tex: (match[1] ?? match[2]).trim() }
  }
  return null
}

// Only top-level blocks become cards. Lists, quotes and ordinary code stay intact
// for DSH's public renderer; unfinished streamed text never enters this parser.
export function mathBlocks(text) {
  if (!/\$\$|\\\[|^[ \t]*(`{3,}|~{3,})(?:latex|tex|math)\b/im.test(text)) return null
  const tree = fromMarkdown(text, options)
  // Splitting a document with footnotes would change their numbering and placement.
  if (/\[\^[^\]\n]+\]/.test(text)) return null
  const definitions = tree.children.filter(node => node.type === 'definition')
    .map(node => text.slice(node.position.start.offset, node.position.end.offset)).join('\n')
  const blocks = tree.children.map(node => {
    const source = text.slice(node.position.start.offset, node.position.end.offset)
    const label = (node.type === 'paragraph' || node.type === 'heading')
      && /^(?:源码|源代码|source(?: code)?)\s*[：:]$/i.test(node.children.map(child => child.value ?? '').join('').trim())
    return { node, value: formula(node, source), label }
  })
  const skipped = new Set()
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (!block.value) continue
    const label = blocks[index - 1]?.label
    if (label) skipped.add(index - 1)
    const previous = index - (label ? 2 : 1)
    // A model often writes a formula and then repeats it in a LaTeX fence.
    // Keep the fence's exact copyable source and present the formula just once.
    if (block.node.type === 'code' && blocks[previous]?.value?.tex.trim() === block.value.tex.trim()) skipped.add(previous)
  }
  const parts = []
  let start = 0
  const markdown = end => {
    const source = text.slice(start, end)
    if (source.trim()) parts.push({ type: 'markdown', key: start, text: definitions ? `${source}\n\n${definitions}` : source })
  }
  for (const [index, { node, value }] of blocks.entries()) {
    const from = node.position.start.offset
    const to = node.position.end.offset
    if (skipped.has(index)) {
      markdown(from)
      start = to
      continue
    }
    if (!value) continue
    markdown(from)
    parts.push({ type: 'math', key: from, ...value })
    start = to
  }
  if (!parts.some(part => part.type === 'math')) return null
  markdown(text.length)
  return parts
}

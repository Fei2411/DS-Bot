// Tool schemas handed to a model provider. An MCP server may describe a property as a
// union with no `type` of its own, or list null in an enum; a strict provider
// (Moonshot/KIMI validates a subset of JSON Schema) refuses the whole request for that,
// while others accept it. Every connector schema is handed on plain instead, so the same
// tool list works on every provider.
import { flattenSchema } from './local-agents/mcp.js'

const scalarType = type => typeof type === 'string' || (Array.isArray(type) && type.every(part => typeof part === 'string'))

// The type a non-empty enum implies, for a schema that carries none.
function enumType(values) {
  const kept = values.filter(value => value !== null)
  if (kept.length === 0) return undefined
  if (kept.every(value => typeof value === 'string')) return 'string'
  if (kept.every(value => typeof value === 'boolean')) return 'boolean'
  if (kept.every(value => typeof value === 'number')) return kept.every(Number.isInteger) ? 'integer' : 'number'
  return undefined
}

// A schema with a type on every node it can name one for, and no null left in a
// scalar enum: the two things a strict provider rejects in an otherwise valid schema.
function typed(node) {
  if (Array.isArray(node)) return node.map(typed)
  if (node === null || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) out[key] = typed(value)
  if (out.type === undefined) {
    if (out.properties !== undefined) out.type = 'object'
    else if (out.items !== undefined) out.type = 'array'
    else if (Array.isArray(out.enum)) out.type = enumType(out.enum)
  }
  if (Array.isArray(out.enum) && scalarType(out.type)) out.enum = out.enum.filter(value => value !== null)
  return out
}

// One tool's parameters, plain enough for any provider: unions collapsed to their
// first non-null branch, no refs or const, every object typed, null out of a scalar enum.
// The input is never changed.
export function plainToolSchema(parameters) {
  return typed(flattenSchema(parameters ?? {}))
}

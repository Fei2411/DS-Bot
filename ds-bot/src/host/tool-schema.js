// Tool schemas handed to a model provider. An MCP server may describe a property as a
// union with no `type` of its own, or list null in an enum; a strict provider
// (Moonshot/KIMI validates a subset of JSON Schema) refuses the whole request for that,
// while others accept it. Every connector schema is handed on plain instead, so the same
// tool list works on every provider.

const scalarType = type => typeof type === 'string' || (Array.isArray(type) && type.every(part => typeof part === 'string'))

const nonNullType = type => Array.isArray(type) && type.includes('null') ? type.find(part => part !== 'null') : undefined

// Both tool transports drop null from unions. Keep the property usable by allowing omission.
export function finishNullableSchema(schema, original) {
  const type = nonNullType(schema.type)
  if (type !== undefined) {
    const types = schema.type.filter(part => part !== 'null')
    schema.type = types.length === 1 ? types[0] : types
  }
  if (!original.properties || !Array.isArray(schema.required)) return schema
  const required = schema.required.filter(name => {
    const property = original.properties[name]
    return nonNullType(property?.type) === undefined && !['anyOf', 'oneOf'].some(key =>
      Array.isArray(property?.[key]) && property[key].some(branch => branch?.type === 'null') &&
      property[key].some(branch => branch?.type !== 'null'))
  })
  if (required.length !== schema.required.length) {
    if (required.length) schema.required = required
    else delete schema.required
  }
  return schema
}

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
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  const out = { ...node }
  delete out.$ref
  delete out.$defs
  delete out.definitions
  delete out.const
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const first = node[key]?.find?.(branch => branch?.type !== 'null')
    delete out[key]
    if (first !== undefined) Object.assign(out, typed(first))
  }
  // Property names and enum/default payloads are data, not schema keywords.
  for (const key of ['properties', 'patternProperties']) {
    if (out[key] !== undefined) out[key] = Object.fromEntries(Object.entries(out[key]).map(([name, schema]) => [name, typed(schema)]))
  }
  for (const key of ['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else']) {
    if (out[key] !== undefined) out[key] = Array.isArray(out[key]) ? out[key].map(typed) : typed(out[key])
  }
  if (out.type === undefined) {
    if (out.properties !== undefined) out.type = 'object'
    else if (out.items !== undefined) out.type = 'array'
    else if (Array.isArray(out.enum)) out.type = enumType(out.enum)
  }
  if (Array.isArray(out.enum) && scalarType(out.type)) out.enum = out.enum.filter(value => value !== null)
  return finishNullableSchema(out, node)
}

// One tool's parameters, plain enough for any provider: unions collapsed to their
// first non-null branch, no refs or const, every object typed, null out of a scalar enum.
// The input is never changed.
export function plainToolSchema(parameters) {
  return typed(parameters ?? {})
}

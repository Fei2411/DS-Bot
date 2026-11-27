import z from '@deepseek-ai/schemastery'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { PtcExecutor, jsonSchemaToTs } from '@deepseek-ai/dsh-tool-executor-ptc'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolBatchExecutionError } from '@deepseek-ai/dsh-tools'

export const name = 'ds-bot-code-mode'
export const inject = ['tools', 'systemPrompt', 'ptcRuntime']
export const Config = z.object({
  mode: z.union([z.const('hybrid'), z.const('code-only')]).default('hybrid'),
  maxResultChars: z.natural().min(256).default(8000),
})

const PROGRAM_TOOLS = new Set(['bash', 'pwsh', 'read', 'read_image', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'working_directory', 'web_fetch', 'web_search'])
const OUTPUTS = {
  bash: '{ kind: "foreground"; stdout: { text: string }; stderr: { text: string }; exitCode: number | null } | { kind: "background" | "promoted"; jobId: string }',
  read: '{ path: string; lines: { number: number; text: string }[]; totalLines: number }',
  grep: '{ matches: { path: string; lineNumber: number; line: string }[]; [key: string]: unknown }',
  glob: '{ paths: string[]; [key: string]: unknown }',
  edit: '{ path: string; [key: string]: unknown }',
  write: '{ path: string; [key: string]: unknown }',
  web_fetch: '{ url: string; statusCode: number; body: { kind: "html" | "text"; content: string }; truncated: boolean }',
  apply_patch: '{ phase: string; operations: unknown[]; affectedPaths: string[]; [key: string]: unknown }',
}

export const isProgramTool = tool => PROGRAM_TOOLS.has(tool.name) || tool.name.startsWith('mcp__')

function withoutDescriptions(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(withoutDescriptions)
  const { description: _description, ...schema } = value
  for (const mapKey of ['properties', '$defs', 'definitions']) {
    if (schema[mapKey] && typeof schema[mapKey] === 'object' && !Array.isArray(schema[mapKey])) {
      schema[mapKey] = Object.fromEntries(Object.entries(schema[mapKey]).map(([key, child]) => [key, withoutDescriptions(child)]))
    }
  }
  for (const key of ['items', 'additionalProperties']) if (schema[key] && typeof schema[key] === 'object') schema[key] = withoutDescriptions(schema[key])
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) if (Array.isArray(schema[key])) schema[key] = schema[key].map(withoutDescriptions)
  return schema
}

export function renderCompactSdk(tools, mode = 'hybrid', programFormat = 'function-body') {
  const selected = mode === 'hybrid' ? tools.filter(isProgramTool) : tools
  const guidance = 'Use run_code for many related calls, repeated edits across files, filtering big outputs, or parallel independent operations. '
    + 'Do a whole multi-file change in one program: locate, apply_patch/edit all files, verify, return a summary. '
    + 'Return only counts, paths, or short excerpts; never raw dumps. '
    + (mode === 'hybrid' ? 'For a single simple call, use its normal tool. Unlisted tools are native-only. ' : '')
    + 'Call await tools.name(args); independent read-only calls can use Promise.all, mutations run serially. '
    + 'Catch ToolCallError (toolName, message) to recover. Images are attached separately. '
    + (programFormat === 'function-body' ? 'Code is an async TypeScript function body; await and return work. ' : 'Use await and a final expression, not top-level return. ')
    + 'Only printed or returned output reaches the model; do not print intermediate results.'
  if (mode === 'hybrid') {
    const outputs = [...selected].sort((a, b) => a.name.localeCompare(b.name))
      .map(tool => `  ${JSON.stringify(tool.name)} -> ${OUTPUTS[tool.name] ?? 'unknown'}`)
    return `${guidance}\n\ntools.<name>(args) takes the same arguments as the native tool <name>.\n\nProgram-only SDK (result shapes show common fields, not complete declarations):\n${outputs.join('\n')}`
  }
  const declarations = [...selected].sort((a, b) => a.name.localeCompare(b.name)).map(tool => {
    const description = String(tool.description ?? '').replace(/\s+/g, ' ').replaceAll('*/', '* /').slice(0, 100)
    const args = jsonSchemaToTs(withoutDescriptions(tool.parameters))
    return `  /** ${description} */\n  ${JSON.stringify(tool.name)}(args: ${args}): Promise<${OUTPUTS[tool.name] ?? 'unknown'}>;`
  })
  return `${guidance}\n\nProgram-only SDK (result shapes show common fields, not complete declarations):\n\`\`\`ts\ndeclare const tools: {\n${declarations.join('\n')}\n};\n\`\`\``
}

export function capResultText(text, maxChars) {
  const chars = Array.from(text)
  const budget = Math.max(0, Math.floor(maxChars))
  if (chars.length <= budget) return text
  let omitted = chars.length
  let marker
  let kept
  let previous
  do {
    previous = omitted
    marker = `\n[code-mode: ${omitted} characters omitted. Filter in code and return only what is needed instead of raw dumps.]\n`
    kept = Math.max(0, budget - marker.length)
    omitted = chars.length - kept
  } while (omitted !== previous)
  if (kept === 0) return Array.from(marker).slice(0, budget).join('')
  const head = Math.ceil(kept * 0.7)
  const tail = kept - head
  return chars.slice(0, head).join('') + marker + (tail > 0 ? chars.slice(-tail).join('') : '')
}

function capContent(content, maxChars) {
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const capped = capResultText(text, maxChars)
  if (capped === text) return content
  let inserted = false
  return content.flatMap(block => {
    if (block.type !== 'text') return [block]
    if (inserted) return []
    inserted = true
    return [{ ...block, text: capped }]
  })
}

export class CodeModeExecutor {
  constructor(ctx, config = {}, options = {}) {
    this.ctx = ctx
    this.config = Config(config)
    this.filterTools = typeof options.filterTools === 'function' ? options.filterTools : undefined
    if (ctx.ptcRuntime.language !== 'typescript') throw new Error('DS Bot code-mode requires a TypeScript PTC runtime')
    this.native = new NativeToolExecutor(ctx)
    this.program = new PtcExecutor(ctx)
    if (this.config.mode === 'hybrid') ctx.systemPrompt.tools(({ scope }) => {
      const program = ctx.tools.selectExecutor(scope) === this ? this.program.describe([]) : { schemas: [] }
      return { schemas: [], knownNames: program.knownNames ?? program.schemas.map(schema => schema.name) }
    })
    this.sections = [{
      name: 'tools:code-mode',
      order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),
      interpolate: false,
      text: tools => renderCompactSdk(this.filterTools ? this.filterTools(tools) : tools, this.config.mode, ctx.ptcRuntime.programFormat),
    }]
  }

  describe(tools) {
    const program = this.program.describe(tools)
    const programSchemas = program.schemas.map(schema => ({
      ...schema,
      description: 'Run a TypeScript program using the program-only tools SDK. Return a concise summary, not raw results. ' + this.ctx.ptcRuntime.executionInstructions,
    }))
    const programNames = program.knownNames ?? programSchemas.map(schema => schema.name)
    if (this.config.mode === 'code-only') return { schemas: programSchemas, knownNames: programNames }
    const native = this.native.describe(tools)
    return {
      schemas: [...native.schemas, ...programSchemas],
      ...(native.knownNames === undefined ? {} : { knownNames: [...new Set([...native.knownNames, ...programNames])] }),
    }
  }

  programToolSet(input, { hybrid = true } = {}) {
    const tools = this.ctx.tools
    const filterTools = this.filterTools
    return {
      dispose() {},
      view(scope) {
        if (scope !== input.agent) return new Map()
        const admitted = input.toolSet?.view(scope) ?? new Map(tools.definitions(scope)
          .filter(tool => tools.executable(tool.name, scope) === tool).map(tool => [tool.name, tool]))
        let entries = [...admitted]
        if (hybrid) entries = entries.filter(([, tool]) => isProgramTool(tool))
        if (filterTools !== undefined) {
          const allowed = new Set(filterTools(entries.map(([, tool]) => tool)).map(tool => tool.name))
          entries = entries.filter(([name]) => allowed.has(name))
        }
        return new Map(entries)
      },
    }
  }

  async execute(input) {
    if (input.maxParallelToolCalls !== undefined && (!Number.isInteger(input.maxParallelToolCalls) || input.maxParallelToolCalls < 1)) {
      throw new RangeError('maxParallelToolCalls must be a positive integer')
    }
    const combined = { results: [], additionalContexts: [], concluded: false }
    const collect = (batch, program, callSeq) => {
      for (const item of batch.results) {
        const result = program ? { ...item.result, content: capContent(item.result.content, this.config.maxResultChars) } : item.result
        if (program && input.log) {
          input.agent.session.append('tool/result', {
            ...input.log,
            message: createToolResultMessage({ callId: item.callId, content: result.content, isError: result.isError }),
            ...(result.error?.info ? { error: result.error.info } : {}),
            ...(result.meta === undefined ? {} : { meta: result.meta }),
          }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
        }
        combined.results.push({ ...item, result })
      }
      combined.additionalContexts.push(...batch.additionalContexts)
      combined.concluded ||= batch.concluded
    }
    for (let offset = 0; offset < input.calls.length;) {
      const program = this.config.mode === 'code-only' || input.calls[offset].name === 'run_code'
      let end = offset + 1
      if (!program) while (end < input.calls.length && input.calls[end].name !== 'run_code') end++
      const toolSet = program && (this.config.mode === 'hybrid' || this.filterTools !== undefined)
        ? this.programToolSet(input, { hybrid: this.config.mode === 'hybrid' })
        : input.toolSet
      const block = input.calls[offset]
      // Own only program root logging (mirroring DSH's BatchSettlement event shape) so the cap
      // also covers pre-dispatch denials.
      let callSeq
      try {
        if (program && input.log) callSeq = input.agent.session.append('tool/call', {
          ...input.log, callId: block.id, name: block.name, arguments: block.arguments,
        }).seq
        const result = await (program ? this.program : this.native).execute({ ...input, calls: input.calls.slice(offset, end), toolSet, ...(program ? { log: undefined } : {}) })
        collect(result, program, callSeq)
      } catch (error) {
        const isBatchError = error instanceof ToolBatchExecutionError
        if (isBatchError) collect(error.partial, program, callSeq)
        const cause = isBatchError ? error.cause : error
        if (!isBatchError && program && input.log && callSeq !== undefined && !combined.results.some(item => item.callId === block.id)) {
          const message = cause instanceof Error ? cause.message : String(cause)
          input.agent.session.append('tool/result', {
            ...input.log,
            message: createToolResultMessage({ callId: block.id, content: [{ type: 'text', text: capResultText(`Error: ${message}`, this.config.maxResultChars) }], isError: true }),
          }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
        }
        const hasProgress = combined.results.length > 0 || combined.additionalContexts.length > 0 || combined.concluded
        if (!isBatchError && !hasProgress && !input.signal?.aborted) throw cause
        throw new ToolBatchExecutionError(cause, combined)
      }
      offset = end
    }
    return combined
  }
}

export const createFallbackExecutor = ctx => new NativeToolExecutor(ctx)

export function apply(ctx, config, options) {
  ctx.tools.setExecutor(new CodeModeExecutor(ctx, config, options))
}

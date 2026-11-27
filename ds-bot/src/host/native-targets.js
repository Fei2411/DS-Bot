// Targets of the native file tools that change files, resolved the same way
// wherever the approval path or the extra-folders path needs them. Shell
// commands are out of scope: their targets cannot be read reliably.
import { within } from './folders.js'

// Older DSH releases have no public patch parser; apply_patch targets stay unknown.
const { parsePatch } = await import('@deepseek-ai/dsh-fs-patch').catch(() => ({}))
export const patchParserAvailable = typeof parsePatch === 'function'

const PATH_ARGS = { write: 'file_path', edit: 'file_path' }

export const fileTargetsOf = (name, args) => {
  if (Object.hasOwn(PATH_ARGS, name)) {
    const path = args?.[PATH_ARGS[name]]
    return typeof path === 'string' && path.trim() !== '' ? [path] : []
  }
  if (name === 'apply_patch' && typeof args?.input === 'string' && patchParserAvailable) {
    // Match DSH's syntax exactly: indented headers can name more files too.
    try {
      return parsePatch(args.input).flatMap(operation => operation.moveTo === undefined ? [operation.path] : [operation.path, operation.moveTo])
    } catch {
      return []
    }
  }
  return []
}

export const isFileTool = name => Object.hasOwn(PATH_ARGS, name) || name === 'apply_patch'

// Resolves every target of a file-tool call with the host's own services, as
// the tool itself would. Returns undefined when the services cannot bind every
// target: the approval path must then treat the target as unknown instead of
// guessing. `insideWorkspace` compares against the sandbox policy's workspace
// root when one is known.
export async function resolveFileTargets(ctx, { name, args, agent, signal }) {
  const raw = fileTargetsOf(name, args)
  if (raw.length === 0) return undefined
  const fs = ctx.get?.('fs')
  const directories = ctx.get?.('workingDirectory')
  if (typeof fs?.resolve !== 'function' || typeof fs.processPath !== 'function' || !directories?.ensure) return undefined
  const cwd = await directories.ensure(agent, signal)
  if (typeof cwd !== 'string') return undefined
  const workspaceRoot = ctx.get?.('sandboxPolicy')?.resolve?.({ session: agent.session })?.workspaceRoot
  const targets = []
  for (const target of raw) {
    try {
      const path = fs.processPath(await fs.resolve(target, { cwd, signal }))
      if (typeof path !== 'string') return undefined
      targets.push({
        path,
        ...(typeof workspaceRoot === 'string' ? { insideWorkspace: within(path, workspaceRoot) } : {}),
      })
    } catch {
      return undefined
    }
  }
  return targets
}

// 1Password external secret provider (`op://vault/item/[section/]field`).
// Resolves multiple references in a single `op --cache=false inject -i <template>`
// invocation using random UUID delimiters so Touch ID / biometric unlock prompts only
// once per batch. Falls back to individual `op --cache=false read --no-newline <ref>`
// calls sharing the same 45s deadline if `inject` fails.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findExecutable, launchOf } from '../local-agents/discover.js'

export const ONEPASSWORD_KIND = 'onepassword'
export const ONEPASSWORD_TIMEOUT_MS = 45_000
const KILL_GRACE_MS = 500
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_REF_LENGTH = 512

// Strict `op://vault/item/field` or `op://vault/item/section/field` syntax.
// Rejects whitespace, control characters, quotes, shell metacharacters, and `..`.
const SEGMENT = '[A-Za-z0-9._:@+-]+'
const OP_REF_RE = new RegExp(`^op:\\/\\/(${SEGMENT})\\/(${SEGMENT})\\/(${SEGMENT})(?:\\/(${SEGMENT}))?$`)
const OP_ACCOUNT_RE = /^[A-Za-z0-9._:@+-]{1,128}$/

export function isOnePasswordReference(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REF_LENGTH) return false
  const match = OP_REF_RE.exec(value)
  if (match === null) return false
  for (let i = 1; i < match.length; i += 1) {
    if (match[i] === '.' || match[i] === '..') return false
  }
  return true
}

export function validateOnePasswordConfig(config) {
  if (config === undefined || config === null) return { account: '' }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('1Password configuration must be an object.')
  }
  const account = typeof config.account === 'string' ? config.account.trim() : ''
  if (account !== '' && (account.startsWith('-') || !OP_ACCOUNT_RE.test(account))) {
    throw new Error('Invalid 1Password account identifier.')
  }
  return { account }
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true })
      killer.unref?.()
    } catch {}
    try { child.kill() } catch {}
    return
  }
  try { child.kill('SIGTERM') } catch {}
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch {}
    }
  }, KILL_GRACE_MS)
  force.unref?.()
}

function runOpProcess(bin, args, { timeoutMs, signal, env }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('1Password secret resolution was aborted.'), { code: 'ABORT_ERR' }))
      return
    }
    if (timeoutMs <= 0) {
      reject(Object.assign(new Error('1Password CLI timed out.'), { code: 'ETIMEDOUT' }))
      return
    }
    let settled = false
    let timedOut = false
    let aborted = false
    let overflowed = false
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutChunks = []
    const stderrChunks = []

    let launch
    try {
      const resolvedBin = process.platform === 'win32' && !bin.includes('/') && !bin.includes('\\')
        ? (findExecutable(bin) ?? bin)
        : bin
      launch = launchOf(resolvedBin, args)
    } catch (error) {
      reject(Object.assign(new Error(error?.message || '1Password CLI could not start.'), { code: error?.code ?? 'OP_SPAWN_ERROR' }))
      return
    }

    const child = spawn(launch.file, launch.args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...launch.options,
      ...(env ? { env } : {}),
    })

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value)
    }

    const onAbort = () => {
      aborted = true
      killProcessTree(child)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)
    timer.unref?.()

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        overflowed = true
        killProcessTree(child)
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderrChunks.push(chunk)
    })

    child.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        finish(Object.assign(new Error('1Password CLI (op) was not found in PATH.'), { code: 'ENOENT' }))
        return
      }
      finish(Object.assign(new Error(`1Password CLI could not start (${error?.code ?? 'error'}).`), { code: error?.code ?? 'OP_SPAWN_ERROR' }))
    })

    child.on('close', (code, sig) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      if (aborted) {
        finish(Object.assign(new Error('1Password secret resolution was aborted.'), { code: 'ABORT_ERR' }))
        return
      }
      if (timedOut) {
        finish(Object.assign(new Error('1Password CLI timed out.'), { code: 'ETIMEDOUT' }))
        return
      }
      if (overflowed) {
        finish(Object.assign(new Error('1Password CLI output exceeded the size limit.'), { code: 'OP_OUTPUT_LIMIT' }))
        return
      }
      if (code !== 0) {
        const detail = stderr ? stderr.split(/\r?\n/)[0].slice(0, 200) : (sig ? `signal ${sig}` : `exit ${code}`)
        finish(Object.assign(new Error(`1Password CLI failed: ${detail}`), { code: 'OP_EXIT_ERROR', exitCode: code }))
        return
      }
      finish(null, Buffer.concat(stdoutChunks).toString('utf8'))
    })
  })
}

function buildInjectTemplate(refs, token) {
  return refs.map((ref, index) => `<<DSBOT_OP_START_${token}_${index}>>{{ ${ref} }}<<DSBOT_OP_END_${token}_${index}>>`).join('\n')
}

function parseInjectOutput(output, refs, token) {
  const result = new Map()
  let cursor = 0
  for (let index = 0; index < refs.length; index += 1) {
    const startMarker = `<<DSBOT_OP_START_${token}_${index}>>`
    const endMarker = `<<DSBOT_OP_END_${token}_${index}>>`
    const startAt = output.indexOf(startMarker, cursor)
    if (startAt === -1) return null
    const valueStart = startAt + startMarker.length
    const endAt = output.indexOf(endMarker, valueStart)
    if (endAt === -1) return null
    result.set(refs[index], output.slice(valueStart, endAt))
    cursor = endAt + endMarker.length
  }
  return result
}

export function createOnePasswordDriver({
  bin = () => process.env.DS_BOT_OP_BIN || 'op',
  binArgs = [],
  timeoutMs = ONEPASSWORD_TIMEOUT_MS,
  tempDir,
  env,
} = {}) {
  const resolveBin = () => (typeof bin === 'function' ? bin() : bin)
  const prefixArgs = Array.isArray(binArgs) ? binArgs.map(String) : []
  const privateTempDir = typeof tempDir === 'string' && tempDir !== '' ? tempDir : null
  const resolvedTempDir = privateTempDir ?? tmpdir()

  return {
    kind: ONEPASSWORD_KIND,
    label: '1Password',
    isReference: isOnePasswordReference,
    validateConfig: validateOnePasswordConfig,
    async readBatch(config, refs, signal) {
      const normalized = validateOnePasswordConfig(config)
      const uniqueRefs = [...new Set(refs ?? [])]
      if (uniqueRefs.length === 0) return new Map()
      for (const ref of uniqueRefs) {
        if (!isOnePasswordReference(ref)) {
          throw Object.assign(new Error(`Invalid 1Password reference: ${ref}`), { code: 'OP_INVALID_REF' })
        }
      }
      const binary = resolveBin()
      const baseArgs = [...prefixArgs, '--cache=false', ...(normalized.account ? [`--account=${normalized.account}`] : [])]
      const deadline = Date.now() + timeoutMs
      const remaining = () => Math.max(0, deadline - Date.now())

      // Fast path: single `op inject` resolves the entire batch under one biometric prompt.
      const token = randomUUID().replace(/-/g, '')
      const templatePath = join(resolvedTempDir, `dsbot-op-${process.pid}-${token}.tpl`)
      let injectError = null
      try {
        if (privateTempDir !== null) {
          await mkdir(privateTempDir, { recursive: true, mode: 0o700 })
          try { await chmod(privateTempDir, 0o700) } catch {}
        }
        await writeFile(templatePath, buildInjectTemplate(uniqueRefs, token), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        try { await chmod(templatePath, 0o600) } catch {}
        const output = await runOpProcess(binary, [...baseArgs, 'inject', '-i', templatePath], {
          timeoutMs: remaining(),
          signal,
          env,
        })
        const parsed = parseInjectOutput(output, uniqueRefs, token)
        if (parsed !== null) return parsed
        injectError = Object.assign(new Error('1Password inject output could not be parsed.'), { code: 'OP_PARSE_ERROR' })
      } catch (error) {
        injectError = error
      } finally {
        await unlink(templatePath).catch(() => {})
      }

      // Do not spawn fallback calls when the binary is missing, aborted, or out of time.
      if (injectError?.code === 'ENOENT' || injectError?.code === 'ABORT_ERR' || injectError?.code === 'ETIMEDOUT' || signal?.aborted || remaining() <= 0) {
        throw injectError
      }

      // Fallback: resolve each reference individually while sharing the original deadline.
      // Isolate per-ref failures so one missing item does not poison valid references.
      const values = new Map()
      let succeeded = 0
      let firstError = null
      for (let i = 0; i < uniqueRefs.length; i += 1) {
        const ref = uniqueRefs[i]
        try {
          const value = await runOpProcess(binary, [...baseArgs, 'read', '--no-newline', ref], {
            timeoutMs: remaining(),
            signal,
            env,
          })
          values.set(ref, value)
          succeeded += 1
        } catch (error) {
          if (firstError === null) firstError = error
          if (error?.code === 'ENOENT' || error?.code === 'ABORT_ERR' || signal?.aborted) {
            throw error
          }
          values.set(ref, { ok: false, error })
          if (error?.code === 'ETIMEDOUT' || remaining() <= 0) {
            const timeoutErr = error?.code === 'ETIMEDOUT'
              ? error
              : Object.assign(new Error('1Password CLI timed out.'), { code: 'ETIMEDOUT' })
            for (let j = i + 1; j < uniqueRefs.length; j += 1) {
              values.set(uniqueRefs[j], { ok: false, error: timeoutErr })
            }
            break
          }
        }
      }
      if (succeeded === 0) throw firstError ?? injectError
      return values
    },
  }
}

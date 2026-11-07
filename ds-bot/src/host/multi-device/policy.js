// What a worker will run for the hub. A worker is the far end of a network link, so the
// allowed set is fixed here, checked before anything is spawned, and never goes through
// a shell: `argv` is an argument list, not a command line.
//
// `echo` is built in because Windows has no echo executable; `uname` exists only on
// POSIX, and a worker there reports the missing program as an ordinary failure.

export const MAX_ARGS = 16
export const MAX_ARG_LENGTH = 200
export const MAX_TOTAL_LENGTH = 1000

// Arguments each program may take. Anything else — another flag, a path, a redirect —
// is refused rather than passed on.
const PROGRAMS = {
  hostname: { args: /^-[a-zA-Z]{1,3}$/, most: 1 },
  whoami: { args: /^$/, most: 0 },
  uname: { args: /^-[asnrvmo]{1,6}$/, most: 1 },
  echo: { builtin: true },
}

export const ALLOWED_PROGRAMS = Object.keys(PROGRAMS)

const refuse = (reason, code = 'invalid') => ({ ok: false, reason, code })

export function checkCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return refuse('command is empty')
  if (argv.length > MAX_ARGS + 1) return refuse(`command has more than ${MAX_ARGS} arguments`)
  let total = 0
  for (const part of argv) {
    if (typeof part !== 'string') return refuse('command parts must be strings')
    if (part.length > MAX_ARG_LENGTH) return refuse(`a command part is longer than ${MAX_ARG_LENGTH} characters`)
    if (/\p{Cc}/u.test(part)) return refuse('a command part contains a control character')
    total += part.length
  }
  if (total > MAX_TOTAL_LENGTH) return refuse(`command is longer than ${MAX_TOTAL_LENGTH} characters`)

  const [program, ...args] = argv
  // A path (`./hostname`, `C:\Windows\hostname.exe`) would pick a different program than
  // the one the allowlist names, so only the bare name is accepted.
  if (!Object.hasOwn(PROGRAMS, program)) return refuse(`program is not allowed: ${program}`, 'not-allowed')
  const spec = PROGRAMS[program]
  if (spec.builtin) return { ok: true, program, args, builtin: true }
  if (args.length > spec.most) return refuse(`${program} takes at most ${spec.most} argument${spec.most === 1 ? '' : 's'}`)
  for (const arg of args) {
    if (!spec.args.test(arg)) return refuse(`argument is not allowed for ${program}: ${arg}`, 'not-allowed')
  }
  return { ok: true, program, args, builtin: false }
}

export function describePolicy() {
  return ALLOWED_PROGRAMS.map(name => (PROGRAMS[name].builtin ? `${name} (built in)` : name))
}

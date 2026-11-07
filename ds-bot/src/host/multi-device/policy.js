// What a worker may run for the hub. A worker is the far end of a network link, so
// every task is checked here before anything happens, and a command never goes through
// a shell: `argv` is an argument list, not a command line.
//
// Two classes of command exist. The read-only commands below run directly; any other
// program needs the user's approval on the hub first (`approved: true`). The approval
// itself is never decided here: the hub asks, and a task without that mark is refused.
//
// `echo` is built in because Windows has no echo executable; `uname` exists only on
// POSIX, and a worker there reports the missing program as an ordinary failure.

export const MAX_ARGS = 16
export const MAX_ARG_LENGTH = 200
export const MAX_TOTAL_LENGTH = 1000

// Arguments each read-only program may take. A program with `args: null` takes a free
// list of paths and flags; it still goes through the size and control-character checks.
const PROGRAMS = {
  hostname: { args: /^-[a-zA-Z]{1,3}$/, most: 1 },
  whoami: { args: /^$/, most: 0 },
  uname: { args: /^-[asnrvmo]{1,6}$/, most: 1 },
  echo: { builtin: true },
  pwd: { args: /^$/, most: 0 },
  ls: { args: null, most: 8 },
  dir: { args: null, most: 8 },
}

export const ALLOWED_PROGRAMS = Object.keys(PROGRAMS)

const refuse = (reason, code = 'invalid') => ({ ok: false, reason, code })

// The size and character checks every argument list gets, whatever it will run.
function checkShape(argv) {
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
  return { ok: true }
}

export function checkCommand(argv) {
  const shape = checkShape(argv)
  if (!shape.ok) return shape
  const [program, ...args] = argv
  // A path (`./hostname`, `C:\Windows\hostname.exe`) would pick a different program than
  // the one the allowlist names, so only the bare name is accepted.
  if (!Object.hasOwn(PROGRAMS, program)) return refuse(`program is not allowed: ${program}`, 'not-allowed')
  const spec = PROGRAMS[program]
  if (spec.builtin) return { ok: true, program, args, builtin: true }
  if (args.length > spec.most) return refuse(`${program} takes at most ${spec.most} argument${spec.most === 1 ? '' : 's'}`)
  if (spec.args !== null) {
    for (const arg of args) {
      if (!spec.args.test(arg)) return refuse(`argument is not allowed for ${program}: ${arg}`, 'not-allowed')
    }
  }
  return { ok: true, program, args, builtin: false }
}

// Whether a command runs without asking the user, or needs approval on the hub. A
// program name with a path is never on the read-only list: its target would be a
// different file than the name suggests.
export function classifyCommand(argv) {
  const shape = checkShape(argv)
  if (!shape.ok) return shape
  const strict = checkCommand(argv)
  if (strict.ok) return { ok: true, safe: true, argv: [...argv] }
  const program = argv[0]
  if (typeof program !== 'string' || program === '') return refuse('command is empty')
  if (program.includes('/') || program.includes('\\')) return refuse('program must be a bare name, not a path', 'not-allowed')
  return { ok: true, safe: false, argv: [...argv] }
}

export function describePolicy() {
  return ALLOWED_PROGRAMS.map(name => (PROGRAMS[name].builtin ? `${name} (built in)` : name))
}

export const APPROVED_NOTE = 'Other programs and file writes need the user\'s approval on the hub first.'

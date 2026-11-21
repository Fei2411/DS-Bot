import { randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { parse } from 'yaml'

const BUNDLE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const within = (path, root) => {
  const rest = relative(root, path)
  return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}

async function fileAt(path) {
  if (!(await lstat(path)).isFile()) throw new Error('Skill bundles must contain ordinary files and folders.')
  const file = await open(path, READ_FLAGS)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Skill bundles must contain ordinary files and folders.')
    return { file, stat }
  } catch (error) {
    await file.close()
    throw error
  }
}

function flag(data, key) {
  const value = data[key]
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (value === 1 || (typeof value === 'string' && /^(?:1|true|yes|on)$/iu.test(value))) return true
  if (value === 0 || (typeof value === 'string' && /^(?:0|false|no|off)$/iu.test(value))) return false
  throw new Error(`The ${key} field in SKILL.md must be a boolean.`)
}

async function readSkill(directory, validateName) {
  const path = join(directory, 'SKILL.md')
  const { file } = await fileAt(path).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('The selected skill folder must contain SKILL.md.')
    throw error
  })
  let raw
  try {
    raw = await file.readFile({ encoding: 'utf8' })
  } finally {
    await file.close()
  }
  const head = /^\uFEFF?---\r?\n([\s\S]*?)^---(?:\r?\n|$)/mu.exec(raw)
  if (!head || head.index !== 0) throw new Error('SKILL.md must begin with YAML frontmatter.')
  let data
  try {
    data = parse(head[1])
  } catch {
    throw new Error('SKILL.md contains invalid YAML frontmatter.')
  }
  if (typeof data?.name !== 'string' || typeof data.description !== 'string' || !data.description.trim()) {
    throw new Error('SKILL.md must have a name and description.')
  }
  for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (Object.hasOwn(data, key)) throw new Error(`Use disable-model-invocation or user-invocable instead of ${key} in SKILL.md.`)
  }
  const invocation = {
    modelInvocable: flag(data, 'disable-model-invocation') !== true,
    userInvocable: flag(data, 'user-invocable') !== false,
  }
  const metadata = data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata) ? data.metadata : undefined
  if (metadata !== undefined) {
    try {
      JSON.stringify(metadata)
    } catch {
      throw new Error('SKILL.md metadata must not contain circular references.')
    }
  }
  return {
    name: validateName(data.name),
    description: data.description.trim().slice(0, 2000),
    content: raw.slice(head[0].length).trim(),
    invocation,
    ...(typeof data.whenToUse === 'string' && data.whenToUse.trim() ? { whenToUse: data.whenToUse.trim() } : {}),
    ...(metadata === undefined ? {} : { metadata }),
    path: path.split(sep).join('/'),
    resourceBase: { kind: 'directory', path: directory.split(sep).join('/') },
  }
}

async function copySkillFiles(source, destination) {
  if (!(await lstat(source)).isDirectory() || relative(source, await realpath(source)) !== '') {
    throw new Error('Skill bundles cannot contain symbolic links.')
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      await mkdir(to)
      await copySkillFiles(from, to)
    } else if (entry.isFile()) {
      const { file, stat } = await fileAt(from)
      try {
        await pipeline(file.createReadStream({ autoClose: false }), createWriteStream(to, { flags: 'wx', mode: 0o600 | (stat.mode & 0o111) }))
      } finally {
        await file.close()
      }
    } else {
      throw new Error('Skill bundles cannot contain symbolic links or special files.')
    }
  }
}

async function sourceFolder(rt, directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Choose a skill folder or enter its full path.')
  const selected = await lstat(directory).catch(() => undefined)
  if (selected?.isSymbolicLink()) throw new Error('Choose the skill folder itself, not a symbolic link.')
  if (!selected?.isDirectory()) throw new Error('The selected skill folder does not exist.')
  const path = await realpath(directory)
  const home = await realpath(rt.home)
  const dataRoots = await Promise.all([rt.dshHome, process.env.DS_BOT_USER_DSH_HOME].filter(Boolean).map(rt.realBeyond))
  const isSkillFolder = dataRoots.some(root => {
    const skills = join(root, 'skills')
    return path !== skills && within(path, skills)
  })
  if (within(home, path) || within(path, join(home, 'capability-skills'))
    || dataRoots.some(root => within(root, path)) || (!isSkillFolder && await rt.inData(path))) {
    throw new Error('Choose a skill folder outside DeepSeek Harness data or inside its skills folder.')
  }
  if (await rt.privateClash(path)) throw new Error('Choose a skill folder outside private Bot folders.')
  return path
}

async function bundleRoot(rt, create = false) {
  const root = join(await realpath(rt.home), 'capability-skills')
  if (create) await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (!(await lstat(root)).isDirectory()) throw new Error('The managed skill library is not a directory.')
  return root
}

export async function previewDirectorySkill(rt, input, validateName) {
  const directory = await sourceFolder(rt, input)
  const { name, description } = await readSkill(directory, validateName)
  return { name, description, directory }
}

export async function importDirectorySkill(rt, input, expectedName, validateName) {
  const directory = await sourceFolder(rt, input)
  const selected = await readSkill(directory, validateName)
  if (selected.name !== expectedName) throw new Error('The skill name in SKILL.md does not match this capability.')
  const root = await bundleRoot(rt, true)
  const staging = await mkdtemp(join(root, '.import-'))
  try {
    await copySkillFiles(directory, staging)
    const { name, description } = await readSkill(staging, validateName)
    if (name !== expectedName) throw new Error('The skill name in SKILL.md does not match this capability.')
    const bundleId = randomUUID()
    await rename(staging, join(root, bundleId))
    return { directory, bundleId, description }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function managedDirectory(rt, id) {
  if (typeof id !== 'string' || !BUNDLE_ID.test(id)) throw new Error('Invalid managed skill directory.')
  return join(await bundleRoot(rt), id)
}

export async function loadDirectorySkill(rt, item, validateName) {
  const directory = await managedDirectory(rt, item.bundleId)
  if (!(await lstat(directory)).isDirectory()) throw new Error('The managed skill directory is missing or invalid.')
  const skill = await readSkill(directory, validateName)
  if (skill.name !== item.name) throw new Error('The skill name in SKILL.md does not match this capability.')
  return { ...skill, description: item.description }
}

export async function discardDirectorySkill(rt, id) {
  const directory = await managedDirectory(rt, id)
  await rm(directory, { recursive: true, force: true })
}

export async function isManagedSkillResource(rt, id, path) {
  try {
    const directory = await managedDirectory(rt, id)
    return (await lstat(directory)).isDirectory() && within(await realpath(path), directory)
  } catch {
    return false
  }
}

// The first start: where the app keeps its data and the Bots' files, and whether it copies the
// Bot team of the user's own DSH. The answers are kept in the app's own data.
import { app, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { findTeam, newerSessions, teamInUse, userDshHome, within } from './import.mjs'
import { installFolder } from './move-data.mjs'

const TEXT = {
  en: {
    welcome: 'Welcome to DS Bot',
    places: (data, workspace) => `Data: ${data}\nTeam workspace: ${workspace}`,
    start: 'Start', change: 'Change…',
    pickData: 'Folder for DS Bot data', pickWorkspace: 'Folder for the team workspace',
    dataInWorkspace: 'The data folder cannot be inside the team workspace.',
    workspaceInData: 'The team workspace cannot be inside the data folder.',
    inDsh: home => `Choose a folder outside the DeepSeek Harness data (${home}).`,
    inProgram: 'Choose a folder outside the program folder: uninstalling removes it.',
    pickMove: 'New folder for DS Bot data',
    moveDrive: 'Choose a folder, not a whole drive.',
    moveNested: 'Choose a folder outside the current data folder.',
    moveWorkspace: 'The data folder and the team workspace cannot hold each other.',
    moveNotEmpty: 'Choose an empty folder or a new one.',
    moveConfirm: to => `Move DS Bot's data to ${to}?`,
    moveDetail: from => `DS Bot copies its data there and starts again. ${from} stays as it is; you can delete it once everything works.`,
    move: 'Move and restart', cancel: 'Cancel',
    moving: 'Copying DS Bot\'s data…',
    starting: 'Starting DS Bot…',
    moveInUse: 'Another DeepSeek Harness is using this data, so it was not moved. Close it, then try again.',
    moveFailed: message => `The data could not be copied: ${message}\n\nDS Bot goes on with its data where it was.`,
    found: (bots, rooms) => `DeepSeek Harness has a Bot team: ${bots} Bot${bots === 1 ? '' : 's'}${rooms > 0 ? `, ${rooms} group${rooms === 1 ? '' : 's'}` : ''}. Copy it into DS Bot?`,
    foundDetail: home => `The copy takes the Bots, groups, memories, chats, files, keys and model settings. Nothing in ${home} changes, and the two teams do not stay in step.`,
    copy: 'Copy', skip: 'Do not copy',
    inUse: 'DeepSeek Harness is using this team. Close it, then try again.', retry: 'Try again',
    newer: count => `${count} chat${count === 1 ? ' was' : 's were'} written by a newer DeepSeek Harness than this DS Bot can read. Update DS Bot, then start it again to copy the team.`,
    quit: 'Quit', startEmpty: 'Start without the team',
    whichModels: 'Which model settings should DS Bot use?',
    failed: message => `The team could not be copied: ${message}\n\nDS Bot starts with a new team. The team in DeepSeek Harness is unchanged.`,
    notStarted: 'DS Bot could not start.',
  },
  zh: {
    welcome: '欢迎使用 DS Bot',
    places: (data, workspace) => `数据：${data}\n总工作区：${workspace}`,
    start: '开始使用', change: '更改位置…',
    pickData: '选择 DS Bot 的数据文件夹', pickWorkspace: '选择总工作区的文件夹',
    dataInWorkspace: '数据文件夹不能放在总工作区里面。',
    workspaceInData: '总工作区不能放在数据文件夹里面。',
    inDsh: home => `请选择 DeepSeek Harness 数据（${home}）以外的文件夹。`,
    inProgram: '请选择程序文件夹以外的位置：卸载时会删掉程序文件夹。',
    pickMove: '选择 DS Bot 数据的新文件夹',
    moveDrive: '请选择一个文件夹，不要选整个磁盘。',
    moveNested: '请选择现在的数据文件夹以外的位置。',
    moveWorkspace: '数据文件夹和总工作区不能互相包含。',
    moveNotEmpty: '请选择一个空文件夹，或者新建一个。',
    moveConfirm: to => `把 DS Bot 的数据移到 ${to} 吗？`,
    moveDetail: from => `DS Bot 会把数据复制过去，然后重新启动。${from} 会原样保留，确认一切正常后可以自己删掉。`,
    move: '移动并重启', cancel: '取消',
    moving: '正在复制 DS Bot 的数据…',
    starting: '正在启动 DS Bot…',
    moveInUse: '另一个 DeepSeek Harness 正在使用这份数据，所以没有移动。请先关掉它，再重试。',
    moveFailed: message => `数据没有复制成功：${message}\n\nDS Bot 会继续使用原来位置的数据。`,
    found: (bots, rooms) => `DeepSeek Harness 里有一个 Bot 团队：${bots} 个 Bot${rooms > 0 ? `、${rooms} 个群` : ''}。要复制到 DS Bot 吗？`,
    foundDetail: home => `会复制 Bot、群、记忆、对话、文件、密钥和模型设置。${home} 里的内容不会改变；复制以后两个团队各自独立。`,
    copy: '复制', skip: '不复制',
    inUse: 'DeepSeek Harness 正在使用这个团队。请先关掉它，再重试。', retry: '重试',
    newer: count => `有 ${count} 段对话是更新版本的 DeepSeek Harness 写的，这个版本的 DS Bot 读不了。请先更新 DS Bot，再打开它来复制团队。`,
    quit: '退出', startEmpty: '不带团队开始',
    whichModels: 'DS Bot 用哪一份模型设置？',
    failed: message => `团队没有复制成功：${message}\n\nDS Bot 会用一个新团队开始。DeepSeek Harness 里的团队没有变化。`,
    notStarted: 'DS Bot 没能启动。',
  },
}
export const localeText = table => (app.getLocale().toLowerCase().startsWith('zh') ? table.zh : table.en)
export const text = () => localeText(TEXT)

const PROFILE_NAMES = { desktop: 'DSH Desktop', web: 'DSH Web' }
const locationsFile = () => join(app.getPath('userData'), 'locations.json')

// A quit request while a first-run dialog is open stops the first run right after that dialog.
class Quit extends Error {}

async function ask(options, signal) {
  const { response } = await dialog.showMessageBox({ title: 'DS Bot', noLink: true, ...options, signal })
  // A quit that arrived while a synchronous macOS box was open gets to run first.
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return response
}

async function pick(title, current, signal) {
  const { canceled, filePaths } = await dialog.showOpenDialog({ title, defaultPath: existsSync(current) ? current : dirname(current), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] })
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return canceled ? current : filePaths[0]
}

export const programFolder = () => installFolder(app.getPath('exe'))

function placeProblem(t, dataDir, workspace) {
  const dsh = userDshHome()
  const program = programFolder()
  if (within(dataDir, workspace)) return t.dataInWorkspace
  if (within(workspace, dataDir)) return t.workspaceInData
  for (const path of [dataDir, workspace]) {
    if (within(path, dsh) || within(dsh, path)) return t.inDsh(dsh)
    if (app.isPackaged && within(path, program)) return t.inProgram
  }
  return undefined
}

function hasTeam(dataDir) {
  try {
    return Object.keys(JSON.parse(readFileSync(join(dataDir, 'bot', 'state.json'), 'utf8')).bots ?? {}).length > 0
  } catch {
    return false
  }
}

async function offerImport(t, dataDir, signal) {
  const from = userDshHome()
  let found
  try {
    found = hasTeam(dataDir) ? undefined : findTeam(from)
  } catch (error) {
    console.error(error)
  }
  if (found === undefined) return undefined
  if (await ask({ type: 'question', message: t.found(found.bots, found.rooms), detail: t.foundDetail(from), buttons: [t.copy, t.skip], defaultId: 0, cancelId: 1 }, signal) === 1) return undefined
  while (teamInUse(from)) {
    if (await ask({ type: 'warning', message: t.inUse, buttons: [t.retry, t.skip], defaultId: 0, cancelId: 1 }, signal) === 1) return undefined
  }
  const newer = newerSessions(from, found.team)
  if (newer.length > 0) {
    if (await ask({ type: 'warning', message: t.newer(newer.length), buttons: [t.quit, t.startEmpty], defaultId: 0, cancelId: 0 }, signal) === 0) return { quit: true }
    return undefined
  }
  const { profiles } = found
  const profile = profiles.length < 2 ? profiles[0]?.name
    : profiles[await ask({ type: 'question', message: t.whichModels, buttons: profiles.map(entry => PROFILE_NAMES[entry.name] ?? entry.name), defaultId: 0, cancelId: 0 }, signal)].name
  return { from, profile }
}

/** Write the chosen places once the first run is finished; quitting before that asks again. */
export function saveLocations({ dataDir, workspace }) {
  const file = locationsFile()
  mkdirSync(dirname(file), { recursive: true })
  // A write that fails half way leaves the places that were there.
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ dataDir, workspace }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

/**
 * Where the app keeps its data and the Bots' files, asked at the first start.
 * A run on throwaway folders (DS_BOT_HOME, for development and tests) asks nothing and copies nothing.
 * @returns {Promise<{ dataDir: string, workspace?: string, import?: { from: string, profile?: string }, quit?: true }>}
 */
export async function chooseLocations(signal) {
  if (process.env.DS_BOT_HOME) return { dataDir: process.env.DS_BOT_HOME, workspace: process.env.DS_BOT_WORKSPACE || undefined }
  const file = locationsFile()
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    return { dataDir: saved.dataDir, workspace: saved.workspace }
  }
  const t = text()
  let dataDir = join(homedir(), '.ds-bot')
  let workspace = join(homedir(), 'DS Bot')
  try {
    for (;;) {
      const choice = await ask({ type: 'info', message: t.welcome, detail: t.places(dataDir, workspace), buttons: [t.start, t.change, t.quit], defaultId: 0, cancelId: 2 }, signal)
      if (choice === 2) return { quit: true }
      if (choice === 1) {
        dataDir = await pick(t.pickData, dataDir, signal)
        workspace = await pick(t.pickWorkspace, workspace, signal)
        continue
      }
      const problem = placeProblem(t, dataDir, workspace)
      if (problem === undefined) break
      await ask({ type: 'warning', message: problem, buttons: ['OK'] }, signal)
    }
    const imported = await offerImport(t, dataDir, signal)
    if (imported?.quit) return { quit: true }
    if (imported !== undefined) return { dataDir, workspace, import: imported }
  } catch (error) {
    if (error instanceof Quit) return { quit: true }
    throw error
  }
  // There is nothing to copy, so the first run ends with the chosen places.
  saveLocations({ dataDir, workspace })
  return { dataDir, workspace }
}

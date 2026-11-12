import { DICTIONARY } from '../../../ds-bot/src/client/i18n.js'

// Phone copy shares the desktop dictionary. Mobile-only strings have their own
// Chinese entries here; the English source stays the key, as on the desktop.
const ZH = DICTIONARY.zh as Record<string, string>
// Words the desktop uses in another sense (its "New" badge, "Light" motion,
// the browser's "Back"); the phone's own meaning wins for these.
const MOBILE_SENSE = new Set(['New', 'Light', 'Back'])

const MOBILE_ZH: Record<string, string> = {
  'Asks for the secret {name}': '请求密钥 {name}',
  '{bot} asks for the secret {name}': '{bot} 请求密钥 {name}',
  'Pair with your computer': '与电脑配对',
  'On the computer, open DS Bot, go to Settings → Phone and show a QR code. Then scan it here.': '在电脑上打开 DS Bot，进入设置 → 手机，出示二维码，然后在这里扫描。',
  'Use the camera': '使用相机',
  'No camera? Paste the pairing link.': '没有相机？粘贴配对链接。',
  'Pair': '配对',
  'Turns': '轮次',
  'Tools': '工具调用',
  'Steps': '步数', 'Context used': '上下文占用',
  'Retry': '重试',
  'Add photos': '添加照片', 'Not sent. Tap to retry': '未发出，点按重试', 'Latest messages': '最新消息', 'Forget {name}?': '忘记 {name}？', 'Clear diagnostics?': '清空诊断记录？',
  'Pick at least two Bots. The admin leads the group.': '至少选两个 Bot，管理员带领这个群。', 'Reconnecting…': '正在重新连接…',
  'A photo did not arrive. Send it again.': '有张照片没传到，请重新发送。', 'This is not a photo DS Bot can send': '这不是 DS Bot 能发送的照片',
  'The computer did not accept this phone. Show a new QR code on the computer and scan it again.': '电脑没有接受这台手机。在电脑上出示新的二维码，再扫一次。',
  'The computer is not connected to the Server. Check that DS Bot is open and phone access is on.': '电脑没有连上服务器。确认 DS Bot 已打开且手机访问已开启。',
  'Not connected to the computer yet.': '还没有连上电脑。',
  'Card': '卡片',
  "Could not reach the Server. Check the network. If the computer's Server address changed, pair again under Computers.": '连不上服务器。请检查网络；如果电脑的服务器地址改了，在「电脑」里重新配对。',
  'Update DS Bot on the computer to use this phone.': '请先更新电脑上的 DS Bot，再用这台手机。',
  'Open team list': '打开团队列表', 'Close team list': '关闭团队列表', 'Pairing link': '配对链接',
  'Forget this computer': '忘记这台电脑',
  'Tap again to forget': '再点一次确认忘记',
  'Needs you': '等你处理',
  'Nothing needs you': '没有要等你的事',
  'Connected': '已连接',
  'Connecting…': '连接中…',
  'Not connected': '未连接',
  'Computer': '电脑',
  'Appearance': '外观',
  'Version': '版本',
  'Team': '团队',
  'Message {name}': '发消息给 {name}',
  'Your answer': '你的回答',
  'No messages yet': '还没有消息',
  'asked for work': '来要工作',
  'replied': '回复了',
  'reported back': '交回了工作',
  'stopped': '停下了',
  'Details': '详情',
  'Edit Bot': '编辑 Bot',
  'Group settings': '群设置',
  'Bot': 'Bot',
  'Main Bot': '主 Bot',
  'Model': '模型',
  'Effort': '强度',
  'Working folder': '工作文件夹',
  'Folder': '文件夹',
  'More': '更多',
  'Memory': '记忆',
  'Schedules': '定时任务',
  'Usage': '用量',
  'Actions': '操作',
  'Duplicate': '复制',
  'Delete': '删除',
  'Delete group': '删除群聊',
  'Tap again to delete this Bot': '再点一次删除这个 Bot',
  'Tap again to delete this group': '再点一次删除这个群聊',
  'Profile': '资料',
  'Name': '名字',
  'Label': '标签',
  'Research, admin…': '研究、管理…',
  'Character shape': '形象',
  'Character color': '颜色',
  'Instructions': '指令',
  'What this Bot does': '这个 Bot 做什么',
  'What this Bot is responsible for…': '这个 Bot 负责什么…',
  'Privacy': '隐私',
  'Private': '私有',
  'Other Bots cannot read its folder, memory or chats, and you approve what it shares with them.': '其他 Bot 看不到它的文件夹、记忆和聊天，它分享出去的内容都要经过你批准。',
  'Can create and change Bots, and runs every group chat.': '可以创建和修改 Bot，并负责主持每个群聊。',
  'New Bot': '新 Bot',
  'Create new Bot': '创建新 Bot',
  'Create group chat': '创建群聊',
  'Create': '创建',
  'New group': '新群聊',
  'New': '新建',
  'Notice': '公告',
  'Name after members': '用成员名字自动命名',
  'Shared instructions every member reads before speaking…': '每个成员发言前都要读的共享指令…',
  'Who answers': '谁来回答',
  'Admin leads': '管理员主导',
  'Everyone': '全体轮流',
  'Members · {count}': '成员 · {count}',
  'Admin': '管理员',
  'Danger': '危险操作',
  'Photo': '照片',
  'Upload photo': '上传照片',
  'Remove photo': '移除照片',
  'Another Bot has this name.': '已经有 Bot 叫这个名字。',
  'Back': '返回',
  'Browser': '浏览器', 'This Bot has no open browser': '这个 Bot 没有打开的浏览器',
  'Take over': '接管', 'Give back': '交还', 'Done': '完成', 'Skip': '跳过',
  'Browser handoff': '浏览器交接', 'View': '查看',
  'Aside': '旁注', 'Delete aside': '删除旁注',
  'This file cannot be read here': '这个文件在这里读不了',
  'Paused after {count} Bot relays. Waiting: {names}': '{count} 次 Bot 接力后暂停。还在等：{names}',
  'Side chat': '旁聊', 'Ask about the work so far': '问一下目前的进展',
  'Answering…': '正在回答…', 'Cancel this side question': '取消这个旁问',
  'Cancelled': '已取消', 'The side answer failed.': '旁问的回答失败了。',
  'Answered from progress so far; nothing was run': '按目前的进展回答；没有运行任何东西',
  '{count} questions': '{count} 个问题', 'New side chat': '新的旁聊',
  'Edit': '编辑', 'Edit capability': '编辑能力', 'Add capability': '添加能力',
'MCP': 'MCP', 'Description': '描述', 'Command': '命令',
  'Arguments (one per line)': '参数（一行一个）', 'Environment': '环境', 'Headers': '请求头',
  'URL': '地址', 'Skill instructions': '技能说明', '{label} must be a JSON object.': '{label} 必须是 JSON 对象。',
  'Save changes': '保存修改', 'Error': '出错',
  'Ready': '就绪', 'Needs approval': '需要批准', 'Pack': '套件', 'No items': '没有项目',
  'Local command': '本地命令', 'HTTP server': 'HTTP 服务', 'Skill': '技能',
  'Approve': '批准', 'Save an MCP server or skill first.': '先保存一个 MCP 服务或技能。',
  'Updating DS Bot…': '正在更新 DS Bot…', 'Restart DSH to start using DS Bot {version}.': '重启 DSH 后开始用 DS Bot {version}。',
  'DS Bot {version} is installed.': 'DS Bot {version} 已安装。',
  'The update did not finish: {reason}': '更新没有完成：{reason}',
  'DS Bot {version} is available': 'DS Bot {version} 可用',
  'Updates come with the DS Bot app.': '更新跟随 DS Bot 应用。',
  'Update checks are off.': '更新检查已关。',
  'Installed from a local folder; update it there.': '从本地文件夹安装；在那里更新。',
  'Updates are not offered for this install.': '这个安装不提供更新。',
  'Up to date': '已是最新', 'Could not check for updates.': '检查更新失败。',
  'Update DS Bot {version} first.': '先更新 DS Bot {version}。',
  'DSH {version} is available': 'DSH {version} 可用', 'Updating DSH…': '正在更新 DSH…',
  'Restart DSH to start using DSH {version}.': '重启 DSH 后开始用 DSH {version}。',
  'Install update': '安装更新', 'Install DSH update': '安装 DSH 更新',
  'Checking for updates…': '正在检查更新…', 'What is new': '新内容',
  'Log size': '日志大小', 'Log entries': '日志条数', 'Last entry': '最后一条', 'Hide log': '收起日志',
  'Copied': '已复制', 'Copy all': '全部复制',
  'Data location': '数据位置', 'Phone app': '手机应用', 'Repository': '仓库',
  'Phone': '手机', 'Computers': '电脑', 'Language': '语言',
  'Follow system': '跟随系统', 'System': '跟随系统', 'Light': '浅色', 'Dark': '深色',
  'In-app banners': '应用内横幅', 'Notifications': '通知',
  'Model providers': '模型服务商', 'Secrets': '密钥', 'Connectors': '连接器',
  'Capabilities': '能力', 'Location': '位置', 'Updates & diagnostics': '更新和诊断',
  'About': '关于',
'Switch': '切换', 'Forget': '忘记',
'Add a computer': '添加一台电脑',
  'Paste or type the key': '粘贴或输入密钥', 'Tap again to delete': '再点一次删除',
  'Unlock to continue': '解锁后继续',
  'Set a screen lock on this phone to do this': '请先给这台手机设一个屏幕锁',
  'Needs an API key': '需要 API 密钥', 'Key set': '已设置密钥',
  'Key set outside DS Bot': '密钥在 DS Bot 外设置',
  'Replace the API key': '替换 API 密钥', 'API key': 'API 密钥',
  '{provider} API key': '{provider} API 密钥',
  'This key comes from outside DS Bot, such as an environment variable, and cannot be changed here.': '这个密钥来自 DS Bot 之外，比如环境变量，这里不能改。',
  'Models': '模型', 'No models': '没有模型', '{count} models': '{count} 个模型',
  ' and {count} more': ' 还有 {count} 个', 'Remove key': '移除密钥', 'Saved.': '已保存。',
  'Remove provider': '移除服务商',
  'Remove {name}? Bots on its models need another model.': '移除 {name}？用它的模型的 Bot 需要换一个模型。',
  'Keep': '保留', 'Remove': '移除', 'Add a provider': '添加服务商',
  'Known provider': '已知服务商', 'Custom API': '自定义 API',
  'Choose a provider': '选择服务商', 'Provider name': '服务商名字',
  'API base URL': 'API 地址', 'Provider id': '服务商标识', 'Find models': '查找模型',
  'Or type model ids, comma separated': '或输入模型标识，用逗号分隔',
  'This DSH cannot set up model providers.': '这个 DSH 不能配置模型服务商。',
  'Could not connect: {error}': '连接失败：{error}',
  'Connected as {account}': '已连接 {account}', 'Disconnect': '断开',
  'Connect': '连接', 'Try again': '重试', '{name} token': '{name} 令牌',
  'Create a token on {name}': '在 {name} 上创建令牌', 'No connectors': '没有连接器',
  'Diagnostics log': '诊断日志', 'Clear diagnostics': '清除诊断', 'Diagnostics': '诊断',
'Could not check': '检查失败', 'Check for updates': '检查更新',
  'Bots': 'Bot', 'Team workspace': '团队工作区', 'Licenses': '许可',
'No key': '未设置密钥',
'Status': '状态',
'Tokens in': '输入', 'Tokens out': '输出',
  'Needs re-auth': '需要重新授权', 'connected': '已连接', 'disconnected': '未连接',
  'approved': '已批准', 'pending': '待批准', 'denied': '已拒绝',
  'Pick the model this Bot runs on.': '选这个 Bot 用的模型。',
  'Pick a model and {name} can start.': '选好模型，{name} 就能开工了。',
  'Ask': '提问', 'Ask memory': '问记忆',
  'Nothing saved yet': '还没有保存的内容', 'Remove from memory': '从记忆里移除',
  'Click again to remove': '再点一次移除', 'Added: {text}': '已添加:{text}', 'Updated: {text}': '已更新:{text}',
  'Team memory': '团队记忆', "{name}'s memory": '{name} 的记忆', 'Group memory': '群记忆',
  'Every Bot reads it': '每个 Bot 都会读', 'Only its members read it': '只有成员能读',
  '{count} entries': '{count} 条', '1 entry': '1 条', 'Manage': '管理',
  'Add': '添加', 'Save': '保存', 'Scope': '范围', 'Topic': '主题', 'Text': '内容',
  'Every day at {time}': '每天 {time}', 'Every day': '每天', 'Every hour': '每小时',
  'Every {count} days': '每 {count} 天', 'Every {count} hours': '每 {count} 小时', 'Every {count} minutes': '每 {count} 分钟',
  'Every weekday at {time}': '每个工作日 {time}', 'Every weekend at {time}': '每个周末 {time}',
  'Once, {time}': '一次,{time}', 'On the schedule {expression}': '按时间表 {expression}',
  'Next: {time}': '下次:{time}', 'Finished': '已结束', 'New task': '新建任务', 'Title': '标题',
  'Prompt': '提示语', 'Every {days} at {time}': '每{days} {time}', 'in {name}': '在 {name}',
  'Delete task': '删除任务', 'Click again to delete': '再点一次删除',
"Each Bot's own folder": '各 Bot 自己的文件夹',
  'Folders': '文件夹', 'Choose a folder…': '选择文件夹…', 'Browse folders…': '浏览文件夹…',
  'Enter a path…': '输入路径…', 'Folder path': '文件夹路径', 'Full path of a folder': '文件夹完整路径',
  'Use this folder': '使用这个文件夹', 'Up one level': '上一级', 'No folders inside.': '里面没有文件夹。',
  'Day': '今天', 'Week': '本周', 'Month': '本月', 'Runs': '运行',
  'Used {count} tools': '用了 {count} 个工具',
  'Used {count} tool': '用了 {count} 个工具',
  ' · thought for {seconds}s': ' · 想了 {seconds} 秒',
  ' — failed': ' — 失败了',
  '{name} {event}': '{name}{event}',
  '{count} images': '{count} 张图片',
  'Waiting for your approval': '等你批准',
  'Allow': '允许',
  'Reject': '拒绝',
  'Answer on the computer.': '在电脑上回答。',
  'This question is no longer open.': '这个问题已经关闭了。',
  'This approval is no longer open.': '这项批准已经关闭了。',
  'Submit': '提交',
  'Stop': '停止',
  'Search the team': '搜索团队',
  'Members': '成员',
  'A secret is needed': '需要一个密钥',
  'Copy': '复制',
  'Select text': '选择文字',
  'Cancel': '取消',
  'Canceled': '已取消',
  'Image': '图片',
  'View it on the computer': '在电脑上查看',
  'Open it on the computer': '在电脑上查看',
  'Questions': '提问',
  'Approvals': '批准',
  'Secret requests': '密钥',
  'Cards': '卡片',
  'Demo team': '演示团队',
}

const systemZh = (): boolean => {
  try { return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') } catch { return false }
}
const isZh = (): boolean => langOverride === 'zh' || (langOverride === 'system' && systemZh())

const fill = (text: string, params?: Record<string, string | number>) =>
  params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))

// The desktop gets a gap between Han characters and Latin letters/digits from CSS
// text-autospace; RN has none, so the composed string gets the space here.
const autospaced = (text: string) =>
  text.replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2').replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2')

let langOverride: 'system' | 'zh' | 'en' = 'system'
export function setLang(lang: 'system' | 'zh' | 'en'): void { langOverride = lang }
export function getLang(): 'system' | 'zh' | 'en' { return langOverride }

export function t(key: string, params?: Record<string, string | number>): string {
  let text = key
  const zh = isZh()
  if (zh) {
    if (MOBILE_SENSE.has(key) && Object.hasOwn(MOBILE_ZH, key)) text = MOBILE_ZH[key]
    else if (Object.hasOwn(ZH, key)) text = ZH[key]
    else if (Object.hasOwn(MOBILE_ZH, key)) text = MOBILE_ZH[key]
  }
  text = fill(text, params)
  return zh ? autospaced(text) : text
}

// Built by hand: Hermes formats dates in the system locale whatever locale is
// asked for, so a phone set to English would show English dates in a Chinese UI.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const pad = (n: number) => String(n).padStart(2, '0')
export const dayLabel = (time: number) => {
  const d = new Date(time)
  return isZh() ? `${d.getMonth() + 1}月${d.getDate()}日` : `${MONTHS[d.getMonth()]} ${d.getDate()}`
}
export const timeLabel = (time: number) => `${dayLabel(time)} ${pad(new Date(time).getHours())}:${pad(new Date(time).getMinutes())}`

// The desktop's message stamps (text.js clockLabel / messageClock), built by hand
// for the same Hermes reason as dayLabel.
const clock = (time: number) => `${new Date(time).getHours()}:${pad(new Date(time).getMinutes())}`
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const daysBefore = (time: number, now: number) => Math.round((midnight(new Date(now)) - midnight(new Date(time))) / 86400000)
const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function clockLabel(time: number, now = Date.now()): string {
  const days = daysBefore(time, now)
  if (days === 0) return t('Today {time}', { time: clock(time) })
  if (days === 1) return t('Yesterday {time}', { time: clock(time) })
  const d = new Date(time)
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : isZh() ? `${d.getFullYear()}年` : `, ${d.getFullYear()}`
  return isZh() ? `${year}${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_ZH[d.getDay()]} ${clock(time)}` : `${WEEK_EN[d.getDay()]}, ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}${year} ${clock(time)}`
}
export const messageClock = (time: number, now = Date.now()) => (daysBefore(time, now) === 0 ? clock(time) : clockLabel(time, now))

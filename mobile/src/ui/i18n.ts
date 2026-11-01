import { DICTIONARY } from '../../../ds-bot/src/client/i18n.js'

// Phone copy shares the desktop dictionary. Mobile-only strings have their own
// Chinese entries here; the English source stays the key, as on the desktop.
const ZH = DICTIONARY.zh as Record<string, string>

const MOBILE_ZH: Record<string, string> = {
  'Asks for the secret {name}': '请求密钥 {name}',
  '{bot} asks for the secret {name}': '{bot} 请求密钥 {name}',
  'Pair with your computer': '与电脑配对',
  'On the computer, open DS Bot, go to Settings → Phone and show a QR code. Then scan it here.': '在电脑上打开 DS Bot，进入设置 → 手机，出示二维码，然后在这里扫描。',
  'Use the camera': '使用相机',
  'No camera? Paste the pairing link.': '没有相机？粘贴配对链接。',
  'The computer did not accept this phone. Show a new QR code on the computer and scan it again.': '电脑没有接受这台手机。在电脑上出示新的二维码，再扫一次。',
  'The computer is not connected to the Server. Check that DS Bot is open and phone access is on.': '电脑没有连上服务器。确认 DS Bot 已打开且手机访问已开启。',
  'Not connected to the computer yet.': '还没有连上电脑。',
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
  'Used {count} tools': '用了 {count} 个工具',
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
  'Dark': '深色',
  'Light': '浅色',
  'Demo team': '演示团队',
}

const isZh = (): boolean => {
  try { return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') } catch { return false }
}

const fill = (text: string, params?: Record<string, string | number>) =>
  params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])))

// The desktop gets a gap between Han characters and Latin letters/digits from CSS
// text-autospace; RN has none, so the composed string gets the space here.
const autospaced = (text: string) =>
  text.replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2').replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2')

export function t(key: string, params?: Record<string, string | number>): string {
  let text = key
  const zh = isZh()
  if (zh) {
    if (Object.hasOwn(ZH, key)) text = ZH[key]
    else if (Object.hasOwn(MOBILE_ZH, key)) text = MOBILE_ZH[key]
  }
  text = fill(text, params)
  return zh ? autospaced(text) : text
}

export const dateLocale = () => (isZh() ? 'zh-CN' : 'en-US')

// The IM platforms DS Bot can connect to. The settings page draws the add form from
// `fields`; `secret` fields are kept as DS Bot secrets and never leave the host.
// `buttons`: the platform can show card buttons (others answer with numbers).
// `groups`: the IM bot can be @-mentioned in platform group chats.
// `login: 'qr'`: the connection starts by scanning a code instead of filling fields.
export const IM_PLATFORMS = [
  {
    id: 'telegram',
    name: 'Telegram',
    fields: [{ key: 'token', label: 'Bot token', secret: true }],
    buttons: true,
    groups: true,
    help: 'https://t.me/BotFather',
  },
  {
    id: 'weixin',
    name: 'WeChat',
    fields: [],
    buttons: false,
    groups: false,
    login: 'qr',
  },
  {
    id: 'feishu',
    name: 'Feishu / Lark',
    fields: [
      { key: 'domain', label: 'Edition', options: [['feishu', 'Feishu'], ['lark', 'Lark']] },
      { key: 'appId', label: 'App ID' },
      { key: 'appSecret', label: 'App Secret', secret: true },
    ],
    buttons: true,
    groups: true,
  },
  {
    id: 'dingtalk',
    name: 'DingTalk',
    fields: [
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client Secret', secret: true },
    ],
    buttons: false,
    groups: true,
  },
  {
    id: 'wecom',
    name: 'WeCom',
    fields: [
      { key: 'botId', label: 'Bot ID' },
      { key: 'secret', label: 'Secret', secret: true },
    ],
    buttons: true,
    groups: true,
  },
  {
    id: 'qq',
    name: 'QQ',
    fields: [
      { key: 'appId', label: 'App ID' },
      { key: 'appSecret', label: 'App Secret', secret: true },
    ],
    buttons: false,
    groups: true,
  },
  {
    id: 'discord',
    name: 'Discord',
    fields: [{ key: 'token', label: 'Bot token', secret: true }],
    buttons: true,
    groups: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    fields: [
      { key: 'appToken', label: 'App-Level Token', secret: true, hint: 'xapp-' },
      { key: 'botToken', label: 'Bot Token', secret: true, hint: 'xoxb-' },
    ],
    buttons: true,
    groups: true,
  },
]

export const imPlatform = id => IM_PLATFORMS.find(platform => platform.id === id)

// The channel a user message came in over. IM messages carry im:<platform>:<uuid> as
// their requestId; a local API token's carry api:<keyId>:<runId>. Both name a channel
// external to the owner's own composer, and a group ledger line keeps the tag in `via`
// so what is drawn, forwarded, or reviewed can tell the owner's direct posts apart.
// `via` reads 'api' for the token channel, which the client's ViaTag already draws.
export const viaOf = (source) => {
  const rpcId = typeof source?.rpcId === 'string' ? source.rpcId : ''
  if (rpcId.startsWith('im:')) return rpcId.split(':')[1]
  if (rpcId.startsWith('api:')) return 'api'
  return undefined
}

// True only when `via` names a real IM platform — not 'api' nor any other external
// channel. Only those may claim or keep a group's IM reply origin; anything else
// external drops it, so private group replies never leak out of the team.
export const viaIsIm = via => typeof via === 'string' && imPlatform(via) !== undefined

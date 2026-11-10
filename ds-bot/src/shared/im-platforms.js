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

// The platform a user message came in over: IM messages carry im:<platform>:<uuid> as their requestId.
export const viaOf = source => (typeof source?.rpcId === 'string' && source.rpcId.startsWith('im:') ? source.rpcId.split(':')[1] : undefined)

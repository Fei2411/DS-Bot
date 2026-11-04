import dingtalk from './dingtalk.js'
import discord from './discord.js'
import qq from './qq.js'
import slack from './slack.js'
import telegram from './telegram.js'
import wecom from './wecom.js'

// Every platform with an adapter. The rest of IM_PLATFORMS still show in settings as
// coming soon — a connection can only be added for a platform listed here.
export const adapters = { telegram, discord, slack, qq, dingtalk, wecom }

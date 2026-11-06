// Mailbox presets by address domain. "Other" takes hosts and ports from the user.
export const PRESETS = [
  { id: 'qq', name: 'QQ Mail', domains: ['qq.com', 'foxmail.com'], imap: { host: 'imap.qq.com', port: 993, secure: true }, smtp: { host: 'smtp.qq.com', port: 465, secure: true } },
  { id: '163', name: '163 Mail', domains: ['163.com'], imap: { host: 'imap.163.com', port: 993, secure: true }, smtp: { host: 'smtp.163.com', port: 465, secure: true } },
  { id: '126', name: '126 Mail', domains: ['126.com'], imap: { host: 'imap.126.com', port: 993, secure: true }, smtp: { host: 'smtp.126.com', port: 465, secure: true } },
  { id: 'gmail', name: 'Gmail', domains: ['gmail.com', 'googlemail.com'], imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
  { id: 'icloud', name: 'iCloud Mail', domains: ['icloud.com', 'me.com', 'mac.com'], imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, starttls: true } },
]

export const presetOf = (address) => {
  const domain = String(address ?? '').split('@')[1]?.toLowerCase() ?? ''
  return PRESETS.find(preset => preset.domains.includes(domain))
}

// 163 and 126 answer "Unsafe Login" without the IMAP ID command (RFC 2971);
// sending it for every server that supports ID is harmless elsewhere.
export const IMAP_ID = { name: 'ds-bot', version: '0.1', vendor: 'DS Bot' }

export const mailSecretName = (address, suffix) => {
  const safe = String(address ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const name = `MAIL_${safe}_${suffix}`
  return name.length <= 64 ? name : `MAIL_${safe.slice(0, 40)}_${suffix}`
}

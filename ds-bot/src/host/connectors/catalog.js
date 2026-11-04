// The connector catalog: services that publish a remote MCP server (or need no
// server, like the mailbox). Each entry is plain data: name, category, address,
// and how it signs in. `about` is our own one-line text.
//
// auth kinds:
//   none  — the server needs no sign-in.
//   oauth — MCP OAuth sign-in (browser PKCE); `client` names a known public
//           client (GitHub device flow), `token: true` also offers pasting a token.
//   key   — an API key in a header (`header`, optional `prefix`) or a query
//           parameter (`query`); `keyUrl` is where the user gets one.
// `headers` are extra static headers; `whoami` reads the account name after
// sign-in for the row.

// The OAuth client id DS Bot is registered as on GitHub. Filled in at release;
// overridable for development. Empty keeps the pasted-token form only.
export const GITHUB_CLIENT_ID = process.env.DS_BOT_GITHUB_OAUTH_CLIENT_ID ?? 'Ov23liin4waZGLSJJgn5'

const oauth = url => ({ remote: { url }, auth: { kind: 'oauth' } })

export const CATALOG = [
  {
    id: 'github', name: 'GitHub', category: 'dev',
    about: 'Repositories, issues, and pull requests',
    remote: { url: 'https://api.githubcopilot.com/mcp/' },
    headers: { 'X-MCP-Toolsets': 'context,repos,issues,pull_requests' },
    auth: { kind: 'oauth', scopes: ['repo', 'read:org'], client: { id: GITHUB_CLIENT_ID, deviceFlow: true }, token: true },
    whoami: { url: 'https://api.github.com/user', field: 'login' },
  },
  { id: 'notion', name: 'Notion', category: 'docs', about: 'Pages, databases, and wiki content', ...oauth('https://mcp.notion.com/mcp') },
  { id: 'linear', name: 'Linear', category: 'work', about: 'Issues, projects, and cycles', ...oauth('https://mcp.linear.app/mcp') },
  { id: 'atlassian', name: 'Atlassian', category: 'work', about: 'Jira issues and Confluence pages', ...oauth('https://mcp.atlassian.com/v1/mcp') },
  { id: 'sentry', name: 'Sentry', category: 'dev', about: 'Errors, traces, and releases', ...oauth('https://mcp.sentry.dev/mcp') },
  { id: 'stripe', name: 'Stripe', category: 'commerce', about: 'Payments, invoices, and customers', ...oauth('https://mcp.stripe.com') },
  { id: 'paypal', name: 'PayPal', category: 'commerce', about: 'Orders, payments, and invoices', ...oauth('https://mcp.paypal.com/mcp') },
  { id: 'square', name: 'Square', category: 'commerce', about: 'Payments, orders, and catalog', ...oauth('https://mcp.squareup.com/mcp') },
  { id: 'cloudflare', name: 'Cloudflare', category: 'dev', about: 'Workers, DNS, and account resources', ...oauth('https://bindings.mcp.cloudflare.com/mcp') },
  { id: 'vercel', name: 'Vercel', category: 'dev', about: 'Projects, deployments, and logs', ...oauth('https://mcp.vercel.com') },
  { id: 'supabase', name: 'Supabase', category: 'data', about: 'Databases, tables, and project settings', ...oauth('https://mcp.supabase.com/mcp') },
  { id: 'neon', name: 'Neon', category: 'data', about: 'Postgres databases and branches', ...oauth('https://mcp.neon.tech/mcp') },
  { id: 'figma', name: 'Figma', category: 'design', about: 'Design files, components, and comments', ...oauth('https://mcp.figma.com/mcp') },
  { id: 'canva', name: 'Canva', category: 'design', about: 'Designs, folders, and exports', ...oauth('https://mcp.canva.com/mcp') },
  { id: 'intercom', name: 'Intercom', category: 'work', about: 'Conversations, contacts, and articles', ...oauth('https://mcp.intercom.com/mcp') },
  { id: 'monday', name: 'monday.com', category: 'work', about: 'Boards, items, and workflows', ...oauth('https://mcp.monday.com/mcp') },
  { id: 'webflow', name: 'Webflow', category: 'design', about: 'Sites, pages, and CMS content', ...oauth('https://mcp.webflow.com/mcp') },
  { id: 'wix', name: 'Wix', category: 'design', about: 'Sites, pages, and site content', ...oauth('https://mcp.wix.com/mcp') },
  { id: 'netlify', name: 'Netlify', category: 'dev', about: 'Sites, deploys, and forms', ...oauth('https://netlify-mcp.netlify.app/mcp') },
  { id: 'airtable', name: 'Airtable', category: 'data', about: 'Bases, tables, and records', ...oauth('https://mcp.airtable.com/mcp') },
  { id: 'dropbox', name: 'Dropbox', category: 'docs', about: 'Files and folders', ...oauth('https://mcp.dropbox.com/mcp') },
  { id: 'zapier', name: 'Zapier', category: 'work', about: 'Zaps and app actions', ...oauth('https://mcp.zapier.com/api/mcp/mcp') },
  { id: 'clickup', name: 'ClickUp', category: 'work', about: 'Tasks, lists, and docs', ...oauth('https://mcp.clickup.com/mcp') },
  { id: 'todoist', name: 'Todoist', category: 'work', about: 'Tasks and projects', ...oauth('https://ai.todoist.net/mcp') },
  { id: 'miro', name: 'Miro', category: 'design', about: 'Boards and whiteboard items', ...oauth('https://mcp.miro.com/') },
  { id: 'attio', name: 'Attio', category: 'work', about: 'CRM records, lists, and notes', ...oauth('https://mcp.attio.com/mcp') },
  { id: 'postman', name: 'Postman', category: 'dev', about: 'Collections, requests, and workspaces', ...oauth('https://mcp.postman.com/mcp') },
  { id: 'asana', name: 'Asana', category: 'work', about: 'Tasks, projects, and workspaces', ...oauth('https://mcp.asana.com/v2/mcp') },
  { id: 'box', name: 'Box', category: 'docs', about: 'Files, folders, and metadata', ...oauth('https://mcp.box.com') },
  { id: 'hubspot', name: 'HubSpot', category: 'work', about: 'Contacts, deals, and tickets', ...oauth('https://mcp.hubspot.com/') },
  { id: 'slack', name: 'Slack', category: 'work', about: 'Channels and messages', ...oauth('https://mcp.slack.com/mcp') },
  { id: 'huggingface', name: 'Hugging Face', category: 'data', about: 'Models, datasets, and Spaces', remote: { url: 'https://huggingface.co/mcp' }, auth: { kind: 'none' } },
  { id: 'exa', name: 'Exa', category: 'search', about: 'Web search for agents', remote: { url: 'https://mcp.exa.ai/mcp' }, auth: { kind: 'none' } },
  { id: 'deepwiki', name: 'DeepWiki', category: 'docs', about: 'Documentation for public code repositories', remote: { url: 'https://mcp.deepwiki.com/mcp' }, auth: { kind: 'none' } },
  { id: 'context7', name: 'Context7', category: 'docs', about: 'Library documentation and code examples', remote: { url: 'https://mcp.context7.com/mcp' }, auth: { kind: 'none' } },
  { id: 'mslearn', name: 'Microsoft Learn', category: 'docs', about: 'Microsoft product documentation', remote: { url: 'https://learn.microsoft.com/api/mcp' }, auth: { kind: 'none' } },
  { id: 'cloudflare-docs', name: 'Cloudflare Docs', category: 'docs', about: 'Cloudflare product documentation', remote: { url: 'https://docs.mcp.cloudflare.com/mcp' }, auth: { kind: 'none' } },
  {
    id: 'amap', name: 'Amap', category: 'search', about: 'Maps, places, and routes in China',
    remote: { url: 'https://mcp.amap.com/mcp' },
    auth: { kind: 'key', query: 'key', keyUrl: 'https://lbs.amap.com/api/mcp-server/create' },
  },
  { id: 'mail', name: 'Mailbox', category: 'mail', about: 'Read and send email over IMAP and SMTP', auth: { kind: 'none' } },
]

export const CATEGORIES = ['dev', 'docs', 'work', 'design', 'data', 'commerce', 'search', 'mail']

export const entryOf = id => CATALOG.find(entry => entry.id === id)

// The secret names a connector's credentials live under. GitHub keeps its
// original GITHUB_TOKEN name; other ids become CONNECTOR_<ID>_*.
export const secretPrefix = (id) => {
  const safe = id.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  return `CONNECTOR_${safe}`
}
export const tokenSecretOf = id => id === 'github' ? 'GITHUB_TOKEN' : `${secretPrefix(id)}_TOKEN`
export const refreshSecretOf = id => `${secretPrefix(id)}_REFRESH`
export const clientSecretOf = id => `${secretPrefix(id)}_CLIENT_SECRET`
export const keySecretOf = id => `${secretPrefix(id)}_KEY`
export const envSecretOf = (id, name) => `${secretPrefix(id)}_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`.slice(0, 64)

// Custom connector ids come from the name the user typed; never a catalog id.
export function customId(name, taken) {
  const base = String(name ?? '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 'c-$1').slice(0, 28) || 'custom'
  let id = entryOf(base) === undefined && base !== 'github' && base !== 'mail' ? base : `${base}-x`
  while (taken.has(id) || entryOf(id) !== undefined || id.length > 32) id = `${id.slice(0, 28)}-${Math.random().toString(36).slice(2, 6)}`
  return id
}

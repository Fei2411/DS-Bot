// Plugins: the engine's plugin manager as a page in Settings. It lists the profile's
// plugin packages (the bundles the installation ships switched off and the official
// catalog included); a switch saves the profile patch through the manager, which
// applies it where the engine can and reports a restart where it cannot. A host
// without a plugin manager shows the page as unavailable instead of guessing.
// The package this plugin runs as; switching it off from its own page would stop it.
const OWN_BUNDLE = 'ds-bot'

export function install(rt) {
  const { ctx } = rt

  // The manager is looked up on first use: it may be mounted after this plugin.
  let manager
  const pluginManager = () => {
    if (manager === undefined) {
      try { manager = ctx.get?.('pluginManager') ?? null } catch { manager = null }
    }
    return manager ?? undefined
  }

  // The client's language, from the DSH locale the last window reported: a locale tag
  // or the language name the host passes on. Plugin metadata keys are locale ids.
  const language = () => {
    const active = String(rt.uiLanguage?.() ?? 'en').toLowerCase()
    if (active.startsWith('zh') || active.includes('chinese')) return 'zh'
    if (active.startsWith('ja') || active.startsWith('japanese')) return 'ja'
    if (active.startsWith('ko') || active.startsWith('korean')) return 'ko'
    if (active.startsWith('es') || active.startsWith('spanish')) return 'es'
    if (active.startsWith('fr') || active.startsWith('french')) return 'fr'
    if (active.startsWith('de') || active.startsWith('german')) return 'de'
    return 'en'
  }
  const localized = (value, code) => (typeof value === 'string' ? value
    : value === undefined || value === null || typeof value !== 'object' ? undefined
      : value[code] ?? value.en)

  const bundleRow = (bundle, code) => ({
    name: String(bundle.name),
    title: localized(bundle.meta?.title, code) ?? String(bundle.name),
    description: localized(bundle.meta?.description, code) ?? bundle.description ?? null,
    enabled: bundle.enabled === true,
    installed: bundle.installed === true,
    official: bundle.official === true,
    version: bundle.version ?? null,
    availability: bundle.availability ?? null,
    // A shipped optional bundle can be switched without installing; a catalog entry
    // that is missing needs the install first. DS Bot's own bundle is never switched
    // off from its own page: that would stop the team mid-session.
    selectable: bundle.name !== OWN_BUNDLE && bundle.error === undefined && bundle.readOnlyReason === undefined
      && (bundle.installed === true || bundle.availability !== 'missing'),
    installable: bundle.installTarget !== undefined && bundle.installed !== true && bundle.availability === 'missing',
    readOnlyReason: bundle.readOnlyReason ?? (bundle.name === OWN_BUNDLE ? 'management-required' : null),
    problem: bundle.error?.code ?? null,
  })

  async function pluginsView() {
    const found = pluginManager()
    if (found === undefined) return { available: false, bundles: [] }
    const code = language()
    const bundles = await Promise.resolve().then(() => found.listBundles()).catch(() => [])
    return {
      available: true,
      // Plugin packages are the user-facing unit: profile dependencies, the bundles the
      // installation ships switched off, and the official on-demand catalog.
      bundles: (bundles ?? [])
        .filter(bundle => bundle.enabled === true || bundle.installed === true || bundle.official === true)
        .filter(bundle => bundle.official !== true || bundle.listedByDefault !== false)
        .map(bundle => bundleRow(bundle, code)),
    }
  }

  const requireManager = () => {
    const found = pluginManager()
    if (found === undefined) throw new Error('This host has no plugin manager, so plugins cannot be changed here')
    return found
  }

  async function pluginsEndpoint(endpoint, body) {
    switch (endpoint) {
      case 'plugins':
        return pluginsView()
      case 'plugin-entry':
        await requireManager().setPluginEnabled(String(body.id ?? ''), body.enabled === true)
        return pluginsView()
      case 'plugin-bundle':
        await requireManager().setBundleEnabled(String(body.name ?? ''), body.enabled === true)
        return pluginsView()
      case 'plugin-install': {
        const found = requireManager()
        const wanted = String(body.name ?? '')
        const bundle = (await found.listBundles()).find(row => row.name === wanted)
        if (bundle === undefined) throw new Error(`No plugin named ${wanted} is offered here`)
        if (bundle.installTarget === undefined) throw new Error(`${wanted} cannot be installed from this host`)
        await found.installBundle(bundle.installTarget.spec)
        return pluginsView()
      }
      default:
        throw new Error(`Unknown endpoint ${endpoint}`)
    }
  }

  Object.assign(rt, { pluginsView, pluginsEndpoint })
}

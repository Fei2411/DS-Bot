import { Children, Fragment, useEffect, useState } from 'react'
import { useIsFocused } from '@react-navigation/native'
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { confirmDanger, Sheet, SheetHeader, useInSheet } from '../nav/sheet.tsx'
import * as Clipboard from 'expo-clipboard'
import { useTeam } from '../team/context.tsx'
import { t } from '../ui/i18n.ts'
import { ChevronLeftIcon, ChevronRightIcon } from '../ui/icons.tsx'
import { radius, shadow, type as typeScale, useTheme } from '../ui/tokens.ts'

function Screen({ children }: { children: React.ReactNode }) {
  const { p } = useTheme()
  const insets = useSafeAreaInsets()
  const inSheet = useInSheet()
  return <View style={{ flex: 1, backgroundColor: p.main, paddingTop: inSheet ? 0 : insets.top }}>{children}</View>
}
function Back({ title, onBack }: { title: string; onBack: () => void }) {
  const { p } = useTheme()
  return (
    <View style={styles.backRow}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={onBack} hitSlop={8} style={styles.backBtn}><ChevronLeftIcon size={20} color={p.ink2} /></Pressable>
      <Text style={[typeScale.rowName, { color: p.ink, flex: 1, textAlign: 'center' }]}>{title}</Text>
      <View style={styles.backBtn} />
    </View>
  )
}
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const { p } = useTheme()
  const items = Children.toArray(children).filter(Boolean)
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={[typeScale.caption, { color: p.ink3, paddingHorizontal: 18, marginBottom: 6, fontSize: 11 }]}>{label}</Text>
      <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
        {items.map((child, i) => (
          <Fragment key={i}>
            {i > 0 ? <View style={[styles.divider, { backgroundColor: p.line }]} /> : null}
            {child}
          </Fragment>
        ))}
      </View>
    </View>
  )
}
function Row({ label, hint, value, onPress, end }: { label: string; hint?: string; value?: string; onPress?: () => void; end?: React.ReactNode }) {
  const { p } = useTheme()
  const body = (
    <View style={styles.row}>
      <View style={{ flex: 1, minWidth: 96 }}>
        <Text style={[typeScale.settingsRow, { color: p.ink }]}>{label}</Text>
        {hint ? <Text style={[typeScale.small, { color: p.ink3, marginTop: 2 }]}>{hint}</Text> : null}
      </View>
      {value !== undefined ? <Text style={[typeScale.settingsRow, { color: p.ink2, flexShrink: 1, maxWidth: '54%', textAlign: 'right' }]} numberOfLines={1}>{value}</Text> : null}
      {end}
      {onPress ? <View style={{ flexShrink: 0 }}><ChevronRightIcon size={16} color={p.ink3} /></View> : null}
    </View>
  )
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed ? { backgroundColor: p.hover } : null}>{body}</Pressable> : body
}

// ------------------------------------------------------------ Providers

// ------------------------------------------------------------ Providers

interface ProviderItem { id: string; name: string; key?: { configured?: boolean; writable?: boolean }; models: { name?: string; id?: string }[]; removable?: boolean; error?: string }
interface ProvidersView { available?: boolean; providers: ProviderItem[]; addable?: { id: string; name: string }[]; protocols?: string[] }

const keyLabel = (key?: { configured?: boolean; writable?: boolean }) =>
  key?.configured !== true ? t('Needs an API key') : key.writable === true ? t('Key set') : t('Key set outside DS Bot')

// A field whose label stays above it once it has a value; the placeholder alone
// would leave a filled form with no way to tell its fields apart.
export function LabeledInput({ label, ...props }: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { p } = useTheme()
  return (
    <View>
      {props.value ? <Text style={[typeScale.small, { color: p.ink3, marginBottom: 2, marginLeft: 2 }]}>{label}</Text> : null}
      <TextInput placeholder={label} {...props} />
    </View>
  )
}

export function Providers({ navigation }: any) {
  const { p } = useTheme()
  const { call } = useTeam()
  const [view, setView] = useState<ProvidersView | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [mode, setMode] = useState<'known' | 'custom'>('known')
  const [key, setKey] = useState('')
  const [draft, setDraft] = useState({ provider: '', name: '', baseURL: '', api: '', key: '', typed: '' })
  const [found, setFound] = useState<{ id: string; name?: string }[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [confirm, setConfirm] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const load = () => void call('providers').then(v => setView(v as ProvidersView)).catch(() => {})
  useState(() => { load(); return null })
  const apply = (task: Promise<unknown>, after?: () => void) => task.then(() => { setError(null); after?.() }, (f: { code?: string; message?: string }) => { if (f?.code !== 'unlock/canceled') setError(f?.message ?? String(f)) })
  const saveKey = (id: string) => { if (key === '') return; const next = key; setKey(''); void apply(call('provider-key', { provider: id, value: next }), () => { setSaved(id); load() }) }
  const typed = draft.typed.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  const models = [...(found ?? []).filter(m => picked.includes(m.id)), ...typed.filter(id => !picked.includes(id)).map(id => ({ id }))]
  const ready = draft.provider.trim() !== '' && draft.baseURL.trim() !== '' && models.length > 0
  const discover = () => { if (draft.baseURL.trim() === '') return; void apply(call('provider-models', { baseURL: draft.baseURL, api: draft.api || (view?.protocols ?? [])[0], key: draft.key }), () => {}) .then(() => {}) }
  const addKnown = () => { if (draft.provider === '') return; void apply(call('provider-add', { provider: draft.provider, key: draft.key }), () => { setAdding(false); setDraft(d => ({ ...d, provider: '', key: '' })); load() }) }
  const addCustom = () => { if (!ready) return; void apply(call('provider-add', { custom: true, provider: draft.provider.trim(), name: draft.name, baseURL: draft.baseURL, api: draft.api || (view?.protocols ?? [])[0], key: draft.key, models }), () => { setAdding(false); setFound(null); setPicked([]); setDraft({ provider: '', name: '', baseURL: '', api: '', key: '', typed: '' }); load() }) }
  return (
    <Screen>
      <Back title={t('Model providers')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {view?.available === false ? <Text style={[typeScale.small, { color: p.ink3, margin: 18 }]}>{t('This DSH cannot set up model providers.')}</Text> : null}
        {error ? <Text style={[typeScale.small, { color: p.danger, margin: 18 }]}>{error}</Text> : null}
        <Section label={t('Model providers · {count}', { count: view?.providers?.length ?? 0 })}>
          {(view?.providers ?? []).map(provider => (
            <View key={provider.id}>
              <Pressable accessibilityRole="button" onPress={() => setOpen(open === provider.id ? null : provider.id)} style={styles.row}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[typeScale.settingsRow, { color: p.ink }]}>{provider.name}</Text>
                  <Text style={[typeScale.small, { color: provider.key?.configured !== true ? p.danger : p.ink3, marginTop: 2 }]}>{keyLabel(provider.key)}</Text>
                  {provider.error ? <Text style={[typeScale.small, { color: p.danger, marginTop: 2 }]}>{provider.error}</Text> : null}
                </View>
                <Text style={[typeScale.settingsRow, { color: p.ink2, flexShrink: 0 }]}>{provider.models.length === 0 ? t('No models') : t('{count} models', { count: provider.models.length })}</Text>
                <View style={{ flexShrink: 0 }}><ChevronRightIcon size={16} color={p.ink3} /></View>
              </Pressable>
              {open === provider.id ? (
                <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line }}>
                  {provider.key?.writable === true ? (
                    <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
                      <Text style={[typeScale.small, { color: p.ink3, marginBottom: 6 }]}>{provider.key.configured ? t('Replace the API key') : t('API key')}</Text>
                      <TextInput style={[typeScale.settingsRow, { color: p.ink, borderWidth: 1, borderColor: p.line, borderRadius: 10, paddingHorizontal: 12, minHeight: 40, paddingVertical: 6 }]} value={key} onChangeText={setKey} placeholder={t('{provider} API key', { provider: provider.name })} placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false} secureTextEntry />
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                        {provider.key.configured ? (
                          <Pressable accessibilityRole="button" onPress={() => void apply(call('provider-key', { provider: provider.id, value: null }), load)} style={[styles.smallBtn, { backgroundColor: p.hover }]}>
                            <Text style={{ color: p.danger, fontSize: 14 }}>{t('Remove key')}</Text>
                          </Pressable>
                        ) : null}
                        <Pressable accessibilityRole="button" disabled={key === ''} onPress={() => saveKey(provider.id)} style={[styles.smallBtn, { backgroundColor: p.accent, opacity: key === '' ? 0.4 : 1 }]}>
                          <Text style={{ color: p.accentInk, fontSize: 14, fontWeight: '600' }}>{t('Save')}</Text>
                        </Pressable>
                      </View>
                      {saved === provider.id ? <Text style={[typeScale.small, { color: p.accent, marginTop: 6 }]}>{t('Saved.')}</Text> : null}
                    </View>
                  ) : provider.key !== undefined ? <Text style={[typeScale.small, { color: p.ink3, paddingHorizontal: 16, paddingVertical: 8 }]}>{t('This key comes from outside DS Bot, such as an environment variable, and cannot be changed here.')}</Text> : null}
                  {provider.models.length > 0 ? (
                    <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
                      <Text style={[typeScale.small, { color: p.ink3, marginBottom: 4 }]}>{t('Models')}</Text>
                      <Text style={[typeScale.small, { color: p.ink2 }]}>{provider.models.slice(0, 4).map(m => m.name ?? m.id).join(' · ')}{provider.models.length > 4 ? t(' and {count} more', { count: provider.models.length - 4 }) : ''}</Text>
                    </View>
                  ) : null}
                  {provider.removable === true ? (
                    confirm === provider.id ? (
                      <View style={[styles.row, { justifyContent: 'flex-end', gap: 12 }]}>
                        <Text style={[typeScale.small, { color: p.ink2, flex: 1 }]}>{t('Remove {name}? Bots on its models need another model.', { name: provider.name })}</Text>
                        <Pressable onPress={() => setConfirm(null)}><Text style={{ color: p.ink2, fontSize: 14 }}>{t('Keep')}</Text></Pressable>
                        <Pressable onPress={() => { setConfirm(null); void apply(call('provider-remove', { provider: provider.id }), load) }}><Text style={{ color: p.danger, fontSize: 14, fontWeight: '600' }}>{t('Remove')}</Text></Pressable>
                      </View>
                    ) : <Row label={t('Remove provider')} onPress={() => setConfirm(provider.id)} />
                  ) : null}
                </View>
              ) : null}
            </View>
          ))}
        </Section>
        {adding ? (
          <Section label={t('Add a provider')}>
            <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
              <View style={[styles.segRow, { borderColor: p.line }]}>
                {[['known', 'Known provider'], ['custom', 'Custom API']].map(([id, label]) => (
                  <Pressable key={id} onPress={() => setMode(id as 'known' | 'custom')} style={[styles.seg, mode === id ? { backgroundColor: p.accent } : null]}>
                    <Text style={[typeScale.caption, { color: mode === id ? p.accentInk : p.ink2, fontWeight: '500' }]}>{t(label)}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            {mode === 'known' ? (
              <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                  {(view?.addable ?? []).map(option => (
                    <Pressable key={option.id} onPress={() => setDraft(d => ({ ...d, provider: option.id }))} style={[styles.smallBtn, { backgroundColor: draft.provider === option.id ? p.accent : p.hover }]}>
                      <Text style={{ color: draft.provider === option.id ? p.accentInk : p.ink2, fontSize: 14 }}>{option.name}</Text>
                    </Pressable>
                  ))}
                </View>
                <LabeledInput label={t('API key')} style={[typeScale.settingsRow, { color: p.ink, borderWidth: 1, borderColor: p.line, borderRadius: 10, paddingHorizontal: 12, height: 40, marginBottom: 8 }]} value={draft.key} onChangeText={v => setDraft(d => ({ ...d, key: v }))} placeholder={t('API key')} placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false} secureTextEntry />
                <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end' }}>
                  <Pressable onPress={() => setAdding(false)}><Text style={{ color: p.ink2 }}>{t('Cancel')}</Text></Pressable>
                  <Pressable disabled={draft.provider === ''} onPress={addKnown}><Text style={{ color: draft.provider === '' ? p.ink3 : p.accent, fontWeight: '600' }}>{t('Add')}</Text></Pressable>
                </View>
              </View>
            ) : (
              <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                <LabeledInput label={t('Provider name')} style={[typeScale.settingsRow, { color: p.ink, borderWidth: 1, borderColor: p.line, borderRadius: 10, paddingHorizontal: 12, height: 40, marginBottom: 6 }]} value={draft.name} onChangeText={v => setDraft(d => ({ ...d, name: v }))} placeholder={t('Provider name')} placeholderTextColor={p.ink3} autoCapitalize="none" />
                <LabeledInput label={t('API base URL')} style={[typeScale.settingsRow, { color: p.ink, borderWidth: 1, borderColor: p.line, borderRadius: 10, paddingHorizontal: 12, height: 40, marginBottom: 6 }]} value={draft.baseURL} onChangeText={v => setDraft(d => ({ ...d, baseURL: v }))} placeholder={t('API base URL')} placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false} />
                <LabeledInput label={t('Provider id')} style={[typeScale.settingsRow, { color: p.ink, borderWidth: 1, borderColor: p.line, borderRadius: 10, paddingHorizontal: 12, height: 40, marginBottom: 6 }]} value={draft.provider} onChangeText={v => setDraft(d => ({ ...d, provider: v }))} placeholder={t('Provider id')} placeholderTextColor={p.ink3} autoCapitalize="none" />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <TextInput style={[typeScale.settingsRow, { color: p.ink, flex: 1, minWidth: 160, borderWidth: 1, borderColor: p.line, borderRadius: 10, paddingHorizontal: 12, minHeight: 40, paddingVertical: 6 }]} value={draft.key} onChangeText={v => setDraft(d => ({ ...d, key: v }))} placeholder={t('API key')} placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false} secureTextEntry />
                  <Pressable accessibilityRole="button" disabled={draft.baseURL.trim() === ''} onPress={discover} style={[styles.smallBtn, { backgroundColor: p.hover, opacity: draft.baseURL.trim() === '' ? 0.4 : 1 }]}>
                    <Text style={{ color: p.ink, fontSize: 14 }}>{t('Find models')}</Text>
                  </Pressable>
                </View>
                {found !== null ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
                    {found.map(model => (
                      <Pressable key={model.id} onPress={() => setPicked(list => list.includes(model.id) ? list.filter(i => i !== model.id) : [...list, model.id])}
                        style={[styles.smallBtn, { backgroundColor: picked.includes(model.id) ? p.accent : p.hover }]}>
                        <Text style={{ color: picked.includes(model.id) ? p.accentInk : p.ink2, fontSize: 14 }}>{model.name ?? model.id}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                <LabeledInput label={t('Or type model ids, comma separated')} style={[typeScale.settingsRow, { color: p.ink, borderWidth: 1, borderColor: p.line, borderRadius: 10, paddingHorizontal: 12, height: 40, marginBottom: 8 }]} value={draft.typed} onChangeText={v => setDraft(d => ({ ...d, typed: v }))} placeholder={t('Or type model ids, comma separated')} placeholderTextColor={p.ink3} autoCapitalize="none" />
                <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end' }}>
                  <Pressable onPress={() => setAdding(false)}><Text style={{ color: p.ink2 }}>{t('Cancel')}</Text></Pressable>
                  <Pressable disabled={!ready} onPress={addCustom}><Text style={{ color: !ready ? p.ink3 : p.accent, fontWeight: '600' }}>{t('Add')}</Text></Pressable>
                </View>
              </View>
            )}
          </Section>
        ) : (
          <View style={{ paddingHorizontal: 18, marginTop: 14 }}>
            <Pressable accessibilityRole="button" onPress={() => setAdding(true)} style={({ pressed }) => [styles.cta, { backgroundColor: p.hover, opacity: pressed ? 0.85 : 1 }]}>
              <Text style={[typeScale.settingsRow, { color: p.ink }]}>{t('Add a provider')}</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </Screen>
  )
}

// ------------------------------------------------------------ Connectors / Capabilities / Usage / Location / Updates / About

const CONNECTOR_ABOUT: Record<string, string> = { github: 'Repositories, issues, and pull requests' }
const TOKEN_URLS: Record<string, string> = { github: 'https://github.com/settings/personal-access-tokens/new' }

const connectorStatus = (item: { id: string; name: string; state?: string; account?: string; error?: string }) => {
  if (item.state === 'connecting') return t('Connecting…')
  if (item.state === 'error') return t('Could not connect: {error}', { error: item.error ?? '' })
  if (item.state === 'ready') return item.account ? t('Connected as {account}', { account: item.account }) : t('Connected')
  return CONNECTOR_ABOUT[item.id] !== undefined ? t(CONNECTOR_ABOUT[item.id]) : ''
}

export function Connectors({ navigation }: any) {
  const { p } = useTheme()
  const { team, call } = useTeam()
  const [form, setForm] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const connectors = (team as { connectors?: { id: string; name: string; state?: string; account?: string; error?: string }[] } | null)?.connectors ?? []
  const run = (id: string, task: Promise<unknown>, after?: () => void) => {
    setBusy(id)
    return task.then(() => { setError(null); after?.() }, (f: { code?: string; message?: string }) => { if (f?.code !== 'unlock/canceled') setError(f?.message ?? String(f)) }).finally(() => setBusy(null))
  }
  return (
    <Screen><Back title={t('Connectors')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {error ? <Text style={[typeScale.small, { color: p.danger, margin: 18 }]}>{error}</Text> : null}
        <Section label={t('Connectors')}>
          {connectors.map(item => {
            const on = item.state !== 'off'
            const connecting = form === item.id
            return (
              <View key={item.id}>
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={[typeScale.settingsRow, { color: p.ink }]}>{item.name}</Text>
                    <Text style={[typeScale.small, { color: item.state === 'error' ? p.danger : p.ink3, marginTop: 2 }]}>{connectorStatus(item)}</Text>
                  </View>
                  {item.state === 'error' ? <Pressable onPress={() => void run(item.id, call('connector-retry', { id: item.id }))}><Text style={{ color: p.accent }}>{t('Try again')}</Text></Pressable> : null}
                  {on ? <Pressable onPress={() => void run(item.id, call('connector-disconnect', { id: item.id }))}><Text style={{ color: p.ink2 }}>{t('Disconnect')}</Text></Pressable>
                    : connecting ? null : <Pressable onPress={() => setForm(item.id)}><Text style={{ color: p.accent }}>{t('Connect')}</Text></Pressable>}
                </View>
                {!on && connecting ? (
                  <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.line, paddingHorizontal: 16, paddingVertical: 10, gap: 8 }}>
                    <LabeledInput label={t('{name} token', { name: item.name })} style={[typeScale.settingsRow, { color: p.ink, borderWidth: 1, borderColor: p.line, borderRadius: 10, paddingHorizontal: 12, minHeight: 40, paddingVertical: 6 }]} value={token} onChangeText={setToken} placeholder={t('{name} token', { name: item.name })} placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false} secureTextEntry />
                    {TOKEN_URLS[item.id] !== undefined ? <Text style={[typeScale.small, { color: p.accent }]} onPress={() => void Linking.openURL(TOKEN_URLS[item.id])}>{t('Create a token on {name}', { name: item.name })}</Text> : null}
                    <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center', justifyContent: 'flex-end' }}>
                      <Pressable onPress={() => { setForm(null); setToken('') }}><Text style={{ color: p.ink2 }}>{t('Cancel')}</Text></Pressable>
                      <Pressable disabled={busy === item.id || token.trim() === ''} onPress={() => { const next = token; setToken(''); void run(item.id, call('connector-connect', { id: item.id, token: next }), () => setForm(null)) }}>
                        <Text style={{ color: token.trim() === '' ? p.ink3 : p.accent, fontWeight: '600' }}>{busy === item.id ? t('Connecting…') : t('Connect')}</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </View>
            )
          })}
          {connectors.length === 0 ? <Row label={t('No connectors')} /> : null}
        </Section>
      </ScrollView>
    </Screen>
  )
}

export const capabilityStatusText = (status?: { state?: string; error?: string }) =>
  status === undefined ? undefined
  : status.state === 'ready' ? t('Ready')
  : status.state === 'needs-approval' ? t('Needs approval')
  : status.state === 'error' ? t('Could not connect: {error}', { error: status.error ?? '' })
  : t('Connecting…')

export function Capabilities({ navigation }: any) {
  const { p } = useTheme()
  const { team, call } = useTeam()
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ name: string; kind: string; description: string; transport: string; command: string; argsText: string; envText: string; url: string; headersText: string; content: string; items: string[]; originalName?: string } | null>(null)
  const items = team?.capabilities ?? []
  const library = items.map(i => i.name)
  const parseMap = (text: string, label: string) => {
    try { const v = JSON.parse(text || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); return v } catch { throw new Error(t('{label} must be a JSON object.', { label })) }
  }
  const setField = (field: string, value: string | string[]) => setEditing(d => d === null ? null : { ...d, [field]: value })
  const saveCapability = () => {
    if (editing === null || editing.name.trim() === '') return
    let payload: Record<string, unknown>
    try {
      payload = { name: editing.name.trim(), kind: editing.kind, description: editing.description, originalName: editing.originalName }
      if (editing.kind === 'mcp' && editing.transport === 'stdio') { payload.transport = 'stdio'; payload.command = editing.command; payload.args = editing.argsText.split('\n').filter(l => l !== ''); payload.env = parseMap(editing.envText, t('Environment')) }
      else if (editing.kind === 'mcp') { payload.transport = 'streamable-http'; payload.url = editing.url; payload.headers = parseMap(editing.headersText, t('Headers')) }
      else if (editing.kind === 'skill') payload.content = editing.content
      else payload.items = editing.items
    } catch (f) { setError((f as Error).message); return }
    setError(null)
    void call('capability-save', payload).then(() => setEditing(null), (f: { code?: string; message?: string }) => { if (f?.code !== 'unlock/canceled') setError(f?.message ?? String(f)) })
  }
  const statuses = (team as { capabilityStatuses?: Record<string, { state?: string; error?: string }> } | null)?.capabilityStatuses ?? {}
  const statusText = capabilityStatusText
  const detail = (item: { kind?: string; transport?: string; items?: string[] }) =>
    item.kind === 'pack' ? `${t('Pack')}: ${(item.items ?? []).join(', ') || t('No items')}`
    : item.kind === 'mcp' ? (item.transport === 'stdio' ? t('Local command') : t('HTTP server'))
    : item.kind === 'skill' ? t('Skill')
    : ''
  const act = (endpoint: string, payload: Record<string, unknown>) =>
    call(endpoint, payload).catch((f: { code?: string; message?: string }) => { if (f?.code !== 'unlock/canceled') setError(f?.message ?? String(f)) })
  return (
    <Screen><Back title={t('Capabilities')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {error ? <Text style={[typeScale.small, { color: p.danger, margin: 18 }]}>{error}</Text> : null}
        <Section label={t('Capabilities')}>
          {items.map(item => {
            const status = statuses[item.name]
            const text = statusText(status)
            return (
              <View key={item.name}>
                <Pressable accessibilityRole="button" onPress={() => setOpen(open === item.name ? null : item.name)} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={[typeScale.settingsRow, { color: p.ink }]}>{item.name}</Text>
                    {item.description ? <Text style={[typeScale.small, { color: p.ink3, marginTop: 2 }]} numberOfLines={2}>{item.description}</Text> : null}
                    <Text style={[typeScale.small, { color: status?.state === 'needs-approval' ? p.accent : status?.state === 'error' ? p.danger : p.ink3, marginTop: 2 }]}>{[detail(item as { kind?: string; transport?: string; items?: string[] }), text].filter(Boolean).join(' · ')}</Text>
                  </View>
                  <ChevronRightIcon size={16} color={p.ink3} />
                </Pressable>
                {open === item.name ? (
                  <View style={{ borderTopWidth: 1, borderTopColor: p.line, paddingHorizontal: 16, paddingVertical: 10 }}>
                    <ScrollView style={{ maxHeight: 180 }}><Text selectable style={[typeScale.small, { color: p.ink2 }]}>{(item as { content?: string }).content ?? item.description ?? ''}</Text></ScrollView>
                    <View style={{ flexDirection: 'row', gap: 14, marginTop: 10, justifyContent: 'flex-end' }}>
                      <Pressable onPress={() => setEditing({ name: item.name, kind: item.kind ?? 'mcp', description: item.description ?? '', transport: item.transport ?? 'stdio', command: item.command ?? '', argsText: '', envText: '', url: item.url ?? '', headersText: '', content: item.content ?? '', items: item.items ?? [], originalName: item.name })}><Text style={{ color: p.ink2 }}>{t('Edit')}</Text></Pressable>
                      {status?.state === 'needs-approval' ? <Pressable onPress={() => void act('capability-approve', { name: item.name })}><Text style={{ color: p.accent }}>{t('Approve')}</Text></Pressable> : null}
                      <Pressable onPress={() => confirmDanger(t('Delete {name}?', { name: item.name }), t('Delete'), () => void act('capability-delete', { name: item.name }))}><Text style={{ color: p.danger }}>{t('Delete')}</Text></Pressable>
                    </View>
                  </View>
                ) : null}
              </View>
            )
          })}
          {items.length === 0 && editing === null ? <Row label={t('Save an MCP server or skill first.')} /> : null}
        </Section>
        {editing === null ? (
          <View style={{ paddingHorizontal: 18, marginTop: 14 }}>
            <Pressable accessibilityRole="button" onPress={() => setEditing({ name: '', kind: 'mcp', description: '', transport: 'stdio', command: '', argsText: '', envText: '', url: '', headersText: '', content: '', items: [] })} style={[styles.cta, { backgroundColor: p.hover }]}>
              <Text style={[typeScale.settingsRow, { color: p.ink }]}>{t('Add capability')}</Text>
            </Pressable>
          </View>
        ) : (
          <Section label={editing.originalName !== undefined ? t('Edit capability') : t('Add capability')}>
            <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 8 }}>
              <LabeledInput label={t('Name')} style={[typeScale.settingsRow, styles.field, { color: p.ink, borderColor: p.line }]} value={editing.name} editable={editing.originalName === undefined} onChangeText={v => setField('name', v)} placeholder={t('Name')} placeholderTextColor={p.ink3} autoCapitalize="none" />
              <View style={[styles.segRow, { borderColor: p.line }]}>
                {[['mcp', 'MCP'], ['skill', 'Skill'], ['pack', 'Pack']].map(([id, label]) => (
                  <Pressable key={id} disabled={editing.originalName !== undefined} onPress={() => setField('kind', id)} style={[styles.seg, editing.kind === id ? { backgroundColor: p.accent } : null]}>
                    <Text style={[typeScale.caption, { color: editing.kind === id ? p.accentInk : p.ink2, fontWeight: '500' }]}>{t(label)}</Text>
                  </Pressable>
                ))}
              </View>
              <LabeledInput label={t('Description')} style={[typeScale.settingsRow, styles.field, { color: p.ink, borderColor: p.line }]} value={editing.description} onChangeText={v => setField('description', v)} placeholder={t('Description')} placeholderTextColor={p.ink3} />
              {editing.kind === 'mcp' ? (
                <>
                  <View style={[styles.segRow, { borderColor: p.line }]}>
                    {[['stdio', 'Local command'], ['streamable-http', 'HTTP server']].map(([id, label]) => (
                      <Pressable key={id} onPress={() => setField('transport', id)} style={[styles.seg, editing.transport === id ? { backgroundColor: p.accent } : null]}>
                        <Text style={[typeScale.caption, { color: editing.transport === id ? p.accentInk : p.ink2, fontWeight: '500' }]}>{t(label)}</Text>
                      </Pressable>
                    ))}
                  </View>
                  {editing.transport === 'stdio' ? (
                    <>
                      <LabeledInput label={t('Command')} style={[typeScale.settingsRow, styles.field, { color: p.ink, borderColor: p.line }]} value={editing.command} onChangeText={v => setField('command', v)} placeholder={t('Command')} placeholderTextColor={p.ink3} autoCapitalize="none" />
                      <LabeledInput label={t('Arguments (one per line)')} style={[typeScale.small, styles.field, styles.multi, { color: p.ink, borderColor: p.line }]} value={editing.argsText} onChangeText={v => setField('argsText', v)} placeholder={t('Arguments (one per line)')} placeholderTextColor={p.ink3} multiline />
                      <LabeledInput label={t('Environment')} style={[typeScale.small, styles.field, styles.multi, { color: p.ink, borderColor: p.line }]} value={editing.envText} onChangeText={v => setField('envText', v)} placeholder='{"API_KEY": "$DSH_SECRET_MY_KEY"}' placeholderTextColor={p.ink3} multiline autoCapitalize="none" />
                    </>
                  ) : (
                    <>
                      <LabeledInput label={t('URL')} style={[typeScale.settingsRow, styles.field, { color: p.ink, borderColor: p.line }]} value={editing.url} onChangeText={v => setField('url', v)} placeholder={t('URL')} placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false} />
                      <LabeledInput label={t('Headers')} style={[typeScale.small, styles.field, styles.multi, { color: p.ink, borderColor: p.line }]} value={editing.headersText} onChangeText={v => setField('headersText', v)} placeholder='{"API_KEY": "$DSH_SECRET_MY_KEY"}' placeholderTextColor={p.ink3} multiline autoCapitalize="none" />
                    </>
                  )}
                </>
              ) : editing.kind === 'skill' ? (
                <LabeledInput label={t('Skill instructions')} style={[typeScale.small, styles.field, styles.multi, { color: p.ink, borderColor: p.line }]} value={editing.content} onChangeText={v => setField('content', v)} placeholder={t('Skill instructions')} placeholderTextColor={p.ink3} multiline />
              ) : (
                library.length === 0 ? <Text style={[typeScale.small, { color: p.ink3 }]}>{t('Save an MCP server or skill first.')}</Text> : (
                  <View style={{ gap: 6 }}>
                    {library.map(name => (
                      <Pressable key={name} onPress={() => setField('items', editing.items.includes(name) ? editing.items.filter(i => i !== name) : [...editing.items, name])} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ color: editing.items.includes(name) ? p.accent : p.ink3 }}>{editing.items.includes(name) ? '✓' : '○'}</Text>
                        <Text style={[typeScale.settingsRow, { color: p.ink }]}>{name}</Text>
                      </Pressable>
                    ))}
                  </View>
                )
              )}
              <View style={{ flexDirection: 'row', gap: 14, justifyContent: 'flex-end', marginTop: 4 }}>
                <Pressable onPress={() => setEditing(null)}><Text style={{ color: p.ink2 }}>{t('Cancel')}</Text></Pressable>
                <Pressable disabled={editing.name.trim() === ''} onPress={saveCapability}><Text style={{ color: editing.name.trim() === '' ? p.ink3 : p.accent, fontWeight: '600' }}>{editing.originalName !== undefined ? t('Save changes') : t('Add capability')}</Text></Pressable>
              </View>
            </View>
          </Section>
        )}
      </ScrollView>
    </Screen>
  )
}

export function TeamUsage({ navigation }: any) {
  const { call } = useTeam()
  // The computer's usage view (usage.js): hourly rows of
  // [hour, owner, model, kind, input, cacheRead, cacheWrite, output, calls].
  const [view, setView] = useState<{ owners?: { name: string; kind: string; deleted?: boolean }[]; models?: { name: string }[]; rows?: number[][] } | null>(null)
  useState(() => { void call('usage', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).then(v => setView(v as typeof view)).catch(() => {}); return null })
  const rows = (view?.rows ?? []) as unknown as [string, number, number, string, number, number, number, number, number][]
  const sum = (pick: (row: typeof rows[number]) => boolean) => rows.filter(pick).reduce((total, row) => ({ input: total.input + row[4] + row[5] + row[6], output: total.output + row[7] }), { input: 0, output: 0 })
  const all = sum(() => true)
  const fmt = (n: number) => n.toLocaleString()
  const owners = (view?.owners ?? []).map((owner, index) => ({ owner, total: sum(row => row[1] === index) })).filter(entry => entry.total.input + entry.total.output > 0)
  const models = (view?.models ?? []).map((model, index) => ({ model, total: sum(row => row[2] === index) })).filter(entry => entry.total.input + entry.total.output > 0)
  return (
    <Screen><Back title={t('Usage')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('Usage')}>
          <Row label={t('Tokens in')} value={view === null ? '—' : fmt(all.input)} />
          <Row label={t('Tokens out')} value={view === null ? '—' : fmt(all.output)} />
        </Section>
        <Section label={t('Bots')}>
          {owners.map(({ owner, total }, index) => <Row key={index} label={owner.name} value={fmt(total.input + total.output)} />)}
        </Section>
        <Section label={t('Models')}>
          {models.map(({ model, total }, index) => <Row key={index} label={model.name} value={fmt(total.input + total.output)} />)}
        </Section>
      </ScrollView>
    </Screen>
  )
}

export function Location({ navigation }: any) {
  const { call, team } = useTeam()
  // As on the desktop, the team workspace comes from `folders`; it is read again on
  // focus so a change made in the folder picker shows on return.
  const [workspace, setWorkspace] = useState('')
  const focused = useIsFocused()
  useEffect(() => { if (focused) void call('folders').then(v => setWorkspace((v as { team?: string })?.team ?? '')).catch(() => {}) }, [focused, team?.revision])
  const dataPath = (team as { dataPath?: string } | null)?.dataPath
  return (
    <Screen><Back title={t('Location')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('Location')}>
          <Row label={t('Team workspace')} value={workspace} onPress={() => navigation.navigate('Folder', { current: workspace, onPick: 'team' })} />
          {dataPath !== undefined ? <Row label={t('Data location')} value={dataPath} /> : null}
        </Section>
      </ScrollView>
    </Screen>
  )
}

export function Updates({ navigation }: any) {
  const { p } = useTheme()
  const { call } = useTeam()
  const [update, setUpdate] = useState<{ current?: string; phase?: string; latest?: string; installed?: string; verified?: string; available?: boolean; checkedAt?: number; source?: string; enabled?: boolean; error?: string; notes?: string } | null>(null)
  const [dsh, setDsh] = useState<{ current?: string; phase?: string; latest?: string; installed?: string; verified?: string; available?: boolean; blockedBy?: string; error?: string } | null>(null)
  // diagnostics.report: { facts, entries: [{ time, level, source, text }], total }
  const [diag, setDiag] = useState<{ total?: number; entries?: { text?: string }[] } | null>(null)
  const [log, setLog] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const check = () => { setBusy(true); void call('update-check').then(v => { const r = v as { update?: typeof update; dsh?: typeof dsh } | typeof update; setUpdate((r as { update?: typeof update }).update ?? (r as typeof update)); setDsh((r as { dsh?: typeof dsh }).dsh ?? null) }).catch(() => {}).finally(() => setBusy(false)) }
  useState(() => { check(); void call('diagnostics').then(v => setDiag(v as typeof diag)).catch(() => {}); return null })
  const updateText = (u: typeof update) => {
    if (u === null) return '—'
    if (u.phase === 'installing') return t('Updating DS Bot…')
    if (u.phase === 'installed') return t('Restart DSH to start using DS Bot {version}.', { version: u.installed ?? u.latest ?? '' })
    if (u.phase === 'updated') return t('DS Bot {version} is installed.', { version: u.installed ?? u.latest ?? '' })
    if (u.phase === 'failed') return t('The update did not finish: {reason}', { reason: u.error ?? '' })
    if (u.available) return t('DS Bot {version} is available', { version: u.latest ?? '' })
    if (u.source === 'app') return t('Updates come with the DS Bot app.')
    if (u.enabled === false) return t('Update checks are off.')
    if (u.source === 'path') return t('Installed from a local folder; update it there.')
    if (u.latest === undefined || u.latest === null) return t('Could not check for updates.')
    return t('Up to date')
  }
  const dshText = (d: typeof dsh) => {
    if (d === null) return '—'
    if (d.phase === 'installing') return t('Updating DSH…')
    if (d.phase === 'installed') return t('Restart DSH to start using DSH {version}.', { version: d.installed ?? d.verified ?? '' })
    if (d.phase === 'failed') return t('The update did not finish: {reason}', { reason: d.error ?? '' })
    if (d.available === false && d.blockedBy) return t('Update DS Bot {version} first.', { version: d.blockedBy })
    if (d.available) return t('DSH {version} is available', { version: d.verified ?? d.latest ?? '' })
    return t('Up to date')
  }
  const loadLog = () => { if (log !== null) { setLog(null); return } void call('diagnostics-log').then(v => setLog(typeof v === 'string' ? v.split('\n') : [])).catch(() => {}) }
  const clearDiag = () => { void call('diagnostics-clear').catch(() => {}) }
  return (
    <Screen><Back title={t('Updates & diagnostics')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('DS Bot')}>
          <Row label={update?.current ? `DS Bot ${update.current}` : t('DS Bot')} value={updateText(update)} />
          {update?.notes ? <Row label={t('What is new')} value={update.notes} /> : null}
          {update?.available === true ? <Row label={t('Install update')} onPress={() => void call('update-install')} /> : null}
          <Row label={busy ? t('Checking for updates…') : t('Check for updates')} onPress={busy ? undefined : check} />
        </Section>
        <Section label={t('DSH')}>
          <Row label={dsh?.current ? `DSH ${dsh.current}` : t('DSH')} value={dshText(dsh)} />
          {dsh?.available === true ? <Row label={t('Install DSH update')} onPress={() => void call('dsh-update-install')} /> : null}
        </Section>
        <Section label={t('Diagnostics')}>
          <Row label={t('Log entries')} value={diag !== null ? String(diag.total ?? diag.entries?.length ?? 0) : '—'} />
          {diag?.entries?.length ? <Row label={t('Last entry')} value={diag.entries[diag.entries.length - 1]?.text ?? ''} /> : null}
          <Row label={log === null ? t('Diagnostics log') : t('Hide log')} onPress={loadLog} />
          {log !== null ? (
            <View style={{ borderTopWidth: 1, borderTopColor: p.line, paddingHorizontal: 16, paddingVertical: 10 }}>
              <ScrollView style={{ maxHeight: 200 }}>
                {log.map((line, i) => <Text key={i} style={[typeScale.small, { color: p.ink2, fontFamily: 'monospace' }]}>{line}</Text>)}
              </ScrollView>
              <Pressable accessibilityRole="button" onPress={() => { void Clipboard.setStringAsync(log.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1500) }} style={{ marginTop: 8 }}>
                <Text style={{ color: p.accent }}>{copied ? t('Copied') : t('Copy all')}</Text>
              </Pressable>
            </View>
          ) : null}
          <Row label={t('Clear diagnostics')} onPress={() => confirmDanger(t('Clear diagnostics?'), t('Clear'), clearDiag)} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

export function About({ navigation }: any) {
  const { p } = useTheme()
  const { call, computer } = useTeam()
  // The state carries no versions; the update check knows both.
  const [versions, setVersions] = useState<{ current?: string; dsh?: { current?: string } | null } | null>(null)
  useState(() => { void call('update-check').then(v => setVersions(v as typeof versions)).catch(() => {}); return null })
  const version = versions?.current ?? '—'
  const dsh = versions?.dsh?.current
  const appVersion = require('expo-constants').default.expoConfig?.version ?? require('expo-constants').default.manifest?.version ?? '—'
  return (
    <Screen><Back title={t('About')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('About')}>
          <Row label={t('DS Bot')} value={version} />
          {dsh !== undefined ? <Row label={t('DSH')} value={dsh} /> : null}
          <Row label={t('Phone app')} value={appVersion} />
          <Row label={t('Computer')} value={computer?.name ?? '—'} />
        </Section>
        <Section label={t('Licenses')}>
          <Row label={t('DS Bot')} hint={t('Apache License 2.0')} onPress={() => void Linking.openURL('https://github.com/Fei2411/DS-Bot/blob/main/LICENSE')} />
          <Row label={t('Repository')} hint="github.com/Fei2411/DS-Bot" onPress={() => void Linking.openURL('https://github.com/Fei2411/DS-Bot')} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  backRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8 },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  card: { marginHorizontal: 14, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', ...shadow(1) },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, minHeight: 50, gap: 10 },
  smallBtn: { borderRadius: 10, paddingHorizontal: 12, minHeight: 36, paddingVertical: 6, alignItems: 'center', justifyContent: 'center' },
  segRow: { flexDirection: 'row', borderWidth: 1, borderRadius: radius.pill, overflow: 'hidden' },
  seg: { flex: 1, minHeight: 38, paddingVertical: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  cta: { minHeight: 48, borderRadius: radius.pill, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  field: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 40, paddingVertical: 6 },
  multi: { minHeight: 80, paddingVertical: 10, textAlignVertical: 'top', fontFamily: 'monospace' },
})

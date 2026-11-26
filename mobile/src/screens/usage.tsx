import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ActivityIndicator, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useIsFocused } from '@react-navigation/native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useInSheet } from '../nav/sheet.tsx'
import { useTeam } from '../team/context.tsx'
import { compact, percent, rankUsage, usageActivity, usageChart, usageRanges, usageReport, type UsageBucket, type UsageRange, type UsageReport, type UsageView } from '../team/usage.ts'
import { t } from '../ui/i18n.ts'
import { ChevronLeftIcon } from '../ui/icons.tsx'
import { BotMark } from '../ui/marks.tsx'
import { inkColor, radius, type as typeScale, useTheme } from '../ui/tokens.ts'

const rangeName = (id: string) => t(({ '24h': '24 hours', '7d': '7 days', '30d': '30 days', '12w': '12 weeks', '12m': '12 months' })[id] ?? id)
const unitName = (unit: string) => t(({ hour: 'Per hour', day: 'Per day', week: 'Per week', month: 'Per month' })[unit] ?? unit)
const MODEL_INKS = ['deepseek', 'tangerine', 'green', 'violet', 'sky', 'rose', 'yellow']
const full = (value: number) => Math.round(value).toLocaleString()

// Bucket times are wall-clock dates encoded as UTC by the shared usage module.
function bucketLabel(bucket: UsageBucket, range: UsageRange, detail = false) {
  const date = new Date(bucket.start)
  const day = `${date.getUTCMonth() + 1}/${date.getUTCDate()}`
  if (range.unit === 'hour') return `${detail ? `${day} ` : ''}${String(date.getUTCHours()).padStart(2, '0')}:00`
  if (range.unit === 'month') return detail ? `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}` : String(date.getUTCMonth() + 1)
  return day
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const { p } = useTheme()
  return <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
    <View style={styles.cardHead}>
      <Text accessibilityRole="header" style={[typeScale.headerTitle, { color: p.ink, flex: 1 }]}>{title}</Text>
      {aside}
    </View>
    {children}
  </View>
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { p } = useTheme()
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress}
    style={({ pressed }) => [styles.choice, { backgroundColor: selected ? p.accent : pressed ? p.active : p.hover }]}>
    <Text style={[typeScale.small, { color: selected ? p.accentInk : p.ink2, fontWeight: selected ? '600' : '400' }]}>{label}</Text>
  </Pressable>
}

interface Series { id: number; name: string; color: string; sub?: string; glyph?: ReactNode }

function Totals({ report, range }: { report: UsageReport; range: UsageRange }) {
  const { p } = useTheme()
  const { total, previous } = report
  const change = previous > 0 ? Math.round((total.total - previous) / previous * 100) : null
  const cells = [
    [t('Tokens in'), compact(total.input + total.cacheRead), full(total.input + total.cacheRead)],
    [t('Output'), compact(total.output), full(total.output)],
    [t('Cache hit rate'), `${percent(total.cacheRead, total.input + total.cacheRead)}%`],
    [t('Calls'), compact(total.calls), full(total.calls)],
  ]
  return <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
    <View style={styles.hero}>
      <Text style={[typeScale.small, { color: p.ink2 }]}>{t('Last {range}', { range: rangeName(range.id) })}</Text>
      <Text accessibilityLabel={t('{count} tokens', { count: full(total.total) })} style={[styles.total, { color: p.ink }]}>
        {compact(total.total)}<Text style={[typeScale.settingsRow, { color: p.ink3 }]}> {t('tokens')}</Text>
      </Text>
      {change !== null ? <Text style={[typeScale.caption, { color: p.ink2 }]}>
        <Text style={{ color: p.accent, fontWeight: '600' }}>{change >= 0 ? '↑' : '↓'} {Math.abs(change)}% </Text>
        {t('Compared with the {range} before', { range: rangeName(range.id) })}
      </Text> : null}
    </View>
    <View style={[styles.metrics, { borderColor: p.line }]}>
      {cells.map(([label, value, exact], index) => <View key={label} accessible accessibilityLabel={`${label}: ${exact ?? value}`}
        style={[styles.metric, { borderColor: p.line, borderTopWidth: index > 1 ? StyleSheet.hairlineWidth : 0 }]}>
        <Text style={[typeScale.caption, { color: p.ink2 }]}>{label}</Text>
        <Text style={[styles.metricValue, { color: p.ink }]}>{value}</Text>
      </View>)}
    </View>
  </View>
}

function UsageChart({ report, range, series, by, onBy }: { report: UsageReport; range: UsageRange; series: Series[]; by: 'bot' | 'model'; onBy: (value: 'bot' | 'model') => void }) {
  const { p } = useTheme()
  const [picked, setPicked] = useState<number | null>(null)
  useEffect(() => setPicked(null), [range.id, by])
  const top = Math.max(1, ...report.buckets.map(bucket => bucket.sum.total))
  const bucket = picked === null ? null : report.buckets[picked]
  const count = report.buckets.length
  return <Card title={t('Tokens over time')} aside={<Text style={[typeScale.caption, { color: p.ink3 }]}>{unitName(range.unit)}</Text>}>
    <View accessibilityLabel={t('Group usage by')} style={styles.choices}>
      <Choice label={t('By Bot')} selected={by === 'bot'} onPress={() => onBy('bot')} />
      <Choice label={t('By model')} selected={by === 'model'} onPress={() => onBy('model')} />
    </View>
    <View style={styles.chart}>
      {[1, 0.5, 0].map(level => <View key={level} pointerEvents="none" style={[styles.grid, { bottom: `${level * 100}%`, borderColor: p.line }]}>
        <Text style={[styles.axis, { color: p.ink3 }]}>{compact(top * level)}</Text>
      </View>)}
      <View style={styles.columns}>
        {report.buckets.map((item, index) => <Pressable key={item.key} accessibilityRole="button"
          accessibilityLabel={`${bucketLabel(item, range, true)}, ${t('{count} tokens', { count: full(item.sum.total) })}`}
          accessibilityState={{ selected: picked === index }} onPress={() => setPicked(picked === index ? null : index)}
          style={[styles.column, { opacity: picked !== null && picked !== index ? 0.35 : 1 }]}>
          <View style={[styles.stack, { height: item.sum.total > 0 ? `${Math.max(1, item.sum.total / top * 100)}%` : 3, backgroundColor: p.hover }]}>
            {series.map(entry => {
              const value = item.stacks.get(entry.id) ?? 0
              return value > 0 ? <View key={entry.id} style={{ flexGrow: value, flexBasis: 0, backgroundColor: entry.color }} /> : null
            })}
          </View>
        </Pressable>)}
      </View>
    </View>
    <View style={styles.ticks}>{report.buckets.map((item, index) =>
      index % Math.max(1, Math.ceil(count / 5)) === 0 || index === count - 1 ? <Text key={item.key} numberOfLines={1}
        style={[styles.tickText, { color: p.ink3, left: `${index / Math.max(1, count - 1) * 100}%`, marginLeft: index === 0 ? 0 : index === count - 1 ? -42 : -21, textAlign: index === 0 ? 'left' : index === count - 1 ? 'right' : 'center' }]}>{bucketLabel(item, range)}</Text> : null
    )}</View>
    {bucket ? <View accessibilityLiveRegion="polite" style={[styles.tip, { backgroundColor: p.hover }]}>
      <Text style={[typeScale.small, { color: p.ink, fontWeight: '600' }]}>{bucketLabel(bucket, range, true)} · {t('{count} tokens', { count: full(bucket.sum.total) })}</Text>
      <Text style={[typeScale.caption, { color: p.ink2 }]}>{t('Tokens in')}: {full(bucket.sum.input + bucket.sum.cacheRead)} · {t('Output')}: {full(bucket.sum.output)}</Text>
      {series.filter(entry => (bucket.stacks.get(entry.id) ?? 0) > 0).map(entry => <Text key={entry.id} style={[typeScale.caption, { color: p.ink2 }]}>{entry.name}: {full(bucket.stacks.get(entry.id) ?? 0)}</Text>)}
    </View> : null}
    {report.total.total === 0 ? <Text style={[typeScale.small, styles.note, { color: p.ink3 }]}>{t('Nothing in this range.')}</Text> : null}
    <View style={styles.legend}>{series.map(entry => <View key={entry.id} style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: entry.color }]} /><Text numberOfLines={1} style={[typeScale.caption, { color: p.ink2, flexShrink: 1 }]}>{entry.name}</Text>
    </View>)}</View>
  </Card>
}

function Ranking({ title, entries, total, series }: { title: string; entries: ReturnType<typeof rankUsage>; total: number; series: Series[] }) {
  const { p } = useTheme()
  return <Card title={title} aside={<Text style={[typeScale.caption, { color: p.ink3 }]}>{entries.length}</Text>}>
    {entries.length === 0 ? <Text style={[typeScale.small, styles.note, { color: p.ink3 }]}>{t('Nothing in this range.')}</Text> : entries.map(([id, sum], index) => {
      const entry = series.find(item => item.id === id)
      if (!entry) return null
      return <View key={id} accessible accessibilityLabel={`${entry.name}, ${t('{count} tokens', { count: full(sum.total) })}, ${percent(sum.total, total)}%`}
        style={[styles.rank, { borderTopWidth: index > 0 ? StyleSheet.hairlineWidth : 0, borderColor: p.line }]}>
        {entry.glyph ?? <View style={[styles.modelGlyph, { backgroundColor: p.hover }]}><Text style={[typeScale.settingsRow, { color: entry.color, fontWeight: '600' }]}>{entry.name.slice(0, 1).toUpperCase()}</Text></View>}
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <View style={styles.rankHead}>
            <Text numberOfLines={1} style={[typeScale.small, { color: p.ink, flex: 1, fontWeight: '500' }]}>{entry.name}</Text>
            <Text style={[typeScale.small, { color: p.ink, fontVariant: ['tabular-nums'] }]}>{compact(sum.total)}</Text>
          </View>
          <View style={[styles.track, { backgroundColor: p.hover }]}><View style={[styles.track, { width: `${total > 0 ? sum.total / total * 100 : 0}%`, backgroundColor: entry.color }]} /></View>
          <View style={styles.rankHead}>
            <Text numberOfLines={1} style={[typeScale.caption, { color: p.ink3, flex: 1 }]}>{entry.sub ?? ''}</Text>
            <Text style={[typeScale.caption, { color: p.ink2 }]}>{percent(sum.total, total)}%</Text>
          </View>
        </View>
      </View>
    })}
  </Card>
}

function Activity({ view }: { view: UsageView }) {
  const { p } = useTheme()
  const { weeks, active } = useMemo(() => usageActivity(view), [view])
  const label = active === 1 ? t('Active on 1 day in the last year') : t('Active on {count} days in the last year', { count: active })
  return <Card title={t('Activity')}>
    <Text style={[typeScale.caption, { color: p.ink2, marginBottom: 14 }]}>{label}</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View accessible accessibilityLabel={label} style={{ flexDirection: 'row', gap: 3 }}>
        {weeks.map((week, index) => <View key={index} style={{ gap: 3 }}>{week.map(day => <View key={day.key} style={[styles.heat, { backgroundColor: day.level > 0 ? p.accent : p.hover, opacity: day.outside ? 0 : day.level > 0 ? 0.25 + day.level * 0.1875 : 1 }]} />)}</View>)}
      </View>
    </ScrollView>
    <View style={[styles.heatLegend, { marginTop: 12 }]}>
      <Text style={[typeScale.caption, { color: p.ink3 }]}>{t('Light')}</Text>
      {[0, 1, 2, 3, 4].map(level => <View key={level} style={[styles.heat, { backgroundColor: level === 0 ? p.hover : p.accent, opacity: level === 0 ? 1 : 0.25 + level * 0.1875 }]} />)}
      <Text style={[typeScale.caption, { color: p.ink3 }]}>{t('Heavy')}</Text>
    </View>
  </Card>
}

export function TeamUsage({ navigation }: any) {
  const { p, dark } = useTheme()
  const { call, team, online } = useTeam()
  const insets = useSafeAreaInsets()
  const inSheet = useInSheet()
  const focused = useIsFocused()
  const [view, setView] = useState<UsageView | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [reload, setReload] = useState(0)
  const [rangeId, setRangeId] = useState('7d')
  const [by, setBy] = useState<'bot' | 'model'>('bot')
  const range = usageRanges.find(item => item.id === rangeId) ?? usageRanges[1]
  useEffect(() => {
    if (!focused) return
    let stopped = false
    let loading = false
    let timer: ReturnType<typeof setTimeout>
    let active = AppState.currentState !== 'background' && AppState.currentState !== 'inactive'
    const load = async () => {
      if (!active || stopped || loading) return
      loading = true
      try {
        const value = await call('usage', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) as UsageView
        if (stopped) return
        setView(value)
        setError('')
        if (active) timer = setTimeout(() => void load(), value.scanning ? 3000 : 20000)
      } catch (failure) {
        if (stopped) return
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        loading = false
        if (!stopped) setRefreshing(false)
      }
    }
    const subscription = AppState.addEventListener('change', state => {
      active = state === 'active'
      clearTimeout(timer)
      if (active) void load()
    })
    void load()
    return () => { stopped = true; clearTimeout(timer); subscription.remove() }
  }, [call, focused, online, reload])
  const report = useMemo(() => view ? usageReport(view, range, by) : null, [view, range, by])
  const ownerSeries: Series[] = (view?.owners ?? []).map((owner, id) => {
    const bot = team?.bots?.find(item => item.id === owner.id)
    const name = bot?.name || owner.name || t(owner.kind === 'bot' ? 'Deleted Bot' : owner.kind === 'room' ? 'Deleted group chat' : 'Other')
    return { id, name, color: inkColor(bot?.color ?? (owner.kind === 'bot' ? MODEL_INKS[id % MODEL_INKS.length] : 'gray'), dark), sub: owner.deleted ? t('Deleted') : bot?.role || (owner.kind === 'room' ? t('Group chat') : ''), glyph: owner.kind === 'bot' ? <BotMark bot={bot ?? { id: owner.id, name }} dark={dark} size={32} /> : undefined }
  })
  const modelSeries: Series[] = (view?.models ?? []).map((model, id) => ({ id, name: model.name || model.model || t('Unknown model'), sub: model.providerName ?? model.provider, color: inkColor(MODEL_INKS[id % MODEL_INKS.length], dark) }))
  const chart = useMemo(() => report ? usageChart(report, by) : null, [report, by])
  const chartSeries = (chart?.ids ?? []).map(id => id === -1
    ? { id, name: t(by === 'bot' ? 'More Bots' : 'More models'), color: p.ink2 }
    : id === -2 ? { id, name: t('Other'), color: p.ink3 }
    : (by === 'bot' ? ownerSeries : modelSeries)[id]).filter((item): item is Series => item !== undefined)
  const refresh = () => { setRefreshing(true); setReload(value => value + 1) }
  return <View style={{ flex: 1, backgroundColor: p.main, paddingTop: inSheet ? 0 : insets.top }}>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={() => navigation.goBack()} style={styles.back}><ChevronLeftIcon size={20} /></Pressable>
      <Text accessibilityRole="header" style={[typeScale.headerTitle, { color: p.ink }]}>{t('Usage')}</Text>
      <View style={styles.back} />
    </View>
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(32, insets.bottom + 20) }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.accent} colors={[p.accent]} />}>
      {error ? <View accessibilityRole="alert" style={[styles.message, { backgroundColor: p.hover }]}>
        <Text style={[typeScale.small, { color: p.danger }]}>{error}</Text>
        <Choice label={t('Retry')} selected={false} onPress={refresh} />
      </View> : null}
      {!view && !error ? <View accessibilityLabel={t('Loading…')} style={styles.empty}><ActivityIndicator color={p.accent} /><Text style={[typeScale.small, { color: p.ink2 }]}>{t('Loading…')}</Text></View> : null}
      {view && view.rows.length === 0 ? <View style={styles.empty}>
        <BotMark bot={{ id: 'usage', name: 'Usage' }} dark={dark} size={56} />
        <Text style={[typeScale.headerTitle, { color: p.ink }]}>{view.scanning ? t('Reading your chats…') : t('No usage yet.')}</Text>
        <Text style={[typeScale.small, { color: p.ink2, textAlign: 'center' }]}>{t('Token usage shows up here after a model is called.')}</Text>
      </View> : null}
      {view && view.rows.length > 0 && report ? <>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.ranges} accessibilityLabel={t('Time range')}>
          {usageRanges.map(item => <Choice key={item.id} label={rangeName(item.id)} selected={item.id === rangeId} onPress={() => setRangeId(item.id)} />)}
        </ScrollView>
        {view.scanning ? <Text accessibilityLiveRegion="polite" style={[typeScale.caption, { color: p.ink2 }]}>{t('Still reading older chats; totals may grow.')}</Text> : null}
        <Totals report={report} range={range} />
        <UsageChart report={chart?.report ?? report} range={range} series={chartSeries} by={by} onBy={setBy} />
        <Ranking title={t('Bots')} entries={rankUsage(report.owners).filter(([id]) => report.bots.has(id))} total={report.total.total} series={ownerSeries} />
        {rankUsage(report.owners).some(([id]) => !report.bots.has(id)) ? <Ranking title={t('Other')} entries={rankUsage(report.owners).filter(([id]) => !report.bots.has(id))} total={report.total.total} series={ownerSeries} /> : null}
        <Ranking title={t('Models')} entries={rankUsage(report.models)} total={report.total.total} series={modelSeries} />
        <Activity view={view} />
      </> : null}
    </ScrollView>
  </View>
}

const styles = StyleSheet.create({
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 16, gap: 16, alignSelf: 'center', width: '100%', maxWidth: 720 },
  ranges: { gap: 6, paddingVertical: 2 },
  choice: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.pill, justifyContent: 'center', alignItems: 'center' },
  choices: { flexDirection: 'row', gap: 6, marginBottom: 30, flexWrap: 'wrap' },
  card: { padding: 18, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.dialog, overflow: 'hidden' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18 },
  hero: { paddingBottom: 20, gap: 7 },
  total: { fontSize: 44, lineHeight: 54, fontWeight: '600', letterSpacing: -1.5, fontVariant: ['tabular-nums'] },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: StyleSheet.hairlineWidth },
  metric: { width: '50%', paddingTop: 16, paddingBottom: 12, gap: 5 },
  metricValue: { fontSize: 22, lineHeight: 28, fontWeight: '500', fontVariant: ['tabular-nums'] },
  chart: { height: 156, marginLeft: 38, marginTop: 8 },
  grid: { position: 'absolute', left: 0, right: 0, borderTopWidth: StyleSheet.hairlineWidth },
  axis: { position: 'absolute', left: -38, top: -8, fontSize: 10, lineHeight: 16 },
  columns: { flex: 1, flexDirection: 'row', gap: 3, alignItems: 'flex-end' },
  column: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  stack: { width: '100%', borderTopLeftRadius: radius.tag, borderTopRightRadius: radius.tag, overflow: 'hidden', flexDirection: 'column-reverse' },
  ticks: { marginLeft: 38, marginTop: 10, height: 24 },
  tickText: { position: 'absolute', fontSize: 9, lineHeight: 14, width: 42 },
  tip: { padding: 12, gap: 5, borderRadius: radius.input, marginTop: 8 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
  rank: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 },
  rankHead: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  modelGlyph: { width: 32, height: 32, borderRadius: radius.row, alignItems: 'center', justifyContent: 'center' },
  track: { height: 4, borderRadius: radius.pill },
  heat: { width: 8, height: 8, borderRadius: 2 },
  heatLegend: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 24, gap: 16 },
  note: { textAlign: 'center', paddingVertical: 16 },
  message: { borderRadius: radius.card, padding: 16, gap: 12 },
})

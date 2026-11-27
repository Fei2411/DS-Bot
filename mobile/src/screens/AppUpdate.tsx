import { useEffect, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { readPrefs, writePrefs } from '../store.ts'
import { formatMegabytes, LATEST_RELEASE_URL } from '../team/app-update.ts'
import { saveUpdateMirror, useAppUpdate } from '../team/app-update-store.ts'
import { t } from '../ui/i18n.ts'
import { radius, type as typeScale, useTheme } from '../ui/tokens.ts'
import {
  SettingsBack as Back,
  SettingsRow as Row,
  SettingsScreen as Screen,
  SettingsSection as Section,
} from './settings-primitives.tsx'

export function AppUpdate({ navigation }: any) {
  const { p } = useTheme()
  const update = useAppUpdate()
  const [autoCheck, setAutoCheck] = useState(true)
  const [mirror, setMirror] = useState('')
  const [editingMirror, setEditingMirror] = useState(false)
  const [mirrorDraft, setMirrorDraft] = useState('')
  const [mirrorError, setMirrorError] = useState<string | null>(null)

  useEffect(() => {
    void readPrefs().then(prefs => {
      setAutoCheck(prefs.autoUpdate !== 'off')
      const saved = prefs.updateMirror ?? ''
      setMirror(saved)
      setMirrorDraft(saved)
    })
  }, [])

  const toggleAutoCheck = (on: boolean) => {
    setAutoCheck(on)
    void writePrefs({ autoUpdate: on ? 'on' : 'off' })
  }

  const commitMirror = async () => {
    setMirrorError(null)
    const res = await saveUpdateMirror(mirrorDraft)
    if (!res.ok) {
      setMirrorError(t('Mirror address must start with https://'))
      return
    }
    setMirror(res.value ?? '')
    setMirrorDraft(res.value ?? '')
    setEditingMirror(false)
    void update.check()
  }

  const clearMirror = async () => {
    setMirrorError(null)
    await saveUpdateMirror('')
    setMirror('')
    setMirrorDraft('')
    setEditingMirror(false)
    void update.check()
  }

  const pct = update.progress >= 0 ? Math.round(update.progress * 100) : null
  const statusLabel = (() => {
    switch (update.phase) {
      case 'checking': return t('Checking for updates…')
      case 'up-to-date': return t('Up to date')
      case 'available': return t('{version} available', { version: update.release?.version ?? '' })
      case 'downloading': return pct !== null ? t('Downloading {pct}%', { pct }) : t('Downloading…')
      case 'ready': return t('Ready to install')
      case 'installing': return t('Opening installer…')
      case 'error': return t('Update failed')
      default: return t('Not checked yet')
    }
  })()

  const statusColor = update.phase === 'error'
    ? p.danger
    : update.phase === 'available' || update.phase === 'ready'
      ? p.accent
      : p.ink2

  const releaseSize = update.release?.size ? formatMegabytes(update.release.size) : ''
  const writtenLabel = update.bytesWritten > 0 ? formatMegabytes(update.bytesWritten) : ''
  const totalLabel = update.totalBytes > 0 ? formatMegabytes(update.totalBytes) : releaseSize
  const shortSha = update.cached?.sha256 ? `${update.cached.sha256.slice(0, 12)}…` : update.release?.sha256 ? `${update.release.sha256.slice(0, 12)}…` : undefined

  const primaryAction = (() => {
    if (update.phase === 'checking') {
      return { label: t('Checking for updates…'), disabled: true, onPress: () => {} }
    }
    if (update.phase === 'downloading') {
      return { label: t('Cancel download'), secondary: true, disabled: false, onPress: () => void update.cancel() }
    }
    if (update.phase === 'ready' && update.release !== null) {
      return {
        label: update.canInstall
          ? t('Install {version}', { version: update.release.version })
          : t('Allow installing updates'),
        disabled: false,
        onPress: () => void update.install(),
      }
    }
    if (update.phase === 'installing') {
      return { label: t('Opening installer…'), disabled: true, onPress: () => {} }
    }
    if (update.hasUpdate && update.release !== null) {
      const label = releaseSize
        ? t('Download {version} ({size})', { version: update.release.version, size: releaseSize })
        : t('Download {version}', { version: update.release.version })
      return { label, disabled: false, onPress: () => void update.download() }
    }
    return { label: t('Check for updates'), disabled: false, onPress: () => void update.check() }
  })()

  const openReleasePage = () => {
    void Linking.openURL(update.release?.releasePageUrl ?? LATEST_RELEASE_URL)
  }

  return (
    <Screen>
      <Back title={t('App update')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Section label={t('Phone app')}>
          <Row label={t('Current version')} value={`v${update.currentVersion}`} />
          <Row
            label={t('Status')}
            value={statusLabel}
            valueColor={statusColor}
            end={update.phase === 'checking' || update.phase === 'installing' ? <ActivityIndicator size="small" color={p.accent} /> : undefined}
          />
          {update.phase === 'downloading' ? (
            <View style={styles.progressWrap}>
              {pct !== null ? (
                <>
                  <View style={[styles.track, { backgroundColor: p.hover }]}>
                    <View style={[styles.fill, { backgroundColor: p.accent, width: `${Math.max(4, pct)}%` }]} />
                  </View>
                  <Text style={[typeScale.small, { color: p.ink2, marginTop: 6 }]}>
                    {writtenLabel && totalLabel ? `${writtenLabel} / ${totalLabel}` : t('Downloading…')}
                  </Text>
                </>
              ) : (
                <View style={styles.indeterminateRow}>
                  <ActivityIndicator size="small" color={p.accent} />
                  <Text style={[typeScale.small, { color: p.ink2 }]}>
                    {writtenLabel ? `${writtenLabel}` : t('Downloading…')}
                  </Text>
                </View>
              )}
            </View>
          ) : null}
          {shortSha !== undefined && (update.hasUpdate || update.phase === 'ready') ? (
            <Row label="SHA-256" value={update.cached !== null ? `${t('Verified')} · ${shortSha}` : shortSha} valueColor={update.cached !== null ? p.green : p.ink2} />
          ) : null}
          {update.error !== null ? (
            <View style={styles.errorBox}>
              <Text style={[typeScale.small, { color: p.danger }]} accessibilityRole="alert">{t(update.error)}</Text>
            </View>
          ) : null}
        </Section>

        <View style={styles.ctaWrap}>
          <Pressable
            accessibilityRole="button"
            disabled={primaryAction.disabled}
            onPress={primaryAction.onPress}
            style={({ pressed }) => [
              styles.cta,
              primaryAction.secondary
                ? { backgroundColor: p.card, borderColor: p.line, borderWidth: StyleSheet.hairlineWidth }
                : { backgroundColor: p.accent },
              (pressed || primaryAction.disabled) && { opacity: 0.72 },
            ]}>
            <Text style={[typeScale.settingsRow, { color: primaryAction.secondary ? p.ink : p.accentInk, fontWeight: '600' }]}>
              {primaryAction.label}
            </Text>
          </Pressable>
        </View>

        {update.hasUpdate && update.release?.notes ? (
          <Section label={t('What is new')}>
            <View style={styles.notesWrap}>
              <Text style={[typeScale.small, { color: p.ink2, lineHeight: 20 }]}>
                {update.release.notes.replace(/^#{1,6}\s+/gm, '')}
              </Text>
            </View>
          </Section>
        ) : null}

        <Section label={t('Preferences')}>
          <Row
            label={t('Auto-check for updates')}
            end={<Switch value={autoCheck} onValueChange={toggleAutoCheck} trackColor={{ false: p.line2, true: p.accent }} thumbColor={p.knob} />}
          />
          <Row
            label={t('Download mirror')}
            value={mirror || t('Default')}
            onPress={() => { setEditingMirror(open => !open); setMirrorError(null) }}
          />
          {editingMirror ? (
            <View style={styles.mirrorBox}>
              <TextInput
                value={mirrorDraft}
                onChangeText={setMirrorDraft}
                placeholder="https://mirror.example.com/ds-bot"
                placeholderTextColor={p.ink3}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={[styles.field, typeScale.settingsRow, { color: p.ink, borderColor: p.line, backgroundColor: p.main }]}
              />
              {mirrorError !== null ? <Text style={[typeScale.small, { color: p.danger, marginTop: 6 }]}>{mirrorError}</Text> : null}
              <View style={styles.mirrorActions}>
                {mirror !== '' ? (
                  <Pressable accessibilityRole="button" onPress={() => void clearMirror()} style={[styles.smallBtn, { backgroundColor: p.hover }]}>
                    <Text style={[typeScale.small, { color: p.ink }]}>{t('Reset')}</Text>
                  </Pressable>
                ) : null}
                <Pressable accessibilityRole="button" onPress={() => void commitMirror()} style={[styles.smallBtn, { backgroundColor: p.accent }]}>
                  <Text style={[typeScale.small, { color: p.accentInk, fontWeight: '600' }]}>{t('Save')}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
          {update.phase !== 'checking' && update.hasUpdate ? (
            <Row label={t('Check again')} onPress={() => void update.check()} />
          ) : null}
          <Row label={t('Open release page')} onPress={openReleasePage} />
        </Section>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  progressWrap: { paddingHorizontal: 16, paddingVertical: 12 },
  indeterminateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  errorBox: { paddingHorizontal: 16, paddingVertical: 10 },
  ctaWrap: { marginHorizontal: 14, marginTop: 16 },
  cta: { minHeight: 48, borderRadius: radius.pill, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  notesWrap: { paddingHorizontal: 16, paddingVertical: 12 },
  mirrorBox: { paddingHorizontal: 16, paddingVertical: 12 },
  field: { borderWidth: 1, borderRadius: radius.input, paddingHorizontal: 12, minHeight: 42, paddingVertical: 6 },
  mirrorActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
  smallBtn: { borderRadius: radius.input, paddingHorizontal: 14, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
})

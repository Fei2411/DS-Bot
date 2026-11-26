import { useMemo, useState } from 'react'
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import {
  cleanSemver,
  getReleaseEntry,
  RELEASE_NOTES,
  releasesUpTo,
  selectReleaseNotes,
} from '../../../ds-bot/src/shared/release-notes.js'
import { currentAppVersion } from '../team/app-version.ts'
import { closeMobileReleaseNotes, useMobileReleaseNotes, type MobileReleaseNotesEntry } from '../team/release-notes.ts'
import { getLang, t } from './i18n.ts'
import { radius, shadow, type, useTheme } from './tokens.ts'

const RELEASES_URL = 'https://github.com/Fei-Craft/DS-Bot/releases'

function activeLocale(): string {
  const pref = getLang()
  if (pref === 'zh' || pref === 'en') return pref
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  } catch {
    return 'en'
  }
}

export function ReleaseNotesModal() {
  const { p } = useTheme()
  const modal = useMobileReleaseNotes()
  const [showEarlier, setShowEarlier] = useState(false)
  const locale = activeLocale()
  const releases = RELEASE_NOTES as MobileReleaseNotesEntry[]
  const current = cleanSemver(modal.current ?? currentAppVersion())
  const allHistory = useMemo(() => releasesUpTo(current, releases) as MobileReleaseNotesEntry[], [current, releases])

  const primaryEntries = useMemo(() => {
    if (Array.isArray(modal.versions) && modal.versions.length > 0) {
      const resolved = modal.versions
        .map(v => getReleaseEntry(v, releases) as MobileReleaseNotesEntry | null)
        .filter((entry): entry is MobileReleaseNotesEntry => entry !== null)
      if (resolved.length > 0) return resolved
    }
    if (current) {
      const exact = getReleaseEntry(current, releases) as MobileReleaseNotesEntry | null
      if (exact) return [exact]
    }
    return allHistory.length > 0 ? [allHistory[0]] : []
  }, [modal.versions, current, releases, allHistory])

  const primarySet = useMemo(() => new Set(primaryEntries.map(entry => entry.version)), [primaryEntries])
  const earlierEntries = useMemo(
    () => (modal.mode === 'manual' ? allHistory.filter(entry => !primarySet.has(entry.version)) : []),
    [modal.mode, allHistory, primarySet],
  )

  if (!modal.open) return null

  const headlineVersion = current ?? primaryEntries[0]?.version ?? ''
  const multiPrimary = primaryEntries.length > 1
  const titleText = multiPrimary && headlineVersion
    ? t('Updated to v{version}', { version: headlineVersion })
    : headlineVersion
      ? t("What's new in v{version}", { version: headlineVersion })
      : t('Release notes')
  const subtitle = multiPrimary
    ? `v${primaryEntries[primaryEntries.length - 1].version} → v${primaryEntries[0].version}`
    : (primaryEntries[0]?.date || '')

  const renderSection = (entry: MobileReleaseNotesEntry, showHead: boolean) => {
    const block = selectReleaseNotes(entry, locale) as { intro?: string; items: string[]; outro?: string } | null
    if (!block) return null
    return (
      <View key={entry.version} style={[styles.section, showHead && styles.sectionBorder, { borderTopColor: p.line }]}>
        {showHead ? (
          <View style={styles.verRow}>
            <View style={[styles.verPill, { backgroundColor: p.tagBg }]}>
              <Text style={[styles.verPillText, { color: p.ink }]}>{`v${entry.version}`}</Text>
            </View>
            {entry.date ? <Text style={[type.caption, { color: p.ink3 }]}>{entry.date}</Text> : null}
          </View>
        ) : null}
        {block.intro ? <Text style={[styles.intro, { color: p.ink2 }]}>{block.intro}</Text> : null}
        <View style={styles.list}>
          {block.items.map((item, idx) => (
            <View key={`${entry.version}-${idx}`} style={styles.item}>
              <View style={[styles.dot, { backgroundColor: p.accent }]} />
              <Text style={[styles.itemText, { color: p.ink }]}>{item}</Text>
            </View>
          ))}
        </View>
        {block.outro ? <Text style={[type.caption, { color: p.ink3 }]}>{block.outro}</Text> : null}
      </View>
    )
  }

  return (
    <Modal
      visible={modal.open}
      transparent
      animationType="fade"
      onRequestClose={() => { setShowEarlier(false); closeMobileReleaseNotes() }}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => { setShowEarlier(false); closeMobileReleaseNotes() }}
        />
        <View style={[styles.card, { backgroundColor: p.main, borderColor: p.line2 }, shadow(4)]}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[type.headerTitle, { color: p.ink }]}>{titleText}</Text>
              {subtitle ? <Text style={[type.caption, { color: p.ink3, marginTop: 2 }]}>{subtitle}</Text> : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('Close')}
              onPress={() => { setShowEarlier(false); closeMobileReleaseNotes() }}
              style={({ pressed }) => [styles.closeBtn, pressed && { backgroundColor: p.hover }]}
            >
              <Text style={{ fontSize: 18, color: p.ink2 }}>×</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {primaryEntries.length > 0
              ? primaryEntries.map((entry, idx) => renderSection(entry, multiPrimary && idx >= 0))
              : <Text style={[type.small, { color: p.ink2 }]}>{t('No release notes for this version yet.')}</Text>}

            {earlierEntries.length > 0 ? (
              <View style={[styles.historyWrap, { borderTopColor: p.line }]}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setShowEarlier(open => !open)}
                  style={({ pressed }) => [styles.historyBtn, { backgroundColor: pressed ? p.active : p.hover }]}
                >
                  <Text style={[type.caption, { color: p.ink2, fontWeight: '500' }]}>
                    {showEarlier ? t('Hide earlier versions') : t('Earlier versions')}
                  </Text>
                </Pressable>
                {showEarlier ? earlierEntries.map(entry => renderSection(entry, true)) : null}
              </View>
            ) : null}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: p.line }]}>
            <Pressable onPress={() => void Linking.openURL(RELEASES_URL)} style={styles.linkBtn}>
              <Text style={[type.caption, { color: p.ink2 }]}>{t('Full changelog')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => { setShowEarlier(false); closeMobileReleaseNotes() }}
              style={({ pressed }) => [styles.primaryBtn, { backgroundColor: p.accent, opacity: pressed ? 0.85 : 1 }]}
            >
              <Text style={{ color: p.accentInk, fontSize: 14, fontWeight: '600' }}>{t('Got it')}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '82%',
    borderRadius: radius.dialog,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 12,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flexGrow: 0,
  },
  bodyContent: {
    paddingHorizontal: 18,
    paddingBottom: 18,
    gap: 14,
  },
  section: {
    gap: 8,
  },
  sectionBorder: {
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  verRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  verPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  verPillText: {
    fontSize: 11,
    fontWeight: '600',
  },
  intro: {
    fontSize: 13,
    lineHeight: 20,
  },
  list: {
    gap: 10,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 8,
  },
  itemText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 22,
  },
  historyWrap: {
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  historyBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  linkBtn: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  primaryBtn: {
    height: 36,
    paddingHorizontal: 20,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
})

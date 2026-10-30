import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { parsePairingUri, type RpcClient } from '../link/src/index.ts';
import { callBot, openLink, type Bot, type Room, type TeamState } from './src/connection.ts';
import { forgetComputer, loadComputer, loadIdentity, saveComputer, type PhoneIdentity, type SavedComputer } from './src/store.ts';
import { palette, type Palette } from './src/theme.ts';
import { BotMark } from './src/mark.tsx';
import { ChatScreen } from './src/chat.tsx';

const POLL_MS = 3_000;
const RETRY_MS = 2_000;

function rejected(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'NOT_PAIRED' || code === 'PAIRING_REJECTED';
}

function errorText(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (rejected(error)) return 'The computer did not accept this phone. Show a new QR code on the computer and scan it again.';
  if (code === 'HOST_OFFLINE') return 'The computer is not connected to the Server. Check that DS Bot is open and phone access is on.';
  return error instanceof Error ? error.message : String(error);
}

// Keeps the link up and the team state fresh. `call` runs one /api/bot endpoint.
function useTeamLink(computer: SavedComputer, identity: PhoneIdentity) {
  const [team, setTeam] = useState<TeamState | null>(null);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<RpcClient | undefined>(undefined);
  const revision = useRef<number>(-1);

  const call = useCallback(async (endpoint: string, payload: unknown = {}) => {
    const client = clientRef.current;
    if (client === undefined) throw new Error('Not connected to the computer yet.');
    return callBot(client, endpoint, payload);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = (run: () => void, ms: number) => { if (!stopped) timer = setTimeout(run, ms); };
    const poll = async () => {
      if (stopped || clientRef.current === undefined) return;
      try {
        const next = await callBot<TeamState>(clientRef.current, 'state', { since: revision.current });
        revision.current = next.revision;
        setTeam(prev => next.unchanged === true && prev !== null ? { ...prev, ...next } : next);
        setError(null);
        later(() => void poll(), POLL_MS);
      } catch (failure) {
        setError(errorText(failure));
      }
    };
    const connect = async () => {
      try {
        const client = await openLink(computer, identity);
        if (stopped) { void client.close(); return; }
        clientRef.current = client;
        setOnline(true);
        setError(null);
        client.onClose(() => {
          clientRef.current = undefined;
          setOnline(false);
          clearTimeout(timer);
          later(() => void connect(), RETRY_MS);
        });
        void poll();
      } catch (failure) {
        setError(errorText(failure));
        if (rejected(failure)) setTeam(null);
        else later(() => void connect(), RETRY_MS);
      }
    };
    void connect();
    return () => { stopped = true; clearTimeout(timer); void clientRef.current?.close(); clientRef.current = undefined; };
  }, [computer, identity]);

  return { team, online, error, call, clientRef };
}

function PairScreen({ identity, onPaired, palette: p }: { identity: PhoneIdentity; onPaired: (computer: SavedComputer) => void; palette: Palette }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const pair = useCallback(async (uri: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const offer = parsePairingUri(uri.trim());
      const client = await openLink(offer, identity, offer.code);
      await client.close();
      onPaired(await saveComputer(offer));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [identity, onPaired]);

  useEffect(() => {
    const open = (url: string | null | undefined) => { if (url?.startsWith('dsbot://pair')) void pair(url); };
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener('url', event => open(event.url));
    return () => subscription.remove();
  }, [pair]);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.center, { backgroundColor: p.main }]}>
      <Text style={[styles.title, { color: p.ink }]}>Pair with your computer</Text>
      <Text style={[styles.hint, { color: p.ink2 }]}>On the computer, open DS Bot, go to Settings → Phone and show a QR code. Then scan it here.</Text>
      <View style={[styles.camera, { backgroundColor: p.sidebar, borderColor: p.line }]}>
        {permission?.granted
          ? <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={busy ? undefined : ({ data }) => void pair(data)} />
          : <Pressable accessibilityRole="button" onPress={() => void requestPermission()} style={[styles.button, { backgroundColor: p.accent }]}><Text style={[styles.buttonText, { color: p.accentInk }]}>Use the camera</Text></Pressable>}
      </View>
      <Text style={[styles.hint, { color: p.ink2 }]}>No camera? Paste the pairing link.</Text>
      <View style={styles.pairRow}>
        <TextInput value={link} onChangeText={setLink} placeholder="dsbot://pair?…" placeholderTextColor={p.ink3} autoCapitalize="none" autoCorrect={false}
          returnKeyType="go" onSubmitEditing={() => { if (link.trim() !== '') void pair(link); }}
          style={[styles.input, { color: p.ink, backgroundColor: p.hover }]} accessibilityLabel="Pairing link" />
        <Pressable accessibilityRole="button" disabled={busy || link.trim() === ''} onPress={() => void pair(link)}
          style={[styles.button, { backgroundColor: p.accent, opacity: busy || link.trim() === '' ? 0.5 : 1 }]}>
          <Text style={[styles.buttonText, { color: p.accentInk }]}>Pair</Text>
        </Pressable>
      </View>
      {busy ? <ActivityIndicator style={styles.gap} color={p.accent} /> : null}
      {error ? <Text style={[styles.hint, { color: p.danger }]} accessibilityRole="alert">{error}</Text> : null}
    </KeyboardAvoidingView>
  );
}

function BotRow({ bot, main, working, palette: p, dark, onPress }: { bot: Bot; main: boolean; working: boolean; palette: Palette; dark: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? p.hover : 'transparent' }]}>
      <View>
        <BotMark bot={bot} dark={dark} size={36} />
        {main ? <Text style={[styles.mainBadge, { color: p.star }]}>★</Text> : null}
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowName, { color: p.ink }]} numberOfLines={1}>{bot.name}</Text>
        <Text style={[styles.rowPreview, { color: p.ink2 }]} numberOfLines={1}>{working ? 'Working…' : bot.role ?? ''}</Text>
      </View>
      {working ? <View style={[styles.unread, { backgroundColor: p.accent }]} /> : null}
    </Pressable>
  );
}

function RoomRow({ room, working, palette: p, onPress }: { room: Room; working: boolean; palette: Palette; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? p.hover : 'transparent' }]}>
      <View style={[styles.roomMark, { backgroundColor: p.tagBg }]}>
        <Text style={{ color: p.tagInk, fontSize: 15 }}>≡</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowName, { color: p.ink }]} numberOfLines={1}>{room.name}</Text>
        <Text style={[styles.rowPreview, { color: p.ink2 }]} numberOfLines={1}>{working ? 'Working…' : room.preview ?? ''}</Text>
      </View>
      {working ? <View style={[styles.unread, { backgroundColor: p.accent }]} /> : null}
    </Pressable>
  );
}

function TeamScreen({ team, online, error, palette: p, dark, onOpenChat }: { team: TeamState | null; online: boolean; error: string | null; palette: Palette; dark: boolean; onOpenChat: (bot: Bot) => void }) {
  const mains = new Set(team?.mainBotIds ?? []);
  const work = team?.work?.bots ?? {};
  const rooms = team?.rooms ?? [];
  const data: { key: string; node: ReactNode }[] = [
    ...(team?.bots ?? []).map(bot => ({ key: `bot-${bot.id}`, node: <BotRow bot={bot} main={mains.has(bot.id)} working={work[bot.id] !== undefined} palette={p} dark={dark} onPress={() => onOpenChat(bot)} /> })),
    ...rooms.map(room => ({ key: `room-${room.id}`, node: <RoomRow room={room} working={false} palette={p} onPress={() => undefined} /> })),
  ];
  return (
    <View style={[styles.listScreen, { backgroundColor: p.main }]}>
      <View style={[styles.teamHeader, { borderBottomColor: p.line }]}>
        <Text style={[styles.teamTitle, { color: p.ink }]}>Bots</Text>
        <Text style={{ color: online ? p.green : error !== null ? p.danger : p.ink3, fontSize: 13 }}>{online ? 'Connected' : 'Connecting…'}</Text>
      </View>
      {error ? <Text style={[styles.hint, { color: p.danger, paddingHorizontal: 20 }]} accessibilityRole="alert">{error}</Text> : null}
      <FlatList style={styles.list} data={data} keyExtractor={item => item.key}
        renderItem={({ item }) => item.node}
        ListEmptyComponent={team === null ? <ActivityIndicator style={styles.gap} color={p.accent} /> : <Text style={[styles.hint, { color: p.ink2 }]}>No Bots yet</Text>} />
    </View>
  );
}

function SettingsScreen({ computer, online, error, palette: p, onForget }: { computer: SavedComputer; online: boolean; error: string | null; palette: Palette; onForget: () => void }) {
  return (
    <View style={[styles.listScreen, { backgroundColor: p.main }]}>
      <View style={[styles.teamHeader, { borderBottomColor: p.line }]}>
        <Text style={[styles.teamTitle, { color: p.ink }]}>Settings</Text>
      </View>
      <View style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
        <Text style={{ color: p.ink2, fontSize: 12 }}>COMPUTER</Text>
        <Text style={{ color: p.ink, fontSize: 15, marginTop: 4 }}>{computer.name || computer.hostDeviceId}</Text>
        <Text style={{ color: online ? p.green : p.ink2, fontSize: 13, marginTop: 8 }}>{online ? 'Connected' : 'Not connected'}</Text>
        {error ? <Text style={{ color: p.danger, fontSize: 13, marginTop: 8 }}>{error}</Text> : null}
      </View>
      <Pressable accessibilityRole="button" onPress={onForget} style={[styles.card, { backgroundColor: p.card, borderColor: p.line }]}>
        <Text style={{ color: p.danger, fontSize: 15 }}>Forget this computer</Text>
      </Pressable>
    </View>
  );
}

function TabBar({ route, palette: p, onTab }: { route: string; palette: Palette; onTab: (tab: 'team' | 'settings') => void }) {
  const tab = (name: 'team' | 'settings', label: string, icon: string) => (
    <Pressable accessibilityRole="button" onPress={() => onTab(name)} style={styles.tab}>
      <Text style={{ color: route === name ? p.accent : p.ink3, fontSize: 20 }}>{icon}</Text>
      <Text style={{ color: route === name ? p.accent : p.ink3, fontSize: 11, marginTop: 1 }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={[styles.tabBar, { backgroundColor: p.sidebar, borderTopColor: p.line }]}>
      {tab('team', 'Bots', '◐')}
      {tab('settings', 'Settings', '⚙')}
    </View>
  );
}

function LinkedApp({ computer, identity, dark, onForget }: { computer: SavedComputer; identity: PhoneIdentity; dark: boolean; onForget: () => void }) {
  const [route, setRoute] = useState<{ name: 'team' | 'settings' } | { name: 'chat'; bot: Bot }>({ name: 'team' });
  const link = useTeamLink(computer, identity);
  const p = palette(dark, link.team?.prefs?.theme, link.team?.prefs?.accent);

  if (route.name === 'chat') {
    return (
      <ChatScreen client={link.clientRef.current} bot={route.bot} team={link.team ?? {}} palette={p} dark={dark}
        onBack={() => setRoute({ name: 'team' })} call={link.call} />
    );
  }
  return (
    <>
      {route.name === 'settings'
        ? <SettingsScreen computer={computer} online={link.online} error={link.error} palette={p}
            onForget={() => { onForget(); }} />
        : <TeamScreen team={link.team} online={link.online} error={link.error} palette={p} dark={dark}
            onOpenChat={bot => setRoute({ name: 'chat', bot })} />}
      <TabBar route={route.name} palette={p} onTab={tab => setRoute({ name: tab })} />
    </>
  );
}

export default function App() {
  const dark = useColorScheme() === 'dark';
  const p = palette(dark);
  const [identity, setIdentity] = useState<PhoneIdentity | null>(null);
  const [computer, setComputer] = useState<SavedComputer | null | undefined>(undefined);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([loadIdentity(), loadComputer()])
      .then(([nextIdentity, saved]) => { setIdentity(nextIdentity); setComputer(saved ?? null); })
      .catch(failure => setBootError(errorText(failure)));
  }, []);

  const forget = useCallback(() => {
    void forgetComputer().then(() => setComputer(null));
  }, []);

  let body;
  if (bootError !== null) body = <View style={[styles.center, { backgroundColor: p.main }]}><Text style={[styles.hint, { color: p.danger }]}>{bootError}</Text></View>;
  else if (identity === null || computer === undefined) body = <View style={[styles.center, { backgroundColor: p.main }]}><ActivityIndicator color={p.accent} /></View>;
  else if (computer === null) body = <PairScreen identity={identity} onPaired={setComputer} palette={p} />;
  else body = <LinkedApp computer={computer} identity={identity} dark={dark} onForget={forget} />;
  return <View style={[styles.app, { backgroundColor: p.main }]}>{body}<StatusBar style={dark ? 'light' : 'dark'} /></View>;
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 26, fontWeight: '600', textAlign: 'center' },
  hint: { marginTop: 12, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  camera: { marginTop: 20, width: 260, height: 260, borderRadius: 16, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  pairRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, alignSelf: 'stretch' },
  input: { flex: 1, height: 44, borderRadius: 10, paddingHorizontal: 12, fontSize: 15 },
  button: { height: 44, borderRadius: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  gap: { marginTop: 20 },
  list: { flex: 1 },
  listScreen: { flex: 1 },
  teamHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 60, paddingBottom: 10, paddingHorizontal: 20, borderBottomWidth: StyleSheet.hairlineWidth },
  teamTitle: { fontSize: 22, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, paddingVertical: 7, paddingHorizontal: 16 },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 14, lineHeight: 20 },
  rowPreview: { fontSize: 13, lineHeight: 18 },
  mainBadge: { position: 'absolute', right: -4, bottom: -4, fontSize: 14 },
  roomMark: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  unread: { width: 8, height: 8, borderRadius: 4 },
  card: { marginHorizontal: 16, marginTop: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  tabBar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6, paddingBottom: 24 },
  tab: { flex: 1, alignItems: 'center' },
});

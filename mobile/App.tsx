import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { parsePairingUri, type RpcClient } from '../link/src/index.ts';
import { callBot, openLink, type Bot, type TeamState } from './src/connection.ts';
import { forgetComputer, loadComputer, loadIdentity, saveComputer, type PhoneIdentity, type SavedComputer } from './src/store.ts';

const POLL_MS = 3_000;
const RETRY_MS = 2_000;

function usePalette() {
  const dark = useColorScheme() === 'dark';
  return {
    dark,
    paper: dark ? '#111' : '#fff',
    card: dark ? '#1c1c1e' : '#f4f4f5',
    ink: dark ? '#f2f2f2' : '#1a1a1a',
    soft: dark ? '#a1a1aa' : '#71717a',
    accent: '#4d6bfe',
    danger: '#e02135',
  };
}
type Palette = ReturnType<typeof usePalette>;

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

function PairScreen({ identity, onPaired, palette }: { identity: PhoneIdentity; onPaired: (computer: SavedComputer) => void; palette: Palette }) {
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
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.screen, { backgroundColor: palette.paper }]}>
      <Text style={[styles.title, { color: palette.ink }]}>Pair with your computer</Text>
      <Text style={[styles.hint, { color: palette.soft }]}>On the computer, open DS Bot, go to Settings → Phone and show a QR code. Then scan it here.</Text>
      <View style={[styles.camera, { backgroundColor: palette.card }]}>
        {permission?.granted
          ? <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={busy ? undefined : ({ data }) => void pair(data)} />
          : <Pressable accessibilityRole="button" onPress={() => void requestPermission()} style={[styles.button, { backgroundColor: palette.accent }]}><Text style={styles.buttonText}>Use the camera</Text></Pressable>}
      </View>
      <Text style={[styles.hint, { color: palette.soft }]}>No camera? Paste the pairing link.</Text>
      <View style={styles.row}>
        <TextInput value={link} onChangeText={setLink} placeholder="dsbot://pair?…" placeholderTextColor={palette.soft} autoCapitalize="none" autoCorrect={false}
          returnKeyType="go" onSubmitEditing={() => { if (link.trim() !== '') void pair(link); }}
          style={[styles.input, { color: palette.ink, backgroundColor: palette.card }]} accessibilityLabel="Pairing link" />
        <Pressable accessibilityRole="button" disabled={busy || link.trim() === ''} onPress={() => void pair(link)}
          style={[styles.button, { backgroundColor: palette.accent, opacity: busy || link.trim() === '' ? 0.5 : 1 }]}>
          <Text style={styles.buttonText}>Pair</Text>
        </Pressable>
      </View>
      {busy ? <ActivityIndicator style={styles.gap} color={palette.accent} /> : null}
      {error ? <Text style={[styles.hint, { color: palette.danger }]} accessibilityRole="alert">{error}</Text> : null}
    </KeyboardAvoidingView>
  );
}

function BotRow({ bot, main, palette }: { bot: Bot; main: boolean; palette: Palette }) {
  return (
    <View style={[styles.bot, { backgroundColor: palette.card }]}>
      <View style={[styles.avatar, { backgroundColor: palette.accent }]}><Text style={styles.avatarText}>{bot.name.slice(0, 1).toUpperCase()}</Text></View>
      <View style={styles.botCopy}>
        <Text style={[styles.botName, { color: palette.ink }]}>{bot.name}{main ? '  ★' : ''}</Text>
        {bot.role ? <Text style={[styles.botRole, { color: palette.soft }]}>{bot.role}</Text> : null}
      </View>
    </View>
  );
}

function TeamScreen({ identity, computer, onForget, palette }: { identity: PhoneIdentity; computer: SavedComputer; onForget: () => void; palette: Palette }) {
  const [team, setTeam] = useState<TeamState | null>(null);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let client: RpcClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = (run: () => void, ms: number) => { if (!stopped) timer = setTimeout(run, ms); };
    const poll = async () => {
      if (stopped || client === undefined) return;
      try {
        setTeam(await callBot<TeamState>(client, 'state', {}));
        setError(null);
        later(() => void poll(), POLL_MS);
      } catch (failure) {
        setError(errorText(failure));
      }
    };
    const connect = async () => {
      try {
        client = await openLink(computer, identity);
        if (stopped) { void client.close(); return; }
        setOnline(true);
        setError(null);
        client.onClose(() => {
          setOnline(false);
          client = undefined;
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
    return () => { stopped = true; clearTimeout(timer); void client?.close(); };
  }, [computer, identity]);

  const mains = new Set(team?.mainBotIds ?? []);
  return (
    <View style={[styles.screen, styles.top, { backgroundColor: palette.paper }]}>
      <Text style={[styles.title, { color: palette.ink }]}>{computer.name || 'Computer'}</Text>
      {error === null || online ? <Text style={[styles.hint, { color: online ? palette.soft : palette.danger }]}>{online ? 'Connected' : 'Connecting…'}</Text> : null}
      {error ? <Text style={[styles.hint, { color: palette.danger }]} accessibilityRole="alert">{error}</Text> : null}
      <FlatList style={styles.list} data={team?.bots ?? []} keyExtractor={bot => bot.id}
        renderItem={({ item }) => <BotRow bot={item} main={mains.has(item.id)} palette={palette} />}
        ListEmptyComponent={team === null ? error !== null ? undefined : <ActivityIndicator style={styles.gap} color={palette.accent} /> : <Text style={[styles.hint, { color: palette.soft }]}>No Bots yet</Text>} />
      <Pressable accessibilityRole="button" onPress={onForget} style={styles.gap}><Text style={{ color: palette.danger }}>Forget this computer</Text></Pressable>
    </View>
  );
}

export default function App() {
  const palette = usePalette();
  const [identity, setIdentity] = useState<PhoneIdentity | null>(null);
  const [computer, setComputer] = useState<SavedComputer | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([loadIdentity(), loadComputer()])
      .then(([nextIdentity, saved]) => { setIdentity(nextIdentity); setComputer(saved ?? null); })
      .catch(failure => setError(errorText(failure)));
  }, []);

  const forget = useCallback(() => { void forgetComputer().then(() => setComputer(null)); }, []);

  let body;
  if (error) body = <View style={[styles.screen, { backgroundColor: palette.paper }]}><Text style={[styles.hint, { color: palette.danger }]}>{error}</Text></View>;
  else if (identity === null || computer === undefined) body = <View style={[styles.screen, { backgroundColor: palette.paper }]}><ActivityIndicator color={palette.accent} /></View>;
  else if (computer === null) body = <PairScreen identity={identity} onPaired={setComputer} palette={palette} />;
  else body = <TeamScreen identity={identity} computer={computer} onForget={forget} palette={palette} />;
  return <>{body}<StatusBar style="auto" /></>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  top: { justifyContent: 'flex-start', paddingTop: 72 },
  title: { fontSize: 26, fontWeight: '600', textAlign: 'center' },
  hint: { marginTop: 12, fontSize: 15, textAlign: 'center' },
  camera: { marginTop: 20, width: 260, height: 260, borderRadius: 16, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, alignSelf: 'stretch' },
  input: { flex: 1, height: 44, borderRadius: 10, paddingHorizontal: 12, fontSize: 15 },
  button: { height: 44, borderRadius: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  gap: { marginTop: 20 },
  list: { alignSelf: 'stretch', marginTop: 20 },
  bot: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, marginBottom: 8 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  botCopy: { flex: 1 },
  botName: { fontSize: 16, fontWeight: '500' },
  botRole: { marginTop: 2, fontSize: 13 },
});

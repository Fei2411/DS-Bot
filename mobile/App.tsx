import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, useColorScheme, View } from 'react-native';

export default function App() {
  const dark = useColorScheme() === 'dark';
  const color = dark ? '#f2f2f2' : '#1a1a1a';
  return (
    <View style={[styles.screen, { backgroundColor: dark ? '#111' : '#fff' }]}>
      <Text style={[styles.title, { color }]}>DS Bot</Text>
      <Text style={[styles.hint, { color }]}>Pair with your computer to reach your Bot team.</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 28, fontWeight: '600' },
  hint: { marginTop: 12, fontSize: 15, opacity: 0.7, textAlign: 'center' },
});

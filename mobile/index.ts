import './src/polyfills';
import { registerRootComponent } from 'expo';
import { AppRegistry, Platform } from 'react-native';

import App from './App';
import { runBackgroundTask } from './src/team/background-task.ts';

if (Platform.OS === 'android' && typeof AppRegistry.registerHeadlessTask === 'function') {
  AppRegistry.registerHeadlessTask('DsBotBackgroundTask', () => runBackgroundTask);
}

registerRootComponent(App);

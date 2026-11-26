import { Alert } from 'react-native'
import { t } from '../ui/i18n.ts'

export function confirmDanger(title: string, action: string, onConfirm: () => void, message?: string) {
  Alert.alert(title, message, [
    { text: t('Cancel'), style: 'cancel' },
    { text: action, style: 'destructive', onPress: onConfirm },
  ])
}

const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const config = getDefaultConfig(__dirname)
// link/: the shared link layer; ds-bot/: the team's themes and characters are
// imported straight from src/client so the app keeps the desktop look.
config.watchFolders = [path.resolve(__dirname, '../link'), path.resolve(__dirname, '../ds-bot/src/client')]
module.exports = config

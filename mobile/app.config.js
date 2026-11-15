// The phone app ships with DS Bot and carries its version. Android installs an update
// only over a lower versionCode, so the code grows with the version, and a pre-release
// (0.4.0-rc.1) stays below its release (0.4.0).
const { version } = require('../ds-bot/package.json')

function versionCode(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?$/.exec(text)
  if (match === null) throw new Error(`app.config: cannot make an Android versionCode from ${text}`)
  const [, major, minor, patch, pre] = match.map(Number)
  if (minor > 999 || patch > 999 || pre > 98) throw new Error(`app.config: ${text} is out of the versionCode range`)
  return ((major * 1000 + minor) * 1000 + patch) * 100 + (match[4] === undefined ? 99 : pre)
}

module.exports = ({ config }) => ({
  ...config,
  version,
  android: { ...config.android, versionCode: versionCode(version) },
  ios: { ...config.ios, buildNumber: version },
})
module.exports.versionCode = versionCode

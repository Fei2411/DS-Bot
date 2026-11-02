// Released macOS and deb clients require the legacy asset name before showing an update.
// Publish an alias of the new payload as well; all normal downloads use DS-Bot-*.
import { copyFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { LEGACY_ARTIFACT_PREFIX } from '../src/legacy.mjs'

for (const file of process.argv.slice(2)) {
  const name = basename(file)
  if (!/^DS-Bot-.+-(?:mac-(?:arm64|x64)\.zip|linux-amd64\.deb)$/u.test(name)) throw new Error(`Unsupported release alias: ${name}`)
  const alias = join(dirname(file), name.replace(/^DS-Bot/u, LEGACY_ARTIFACT_PREFIX))
  copyFileSync(file, alias)
  console.log(alias)
}

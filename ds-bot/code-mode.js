import semver from 'semver'
import host from '@deepseek-ai/dsh-tools/package.json' with { type: 'json' }

const minimum = '0.2.2-rc.1'
const required = ['@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-tool-executor-ptc', '@deepseek-ai/dsh-ptc-runtime', '@deepseek-ai/schemastery']
const missing = required.filter(name => {
  try {
    import.meta.resolve(name)
    return false
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return true
  }
})
const requirement = `DS Bot code-mode requires DSH >= ${minimum}; host @deepseek-ai/dsh-tools is ${host.version}`
if (missing.length > 0 || semver.lt(host.version, minimum)) {
  throw new Error(`${requirement}${missing.length > 0 ? `; missing packages: ${missing.join(', ')}` : ''}`)
}

const implementation = await import('./src/host/code-mode.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
  throw new Error(`${requirement}; ${error.message}`, { cause: error })
})

export const { name, inject, Config, apply, createFallbackExecutor } = implementation

// Registers the ds-bot harness module-resolution hook before any test file in this
// process imports a ds-bot module that names @deepseek-ai peers. ESM static imports are
// hoisted, so a test cannot import this after the ds-bot module itself — it must come
// through an awaited side-effect import placed before the rest.
import '../../ds-bot/test/harness-resolve.mjs'

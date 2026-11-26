// A Bot runs inside the desktop app, so a plain `npm test` inherits the app's own runtime
// environment: its port, its profile and the packaged runtime it ships. The suite has to answer
// the same everywhere, and CI has none of these, so they are removed before any test file loads.
// A test that needs one sets it itself; DS_BOT_PORT alone used to break the first-run check, and
// DS_BOT_RUNTIME_DIR alone broke the Office overlay tests.
const APP_RUNTIME_ENVIRONMENT = [
  'DS_BOT_APP',
  'DS_BOT_COMPUTER_HELPER_HOME',
  'DS_BOT_OFFICE_NODE',
  'DS_BOT_PORT',
  'DS_BOT_RUNTIME_DIR',
  'DS_BOT_USER_DSH_HOME',
  'DS_BOT_WORKSPACE',
  'DSH_HARNESS',
  'DSH_HOME',
  'DSH_PROFILE',
  'DSH_PROFILE_DIR',
  'DSH_SESSION_ID',
  'DSH_SHELL',
  'DSH_WEB_URL',
]

for (const name of APP_RUNTIME_ENVIRONMENT) delete process.env[name]

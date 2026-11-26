# Telemetry and Privacy Controls

- Date: 2026-11-25
- Code: `ds-bot/src/host/telemetry.js`, `ds-bot/src/client/privacy-page.js`, `app/src/main.mjs`, `telemetry/`

## Why

1. **DSH upstream telemetry safeguards**: DeepSeek Harness (`@deepseek-ai/dsh`) ships `session-log-deepseek` enabled by default on official DeepSeek API requests, plus `session-telemetry-otel` (`FEEDBACK_ONLY`). In DS Bot:
   - `session-log-deepseek` reads canonical session events after `secrets.js` redacts outbound `llm/stream` messages, risking unredacted user messages and exposing local `cwd` paths. Private Bots were also not excluded.
   - `session-telemetry-otel` ships with no default redaction listeners on `session-telemetry/record`.
   - The DSH session-log toggle was buried inside `Settings → General → Advanced`.
2. **Privacy-first DS Bot telemetry**: Maintainers need aggregate adoption (DAU/WAU/MAU, version/OS distribution), coarse built-in feature usage, and structured crash/error fingerprints to prioritize bug fixes and roadmap work — without collecting any user content, private Bot activity, hardware fingerprints, or IP addresses.

## Decided Behavior

### 1. Hard Privacy Red Lines

1. **Zero content**: Never collect chat text, prompts, memories, Bot names or instructions, file paths, URLs, shell commands, tool arguments, API keys, secrets, connector account identifiers, custom provider URLs, or custom plugin/MCP names.
2. **Zero private Bot participation**: Private Bots (and deleted private Bot archives) are completely excluded from DSH session-log uploads, DSH feedback telemetry, DS Bot usage counts/buckets, and DS Bot error reports.
3. **No long-term user tracking, zero server IP retention**:
   - Local random UUID v4 (`anon_id`) rotates automatically on the 1st of each UTC month and can be reset manually at any time.
   - The Cloudflare Worker (`telemetry.dsbot.app`) never reads, logs, or stores `CF-Connecting-IP`, `User-Agent`, `Referer`, or cookies.
4. **Daily aggregates only — no real-time event stream**: Usage data is aggregated locally into at most one daily snapshot per UTC day using coarse buckets and built-in enum allowlists.
5. **Structured error fingerprints only — no raw `error.message`**: Automatic error reports contain only `source`, `error_name`, safe `error_code`, module `where`, and strictly sanitized relative stack frames (`ds-bot/`, `app/`, `link/`, `mobile/` only; all host filesystem prefixes and third-party frames stripped). Free-text `error.message` is never accepted by either the client serializer or the server validator.
6. **Radical transparency and easy opt-out**:
   - Nothing is sent until the user explicitly confirms the first-run/upgrade privacy notice card.
   - The notice card presents two independent switches: **Anonymous usage statistics** (checked by default) and **Anonymous error reports** (unchecked by default), plus a one-click **Turn all off** button.
   - Settings → **About DS Bot → Privacy** exposes all toggles, a live **Recently sent data** JSON inspector (last 20 payloads stored locally), and an **Anonymous ID** reset button.
   - Environment kill switches: any non-empty `DS_BOT_TELEMETRY_DISABLED` or `DO_NOT_TRACK=1` / `DO_NOT_TRACK=true` hard-disables all DS Bot telemetry.

### 2. DSH Upstream Safeguards (No DSH Patching)

- **`session-log-deepseek`**: `ds-bot/src/host/telemetry.js` registers a `ctx.sessionLogDeepSeek.registerExclusion()` predicate. Uploads are excluded by default (`dshSessionLog: false`) and **permanently excluded** for all private Bots even if the user enables `dshSessionLog` in Settings → Privacy.
- **`session-telemetry-otel`**:
  - Plugin layer registers a `session-telemetry/record` listener that withholds records when `dshFeedbackTelemetry !== true` or for private Bots, and applies `rt.redactSecrets` + `cleanText` scrubbing to any allowed record.
  - Desktop app (`app/src/main.mjs`) passes `DSH_TELEMETRY_DISABLED=1` to the Host process unless `dshFeedbackTelemetry === true` (respecting any explicit user-provided `DSH_TELEMETRY_DISABLED` env var).
- **UI consolidation**: The DSH `session-log-deepseek` row is removed from `Settings → General → Advanced` and replaced by the explicit **DeepSeek Harness (Engine)** section in `Settings → About DS Bot → Privacy`.

### 3. Open-Source Collector (`telemetry/`)

- Deployed on Cloudflare Workers (`https://telemetry.dsbot.app/v1/collect`) backed by Cloudflare D1 (`telemetry/schema.sql`).
- Strict allowlist validator (`telemetry/src/validate.js`) enforces `<= 8 KiB` payload limit and rejects any unknown keys (`additionalProperties: false`), raw messages, or non-relative stack frames with HTTP `400`.
- Client sends one-way HTTPS POST with a 5-second timeout, silent failure, no retry storms, and no remote config/script execution.

## Non-goals

- No third-party analytics or crash SDKs (PostHog, Sentry, Amplitude, etc.).
- No automatic upload of full `diagnostics.jsonl` logs (manual preview-and-submit GitHub issues remain in Settings → Feedback).
- No telemetry settings exposure over remote browser links (`BROWSER_ALLOWED` stays local-only).

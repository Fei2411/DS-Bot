-- Privacy-first anonymous telemetry schema for DS Bot (Cloudflare D1).
-- Never stores IP addresses, User-Agent strings, chat content, file paths, or error messages.

CREATE TABLE IF NOT EXISTS daily_pings (
  day TEXT NOT NULL,
  anon_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  dsh_version TEXT NOT NULL,
  surface TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  locale TEXT NOT NULL,
  is_first_day INTEGER NOT NULL DEFAULT 0,
  bot_count_bucket TEXT NOT NULL,
  group_count_bucket TEXT NOT NULL,
  turns_bucket TEXT NOT NULL,
  connectors_count_bucket TEXT NOT NULL,
  theme TEXT NOT NULL,
  layout TEXT NOT NULL,
  providers_json TEXT NOT NULL,
  local_agents_json TEXT NOT NULL,
  features_json TEXT NOT NULL,
  im_platforms_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, anon_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_pings_day ON daily_pings (day);
CREATE INDEX IF NOT EXISTS idx_daily_pings_version ON daily_pings (app_version, day);

CREATE TABLE IF NOT EXISTS error_reports (
  day TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  anon_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  dsh_version TEXT NOT NULL,
  surface TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  source TEXT NOT NULL,
  error_name TEXT NOT NULL,
  error_code TEXT NOT NULL,
  where_mod TEXT NOT NULL,
  stack_json TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, fingerprint, anon_id)
);

CREATE INDEX IF NOT EXISTS idx_error_reports_day ON error_reports (day);
CREATE INDEX IF NOT EXISTS idx_error_reports_fp ON error_reports (fingerprint, day);

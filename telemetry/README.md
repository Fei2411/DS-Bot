# DS Bot Telemetry Collector

Open-source Cloudflare Worker (`telemetry.dsbot.app`) that receives DS Bot's optional anonymous telemetry.

## Privacy Guarantees

- **Zero IP or header retention**: Never reads or stores `CF-Connecting-IP`, `X-Forwarded-For`, `User-Agent`, `Referer`, or cookies.
- **Strict allowlist schema**: Rejects any unexpected field, free-text error message, or absolute filesystem path with HTTP `400`.
- **One-way ingest**: Always returns `204 No Content` on accepted payloads; never returns remote config, experiments, or scripts.

## Example Analytics Queries (Cloudflare D1)

```sql
-- Daily Active Users (DAU) over the last 30 days
SELECT day, COUNT(DISTINCT anon_id) AS dau
FROM daily_pings
WHERE day >= date('now', '-30 days')
GROUP BY day
ORDER BY day DESC;

-- Weekly Active Users (WAU) in the last 7 days
SELECT COUNT(DISTINCT anon_id) AS wau
FROM daily_pings
WHERE day >= date('now', '-7 days');

-- Top errors by affected anonymous installs over the last 7 days
SELECT fingerprint, source, error_name, error_code, where_mod,
       COUNT(DISTINCT anon_id) AS affected, SUM(occurrences) AS total_hits
FROM error_reports
WHERE day >= date('now', '-7 days')
GROUP BY fingerprint
ORDER BY affected DESC, total_hits DESC
LIMIT 20;
```

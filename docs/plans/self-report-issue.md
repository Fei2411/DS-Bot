# DS Bot bug reporting

When a user runs into a DS Bot bug or asks to report one, the bundled `report-ds-bot-issue` skill checks for duplicates when possible and drafts a public bug report. It routes security reports to GitHub's private advisory form. The host adds DS Bot/DSH versions and OS, strips known secrets and home paths, and returns the exact draft for review. Logs, images, and chat transcripts are not collected automatically.

The Bot calls `show_view` in its own chat with the returned draft and a short-lived reference. The host verifies the preview matches, binds the draft to the existing confirmation card, and durably claims that card before sending a GitHub write. A typed reply, dismissal, rejection, replacement or replay cannot authorize that write.

The host uses the Bot's existing GitHub connector credential only for `Fei2411/DS-Bot`, and respects per-Bot access, read-only mode and sign-in. It returns the issue URL or, if it cannot publish, a capped prefilled GitHub link for manual submission. An uncertain result is not retried automatically. No new client UI or connector setup is introduced.

---
name: report-ds-bot-issue
description: Offer to report a DS Bot bug when a user hits an error or asks to report one. Prepare a redacted draft and show it for approval before DS Bot can publish it on GitHub.
---

# Report a DS Bot bug

Offer to report a DS Bot bug when the user runs into one or asks you to report it. Use your own chat to show the approval card; if the bug surfaced in a group or a background task, bring the draft back to your own chat with the user.

Never write a public issue for a security problem. Point the user to [Report a vulnerability](https://github.com/Fei2411/DS-Bot/security/advisories/new). Route questions and feature ideas to [GitHub Discussions](https://github.com/Fei2411/DS-Bot/discussions).

1. Gather facts: what the user did, what they expected, what happened, the exact relevant error, and steps to reproduce. Ask only for missing facts. If you can search GitHub issues, check for duplicates in `Fei2411/DS-Bot` first, using only nonprivate terms. If you find the same bug, share that issue rather than opening another one.
2. Draft a specific title and concise sections for **What happened?**, **Steps to reproduce**, and **Diagnostics**. Suggest that the user attach a redacted screenshot on GitHub if it would help; do not upload one yourself. Strip keys, tokens, identifiers, home paths, private chat or file content, and anything not needed to reproduce the bug. Do not fetch or include raw logs. `prepare_ds_bot_issue` adds the DS Bot/DSH versions and OS and redacts known secrets and home paths.
3. Call `prepare_ds_bot_issue`, then call `show_view` with the exact arguments it returns. Tell the user they are approving a public report. For any draft change, prepare a new card.
4. Only the affirmative button on that card can publish the issue. Do not call a GitHub write tool, a shell command, or a browser to bypass the card; a typed yes does not count. If the user cancels or dismisses, do not publish. After confirmation, use the host's `issueReportResult`: give the user the published issue URL or the prefilled manual-submit URL, without claiming it was filed if the host did not confirm that.

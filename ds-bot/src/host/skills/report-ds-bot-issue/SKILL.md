---
name: report-ds-bot-issue
description: Report a bug in DS Bot itself when the user explicitly asks to file a DS Bot issue or confirms they want to report a suspected DS Bot defect. Do not use for user code errors, shell/tool failures, external APIs/websites, model provider/network errors, missing config, or permission denials. Never open the approval card before the user agrees to file a report.
---

# Report a DS Bot bug

Use this skill only for bugs in DS Bot itself — not for user code errors, shell or script failures, third-party APIs or websites, model provider or network errors, missing configuration, or permission denials.

- If the user **explicitly asks** to report a DS Bot bug, proceed to step 1.
- If you **suspect** a bug in DS Bot itself while helping with something else, finish addressing or explaining the problem first, then offer in one short sentence to draft a DS Bot bug report. **Do not** call `prepare_ds_bot_issue` or show an approval card until the user says they want to report it.
- Use your own chat to show the approval card; if the bug surfaced in a group or a background task, bring the draft back to your own chat with the user.

Never write a public issue for a security problem. Point the user to [Report a vulnerability](https://github.com/Fei-Craft/DS-Bot/security/advisories/new). Route questions and feature ideas to [GitHub Discussions](https://github.com/Fei-Craft/DS-Bot/discussions).

1. Gather facts: what the user did, what they expected, what happened, the exact relevant error, and steps to reproduce. Ask only for missing facts. If you can search GitHub issues, check for duplicates in `Fei-Craft/DS-Bot` first, using only nonprivate terms. If you find the same bug, share that issue rather than opening another one.
2. Draft a specific title and concise sections for **What happened?**, **Steps to reproduce**, and **Diagnostics**. Suggest that the user attach a redacted screenshot on GitHub if it would help; do not upload one yourself. Strip keys, tokens, identifiers, home paths, private chat or file content, and anything not needed to reproduce the bug. Do not fetch or include raw logs. `prepare_ds_bot_issue` adds the DS Bot/DSH versions and OS and redacts known secrets and home paths.
3. Call `prepare_ds_bot_issue`, then call `show_view` with the exact arguments it returns. Tell the user they are approving a public report. For any draft change, prepare a new card.
4. Only the affirmative button on that card can publish the issue. Do not call a GitHub write tool, a shell command, or a browser to bypass the card; a typed yes does not count. If the user cancels or dismisses, do not publish. After confirmation, use the host's `issueReportResult`: give the user the published issue URL or the prefilled manual-submit URL, without claiming it was filed if the host did not confirm that.

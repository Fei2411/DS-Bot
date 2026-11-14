# Issue tracker: GitHub (fork)

Issues and specs for this fork live as GitHub issues on `rml4791lol-lang/DS-Bot`.

`Fei2411/DS-Bot` is the upstream project. Its issues are the upstream queue and this fork has read-only access there, so fork work is tracked on the fork. The repo's own `.agents/skills/issue-triage/` skill and `CONTRIBUTING.md` target upstream; that remains the upstream maintainer's process.

`gh` inside this clone resolves to the upstream parent, so pass `--repo rml4791lol-lang/DS-Bot` on every gh call.

## Conventions

- **Create an issue**: `gh issue create --repo rml4791lol-lang/DS-Bot --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo rml4791lol-lang/DS-Bot --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --repo rml4791lol-lang/DS-Bot --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo rml4791lol-lang/DS-Bot --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo rml4791lol-lang/DS-Bot --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo rml4791lol-lang/DS-Bot --comment "..."`

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42 --repo rml4791lol-lang/DS-Bot` and fall back to `gh issue view 42 --repo rml4791lol-lang/DS-Bot`. Only issues are a triage surface here.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this fork treats external PRs as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `rml4791lol-lang/DS-Bot`.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

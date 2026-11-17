# One place to change many Bots' model

- Date: 2026-11-13
- Related: Issue #1502

## Why

With many Bots, moving them to another model means opening each Bot's settings in
turn. When a plan runs out or the user changes provider, that is slow and easy to
miss a Bot.

## Decided behavior

- Settings gains a page, **Bot models**. It lists every Bot with the model it runs
  on: its pick, else the model it last ran on, else the team default.
- The user selects several Bots and picks one model once. Each selected Bot gets
  the same model change its own settings would make; there is no new host
  endpoint and no bulk state in the team.
- The picker lists DS Bot models only, because a model menu lists the Bot's own
  kind (see `2026-11-04-local-agents.md`, Run mode). A Bot on a local agent is
  listed with its model and a Local agent tag, and cannot be selected; how a Bot
  runs changes only in its own settings, after a confirmation.
- The change runs one Bot at a time. A failure on one Bot never stops the ones
  after it. After the run each Bot shows its own outcome: changed, already on
  this model, skipped (runs on a local agent / model not available now), or the
  error the host returned. A line above the list sums the run up, so no Bot is
  silently left out.
- A model the catalog no longer serves changes nothing: every selected Bot is
  reported as skipped instead. A Bot already on the picked model is reported as
  already using it, not as changed.
- Picking a model applies it at once, as it does in a Bot's own settings; there
  is no extra confirmation step.

## Assumptions

- The page lists all Bots in sidebar order and does not filter by section or
  group: the issue does not ask for it, and a filter can come later.
- Retrying a failed Bot means selecting it again; no separate retry action.
- The team default model (for new Bots) stays on the General page.

## Out of scope

- Changing models from a group chat's member panel (#1300): that is a group's
  members, a different scope.
- Moving a Bot between DS Bot models and a local agent CLI in bulk.
- Listing or changing the team default model here.

## Known limits

- A local agent Bot's model changes only in its own settings. The page says so
  on the row and in the summary.
- A DS Bot model whose provider has no API key can still be picked; the Bot's
  own chat then asks for the key, as it does after a pick in its settings.

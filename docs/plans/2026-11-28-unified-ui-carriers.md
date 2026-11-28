# Unified Frontend UI Carrier Architecture

Date: 2026-11-28

## Problem

As DS Bot expanded across `ds-bot/src/client/` and `app/ui/src/`, feature work repeatedly re-implemented the same interaction surfaces instead of composing from shared product-level carriers:

- **Cards**: `ActionCard`-like request prompts were written separately in `questions.js`, `secret-card.js`, `handoff-card.js`, `computer.js`, `work-pause-card.js`, `learning-card.js`, `approval-dock.js`, and `classic-questions.js`, while `ToolCardShell` lived in `app/ui/src/tool-view-shared.js`.
- **Top surfaces**: Connection status (`ConnectionBanner`), pending learning reviews (`PendingLearning`), memory updates (`MemoryNotice`), and group/task/approval pods (`GoalIsland`) each created separate top-of-chat popups or floating banners.
- **Sliders & controls**: Appearance sliders used bare `<input type="range">` while `EffortBar` built a custom spring pointer slider; switches (`role="switch"`), native `<select>`, and `SettingSection`/`SettingRow` were duplicated across `bot-settings.js`, `settings.js`, `cookie-import-ui.js`, `local-agents-page.js`, and `engine-settings.js`.
- **Dialogs & popovers**: Centered dialogs hand-rolled scrims, frameless top drag bands, Escape handling, and focus traps across `app/ui/src/` and `ds-bot/src/client/`.

## Solution: Single Canonical Carrier per Product Family

All shared carriers now live in `ds-bot/src/client/ui/` and are consumed by both the DSH plugin (`ds-bot/src/client/`) and the desktop app (`app/ui/src/`):

| Product family | Canonical module | Exports | Replaces |
|---|---|---|---|
| **Top surface / Notices** | `ds-bot/src/client/ui/island.js` | `DynamicIsland`, `IslandNotice`, `IslandPod`, `IslandPanel`, `IslandPager`, `ISLAND_CSS` | `GoalOutside`, standalone `ConnectionBanner`, floating `PendingLearning`, ad-hoc `MemoryNotice` chrome |
| **Interactive & tool cards** | `ds-bot/src/client/ui/card.js` | `ActionCard`, `SettledCard`, `CardShell`, `CardDock`, `CARD_CSS` | Duplicated card shells across `questions.js`, `secret-card.js`, `handoff-card.js`, `computer.js`, `work-pause-card.js`, `learning-card.js`, `approval-dock.js`, `classic-questions.js`, `tool-view-shared.js` |
| **Sliders (continuous + stepped)** | `ds-bot/src/client/ui/slider.js` | `Slider`, `SLIDER_CSS` | Bare `<input type="range">` in `appearance-page.js` and bespoke slider logic in `EffortBar` (`model-menu.js`) |
| **Centered modal dialogs** | `ds-bot/src/client/ui/dialog.js` | `Dialog`, `DIALOG_CSS` | Hand-rolled modal chrome in `engine-settings.js`, `classic-controls.js`, `classic-feedback.js`, `deepseek-account.js`, `shortcuts.js`, `release-notes-dialog.js`, `privacy-page.js` |
| **Anchored menus & collapse** | `ds-bot/src/client/ui/popover.js` | `PopoverMenu`, `useAnchoredMenu`, `useInlineMenu`, `Collapse`, `MENU_EXIT_MS` | Menu positioning & linger logic previously buried inside `model-menu.js` |
| **Settings & form controls** | `ds-bot/src/client/ui/controls.js` | `Switch`, `SwitchRow`, `InlineText`, `SettingSection`, `SettingCard`, `SettingRow`, `Choice`, `SelectMenu`, `Segmented`, `StatusAlert`, `EmptyState`, `SearchInput`, `CONTROLS_CSS` | Private `SetSection`/`SetRow`/`Choice` in `settings.js`, `EngineSection`/`EngineRow` in `engine-settings.js`, bare switch in `cookie-import-ui.js`, native `<select>` in `local-agents-page.js` |

### Built-in Invariants

1. **Motion baked into carriers**: `DynamicIsland`, `ActionCard`, `Slider`, `Dialog`, `PopoverMenu`, `Switch`, and `Segmented` use `motion.js` springs (`SPRING_SHAPE`, `SPRING_TAP`, `SPRING_STRETCH`, `SPRING_POP`) and `useLinger` exit timing out of the box.
2. **Frameless window drag band**: `Dialog` automatically renders `data-bt-dialog-mask` with the macOS/Windows frameless caption drag band (`html[data-windows-titlebar]:not([data-fullscreen])`), Escape priority (`useEscape`), and optional focus trap (`useModalFocusTrap`).
3. **One top surface**: `DynamicIsland` hosts the active chat identity, goal progress, pending approvals, background tasks, pending learning proposals (`LearningIslandPod`), memory notices (`IslandNotice`), and connection status (`ConnectionIslandPod`) in one morphing top pill.

## CI Enforcement

`ds-bot/scripts/ui-architecture-guard.mjs` + `ds-bot/test/ui-architecture-guard.test.js` runs inside `npm test` with a ratchet-down-only baseline (`ds-bot/test/ui-architecture-debt.json`):

- **Zero-tolerance categories (0 baseline)**: bare `role="switch"`, bare `type="range"` / `role="slider"`, bare `h('select')`, and ad-hoc top banners outside `DynamicIsland`.
- **Ratchet-down categories**: legacy complex dialogs (`Settings`, `Memory`, `Palette`, `Voice`, etc.), legacy card shells, and legacy `cubic-bezier(...)` curves cannot increase; removing one requires lowering the baseline via `node scripts/ui-architecture-guard.mjs --write`.

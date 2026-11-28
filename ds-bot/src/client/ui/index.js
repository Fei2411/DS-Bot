// Single canonical entry point for DS Bot's unified UI carriers and primitives.
//
// Product-level carriers:
// - DynamicIsland (`island.js`): the ONE top floating morphing surface for all top notices, pods & dropdown panels
// - ActionCard / SettledCard / CardShell / CardDock (`card.js`): the ONE card family for all interactive & tool cards
// - Slider (`slider.js`): the ONE continuous + discrete-stop slider
// - Dialog (`dialog.js`): the ONE centered modal dialog (with automatic frameless top drag band & Escape stack)
// - PopoverMenu / useAnchoredMenu / useInlineMenu / Collapse (`popover.js`): the ONE anchored popover & menu layer
// - Controls (`controls.js`): Switch, SwitchRow, SettingSection, SettingCard, SettingRow, Choice, SelectMenu, Segmented, InlineText, StatusAlert, EmptyState, SearchInput
// - Motion (`../motion.js`): SPRING_*, spring, liveSprings, useGlide, useMorph, useFlip, useLinger, stepMenuFocus
import { CARD_CSS } from './card.js'
import { CONTROLS_CSS } from './controls.js'
import { DIALOG_CSS } from './dialog.js'
import { ISLAND_CSS } from './island.js'
import { SLIDER_CSS } from './slider.js'

export { DynamicIsland, IslandNotice, IslandPager, IslandPanel, IslandPod, ISLAND_CSS } from './island.js'
export { ActionCard, CardDock, CardShell, SettledCard, CARD_CSS } from './card.js'
export { Slider, SLIDER_CSS } from './slider.js'
export { Dialog, DIALOG_CSS } from './dialog.js'
export { Collapse, MENU_EXIT_MS, PopoverMenu, useAnchoredMenu, useInlineMenu } from './popover.js'
export { Choice, EmptyState, InlineText, SearchInput, Segmented, SelectMenu, SettingCard, SettingRow, SettingSection, StatusAlert, Switch, SwitchRow, CONTROLS_CSS } from './controls.js'
export {
  QUICK_EDGES,
  SPRING_GLIDE,
  SPRING_LEAD,
  SPRING_LIST,
  SPRING_POP,
  SPRING_SHAPE,
  SPRING_SLIDE,
  SPRING_STRETCH,
  SPRING_TAP,
  SPRING_TRAIL,
  effectsTier,
  fitSegmented,
  liveSprings,
  noHover,
  reducedEffects,
  reducedMotion,
  spring,
  springEasing,
  stepMenuFocus,
  useFlip,
  useGlide,
  useLinger,
  useMorph,
  useViewport,
  viewBottom,
} from '../motion.js'

export const UI_CSS = ISLAND_CSS + CARD_CSS + SLIDER_CSS + DIALOG_CSS + CONTROLS_CSS

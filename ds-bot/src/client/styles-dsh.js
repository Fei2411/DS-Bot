// Plugin-only CSS overrides and DSH custom-property bridges.
// Loaded only by the DSH plugin entry (`ds-bot/src/client/index.js`);
// never imported by the desktop app (`app/ui/src/main.js`).
import { DSH_NARROW } from './frame-layout.js'
import { SPRING_POP, SPRING_SLIDE, SPRING_TAP, spring } from './motion.js'
import { REPLY_FAMILY } from '../shared/reply-fonts.js'
import { SERIF_REPLIES } from './themes.js'

// Maps DSH's private `--dsh-*` tokens onto DS Bot's `--bt-*` contract at the exact
// DOM element level where DSH declares each token (CSS custom properties resolve var()
// on the declaring element before inheritance), and adapts DSH's own shell frame.
export const DSH_SHELL_CSS = `
:root{--bt-chrome-top:var(--dsh-frame-chrome-top,0px);--bt-top-clearance:var(--dsh-frame-top-clearance,var(--dsh-windows-titlebar-height,0px));--bt-overlay-top:var(--dsh-frame-overlay-top,32px);--bt-titlebar-h:var(--dsh-windows-titlebar-height,0px);--bt-reply-font-default:var(--dsh-font-family-text-default,sans-serif)}
html body{--bt-content-fs:var(--dsh-content-font-size,14px);--bt-reply-font:var(--dsh-font-family-text);--bt-mono:var(--dsh-font-family-code,var(--dsh-font-mono,ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace))}
[class*="_body"],[class*="_embeddedBody"]{--bt-chat-w:var(--dsh-chat-content-width,748px);--bt-composer-max-w:var(--dsh-composer-card-max-width,748px);--bt-composer-side:var(--dsh-composer-side-clearance,0px);--bt-composer-dock-inset:var(--dsh-composer-dock-inset,8px)}
[class*="_composerStack"]{--bt-composer-gap:var(--dsh-composer-stack-gap,8px)}
[data-chat-flow],[data-chat-flow]>*,[data-chat-group-key]{--bt-flow-gap:var(--dsh-chat-flow-gap,12px)}
@media (prefers-reduced-motion:reduce){[class*="_centerCol"]{transition:none}}
@media (min-width:${DSH_NARROW}px){
[class*="_frame"][data-sidebar-collapsed][data-rightbar-collapsed]:has(>[class*="_sidebarCol"]){grid-template-columns:0px minmax(0,1fr) 0px!important}
}
@media (max-width:${DSH_NARROW - 1}px){
[class*="_frame"][data-sidebar-collapsed][data-rightbar-collapsed]:has(>[class*="_centerCol"] .bt-head){grid-template-columns:0px minmax(0,1fr) 0px!important}
[class*="_frame"][data-sidebar-collapsed][data-rightbar-collapsed]:has(>[class*="_centerCol"] .bt-head)>[class*="_centerCol"]{grid-column:2!important;width:auto!important}
}
html[data-bt-collapsing] [class*="_frame"]:has(>[class*="_sidebarCol"]){transition:none!important}
.bt-bubble [class*="_markdown"]>*+*{margin-top:10px}
.bt-bubble [class*="_markdown"]{color:inherit!important;font-size:inherit!important;line-height:inherit!important}
.bt-bubble [class*="_markdown"] li+li{margin-top:6px}
.bt-bubble [class*="_markdown"] li::marker{color:var(--bt-ink-2)}
.bt-bubble [class*="_markdown"] :not(pre)>code{line-height:1;-webkit-box-decoration-break:clone;box-decoration-break:clone}
[data-chat-flow] [class*="_bubble"] :is(img,video){max-width:100%;height:auto}
[class*="_centerCol"]{transition:margin-right ${SPRING_SLIDE.duration}ms ${SPRING_SLIDE.easing}}
.bt-settings-icon>[data-slot="settings.section.icon"]>svg{display:block!important}
.bt-dsh-section>[data-slot]>*>h2:first-child,.bt-dsh-section>[data-slot]>*>:first-child>h2:first-child{display:none}
.bt-dsh-item>[data-slot]>*{padding-left:16px;padding-right:16px;border-bottom-width:0}
.bt-dsh-item>[data-slot]>.bt-set-row{padding:12px 16px}
.bt-dsh-item:has(>[data-slot]:empty){display:none}
.bt-dsh-item[data-item=appearance]>[data-slot]>*>:first-child{display:none}
[class*="_newSession"],nav[class*="_panelList"],[class*="_logoRow"]>[class*="_brand"],[class*="_logoRow"]:not(:has([class*="_toggle"])){display:none!important}
html:not([data-windows-titlebar]) :not([class*="_collapsed"])>[class*="_logoRow"]{display:none!important}
html[data-windows-titlebar] :not([class*="_collapsed"])>[class*="_logoRow"]{height:0!important;margin:0!important}
/* Hide DSH's own sidebar toggles everywhere they mount: logoRow, macOS topStrip, and the
   shell.leading seat (narrow drawers <768px and collapsed macOS frames, which also carries
   DSH's New Session button on desktop). Left visible, the leading opener bleeds through
   translucent Bot sidebars and stays underneath our top buttons. */
[class*="_logoRow"]>[class*="_toggle"],[class*="_topStrip"]>[class*="_toggle"],[data-shell-leading],[data-sidebar-opener]{display:none!important}
[class*="_footArea"]{grid-template-columns:auto minmax(0,1fr);grid-auto-flow:row dense;align-items:center;gap:4px 9px;padding:8px 6px 6px!important}
html:not([data-windows-titlebar]) [class*="_footArea"],:not([class*="_collapsed"])>[class*="_footArea"]{display:grid!important}
[class*="_footArea"]>[class*="_footerActions"],[class*="_footArea"]>[class*="_footerActions"]>div{display:contents!important}
[class*="_footArea"]>[class*="_footerActions"]>div>*{grid-column:1/-1}
[class*="_footArea"]>[class*="_settingsArea"]{grid-column:1;order:1;width:auto!important}
[class*="_footArea"] button[aria-label="Settings"]{width:auto!important;padding:0!important;background:none!important;border-radius:50%!important;height:auto!important}
[class*="_footArea"]:has(.bt-foot-account){grid-template-columns:auto minmax(0,1fr) auto;column-gap:6px}
[class*="_footArea"]>[class*="_footerActions"]>div>.bt-foot-account{grid-column:1;order:1;display:inline-flex}
[class*="_footArea"]:has(.bt-foot-account)>[class*="_settingsArea"]{grid-column:3}
[class*="_footArea"]:has(.bt-foot-account)>[class*="_settingsArea"] button[class*="_trigger"] [class*="_label"]{display:none!important}
[class*="_widthHandle"]{display:none!important}
body[data-bt-os=windows] :is([data-composer-card],[class*="_toBottomSlot"]>button){-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
body[data-bt-effects=off] [class*="_centerCol"]{transition:none!important}
[data-composer-overlay] [data-menu-material],[data-trigger-menu]{--dsw-menu-surface-fill:var(--bt-card);--dsw-specific-menu:var(--bt-card)}
`

// Adapts DSH's conversation DOM (header, scroller, step-process, composer card,
// user bubble, toBottomSlot, composer dock) when DS Bot runs inside DSH.
export const DSH_CONVERSATION_CSS = `
[data-trigger-menu] [role=option]>span{text-align:left}
[data-conversation-scroll]{--bt-composer-h:var(--dsh-composer-height,152px);--bt-composer-inset:var(--dsh-composer-height,152px)}
[class*="_scroll"]>[class*="_column"]::before{content:var(--bt-first-sep,none);display:block;flex:none;height:28px;margin:17px 0 12px;font-size:12px;line-height:28px;text-align:center;color:var(--bt-ink-2);white-space:nowrap}
[data-step-process]>div:first-child{display:none!important}
[data-step-process]>[data-step-process-body]{display:block!important;content-visibility:visible!important;max-height:none!important;overflow:visible!important;mask-image:none!important;scrollbar-gutter:auto!important}
[data-step-process]:has(.bt-secret)>div:first-child{display:none!important}
[data-step-process]:has(.bt-secret)>[data-step-process-body]{display:block!important;content-visibility:visible!important;max-height:none!important;overflow:visible!important;mask-image:none!important;scrollbar-gutter:auto!important}
:is([data-step-process],[data-turn-process-hidden])[hidden]{content-visibility:visible!important}
[class*="_flowItem"]:has(> [data-slot="conversation.chat.node"]:empty, > [data-slot="conversation.chat.node"][data-bt-emptied]){display:none!important}
[data-step-process]:has(> [data-step-process-body] [data-slot="conversation.chat.node"][data-bt-emptied]):not(:has(> [data-step-process-body] [data-slot="conversation.chat.node"]:not([data-bt-emptied]))){display:none!important}
[class*="_header"]:has(.bt-head){border-bottom-color:transparent!important;box-shadow:none!important}
header[class*="_header"]:has(.bt-head){position:absolute!important;top:0;left:0;right:0;z-index:8;display:flex!important;padding:10px 0 0!important;background:transparent!important;pointer-events:none;justify-content:center}
header[class*="_header"]:has(.bt-head)::before{content:"";position:absolute;inset:0 0 auto;height:calc(60px + env(safe-area-inset-top,0px));background:linear-gradient(to bottom,var(--bt-main),color-mix(in srgb,var(--bt-main) 0%,transparent));pointer-events:none;z-index:-1}
header[class*="_header"]:has(.bt-head)>[class*="_headerLeading"]{position:absolute;left:12px;top:10px;z-index:1;pointer-events:auto}
header[class*="_header"] .bt-head{flex:1 1 auto;width:100%}
html.dsh-native-mobile-active header[class*="_header"]:has(.bt-head),header[class*="_header"][data-dsh-mobile-header]:has(.bt-head){width:auto!important;margin:0!important;padding:calc(10px + env(safe-area-inset-top,0px)) 0 10px!important;background:var(--bt-main)!important;pointer-events:auto}
html.dsh-native-mobile-active header[class*="_header"]:has(.bt-head)::before,header[class*="_header"][data-dsh-mobile-header]:has(.bt-head)::before{content:none}
html.dsh-native-mobile-active header[class*="_header"]:has(.bt-head)>[class*="_headerLeading"],header[class*="_header"][data-dsh-mobile-header]:has(.bt-head)>[class*="_headerLeading"]{top:calc(10px + env(safe-area-inset-top,0px))}
html[data-platform=darwin] header[class*="_header"]:has(.bt-head) .bt-head{pointer-events:auto;-webkit-app-region:drag}
html[data-platform=darwin] header[class*="_header"]:has(.bt-head) :is(a,button,input,textarea,select,[role=button],[role=menuitem],[role=menu],[contenteditable=true]){-webkit-app-region:no-drag}
[data-slot="main.conversation"]>[class*="_root"]>[class*="_body"]{--dsh-chat-content-width:min(960px,100%);--bt-chat-w:min(960px,100%)}
@property --dsh-conversation-column-width{syntax:"*";inherits:false}
@property --dsh-chat-user-width{syntax:"*";inherits:false}
[data-turn-tail]>:not([data-slot="conversation.chat.turnTail"]){display:none!important}
[class*="_flowItem"][data-chat-flow-kind="turn-tail"]:not(:has([data-slot="conversation.chat.turnTail"]:not(:empty))){display:none!important}
[data-content-phase=hero] [class*="_scrollBody"]{justify-content:flex-end!important}
[data-content-phase=hero] [class*="_composerHero"]{align-self:stretch!important;width:auto!important;padding-bottom:0!important}
[data-content-phase=hero] [class*="_composerHero"]>[class$="_root"],[data-content-phase=hero] [class*="_heroWorkspaceRow"]{display:none!important}
[data-content-phase=hero] [class*="_composerHero"] [class*="_input"]{min-height:0!important}
[class*="_scroll"]:has(> [class*="_column"]){padding:calc(60px + env(safe-area-inset-top,0px)) calc(11px + env(safe-area-inset-right,0px)) calc(16px + env(safe-area-inset-bottom,0px)) calc(16px + env(safe-area-inset-left,0px))!important}
body[data-bt-goal] [class*="_scroll"]:has(> [class*="_column"]){padding-top:calc(90px + env(safe-area-inset-top,0px))!important}
body[data-bt-goal="2"] [class*="_scroll"]:has(> [class*="_column"]){padding-top:calc(120px + env(safe-area-inset-top,0px))!important}
[data-composer-card]:has(> [data-slot="conversation.input.attachments"] *),[data-composer-card]:has([data-composer-input] br + *),[data-composer-card]:has([data-composer-input] > :nth-child(2)){border-radius:18px!important}
[class*="_root"]:has(> [data-composer-card]){padding:0 11px 13px 16px!important}
[class*="_root"]:has(> [data-composer-card])>[data-composer-card]{max-width:min(992px,100%)!important}
@media (max-width:${DSH_NARROW - 1}px) and (pointer:coarse){
[class*="_root"]:has(> [data-composer-card]){padding-left:max(16px,env(safe-area-inset-left,0px))!important;padding-right:max(16px,env(safe-area-inset-right,0px))!important;padding-bottom:max(24px,env(safe-area-inset-bottom,0px))!important}
}
[data-composer-card]>[class*="_row"]{display:contents!important}
[data-composer-card] [class*="_tools"]{order:1!important;flex:none!important;align-self:flex-end!important;margin:0!important}
[data-composer-card]>[data-input-scroll]{order:2!important;flex:1 1 0!important;min-width:0!important;padding:0 8px!important;margin:0!important;box-sizing:border-box}
[data-composer-card] [class*="_trailing"]{order:3!important;flex:none!important;align-self:flex-end!important;margin:0!important}
[data-composer-card]>[data-slot="conversation.input.attachments"]>[class*="_rail"]{order:0!important;flex:0 0 100%!important;margin:0!important;padding:2px 8px 6px!important}
[data-composer-card]:has(> [data-slot="conversation.input.attachments"] > [class*="_rail"])>[data-input-scroll]{order:1!important;flex:0 0 100%!important;margin:0 0 6px!important}
[data-composer-card]:has(> [data-slot="conversation.input.attachments"] > [class*="_rail"]) [class*="_tools"]{order:2!important}
[data-composer-card]:has(> [data-slot="conversation.input.attachments"] > [class*="_rail"]) [class*="_trailing"]{margin-left:auto!important}
@media (max-width:600px), (max-width:${DSH_NARROW - 1}px) and (max-height:500px) and (pointer:coarse){
[data-composer-card]>[data-input-scroll]{order:1!important;flex:0 0 100%!important;margin:0 0 6px!important}
[data-composer-card] [class*="_tools"]{order:2!important}
[data-composer-card] [class*="_trailing"]{margin-left:auto!important}
}
[data-composer-card] [data-composer-input]{min-height:24px!important;padding:2px 0!important}
[data-composer-card] [data-composer-placeholder]{left:0!important;top:2px!important}
[data-composer-placeholder]{font-size:0!important;line-height:0!important}
[data-composer-placeholder]::before{content:var(--bt-placeholder,"Message")!important;display:block!important;font-size:14px!important;line-height:24px!important;color:color-mix(in srgb,var(--bt-ink) 36%,transparent)!important}
[data-composer-card] button[class*="_add"]{display:none!important}
[data-composer-card] [class*="_tools"]{gap:0!important}
[data-composer-card] [class*="_modes"]:empty{display:none!important}
[data-composer-card] [class*="_activity"]:not(:has([data-slot] > *)){display:none!important}
[data-composer-card] [class*="_trailing"]{gap:8px!important}
[data-composer-card] [class*="_standardControls"]{align-items:center!important;gap:8px!important}
[data-composer-card] button[class*="_primary"]{width:28px!important;height:28px!important;background:var(--bt-accent)!important;color:var(--bt-accent-ink)!important;border-radius:50%!important;transition:background-color .15s ease,${spring(SPRING_TAP, 'scale')};animation:bt-icon-swap ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
[data-composer-card] button[class*="_primary"]:hover:not(:disabled){background-color:color-mix(in srgb,var(--bt-accent) 90%,transparent)!important}
[data-composer-card] button[class*="_primary"]:active:not(:disabled){scale:.9}
[data-composer-card] button[class*="_primary"] svg{width:14px;height:14px}
[data-composer-card] button[class*="_primary"]:disabled{display:none!important}
[data-composer-dock]{display:none!important}
@media (hover:none){
  [data-chat-flow-kind=user] [class*="_actions"] button{width:44px;height:44px}
}
[data-composer-card]:has(button[class*="_primary"]:disabled) .bt-voice{display:inline-grid}
body[data-bt-room] [data-composer-card]:has(button[class*="_primary"]:disabled) .bt-mic:not([aria-pressed=true]){background:var(--bt-accent);color:var(--bt-accent-ink)}
div:has(> nav [class*="_marks"]){display:none!important}
.bt-uhost [class*="_userStack"]{max-width:100%}
[class*="_userRow"] [class*="_bubble"],.bt-uhost [class*="_bubble"],[data-chat-flow-kind=question-reply] [class*="_bubble"],[data-chat-flow-kind=command-input] [class*="_bubble"]{background:var(--bt-user)!important;background-image:linear-gradient(var(--bt-user),var(--bt-user))!important;color:var(--bt-user-ink)!important;border-radius:12px!important;padding:7px 12px!important;font-size:var(--dsh-content-font-size,14px)!important;line-height:calc(var(--dsh-content-font-size,14px) + 8px)!important}
[class*="_userRow"] [class*="_bubble"] [class*="_markdown"],[class*="_userRow"] [class*="_bubble"] a,.bt-uhost [class*="_bubble"] a{color:inherit}
[class*="_userRow"] [class*="_actions"]{display:none!important}
[data-chat-flow-kind=user] [class*="_userRow"]{flex-direction:row-reverse;align-items:center;justify-content:flex-start}
[data-chat-flow-kind=user] [class*="_actions"]{display:flex!important;height:24px!important;gap:2px!important;opacity:0!important;visibility:hidden;transition:opacity .12s ease,visibility .12s!important;flex:none}
[data-chat-flow-kind=user] [class*="_userRow"]:hover [class*="_actions"],[data-chat-flow-kind=user] [class*="_userRow"]:focus-within [class*="_actions"]{opacity:1!important;visibility:visible}
@media (hover:none){[data-chat-flow-kind=user] [class*="_actions"]{opacity:1!important;visibility:visible}}
[data-chat-flow-kind=user] [class*="_actions"] [class*="_timeStart"]{display:none}
[data-chat-flow-kind=user] [class*="_actions"] button{width:24px;height:24px;border-radius:6px;color:var(--bt-ink-2)}
[data-chat-flow-kind=user] [class*="_actions"] button:hover{background:var(--bt-hover);color:var(--bt-ink)}
[data-chat-flow-kind=user] [class*="_actions"] svg{width:15px;height:15px}
[data-chat-flow-kind=assistant-step]+[data-step-process]:has(.bt-q-inline){margin-top:0!important}
[data-chat-flow-kind=question-reply]:has(.bt-q-inline),[data-chat-group-key]:has([data-chat-flow-kind=question-reply] .bt-q-inline),[data-chat-group-key]:has(.bt-q-gone){margin-top:0!important}
@media (max-width:640px){
[data-chat-flow] [class*="_bubble"]{max-width:100%;overflow-wrap:anywhere;word-break:break-word}
}
[class*="_toBottomSlot"]{justify-content:center!important;padding-right:0!important}
[data-conversation-scroll] [class*="_toBottomSlot"]{bottom:calc(var(--dsh-composer-height,152px) + 8px)!important}
[class*="_toBottomSlot"]>button{width:36px!important;height:36px!important;margin-top:-36px!important;background:var(--bt-glass-bg)!important;-webkit-backdrop-filter:blur(16px) saturate(180%)!important;backdrop-filter:blur(16px) saturate(180%)!important;color:var(--bt-ink)!important;box-shadow:var(--bt-glass-shadow)!important;animation:bt-tobottom-in ${SPRING_TAP.duration}ms ${SPRING_TAP.easing},bt-veil-in .16s ease-out;transition:background-color .12s ease,${spring(SPRING_TAP, 'scale')}}
[class*="_toBottomSlot"]>button:active{scale:.9}
[class*="_toBottomSlot"]>button:hover{background:color-mix(in srgb,var(--bt-ink) 4%,var(--bt-main))!important}
[class*="_toBottomSlot"]>button svg{display:none}
[class*="_toBottomSlot"]>button::before{content:"";width:20px;height:20px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 4v12M5 11l5 5 5-5'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 4v12M5 11l5 5 5-5'/%3E%3C/svg%3E") center/contain no-repeat}
[data-bt-news] [class*="_toBottomSlot"]>button{visibility:hidden!important;pointer-events:none!important}
@media (prefers-reduced-motion:reduce){[class*="_toBottomSlot"]>button{animation:none}}
.bt-ububble [class*="_markdown"]{color:inherit!important}
[data-composer-dock]:has(.bt-btw){display:flex!important;flex-direction:column;align-items:center;width:100%;max-width:var(--dsh-composer-card-max-width,748px)}
[data-composer-dock]:has(.bt-btw)>:not([data-slot="conversation.composer.dock"]){display:none!important}
body:is([data-bt-effects=reduced],[data-bt-effects=off]) :is([data-composer-card],[class*="_toBottomSlot"]>button){-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
body[data-bt-effects=off] :is([data-composer-card],[data-chat-flow-kind=user] [class*="_actions"],[class*="_toBottomSlot"]>button){transition:none!important}
body[data-bt-effects=off] [class*="_toBottomSlot"]>button{animation:none!important}
`

// Plugin-only theme supplement for DSH's hashed `_markdown` class inside Bot bubbles.
export function dshThemeCss(theme) {
  if (!theme?.css || !theme.css.includes(SERIF_REPLIES)) return ''
  return `.bt-bubble [class*="_markdown"],.bt-bubble [class*="_markdown"] :is(h1,h2,h3,h4,h5,h6,th,td){font-family:var(--dsh-font-family-text,"${REPLY_FAMILY}","Source Han Serif SC","Noto Serif CJK SC","Songti SC"),var(--dsh-font-family-text-default,sans-serif)}`
}

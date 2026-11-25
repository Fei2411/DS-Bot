// The Side Apps' look: the Canvas and Reader views, the shared source and diff, and the
// chat card. Colors come from the theme tokens; corners and springs from the shared sets.
import { SPRING_TAP } from './motion.js'

export const SIDE_APP_CSS = `
.bt-sapp{min-height:0;flex:1;display:flex;flex-direction:column;min-width:0}
.bt-sapp-bar{display:flex;align-items:center;gap:8px;flex:none;height:44px;padding:0 10px;border-bottom:.5px solid var(--bt-line);min-width:0}
.bt-sapp-bar>.bt-pmenu:last-child{margin-left:auto}
.bt-sapp-seg{flex:none}
.bt-sapp-seg button{height:26px;padding:0 10px;font-size:12px;display:inline-flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap}
.bt-sapp-count{min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font-size:10px;line-height:16px;font-variant-numeric:tabular-nums;text-align:center}
.bt-sapp-devices{display:inline-flex;gap:2px;margin-left:auto;flex:none}
.bt-sapp-devices+.bt-sapp-live{margin-left:0}
.bt-sapp-device{height:24px;padding:0 8px;border:0;border-radius:6px;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer}
.bt-sapp-device:hover{background:var(--bt-hover)}
.bt-sapp-device[aria-pressed=true]{background:var(--bt-active);color:var(--bt-ink)}
.bt-sapp-live{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:.5px solid var(--bt-line-2);border-radius:999px;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;flex:none}
.bt-sapp-live:hover{background:var(--bt-hover)}
.bt-sapp-live-dot{width:6px;height:6px;border-radius:999px;background:var(--bt-ink-3)}
.bt-sapp-live[aria-pressed=true] .bt-sapp-live-dot{background:var(--bt-green)}
.bt-sapp-bar>.bt-sapp-seg:first-child{margin-left:0}
.bt-sapp-status{display:flex;align-items:center;gap:8px;flex:none;height:24px;padding:0 12px;font-size:11px;line-height:16px;color:var(--bt-ink-3);min-width:0;border-bottom:.5px solid var(--bt-line)}
.bt-sapp-status-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.bt-sapp-status-note{flex:none;font-variant-numeric:tabular-nums}
.bt-sapp-status[data-status=missing] .bt-sapp-status-note,.bt-sapp-status[data-status=error] .bt-sapp-status-note{color:var(--bt-danger)}
.bt-sapp-retry{flex:none;border:0;background:none;color:var(--bt-accent);font:inherit;font-size:11px;cursor:pointer;padding:0}
.bt-sapp-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.bt-sapp-stage{position:relative;flex:1;min-height:0;display:flex;justify-content:center;background:var(--bt-sidebar);overflow:auto}
.bt-sapp-frame{flex:1;min-width:0;border:0;background:Canvas;color-scheme:light;transition:opacity 140ms ease-out}
.bt-sapp-stage:not([data-fit]) .bt-sapp-frame{flex:none;max-width:100%;border-left:.5px solid var(--bt-line-2);border-right:.5px solid var(--bt-line-2)}
.bt-sapp-frame[data-fade]{animation:bt-sapp-fade 140ms ease-out}
.bt-sapp-frame-next{position:absolute;top:0;bottom:0;visibility:hidden;pointer-events:none}
@keyframes bt-sapp-fade{from{opacity:.55}}
.bt-sapp-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px;text-align:center;color:var(--bt-ink-2);font-size:13px;line-height:19px}
.bt-sapp-empty-title{font-weight:540;color:var(--bt-ink)}
.bt-sapp-empty-path{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--bt-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--bt-ink-3)}
.bt-sapp-empty-note{font-size:12px;color:var(--bt-ink-3);max-width:320px}
.bt-sapp-empty .bt-soft{margin-top:6px}
.bt-sapp-source,.bt-sapp-diff{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;background:var(--bt-main);font-family:var(--bt-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:19px}
.bt-sapp-note{flex:none;padding:6px 12px;color:var(--bt-ink-3);font-family:var(--bt-font);font-size:11px;border-bottom:.5px solid var(--bt-line)}
.bt-sapp-lines{min-width:max-content;padding:6px 0}
.bt-sapp-line{display:flex;align-items:flex-start;padding-right:14px}
.bt-sapp-no{flex:none;width:44px;padding-right:10px;text-align:right;color:var(--bt-ink-3);user-select:none;font-variant-numeric:tabular-nums}
.bt-sapp-mark{flex:none;width:14px;text-align:center;color:var(--bt-ink-3);user-select:none}
.bt-sapp-code{white-space:pre;color:var(--bt-ink)}
.bt-sapp-line[data-kind=add]{background:color-mix(in srgb,var(--bt-green) 13%,transparent)}
.bt-sapp-line[data-kind=add] .bt-sapp-mark{color:var(--bt-green)}
.bt-sapp-line[data-kind=del]{background:color-mix(in srgb,var(--bt-danger) 11%,transparent)}
.bt-sapp-line[data-kind=del] .bt-sapp-mark{color:var(--bt-danger)}
.bt-sapp-line[data-kind=del] .bt-sapp-code{color:var(--bt-ink-2)}
.bt-sapp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.bt-sapp-fold{display:block;width:100%;padding:3px 12px 3px 58px;border:0;border-top:.5px solid var(--bt-line);border-bottom:.5px solid var(--bt-line);background:var(--bt-sidebar);color:var(--bt-ink-3);font:inherit;font-family:var(--bt-font);font-size:11px;text-align:left;cursor:pointer}
.bt-sapp-fold:hover{color:var(--bt-ink)}
.bt-sapp-diffbar{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:10px;flex:none;padding:6px 12px;background:var(--bt-main);border-bottom:.5px solid var(--bt-line);font-family:var(--bt-font);font-size:11px;color:var(--bt-ink-2)}
.bt-sapp-diffnote{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-sapp-diffnum{display:inline-flex;gap:6px;font-variant-numeric:tabular-nums}
.bt-sapp-add{color:var(--bt-green)}
.bt-sapp-del{color:var(--bt-danger)}
.bt-sapp-reader{flex:1;min-height:0;display:flex}
.bt-sapp-outline{flex:none;width:168px;overflow:auto;padding:12px 6px;border-right:.5px solid var(--bt-line);display:flex;flex-direction:column;gap:1px}
.bt-sapp-outline-item{border:0;border-radius:6px;background:none;padding:5px 8px;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:17px;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-sapp-outline-item:hover{background:var(--bt-hover)}
.bt-sapp-outline-item[data-depth="1"]{padding-left:16px}
.bt-sapp-outline-item[data-depth="2"]{padding-left:28px}
.bt-sapp-outline-item[aria-current]{color:var(--bt-accent);font-weight:500}
.bt-sapp-scroll{flex:1;min-width:0;overflow:auto;padding:20px 22px 48px;outline:none}
.bt-sapp-article{max-width:680px;margin:0 auto;font-size:14.5px;line-height:1.7;color:var(--bt-ink);overflow-wrap:anywhere}
.bt-sapp-article :is(h1,h2,h3,h4){line-height:1.35;margin:1.5em 0 .5em}
.bt-sapp-article :is(p,ul,ol,blockquote,pre,table){margin:0 0 1em}
.bt-sapp-article img{max-width:100%;height:auto;display:block;margin:0 auto;border-radius:6px}
.bt-sapp-figure{margin:0 0 1em}
.bt-sapp-figure[data-state=loading],.bt-sapp-figure[data-state=error]{color:var(--bt-ink-3,var(--bt-ink));opacity:.7;font-size:13px}
.bt-sapp-contents{flex:1;min-width:0}
.bt-sapp-contents-btn{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:26px;padding:0 8px;border:.5px solid var(--bt-line-2);border-radius:999px;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer}
.bt-sapp-contents-btn:hover{background:var(--bt-hover)}
.bt-sapp-contents-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-sapp-menu{position:absolute;z-index:6;top:calc(100% + 4px);left:0;max-height:min(360px,60vh);overflow:auto;min-width:200px;max-width:min(320px,100vw - 32px)}
.bt-sapp-menu button[data-depth="1"]{padding-left:22px}
.bt-sapp-menu button[data-depth="2"]{padding-left:34px}
.bt-sapp-menu button[aria-current]{color:var(--bt-accent);font-weight:500}
.bt-sapp-pill{position:fixed;z-index:60;height:28px;padding:0 12px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:12px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.12);animation:bt-pop-drop ${SPRING_TAP.duration}ms ${SPRING_TAP.easing}}
.bt-sapp-pill:hover{background:var(--bt-hover)}
.bt-sapp-ask{position:fixed;z-index:60;width:min(320px,calc(100vw - 16px));display:flex;flex-direction:column;gap:8px;padding:10px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-main);color:var(--bt-ink);box-shadow:0 8px 28px rgba(0,0,0,.18);animation:bt-pop-drop ${SPRING_TAP.duration}ms ${SPRING_TAP.easing}}
.bt-sapp-ask[data-leaving]{opacity:0;transition:opacity .12s ease}
.bt-sapp-ask-quote{margin:0;padding:2px 0 2px 8px;border-left:2px solid var(--bt-line-2);color:var(--bt-ink-2);font-size:12px;line-height:17px;max-height:72px;overflow:auto}
.bt-sapp-ask-input{box-sizing:border-box;width:100%;resize:none;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:13px;line-height:19px;padding:6px 8px}
.bt-sapp-ask-input:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-1px}
.bt-sapp-ask-actions{display:flex;justify-content:flex-end;gap:6px}
.bt-sapp-primary{background:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-sapp-card{display:flex;align-items:center;gap:10px;max-width:min(420px,100%);margin:6px 0 0 46px;padding:8px 10px;border:1px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card);color:var(--bt-ink);font-size:12px;line-height:17px}
[data-bt-layout=flat] .bt-sapp-card{margin-left:0}
@media (max-width:640px){.bt-sapp-card{margin-left:0}}
.bt-sapp-card-ico{flex:none;display:inline-flex;color:var(--bt-ink-2)}
.bt-sapp-card-text{flex:1;min-width:0;display:flex;flex-direction:column}
.bt-sapp-card-name{font-weight:540;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-sapp-card-sub{color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.bt-sapp-card[data-failed] .bt-sapp-card-sub{color:var(--bt-danger)}
@media (hover:none){.bt-sapp-device,.bt-sapp-live{height:34px}.bt-sapp-bar{height:52px}}
@media (prefers-reduced-motion:reduce){.bt-sapp-frame,.bt-sapp-frame[data-fade],.bt-sapp-pill,.bt-sapp-ask{animation:none;transition:none}}
`

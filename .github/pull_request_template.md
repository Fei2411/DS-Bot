<!--
Base branch: dev. Hotfixes and releases only: main.
目标分支选 dev。只有热修和发版才选 main。
-->

## Issue

Fixes #

## Agent

<!-- Required when an AI agent opens this PR. Keep human as git author. / 由 AI Agent 开 PR 时必填；git 提交作者仍保留人类。 -->
Agent: <Agent> (<Model>)

## What changed / 改了什么



## Changelog

<!-- One sentence that users will notice, or "none". Do not edit CHANGELOG.md. / 一句用户能看到的变化，没有写「无」。不要改 CHANGELOG.md。 -->



## How I checked it / 怎么验证的

- [ ] `npm test` (in `ds-bot/`)
- [ ] `node scripts/build-client.mjs --check`
- [ ] `npm run lint`
- [ ] Smoke test, for changes to `index.js` or `src/host/` / 改了 `index.js` 或 `src/host/` 时跑冒烟测试
- [ ] Screenshot attached, for interface changes / 界面改动已附截图

## Checklist / 检查

- [ ] One issue, one subject. / 只做一件事。
- [ ] `src/client/` changed → `npm run build` ran and `client.js` is committed. / 改了 `src/client/` 就已重新 build 并提交 `client.js`。
- [ ] No keys, tokens or personal data, also in screenshots. / 没有密钥、token 或个人信息，截图里也没有。
- [ ] No AI tool as author or `Co-authored-by`. / 没有把 AI 工具写成作者或 `Co-authored-by`。

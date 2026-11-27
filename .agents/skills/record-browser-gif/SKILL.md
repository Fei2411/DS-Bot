---
name: record-browser-gif
description: 把浏览器 / Web 界面操作录成优化过的 GIF：优先用当前可用的浏览器控制工作流（支持 recordVideo 时开 Playwright Videos 拿更高帧率），用随附编码器裁剪、变速、收尾定格并控制尺寸与体积；需要挂到 PR 时用 gh --attach，不可用时退回专用 assets 分支。触发词：录 GIF、录屏、界面演示、PR 演示证据、截图。改了用户可见界面行为的 PR 按模板需要截图证据，用本 skill 从该 PR 分支的真实服务与真实模型流程录 GIF 即满足。
---

# 录制浏览器演示 GIF

产出一段简短、真实的界面演示 GIF；仅当任务包含「挂到 PR」时，才走文末的发布流程。优先使用当前可用的浏览器控制工作流；该工作流支持连续录像时用 [Playwright Videos](https://playwright.dev/docs/videos) 拿更高帧率。裁剪、变速、收尾定格、尺寸和体积用随附编码器（`scripts/encode_gif.py`）。

两条纪律来自 DeepSeek Harness 的同名 skill（出处见 `NOTICE`）：一个 storyboard 只来自一次隔离运行；发布前要重新校验产物和被演示 PR 的头提交。

## 界面改动的 PR 附演示 GIF

改了用户可见界面行为的 PR，按 PR 模板需要附截图证据；用本 skill 录的 GIF 满足该要求，嵌进 PR 正文或作为评论附件均可（见[发布 GIF](#发布-gif)）。

录屏本身是证据的一部分：从该 PR 分支的代码树启动真实服务、用真实 API key、跑真实模型回合。不要用 fixture 查询、mock transport、合成事件注入或测试钩子替代，除非用户明确要求录 fixture。在 GIF 旁边注明被演示的确切 commit SHA、服务它的代码树与来源、模式开关或浏览器状态例外、是否跑了真实模型回合，让评审知道这段录像证明了什么。

## 录制与发布分开

- 录制只产出本地视频或截图和一个 `.gif`，绝不动远端状态。
- 发布——用 `gh --attach` 把 GIF 挂到 PR，或不可用时推到 assets 分支并嵌入 URL——是独立的最后一步，仅当任务包含挂到 PR 时执行。它绝不动 PR 自己的分支。
- 保持约定的录制条件。真实服务 / 真实 API 的演示不得换成 fixture 查询、mock transport、合成事件注入或测试钩子。凭证或服务不可用时如实报告，不要拿 fixture 顶替。
- 绝不读取或暴露凭证值。走应用正常的配置路径，用无害的演示提示词。截图和录像里同样不能有密钥、token 或个人信息（PR 模板硬性要求）。

## 搭建被演示的应用

为某个 PR 录的 GIF 演示的是该 PR 的代码树，按 PR 搭建：

1. 工作树必须干净，用 `git rev-parse HEAD` 记录确切提交，并构建这棵记录过的树：界面改动在 `ds-bot/` 里跑 `npm run build`（`src/client` → `client.js`）。拿别的提交的构建产物录屏是错误归因。
2. 用测试台架从该树启动 DSH Web：`dev/bench.sh <name> <web-port> <mock-port> reset`（台架需要一个 deepseek-harness 检出：`../deepseek-harness` 或 `DSH_HARNESS`，版本见 README）。台架把插件 link 到当前 checkout——host 代码改动重启生效，`src/client` 改动 `npm run build` 后刷新页面生效；数据全部落在 gitignored 的 `.dsh-test-<name>/`，`reset` 会先清空 Bot 团队和会话。每个端口只起一个服务。浏览器同样用全新隔离的 context 或 profile；浏览器工作流建不了隔离环境时，先清掉该 origin 的 cookie 和站点存储再导航，避免残留的客户端状态污染证据。
3. 台架默认跑 mock 模型（`dev/mock-llm.mjs`）。要录真实模型回合，在该台架自己的数据目录里配置真实 provider（通过它的 Web 设置页）；绝不要把台架或任何测试指向 `~/.dsh`、桌面应用的数据或用户正在跑的 DSH（仓库硬规则第 5 条）。演示桌面应用窗口（`app/ui` 或 Electron 行为）时改在 `app/` 里用一次性数据目录启动：`DS_BOT_HOME=<throwaway-dir> npm start`（见 `app/README.md`）。
4. 一个 storyboard 算一次证据运行：发布的每一帧都来自同一个服务、同一组状态根、同一个工作区 / 会话和同一次模型场景运行。采集自动化失败就丢弃它的帧、从全新状态根重跑；绝不拼接不同运行的帧。
5. 录制结束或切换 PR 时停掉自己起的服务：`dev/bench.sh <name> <web-port> <mock-port> stop`（台架按 pid 文件停进程组）。不要用宽泛的 `pkill -f`——它可能匹配并杀掉发起它的 shell，包括你自己的。

## 录制流程

遵循当前可用的浏览器控制工作流的设置、交互和清理说明。它暴露 `recordVideo` 时，在同一个受控 context 上开录像以捕获更多中间帧；否则在该工作流里用[截图采集](#截图采集)。录像是否可用不决定用哪个浏览器控制工作流。用户既有浏览器状态算显式的隔离例外。

仅当浏览器控制不可用时，才在隔离的无头浏览器里用 Playwright 兜底，并在采集说明里声明用了兜底。`ds-bot/` 声明了 `playwright-core`，`browser-plugins/` 声明了 `playwright`；从已安装的包或环境里的 Playwright 解析，并确认 Chromium 和录像需要的 ffmpeg 已就绪。不要为了录屏往仓库加依赖，也不要打开用户的浏览器。

录制前确认 origin、构建产物或开发服务器、传输方式和模式开关。当生产默认打开自动化无法驱动的原生界面时，通过正常的应用配置选择官方可在浏览器操作的生产后端，并披露该替代。

把脚本、原始视频、计时笔记、QA 帧和 GIF 放在仓库已 gitignore 的 `.playwright-mcp/` 目录下。先建运行目录。

### 采集视频

显式让 `viewport` 和 `recordVideo.size` 一致：否则 Playwright 会把视频缩进 800×800，界面文字会糊。

视频通过所选浏览器控制工作流配置。独立 Playwright 兜底用：

```js
import { chromium } from 'playwright'  // 从 browser-plugins/ 或环境里的安装解析
const browser = await chromium.launch()
const size = { width: 1440, height: 900 }
const context = await browser.newContext({
  viewport: size,
  recordVideo: { dir: join(runDir, 'videos'), size },
})
try {
  const page = await context.newPage()
  const video = page.video()
  // 在这里导航并操作真实应用。
  await context.close()
  await video.saveAs(join(runDir, 'demo.webm'))
} finally {
  await context.close()
  await browser.close()
}
```

`join` 从 `node:path` 导入；新建的 `runDir` 在录制脚本里写绝对路径。关掉页面前先留住它的 video 句柄；先 `await context.close()` 再 `video.saveAs()` 或编码——只关 browser 不保证视频落盘。每个 page 有自己的视频：明确选择被演示的 page，不串接无关 page 或运行。失败的运行只用于诊断。

挑一个有三到六个有意义状态的短故事。操作前等唯一的语义定位器；accessible-name 相等判断用 `exact: true`，结束断言用不会误匹配 prompt 回显的精确文本。固定等待只能用于状态确认后的阅读停留，绝不能用来建立就绪。录像时保留动画和滚动。

演示工具调用、拒绝或恢复时，展开它的详情或轨迹，让视频呈现工具身份、状态或稳定错误码和下游结果。瞬时运行态重要时，用一个慢前台操作触发并观察它的具体 DOM 标记；连续录像会捕获中间帧。给模型一个简短的收尾哨兵来锚定完成。真实 API 运行在被演示状态可见后即可停止，不必跑完全程。

不要拍到密钥、个人数据、无关标签页或通知。浏览器视频只含页面内容、不含浏览器外壳；避免在应用里渲染带凭证的 URL。完整回看选中的区间，包括中间状态。全程保持一个 viewport。

## 编码 GIF

需要 `python3`、`ffmpeg`、`ffprobe`。缺媒体二进制时如实报告依赖，不要未经授权安装软件。`GIF_SKILL_DIR` 单独一行 export；同一命令里的内联赋值影响不了参数展开。

```sh
export GIF_SKILL_DIR=<repo>/.agents/skills/record-browser-gif
python3 "$GIF_SKILL_DIR/scripts/encode_gif.py" \
  /absolute/path/to/demo.webm \
  /absolute/path/to/demo.gif \
  --start 2 --end 32 --speed 2 --final-hold 3 \
  --fps 10 --max-width 1200 --colors 128
```

`--start` 和 `--end` 以秒选一段连续的源区间。默认保留完整视频、1× 速度、加两秒收尾定格。`--speed` 改播放速度；在 GIF 旁边披露它及所选区间，避免演示暗示实测的响应延迟。用视频里观察到的时间，不要猜墙钟偏移；保留被演示行为完整的因与果。收尾定格重复最后一帧。`--fps` 是编码帧率；提高它补不回源录像没采到的运动。原始 WebM 留作 QA；不拼接不同运行，不合成缺失状态。

编码器探测 WebM 容器时长，先裁剪变速再做调色板转换，并校验编码后的时长、动画、宽度和字节数。它会拒绝空区间或越界区间、不足两个输出帧的选择、模式不符的开关和意外覆盖。产物太大时先降 `--max-width`，再降 `--colors` 或 `--fps`；保持文字可读。确认输出路径无误后才用 `--force`。

### 截图采集

连续录像不可用、或用户要 storyboard 时，遵循可用的浏览器控制工作流，用浏览器的截图 API 从一次隔离运行采集三到六个已验证状态。返回的图像字节直接存进同一个运行目录：`00-initial.png`、`01-typed.png`……尺寸和裁剪保持一致。瞬时状态轮询它的 DOM 标记，并在同一次浏览器脚本调用内截图。

```sh
python3 "$GIF_SKILL_DIR/scripts/encode_gif.py" \
  /absolute/path/to/frames /absolute/path/to/demo.gif \
  --durations 1.5,1.5,1.5,3.5 --fps 10 --max-width 1200 --colors 128
```

一个时长作用于每张截图；否则给每帧一个正时长，并让落定状态停最久。目录输入拒绝少于两帧、尺寸不一致或时长数量不符。视频计时开关只适用于视频文件；`--durations` 和 `--pattern` 只适用于截图目录。

## 校验产物

1. 读编码器的 JSON 摘要，确认输出路径、源区间与速度（或截图张数）、编码帧数、尺寸、时长和字节数。
2. 亲自看编码后的 GIF 本身，不只看源帧。确认过渡清晰可读、最后状态停得够久、没有敏感内容。查看器只渲染第一帧时，用 `ffmpeg` 从 GIF 解出代表帧检查；编码前的截图证明不了编码后的顺序、调色板或收尾定格。
3. 跑 `git status --short`，确认原始视频、QA 帧和产物只落在 ignored 路径下。
4. 返回 GIF 的绝对路径，客户端支持本地媒体就渲染出来，并说明录制用的是真实 API、fixture 还是别的 transport。任务不含挂到 PR 时到此为止。

编码器维护：装好媒体依赖后跑 `python3 -m unittest discover -s "$GIF_SKILL_DIR/scripts" -p 'test_*.py' -v`。这些本地媒体测试不进仓库 CI。

## 发布 GIF

仅当任务包含把 GIF 挂到 PR 时执行本节。

绝不把 GIF 提交进 PR 自己的分支或任何会合入长期分支的分支：二进制媒体进了历史会拖累未来的每一次克隆。优先 `gh --attach`——上传 GIF 到 GitHub 并在同一条命令里改写正文引用，任何分支都不用携带媒体。

### 用 gh 挂附件

`gh --attach` 需要 gh v2.99.0 或更新（`gh --version`）、github.com 上的仓库（不支持 GitHub Enterprise Server）、对仓库的写权限、不超过 10 MB 的 GIF。先确认校验过的产物在限内；超出就先按上文压缩再挂。

把 GIF 作为普通的本地路径引用写进正文文件，路径与传给 `--attach` 的相同；`gh` 会原位把引用改写成上传后的 URL，保留位置和 alt 文本：

```markdown
![<alt 文本>](<path/to/demo.gif>)
```

被演示的 PR 通常就是发布目标。工具类 PR 也可以嵌入明确标注来自另一个 PR 的示例：指出该来源 PR，并在下面每个检查里比对它的实时头。绝不要把示例归到工具分支头上。

挂上前一刻，重读被演示 PR 的实时头——新 PR 是已推送分支的尖端——与 GIF 旁记录的提交比对。动了就停下来重录。然后挂上：

```sh
gh pr create --body-file <body.md> --attach <path/to/demo.gif>     # 新 PR
gh pr edit <pr> --body-file <body.md> --attach <path/to/demo.gif>  # 已有 PR 正文
gh pr comment <pr> --body <text> --attach <path/to/demo.gif>       # 只挂到评论
```

`--attach` 可重复，但拒绝同一个文件两次。正文没引用的 GIF 会追加到末尾，此时开关上的 alt 文本（`--attach '<path>#<alt 文本>'`）生效；被改写的引用保留正文里的 alt 文本。挂上后：重读实时头，确认仍在记录的提交；重读线上正文，确认引用指向上传后的 URL；用 GitHub 的 Markdown API 渲染正文，确认出现预期的 `<img>`；请求一次上传 URL，确认 `200` 和 `image/gif`。

### 退回 assets 分支

仅在 `gh --attach` 不可用时走 assets 分支：GIF 仍超 10 MB、gh 低于 v2.99.0、或仓库不在 github.com。GIF 放在专用的孤儿 assets 分支——没有父提交、只有媒体——一个 assets 分支服务整个 PR 系列（命名 `<series>-assets`；用 `git ls-remote --heads origin '*assets*'` 列出现有的）。

两种流程推送前都要验证：assets 分支只有媒体，且待挂 GIF 的校验和与本地校验过的产物一致。

已有 assets 分支时，在浅克隆单分支的临时 checkout 里操作，发布过程碰不到你的工作树：

```sh
git clone --branch <assets-branch> --single-branch --depth 1 <repo-url> /tmp/assets-checkout
cp /absolute/path/to/demo.gif /tmp/assets-checkout/<name>.gif
cd /tmp/assets-checkout
git add <name>.gif
git commit -m "assets: <what it shows> gif (#<pr>)"
git push origin <assets-branch>
```

新系列则浅克隆临时 checkout（`git clone --depth 1 <repo-url> /tmp/assets-checkout`），用 `git switch --orphan <assets-branch>` 建孤儿分支，然后同样 add、commit、push。

推送后用带认证的 GitHub API 或 raw 请求确认远端路径、字节数、校验和、`200` 响应和 `image/gif` 类型。匿名 `404` 不能证伪私有仓库的资产；用认证请求验证。这证明的是仓库成员的评审路径，不是公网可达。

编辑 PR 正文前一刻，重读被演示 PR 的实时头并与 GIF 旁记录的提交比对；动了就停下来重录。编辑后重读实时头，确认仍在该提交。另外用 GitHub 的 Markdown API 渲染正文，确认预期的 `<img>` 出现。

用 raw blob URL 把 GIF 嵌进 PR 正文；`?raw=true` 后缀必须带，普通 blob URL 渲染的是 GitHub 的文件页而不是图：

```markdown
![<alt 文本>](https://github.com/<owner>/<repo>/blob/<assets-branch>/<name>.gif?raw=true)
```

绝不删除或改写 assets 分支，绝不 force-push：已合并 PR 的正文永远引用它的 URL。只追加新提交。

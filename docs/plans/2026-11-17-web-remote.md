# 浏览器远程客户端

- 日期：2026-11-17
- 相关：[手机 App](2026-10-24-mobile-app.md)、[移动端客户端 API](2026-10-24-mobile-api.md)、[愿景](../vision.zh.md)

## 为什么

用户没有安装手机 App，或在另一台电脑上，也要能安全地访问自己的 Bot 团队。把 `mobile/` 的 Expo 客户端导出为网页，复用已有的配对、设备身份和端到端加密链路；不把 DSH 管理界面直接暴露到公网，也不再维护另一套远程界面。

## 已定的行为

### 同源部署

- `mobile/` 用 Metro 导出单页应用，资源基址为 `/web`；`npm run export:web` 生成 `dist/`。
- Relay Server 的 `DSBOT_LINK_WEB_DIR` 指向构建目录，才开启 `/web/` 静态服务；不配置时保持 404。`/web` 重定向到 `/web/`，无扩展名的未知路由回退到 `index.html`，拒绝目录穿越和指向目录外的符号链接。
- 网页和 WebSocket 使用同一个对外 origin，沿用网关的同源检查，不开放跨源访问。反向代理有路径前缀时，把该前缀下的 `/web/` 和 `/v1/link` 一起转发到 Relay Server；构建的资源基址也必须带相同前缀。
- `index.html` 不缓存。静态响应有严格 CSP：默认只允许同源资源，连接只允许同源及同主机的 ws/wss，图片额外允许 data/blob，样式允许内联；禁止嵌入框架、对象和 base URL，并设置 nosniff、no-referrer。
- 在构造 CSP 前验证 Host，只接受普通主机名、IPv4 或带方括号的 IPv6，以及可选端口；拒绝分号、空格等非法字符，返回 400。保留显式 ws/wss 来源，避免 Safari 对 `'self'` 的 WebSocket 匹配差异。

### 配对与身份

- 电脑 Settings → Phone 的二维码旁增加 **Open in a browser** 和 **Copy browser link**。浏览器地址从当前 Server 的 ws/wss URL 转换为 http/https，保留 `/v1/link` 之前的前缀，打开 `/web/#pair=<编码后的配对 URI>`。
- 每次配对同时发出手机码和浏览器码；二维码仍使用手机码，浏览器链接使用浏览器码。任一个成功使用都会关闭这轮配对。电脑按使用的码记录 `kind: phone | browser`，不相信客户端自报的名字；旧设备缺少 kind 时视为手机。列表按 kind 把浏览器显示为 **Web browser**。
- 一次性配对码只在 fragment，不进入 HTTP 路径或查询串。网页启动时取出并用 `history.replaceState` 清掉 fragment，再走和手机一样的配对流程。已有其他电脑的浏览器也能配对新电脑。
- 网页不申请摄像头权限，也可手动粘贴 `dsbot://pair?...` 或复制的浏览器链接。每个浏览器 origin 保存自己的身份和电脑列表，作为一台额外设备出现在电脑的已配对列表，可从电脑撤销。同 origin 通过独占 Web Lock 只让一个标签页持有身份和链路，其余标签页等候，持有者关闭后接管。
- 团队、聊天和 Agent 仍在电脑上运行；网页经现有 E2E link 调用相同接口。下载按块收集为 Blob 后触发浏览器保存，不调用原生文件系统或分享面板。

### 浏览器安全边界

主机按使用的配对码决定设备 kind，而不是检测客户端类型。手机二维码是手机权限凭据：任何持有码的人都可以把任意客户端配成手机。浏览器链接带 `device=browser` 标记，网页拒绝无此标记的手机链接，原生手机 App 也对称拒绝带 `device=browser` 的浏览器链接，防止误粘贴浏览器链接把手机永久降级为受限浏览器；修改过的客户端仍无法通过浏览器码提升权限。主机没有可靠信号区分浏览器和手机：握手端到端加密，浏览器的 Origin 请求头也只有不可信的 Relay 能看到。因此权限控制依赖把手机二维码留在电脑屏幕上，不向远程设备提供它；不要把二维码或手机配对链接交给不应获得手机权限的客户端。

- 浏览器不能完成原生的每次设备解锁，且不得调用仅限桌面端或高危宿主能力的接口。主机与网页客户端共享最小权限白名单（`BROWSER_ALLOWED`，位于 `ds-bot/src/shared/browser-endpoints.js`），在 `ds-bot/src/host/phone.js` 上按默认拒绝（default-deny）与未知设备 fail-closed 执行：查不到已配对设备时一律拒绝；浏览器仅允许调用白名单内的聊天、团队读写与安全取消接口，其余所有接口（包括全部 `GATED` 敏感操作、`connector-add`/`connector-remove`/`connector-set`/`connector-import*`、`secret-encrypt`/`decrypt`/`unlock`/`store`、`provider-models`/`provider-models-save`、`im-*`、`local-agent-*`、`mail-*`、`computer-*`、`phone-*` 以及未来新增的未审查接口）均被主机拒绝，返回 `bot/refused` 和 “Not available from a browser. Use the phone app or the computer.”。手机仍走原有解锁流程，单测保证 `BROWSER_ALLOWED` 与 `GATED` 严格互斥且覆盖全部宿主路由。
- 网页存储的每个值使用 AES-GCM 加密，随机 96 位 IV，并把存储键名绑定为认证附加数据。localStorage 只有版本、IV 和密文；不可导出的 AES CryptoKey 保存在 IndexedDB。不保留明文设备私钥；旧明文、缺失密钥或认证失败的值按空值读取，因此需要重新配对。删除旧浏览器设备可从电脑撤销它的身份。
- 电脑在浏览器链接旁提示：浏览器运行的是 Server 发来的网页，只使用可信 Server。Server 帮助不再无条件声称它无法读取内容；原生 App 的代码独立于 Relay，而网页代码由 Relay 发布者控制。

## 不做什么

- 不更改 DSH，不提供绕过配对的远程入口，不放宽 WebSocket 同源检查。
- 不在浏览器运行 Agent，不新增独立的云端账号、团队存储或明文中转协议。
- 不实现网页的本地生物识别锁、后台推送或离线 Agent；原生 App 的安全存储和解锁要求不变。

## 已知限制

- **浏览器密钥由 IndexedDB 中不可导出的 CryptoKey 加密，而不是系统钥匙串保护。** 不可导出只阻止直接导出 AES 密钥；同 origin 的恶意 JavaScript 仍可取到 CryptoKey，调用解密或冒用设备。XSS 或被篡改的网页构建仍会危及身份和允许的聊天操作。通过严格 CSP、同源部署、无内联脚本和现有内容渲染边界减小风险，不能抵御恶意 Relay 网页发布者。应信任发布者，使用 HTTPS，并从电脑撤销不再使用的浏览器。清除站点数据会丢失身份，需要重新配对；浏览器必须支持 Web Locks、WebCrypto 和 IndexedDB。
- 网页没有后台通知；浏览器后台挂起或关闭后不会持续收消息，回来后重连同步。浏览器不强制原生设备解锁；需要解锁的敏感接口在客户端和主机上都被禁用，改用手机 App 或电脑。
- 下载会在内存中累积 Blob，大文件受浏览器内存和保存策略限制。添加到 iOS 主屏幕可用网页名称和主题色，不代表原生 App 或完整离线 PWA。
- `relay.dsbot.app` 必须另外部署非 demo 网页构建并配置 `DSBOT_LINK_WEB_DIR`，否则浏览器链接仍是 404；本仓库的改动不会自动部署线上服务。
- 带路径前缀的反向代理需要对应前缀的 Expo 资源基址；默认构建只适用于 origin 根下的 `/web/`。正式环境需要 HTTPS/WSS，localhost 的 HTTP/WS 仅用于本机测试。

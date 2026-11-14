# iOS 出包与 TestFlight

- 日期：2026-11-13
- 相关：Issue #1448

## 为什么

v0.3.5 已经有 Android 手机 App（Settings → Phone 扫码配对），iOS 没有对应版本，iPhone 用户用不了配对。用户拍板走付费 Apple Developer Program（99 美元/年），测试版走 TestFlight。账号、付款和证书由用户自己办；仓库这边把出包、签名、上传的流程和脚本准备好，账号一到就能出包。

## 现在的状态

- `mobile/` 是 Expo（React Native）工程，一套代码出两端；iOS 原生工程由 `expo prebuild` 生成，不提交（`mobile/.gitignore` 忽略 `ios/`）。
- app.json 里已有 iOS 配置：bundle id `io.github.fei2411.dsbot`、deployment target 16.4、buildNumber 跟版本、`zh-Hans`、相机权限文案；`mobile/app.config.js` 把 `ds-bot/package.json` 的 version 写成 iOS 的 buildNumber。
- 无签名模拟器构建已经验过（Xcode 26.6 + Expo SDK 58，`xcodebuild` BUILD SUCCEEDED，App 能装进 iPhone 模拟器启动）；CI 的 `Mobile app iOS build (simulator)` 任务每次跑这一条，证明编译通过。
- 签名、archive、上传 TestFlight 的脚本已就位（`mobile/scripts/ios-archive.sh`），只差 Apple 账号和密钥。
- 真机安装、扫码配对还没做，同样等账号和设备。

## 用户要做什么

按顺序做，每步的产物后面要用。所有页面都在 <https://developer.apple.com> 和 <https://appstoreconnect.apple.com>。

1. **注册 Apple Developer Program**：<https://developer.apple.com/programs/enroll/>。个人账号用 Apple ID 注册并验证身份；组织账号还要 D-U-N-S 编号。年费 99 美元，账号持有人（Account Holder）本人操作。
2. **接受协议**：App Store Connect →「协议、税务和银行业务」（Agreements, Tax, and Banking）→ 接受 Program License Agreement。免费 App 不需要填付费 App 的税务和银行信息。
3. **拿 Team ID**：App Store Connect →「用户和访问」（Users and Access）→ 页面顶部显示 **Team ID**（10 位，字母数字）；或在 developer.apple.com 的 Membership details 里看。
4. **注册 App ID**：developer.apple.com →「Certificates, Identifiers & Profiles」→ Identifiers → 点 `+` → App IDs → App：
   - Description 填 `DS Bot`
   - Bundle ID 选 **Explicit**，填 `io.github.fei2411.dsbot`（必须完全一致，不能用 wildcard）
   - Capabilities 保持默认。App 用 `expo-secure-store` 的默认钥匙串组，不需要额外能力；不要勾 Associated Domains 等用不到的项。
5. **建 App Store Connect 记录**：appstoreconnect.apple.com →「我的 App」→ `+` → 新建 App：
   - 平台 iOS；名称 `DS Bot`（App Store 上要唯一，冲突时换一个，比如 `DS Bot Team`）
   - 主要语言按需要；Bundle ID 选第 4 步那个；SKU 填一个没人用过的串（例如 `dsbot-ios`）
   - 用户访问权限保持默认即可
6. **生成 App Store Connect API Key**：App Store Connect →「用户和访问」→「集成」（Integrations）→ App Store Connect API →「团队密钥」（Team Keys）→ `+`：
   - 名称例如 `dsbot-ci`；权限选 **App Manager**（能上传和管理构建；Admin 也可以）
   - 生成后**只能下载一次** `AuthKey_<KEYID>.p8`，同时记下列表里的 **Key ID**（10 位）和页面顶部的 **Issuer ID**（UUID）
   - 看不到「集成 / Team Keys」时，是账号角色不够：需要 Account Holder 或 Admin 来建
7. **（可选）测试用 Apple ID**：TestFlight 内部测试要邀请 Apple ID 邮箱。要测的那台 iPhone 用哪个 Apple ID，就提供哪个邮箱。

### 用户需要交给我们的东西

| 项 | 在哪拿 | 我们用来做什么 |
|---|---|---|
| Team ID（10 位） | App Store Connect → 用户和访问 → 顶部 | 签名配置（`DS_BOT_APPLE_TEAM_ID`） |
| Issuer ID（UUID） | 同上 → 集成 → App Store Connect API 页面顶部 | API 认证（`APPLE_API_ISSUER`） |
| Key ID（10 位） | 同上 → Team Keys 列表 | API 认证（`APPLE_API_KEY_ID`） |
| `AuthKey_<KeyID>.p8` 文件 | 生成密钥时下载（只有一次） | API 认证（`APPLE_API_KEY` 指向它） |
| 已建好的 App 记录（Bundle ID 一致） | App Store Connect → 我的 App | TestFlight 上传的目标 App |
| （可选）内部测试用的 Apple ID 邮箱 | — | TestFlight 邀请测试 |

`.p8` 和 Issuer ID 不要贴进聊天、邮件或 Issue；用密钥卡（`request_secret`）或放到本机目录后只告诉我们路径。仓库里不存任何密钥。

## 拿到之后我们做什么

1. 放密钥：本机放到 `~/Library/private_keys/AuthKey_<KEYID>.p8`（或任意路径，用 `APPLE_API_KEY` 指过去）；CI 用 secret，不进仓库。
2. 设环境变量（只传名字不含值）：
   ```sh
   export DS_BOT_APPLE_TEAM_ID=<Team ID>
   export APPLE_API_KEY=$HOME/Library/private_keys/AuthKey_<KEYID>.p8
   export APPLE_API_KEY_ID=<Key ID>
   export APPLE_API_ISSUER=<Issuer ID>
   ```
3. 出包：`cd mobile && sh scripts/ios-archive.sh`。脚本会 `expo prebuild` → `pod install` → 用 API key 自动签名 archive → 导出 `mobile/ios/build/export/DSBot.ipa`。
4. 上传：`sh scripts/ios-archive.sh --upload`，用 `xcrun altool --upload-app` 传到 App Store Connect。上传后等处理完，在 TestFlight 里加内部测试员（最多 100 人）。
5. TestFlight 设置：App Store Connect → 该 App → TestFlight。内部测试不需要 App Review；外部测试要 Beta App Review。出口合规：App 的连接层用标准算法做端到端加密，Info.plist 声明了 `ITSAppUsesNonExemptEncryption=false`；如果审核问起，按标准算法（X25519 等）说明。
6. 版本号：`mobile/app.config.js` 用 `ds-bot/package.json` 的 version 作 `CFBundleShortVersionString` 和 buildNumber。同一个版本重传必须递增 build number（发新版本时 version 跟着发版走）。

## 失败怎么排查

| 现象 | 原因 / 处理 |
|---|---|
| `No signing certificate "iOS Distribution" found`、`No profiles ... were found` | 三个 `-authenticationKey*` 参数没传全，或账号没接受协议，或 Key 权限低于 App Manager；自动签名需要 App Store Connect 里已有该 App 记录（第 5 步） |
| `Authentication failed` / HTTP 401 | Key ID、Issuer ID、`.p8` 不是同一把钥匙，或密钥已吊销；重新生成一把 |
| `bundle identifier ... is not available` / App ID 不存在 | App ID 没注册或拼错；`mobile/app.json` 的 `ios.bundleIdentifier` 必须与 App ID 完全一致 |
| 上传 `ITMS-...` 报错 | 多为 build number 未递增、版本号重复、缺少出口合规或图标/隐私清单问题；看 altool 输出的完整报错 |
| `pod install` 失败 | 先 `pod repo update`；CI 用 macos runner 自带 CocoaPods |
| CI 的 iOS 任务失败但本机过 | 无签名模拟器构建只证明编译；签名问题看本机 archive 输出 |

## 不做什么

- 拿到账号之前不上传 TestFlight、不伪造签名、不把证书或占位符写进仓库。
- 不做 App Store 上架（文案、截图、提审）；TestFlight 之后再说。
- 不做 iPad 专门适配；不改 Android 现有流程。

## 已知限制

- TestFlight：内部测试最多 100 人；每个 build 90 天；外部测试需要 Beta App Review。
- 账号角色：Team Keys 只有 Account Holder / Admin 能创建；只有 Account Holder 能签协议。
- CI 的 iOS 任务只做无签名模拟器构建，签名构建需要账号和密钥，走本机脚本或带 secret 的发布流程。
- 扫码配对真机验证仍要等账号和设备（模拟器没有摄像头，App 有粘贴配对链接的入口，但不能替代真机验收）。

## 变更

- 2026-11-13：初版：状态、用户清单、出包/上传流程、排查表（#1448）。

# Linux 桌面包：AppImage、deb 与 RPM

- 日期：2026-10-21
- 相关：#410、#556（2026-10-27 维护者同意增加 RPM，由提议者跟进 Fedora 实机测试与维护）

## 为什么

桌面应用只有 Windows（NSIS）和 macOS（zip）两个包。Linux 如果按发行版分别打 deb/rpm/pacman，每加一个格式就多一条维护线，而且这些格式都不支持应用内自动更新。

## 已定的行为

- Linux 同一次 `npm run dist` 产出三个 x64 包：**AppImage**（通用包）、**deb**（Debian/Ubuntu）与 **RPM**（Fedora/RHEL，可用 dnf 安装卸载，无需 FUSE，自带桌面菜单与图标）。#556 明确了 RPM 维护责任，因此扩展原先只出两个包的决定。不打 pacman/Flatpak/Snap。
- AppImage 是 Linux 上唯一被 electron-updater 原生支持的格式：读 `latest-linux.yml`，后台下载、退出时替换自身，与 Windows 共用 `watchUpdates` 路径。
- deb/RPM 不能自更新：与 macOS 共用 `watchReleases` 发布页提醒路径，分别等待资产 `linux-amd64.deb`、`linux-x86_64.rpm`（`watchReleases` 因此加了 `asset` 参数，默认仍是 mac zip）。
- 文件名遵循 Linux 惯例而非 `${arch}` 字面量：AppImage/RPM 是 `linux-x86_64`，deb 是 `linux-amd64`（electron-builder 对 Linux 目标的架构名映射；与 IPFS Desktop 等先例一致）。`src/linux-package.mjs` 统一提供架构名映射。
- `main.mjs` 优先按 `APPIMAGE` 环境变量选择自更新；其他 Linux 安装读取 `/etc/os-release`（不可读时回退 `/usr/lib/os-release`），先匹配 `ID`，再按 `ID_LIKE` 顺序匹配 RPM 或 Debian 家族；未知系统保持原先 deb 提醒。只解析身份字段，不执行文件内容。
- 不选 Flatpak/Snap：应用要在宿主机跑 pnpm 装插件、用 node-pty 开真实终端、读 `~/.dsh` 导入团队，与沙箱直接冲突（`flatpak-spawn --host` 等于拆空沙箱；Snap 的 classic 限制要商店特批，非 Ubuntu 发行版也普遍抵触）。先例：IPFS Desktop 因 confinement 问题弃用 Snap，主推 AppImage。
- 已知坑写进 README：AppImage 需要 FUSE 2（Ubuntu 24.04+/Debian 13+ 装 `libfuse2t64`）；Ubuntu 24.04+ 的 AppArmor 限制非特权 user namespace，会拦 AppImage 里的 Chromium 沙箱——deb 无此问题（post-install 设好 `chrome-sandbox`，electron-builder 26 起自动生成 AppArmor profile）。
- 只出 x64；arm64 留到有 `linux/arm64` 预编译链（node-pty 等）确认后的后续工作。
- 二进制与菜单项名 `deepseek-bot`（`executableName`），deb/RPM 装进 `/opt/DeepSeek Bot`。

## CI

- `test.yml` 加 `app-package-linux`：构建、xvfb 下 `check-packed`、deb 安装/检查/更新提醒/卸载、AppImage 自更新端到端（退出后文件 sha512 等于新版）。runner 上 `sysctl kernel.apparmor_restrict_unprivileged_userns=0` 并装 `libfuse2t64`（一次性的抛弃环境，安全代价可接受）。
- `release.yml` 加 `app-linux` job：把 AppImage（内嵌 block map）、deb、RPM 和 `latest-linux.yml` 挂到 release。
- `result` 汇总 job 的 `needs` 同步加 `app-package-linux`。
- 构建 runner 安装 `rpm`，同一 Linux job 用 Fedora 44 容器执行 RPM 的 dnf 安装、桌面项/图标/沙箱权限检查、非 root 用户启动与 mock 对话、更新提醒、卸载。容器只读挂载源码；SYS_ADMIN 仅用于一次性容器内的 Chromium 沙箱。AppImage 更新测试只重打 AppImage。

## Fedora 图片兼容性（#556）

Fedora 44 实测发现 Electron 44.7.0 与 sharp 0.35.5 的原生 GLib 符号冲突：图片缩放在系统 `g_object_unref` 中崩溃，见 [electron#46323](https://github.com/electron/electron/issues/46323)。Linux 包携带同版本的官方 `@img/sharp-wasm32`，通过打包排除原生 Linux sharp/libvips，让 sharp 使用其已有的 WASM 回退路径；不修改 DSH、sharp 源码或模块加载器，也不增加另一个 Host 运行时。Windows/macOS 保持原生后端。

`check-packed` 保留原有像素级缩放断言，并通过 DSH 公共 `prepareImageFile` API 检查 PNG/JPEG/WebP/GIF 的归一化、尺寸、透明度和坏图片拒绝。WASM 不支持原生字体渲染和瓦片输出，DSH 的图片附件归一化不使用这些能力；源码开发运行仍按 npm 安装的原生后端执行。该打包兼容方案随本 PR 提交维护者审查。

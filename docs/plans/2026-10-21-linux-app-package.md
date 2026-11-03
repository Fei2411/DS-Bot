# Linux 桌面包：一个 AppImage 通吃 + deb 兜底

- 日期：2026-10-21
- 相关：#410

## 为什么

桌面应用只有 Windows（NSIS）和 macOS（zip）两个包。Linux 如果按发行版分别打 deb/rpm/pacman，每加一个格式就多一条维护线，而且这些格式都不支持应用内自动更新。

## 已定的行为

- Linux 只出两个包，同一次 `npm run dist` 产出：**AppImage**（主包，一个文件跑所有 glibc 发行版）加 **deb**（Debian/Ubuntu 兜底）。不打 rpm/pacman/Flatpak/Snap，也不做按发行版分包。
- AppImage 是 Linux 上唯一被 electron-updater 原生支持的格式：读 `latest-linux.yml`，后台下载、退出时替换自身，与 Windows 共用 `watchUpdates` 路径。
- deb 不能自更新：与 macOS 共用 `watchReleases` 发布页提醒路径，等待的资产是 `linux-amd64.deb`（`watchReleases` 因此加了 `asset` 参数，默认仍是 mac zip）。
- 文件名遵循 Linux 惯例而非 `${arch}` 字面量：AppImage 是 `linux-x86_64`，deb 是 `linux-amd64`（electron-builder 对 Linux 目标的架构名映射；与 IPFS Desktop 等先例一致）。`main.mjs` 和 `check-update.mjs` 里因此有 x64→amd64 的映射。
- `main.mjs` 按 `APPIMAGE` 环境变量区分 Linux 上两种格式的更新路径。
- 不选 Flatpak/Snap：应用要在宿主机跑 pnpm 装插件、用 node-pty 开真实终端、读 `~/.dsh` 导入团队，与沙箱直接冲突（`flatpak-spawn --host` 等于拆空沙箱；Snap 的 classic 限制要商店特批，非 Ubuntu 发行版也普遍抵触）。先例：IPFS Desktop 因 confinement 问题弃用 Snap，主推 AppImage。
- 已知坑写进 README：AppImage 需要 FUSE 2（Ubuntu 24.04+/Debian 13+ 装 `libfuse2t64`）；Ubuntu 24.04+ 的 AppArmor 限制非特权 user namespace，会拦 AppImage 里的 Chromium 沙箱——deb 无此问题（post-install 设好 `chrome-sandbox`，electron-builder 26 起自动生成 AppArmor profile）。
- 只出 x64；arm64 留到有 `linux/arm64` 预编译链（node-pty 等）确认后的后续工作。
- 二进制与菜单项名 `dsbot`（`executableName`），deb 装进 `/opt/DS Bot`。

## CI

- `test.yml` 加 `app-package-linux`：构建、xvfb 下 `check-packed`、deb 安装/检查/更新提醒/卸载、AppImage 自更新端到端（退出后文件 sha512 等于新版）。runner 上 `sysctl kernel.apparmor_restrict_unprivileged_userns=0` 并装 `libfuse2t64`（一次性的抛弃环境，安全代价可接受）。
- `release.yml` 加 `app-linux` job：把 AppImage（含 `.blockmap`）、deb 和 `latest-linux.yml` 挂到 release。
- `result` 汇总 job 的 `needs` 同步加 `app-package-linux`。

- 2026-11-01：程序与包名改为 dsbot；deb 声明替换并冲突于旧包，安装新包时由包管理器移除旧程序，用户数据保留。

#!/usr/bin/env bash
# Run as root inside a disposable Fedora container, with the checkout at /src (read-only).
set -euo pipefail
cd /src/app
dnf install -y nodejs xorg-x11-server-Xvfb xauth dbus-daemon util-linux shadow-utils
version="$(node -p "require('./package.json').version")"
package="./dist-pack/DeepSeek-Bot-$version-linux-x86_64.rpm"
dnf install -y "$package"
test "$(rpm -q --qf '%{VERSION}-%{RELEASE}.%{ARCH}' deepseek-bot)" = "$(rpm -qp --qf '%{VERSION}-%{RELEASE}.%{ARCH}' "$package")"
test -f /usr/share/applications/deepseek-bot.desktop
test -f /usr/share/icons/hicolor/1024x1024/apps/deepseek-bot.png
if unshare --user true; then sandbox_mode=755; else sandbox_mode=4755; fi
test "$(stat -c '%a:%U' '/opt/DeepSeek Bot/chrome-sandbox')" = "$sandbox_mode:root"
useradd --create-home checker
runuser -u checker -- xvfb-run -a node scripts/check-packed.mjs '/opt/DeepSeek Bot/deepseek-bot'
runuser -u checker -- xvfb-run -a node scripts/check-update.mjs '/opt/DeepSeek Bot/deepseek-bot' 99.0.0
dnf remove -y deepseek-bot
test ! -e '/opt/DeepSeek Bot/deepseek-bot'
test ! -e /usr/share/applications/deepseek-bot.desktop
test ! -e /usr/bin/deepseek-bot

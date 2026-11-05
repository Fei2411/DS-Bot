# DS-Bot Fork Patches

每个 `.patch` 文件对应一个二开修复或功能补丁。
上游升级后执行以下命令重新应用所有补丁：

```bash
git fetch upstream
git rebase upstream/main
git apply patches/*.patch
```

如某个补丁已被上游合并，删除对应 `.patch` 文件即可。

## 补丁清单

| 文件 | 状态 | 说明 |
|------|------|------|
| （待添加：Worker Bot 类型扩展） | 🔵 开发中 | feat: type=remote-worker Bot 类型 + turn 路由 + worker-bridge |
| （待添加：Bot 自定义分组） | 🔵 开发中 | feat: state.json groups 字段 + 侧边栏折叠视图 |
| （待添加：记忆系统选择） | 🔵 开发中 | feat: bot.memoryConfig.backend 多后端路由 |

## 提 Issue 流程

发现上游 Bug 时，在当前会话说"提 Issue"，助手会从 memory 提炼根因和复现步骤生成 Issue 正文。
目标仓库：https://github.com/Fei2411/DS-Bot/issues

## 上游已知 Bug（待提 Issue）

| Issue | 状态 | 说明 |
|-------|------|------|
| #919 | open | delegated Bot stuck waiting with no timeout recovery |
| #881 | open | read_group_chat no since cursor, 770K token repeat |

# 文件夹拖入创建对话 · dsh 插件

把电脑文件管理器里的**文件夹**拖进 dsh（桌面客户端），自动以该文件夹为工作区**新建一个对话**。
单个文件、图片、文字拖放保持 dsh 原有行为，不受影响。

- 适用宿主：DeepSeek Harness（dsh）`0.2.2-rc.3`
- 类型：纯客户端插件（不修改 Electron 宿主，不打宿主补丁）
- 许可证：MIT

## 它做什么

| 拖入对象 | 行为 |
|---|---|
| 一个文件夹 | 注册该文件夹为 Workspace（已存在则复用）→ 新建对话并选中 → 新对话的 cwd 即该文件夹 |
| 同次多个文件夹 | 只处理第一个，提示里说明其余被忽略 |
| 单个文件 / 图片 | 不触发，交回 dsh 常规附件处理 |
| 无权限文件夹 | 提示读/列举失败，不创建对话，不崩溃 |
| 非桌面网页窗口 | 提示缺少原生路径桥，不创建对话 |

## 安装

**方式 A：市场索引（推荐）**

1. dsh：设置 → 插件 → 实验性插件 → 更多 → 自定义插件市场 → 开启
2. 发现 → 添加索引源，粘贴：
   `https://yang313760940.github.io/dsh-folder-drop-session/index.json`
3. 在「文件夹拖入创建对话」上点安装，然后**完全退出并重开 dsh**。

**方式 B：命令行**

```pwsh
# 先完全退出 dsh 桌面应用
dsh plugin --profile desktop add "git+https://github.com/yang313760940/dsh-folder-drop-session.git"
```

**方式 C：本地 tgz**

```pwsh
npm pack
dsh plugin --profile desktop add ".\dsh-folder-drop-session-1.0.0.tgz"
```

## 使用

安装并重启后，从资源管理器/Finder 拖一个文件夹到 dsh 窗口任意位置：
右下角出现「正在为文件夹创建新会话」，完成后视图切到新对话，工作区即该文件夹。

## 实现要点（已按真实接口开发）

- 目录判定：`DataTransferItem.webkitGetAsEntry().isDirectory`，不靠扩展名或空文件。
- 原生路径：桌面桥 `window.__DSH_HOST_PATHS__.pathFor(file)`（`electron.webUtils.getPathForFile`），路径在 `drop` 的同步栈内快照，避免异步后失效。
- 权限预检：`FileSystemDirectoryReader.readEntries` 首批读取，失败即报错且不调用宿主。
- 注册与建会话：`workspaces.create({ path })` → `sessions.create({ workspaceId })` → `uiWorkspace.openSession(sessionId)`，失败保留已完成步骤并给出可恢复信息。
- 无自造 RPC、无跨会话 cwd 修改、不读取文件夹内容。

接口证据与边界见 [docs/HOST-INTERFACES.md](docs/HOST-INTERFACES.md)。

## 开发

```pwsh
node scripts/build.mjs          # 构建 lib/client.js（惰性 factory）
npm test                        # 39 项单元 + DOM 事件测试
node scripts/build-market.mjs   # 生成 market-dist/index.json
```

也可以直接打开 dsh 的 `http://127.0.0.1:<port>` 之外的桌面窗口拖动验证；普通浏览器页面没有原生路径桥，只会给出提示。

## 市场索引

本仓库自身就是一个 format-1 插件市场索引源，由 GitHub Actions 在每次 push 后生成并部署到 GitHub Pages：

`https://yang313760940.github.io/dsh-folder-drop-session/index.json`

## 已知限制

- 服务端（远程 Host）场景下浏览器拿到的路径是本机路径，请改用 dsh 自带目录选择器。
- 仅在 `0.2.2-rc.3` 上验证；升级宿主后请先跑 `npm test` 与人工拖放验收。

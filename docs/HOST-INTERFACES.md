# 已核实的宿主接口清单（dsh 0.2.2-rc.3）

本文件只记录实现用到的真实接口与证据；本插件不虚构 API。

## 拖放与原生路径

| 接口 | 来源 | 用途 |
|---|---|---|
| `window.__DSH_HOST_PATHS__.pathFor(file: File): string` | `resources/app/lib/preload-app.cjs:2098` | 原始 File → 宿主绝对路径（`electron.webUtils.getPathForFile`） |
| `DataTransfer.items[].webkitGetAsEntry()?.isDirectory` | 浏览器标准；现有 `dsh-client-ui-attachment/src/client/drop-events.ts:5-20` 同样使用 | 判定目录；不靠 size/扩展名/文件名 |
| `FileSystemDirectoryReader.readEntries` | 浏览器标准 | 权限冒烟检查（首批成功或 error 回调） |

`__DSH_HOST_PATHS__` 仅在 `dsh-app://app` 页面注入；普通 `http://127.0.0.1` 浏览器页没有该桥，插件检测缺失并明确报错。

## 客户端业务服务（浏览器侧）

| 接口 | 证据 | 用途 |
|---|---|---|
| `ctx.workspaces.create({ path }): Promise<WorkspaceView>` | `dsh-api-workspace-controller/src/client/service.ts:130` | 幂等注册目录；返回 `{ workspaceId, path, title, sessionIds }` |
| `ctx.sessions.create({ workspaceId }): Promise<SessionId>` | `dsh-api-session-controller/src/client/sessions/service.ts:450` | 新建对话；cwd 由宿主取 workspace.path |
| `ctx.uiWorkspace.openSession(sessionId)` | `dsh-client-ui-workspace/src/client/navigation.ts:293` | 把新对话切为主视图 |
| `ctx.layout.beginNavigation(): AbortSignal` | `dsh-client-ui-layout/src/client`（`ILayout.beginNavigation`） | 用户另一次导航时优先，不抢回视图 |
| `ctx.effect(() => disposer)` | `@deepseek-ai/cordis` `Fiber` | 挂载/卸载拖放生命周期 |

## 宿主工作区域（Region）

| 语义标记 | 证据 | 用途 |
|---|---|---|
| `[data-sidebar-workspace-header]` | `dsh-client-ui-workspace/src/client/rows/WorkspaceBrowser.tsx:1220` | 定位工作区栏根 |
| `[data-sidebar-list-area]` | `WorkspaceBrowser.tsx:1354` | 兼容只挂载 list 的壳 |

## bundle / client 加载

| 机制 | 证据 | 用途 |
|---|---|---|
| `package.json.dsh.client = { platform: 'web', inject: [...] }` | `dsh-package-manifest/src/types.ts:87-100` | 声明浏览器插件与依赖 |
| `package.json.dsh.bundle.patch` | `dsh-package-manifest/src/types.ts:71-78` | 组合包 patch 入口 |
| `cordis.patch.yml` `- insert:` | 安装版 `dsh-experimental-terminal-bundle/cordis.patch.yml` | 追加独立 Loader 条目，不覆盖内置条目 |
| `window.__ModuleLoader__.load({ id, factory })` | `dsh-client-modules/src/client/system.ts:165-174` | 生成的 client bundle 注册惰性 factory |

## 宿主侧目录注册（仅证明路径规则，未直接调用）

`dsh-workspace/src/index.ts:254-260`：`create(path)` 先 `realpathNormalize`（要求完全限定路径）再 `stat` 判目录；相对路径、不存在、非目录拒绝。因此客户端传入拖放得到的绝对路径即可，错误信息由宿主 Remote 抛出（`workspace/invalid-path`）。

## 未实测项

- 真实 OS 从资源管理器拖动文件夹：静态核实的桥接链路未被本机人工拖放复验，需安装后手动验收。
- `getAsFile()` 对目录 File 的行为：已按现有 attachment 实现保持保守（优先 `getAsFile`，缺失时按 FileList 文件项顺序回退并校验名称）。

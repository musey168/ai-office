---
id: rpc-bridge
type: module-design
status: draft
title: rpc-bridge —— renderer 与服务端之间的 IPC 等价层
parent: architecture
tags: [web, ipc]
---

# rpc-bridge

## 职责

在浏览器与 Node 服务端之间提供与上游 Electron IPC **语义等价**的调用面，让上游 renderer 零改动地跑在网页里。

它拥有三样东西：

1. **浏览器端 preload 替身**——注入与上游同名同签名的全局对象；
2. **服务端通路上由**——把约 600 个通道名映射到处理器；
3. **契约的镜像**——通道名、方法名、参数与返回形状一律以上游 `apps/*/src/shared/` 为准，本模块不自己定义第二套。

## 边界

**允许依赖**：`web/workspace-store`、`web/engine-pool`、`web/render-service`、`web/ai-service`、`web/file-index`；上游 `apps/*/src/shared/*.ts` 的**类型**（仅类型，不含实现）。

**禁止**：

- 不得 import `electron`；
- 不得复制或重定义上游的 API 类型——两份定义一旦分叉，合上游时会静默出错；
- 不得在本模块内直接读文件，文件访问一律经 `web/workspace-store`；
- 不得修改上游 `apps/*/src/main/`。

## 契约：什么必须一字不差

### 全局对象名

上游 preload 用 `contextBridge.exposeInMainWorld` 暴露的对象，网页版必须**同名**注入：

| app | 全局对象 | 方法数 |
| --- | --- | --- |
| docs | `desktop` / `aiNamingApi` / `projectApi` | 110 / 1 / 6 |
| sheets | `desktopApi` / `aiNamingApi` / `projectApi` / `nativeSpell` | 105 / 1 / 6 / 2 |
| slides | `slidesApi` / `desktop` / `aiNamingApi` / `projectApi` | 208 / 6 / 1 / 6 |
| pdf | `pdfApi` / `projectApi` | 82 / 4 |
| markdown | `markdownApi` / `aiNamingApi` / `projectApi` | 69 / 1 / 4 |
| html | `htmlApi` / `aiNamingApi` / `projectApi` | 61 / 1 / 4 |
| shell | `aiOffice` / `aiOfficeTabs` / `aiOfficeIntegrations` / `aiNamingApi` / `projectApi` | 130 / 19 / 14 / 1 / 6 |

**陷阱**：`desktop` 这个名字被 docs（110 个方法的完整 API）和 slides（6 个方法的附件子集 `DesktopFilesApi`）同时使用，形状完全不同。网页版按 app 分别注入，不得合并成一个公共对象。

### 调用语义判定

上游没有可依赖的统一前缀，只能按返回值判定：

| 返回值 | 语义 | 上游对应 |
| --- | --- | --- |
| `Promise` | 请求-应答 | `ipcRenderer.invoke` |
| 函数 | 订阅（调用后返回退订函数） | `ipcRenderer.on` |
| `void` / `undefined` | 单向发送 | `ipcRenderer.send` |

两个例外必须单独处理：

- `aiOffice.onboardingSeen`（`apps/shell/src/preload/index.ts:352`）名字以 `on` 开头但走 invoke；
- `nativeSpell`（`apps/sheets/src/preload/index.ts:1064`）走 `webFrame.isWordMisspelled`，**根本不是 IPC**，浏览器无对应物。

### 通道命名空间

约 600 个通道名，来源有两处，路由表必须**同时**从这两处生成：

- 类型文件：`apps/*/src/shared/ipc.ts` 等；
- 常量表：`apps/pdf/src/shared/ipc.ts:14` `PDF_CHANNELS`、`apps/markdown/src/shared/ipc.ts:13` `MARKDOWN_CHANNELS`、`apps/html/src/shared/ipc.ts:11` `HTML_CHANNELS`、`apps/shell/src/shared/home-api.ts:667` `HOME_CHANNELS`（96 个）、`apps/shell/src/shared/tabs-api.ts:108` `TABS_CHANNELS`、`apps/shell/src/shared/integrations-api.ts:74` `INTEGRATIONS_CHANNELS`、`apps/sheets/src/shared/ipc-channels.ts:1` `IPC_CHANNELS`（81 项）。

通道名一律不改。

## 协议映射

| 上游语义 | 网页版 | 说明 |
| --- | --- | --- |
| `invoke` | `POST /rpc/:channel` | 响应体即返回值；错误以非 2xx + 结构化 body 返回 |
| `send` | `POST /rpc/:channel` | 响应体为空，服务端不等待结果 |
| `on`（主进程推送） | `GET /events`（SSE） | 按通道名过滤订阅 |
| AI 流式回合 | `POST /ai/stream` 发起 + `GET /ai/stream/:requestId`（SSE） | 见「AI 通道」 |
| 长耗时任务 | `POST /rpc/:channel` 返回 `{taskId}` + `GET /tasks/:taskId` | 见「长耗时通道」 |

### 定向问题

上游的 `webContents.send` 是 **per-tab 定向**的：`menu:command`（docs）、`menu:action`（sheets）、`slides:menu`（slides）、`docs:mcp-command`、`sheets:mcp-command` 只发给某一个标签页。BroadcastChannel 是全页面广播，**必须带 tabId**，否则多标签串扰。

`home:open-path` 是唯一的跨 app 通道（shell 与五个编辑器共用，语义是「打开或切到该文档」），路由表要保留它。

菜单命令本身已在上游定型，不在本模块重新设计：docs 72 个（`apps/docs/src/shared/ipc.ts:204-274`）、sheets 8 个（`apps/sheets/src/shared/desktop-api.ts:3641`）、slides 17 个（`apps/slides/src/shared/ipc.ts:1344-1360`）；pdf / markdown / html 上游没有菜单通道。

### 同步通道

上游有一处 `ipcRenderer.sendSync`：`docs:context-menu-claim`（`apps/docs/src/preload/index.ts:131`）。HTTP 无同步语义，而 renderer 不能改——需要一个等价方案（预登记 seq + 轮询，或改成服务端预分配 claimId 的握手）。**这是本模块最硬的一处兼容缺口。**

### 非 IPC 能力

| 上游能力 | 位置 | 网页版 |
| --- | --- | --- |
| `webUtils.getPathForFile` | `docs:248` / `sheets:939` / `html:62` / `slides:562` / `shell:292` | 浏览器无此 API → 改为「上传 File 对象到工作区」，renderer 代码不变、语义变 |
| `webFrame.isWordMisspelled` | `sheets:1064` | 浏览器无 → 该能力不可用，登记为原生能力缺口 |
| 拖放打开桥 `installDropOpenBridge()` | `packages/electron-utils/src/drop-open.ts:112` | 不暴露全局，但网页版会失去「拖文件到窗口即打开」→ 改为上传 |
| 自定义 scheme（`genoffice-lazy-media://handoff/...`） | `apps/docs/src/main/byte-handoff.ts:44` | 改为 HTTP 端点 + 一次性 token，语义照搬（TTL 60s、上限 8 个 / 1GB） |
| **媒体 scheme `genoffice-docx-media:` / `genoffice-slide-media:`** | `packages/electron-utils/src/renderer-scheme.ts:23`、`:35` | **必须改成服务端 URL**——且这是硬阻塞：docs renderer 的 CSP 写死了 `img-src 'self' data: blob: genoffice-docx-media:`（`apps/docs/src/renderer/index.html:6-8`）。CSP 是上游文件，属于「允许的插入点」清单里的一处 |

### 原生菜单与窗口（不可移植）

`TabsApi` 里有三组能力依赖 Electron 原生能力，网页版无法照搬：

| 能力 | 位置 | 网页版处置 |
| --- | --- | --- |
| `showMenu` / `showNewMenu` / `showTabMenu` | `apps/shell/src/shared/tabs-api.ts:36` 起 | 原生右键菜单（因为内容区是 WebContentsView 会盖住 DOM 下拉）→ 改成 DOM 菜单 |
| `tearOff` / `dragTornWindow` / `dockTornWindow` / `endTornDrag` | 同上 | 窗口拖出与回嵌 → 退化，不实现 |
| `reportDockIndex` / `onDockPreview` / `dockTornWindow` | 同上 | 拖拽预览 → 退化 |

这些属于[架构文档](../architecture.md)列的原生能力缺口，处置结论要能逐条对得上。

## AI 通道

上游 `registerAiIpc()`（`apps/docs/src/main/docs-main.ts:4456`）由 shell 调用**一次**（`apps/shell/src/main/index.ts:7032`），六个编辑器与 shell home 共用同一批通道。网页版同样只注册一份实现——上游靠 `ipcMain.removeHandler` 做「后注册覆盖」，网页版是单一路由表，不存在覆盖顺序问题。

**必须复刻静默看门狗**：上游 `IPC_STREAM_SILENCE_TIMEOUT_MS = 240_000`（`packages/agent-core/src/electron-transport.ts:49`），靠 `type: 'ping'` 的增量块保活。SSE 若不送 ping，240 秒后会被判死。

## 长耗时通道

以下通道在网页版必须改成「提交任务 + 取结果」，不能让 HTTP 请求长期挂起：

- AI 回合：`ai:stream` / `ai:stream-cancel`；
- 导出：`docs:export-pdf|html|markdown`、`slides:export-pdf|images|video`、`pdf:export-pdf`、`markdown:export-docx|pdf`、`html:export-docx|pdf|html`；
- 转换：`pdf:convert-office`、`pdf:ocr-page`、`pdf:decrypt`、`docs:altchunk-html-to-docx`；
- 分块保存：`workbook:save-edits-begin` / `-chunk` / `-abort`（`apps/sheets/src/shared/ipc-channels.ts:105-107`）；
- 导入进度：`workbook:import-progress`（推送，保留为 SSE）；
- headless export：`<app>:consume-headless-export` + `<app>:headless-export-done`。

**分块保存不是长任务的全部**：sheets 的 `workbook:save-edits-begin/-chunk/-abort` 分块只是为了限制 IPC 结构化克隆的峰值（累积器 `apps/sheets/src/main/save-edits-transfer.ts:25`，`MAX_OPEN_TRANSFERS=4`、闲置 120 秒过期），最终仍是一次全量的 `saveWorkbookViaSidecar`（`apps/sheets/src/main/sheets-main.ts:5037`）。网页版保持「收齐分块 → 一次提交」的结构即可，不必给这一路单独的任务队列。

## 控制通道（CLI ↔ shell）

上游用 Unix domain socket / Windows 命名管道（`apps/shell/src/main/control-server.ts:33-38`），线格式是每连接一问一答的换行 JSON（`packages/cli/src/control-protocol.ts:22-58`），renderer 侧钩子是 `window.__genofficeControl`——各 app renderer 自己挂到 window，不是 preload 暴露的（`apps/docs/src/renderer/App.tsx:7129`、`apps/sheets/src/renderer/App.tsx:5895`、`apps/slides/src/renderer/App.tsx:3278`、`apps/pdf/src/renderer/App.tsx:2027`；markdown 与 html 没有）。

浏览器没有 unix socket，服务端也无法 `executeJavaScript`（上游靠 `apps/shell/src/main/control-handlers.ts:105-133` 求值）。网页版需要一条新传输层：**页面主动轮询服务端**，服务端把 control 请求路由到目标标签。`window.__genofficeControl` 本身在网页版仍然可用。

## 不变量

1. 上游 renderer 文件零改动，只在入口挂载本模块的 bridge 脚本；
2. 通道名与全局对象名与上游一一对应，不改名、不合并；
3. 路由表覆盖上游全部约 600 个通道——**未实现的通道必须显式报错，不得静默返回 undefined**；
4. API 类型只从上游 `shared/` 引入，本模块不定义第二套；
5. SSE 必须带 ping 保活，与上游 240 秒看门狗对齐；
6. 本模块不得直接访问文件系统；
7. 任何跨标签推送都必须带 tabId。

## 风险

- `sendSync` 的同步语义需要专门方案（见「同步通道」）；
- 通道数量约 600，逐个实现容易漏——需要一份可自动核对的清单，且能力回归（S4）要覆盖它；
- `desktop` 命名空间在 docs 与 slides 下形状不同，注入时容易串；
- 上游 preload 强制单文件打包（sandbox 下多 chunk 会丢全局，见 `apps/docs/src/preload/index.ts:301-310`），网页版无此约束，但照抄 preload 源码时要注意 `aiNamingApi` 是内联而非 import 的。

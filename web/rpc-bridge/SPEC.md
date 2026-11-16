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

## 落点与构建

代码落在 `web/rpc-bridge/`，**自包含**（自带 `package.json` 与自己的 `node_modules`），只依赖 `web/workspace-store`（`file:` 依赖）。

浏览器端的桥接层**不手写**：构建时把 `electron` 这个 import 别名指向我们的 shim（`src/shim.ts`），
把上游 7 个 preload 源码（`apps/<app>/src/preload/index.ts`）**原样**编成浏览器 bundle：

- 上游 preload 只从 electron 导入 `contextBridge`、`ipcRenderer`、`webUtils`（sheets 另加 `webFrame`）——shim 面很小；
- 其余 `@genoffice/*` 引用全是 type-only，运行时依赖只有 `@genoffice/electron-utils/drop-open`（它自己也只 import electron）与 `@genoffice/ai-provider/browser`、`@genoffice/ui/ai-panel-prefs`（两者都是零依赖自包含文件）；
- 产物为 ES module（`<script type="module" src="/bridge/<app>.js">`），模块脚本按文档顺序执行，bridge 在前；
- `@genoffice/*` 子路径按规则解析到上游 checkout 的源码（与上游自己的 vite 配置同思路），上游新增子路径不必改我们的配置。

**为什么不用手写桥接层**：上游那约 600 个通道的名字、参数与返回形状已经写在 preload 里；
重新表达一遍就等于有了第二份通道表，会在合上游时静默失配。

## 协议映射

| 上游语义 | 网页版 | 说明 |
| --- | --- | --- |
| `invoke` | `POST /rpc/:channel` | 响应体即返回值；错误以非 2xx + 结构化 body 返回 |
| `send` | `POST /rpc/:channel` | 响应体为空，服务端不等待结果 |
| `on`（主进程推送） | `GET /events`（SSE） | 按通道名过滤订阅 |
| AI 流式回合 | `POST /ai/stream` 发起 + `GET /ai/stream/:requestId`（SSE） | 见「AI 通道」 |
| 长耗时任务 | `POST /rpc/:channel` 返回 `{taskId}` + `GET /tasks/:taskId` | 见「长耗时通道」 |

### 页面上下文：浏览器没有 `event.sender.id`

Electron 用 `event.sender.id`（发起调用的 web contents 的 id）把文档交给对应的窗口——
上游的 `pendingWindowOpens` 就是一张按 id 索引的表。浏览器没有这个 id，
所以**页面自己声明**自己是谁：`RpcContext { app, tabId }`。

- `app` 从路径得出（`/app/docs/` → `docs`）；
- `tabId` 从查询参数得出（`/app/docs/?tab=tab-1`）；
- 上下文走请求信封（`{ args, ctx }`），**不混进通道参数**——通道参数必须与上游一字不差。

### 标签表在服务端

上游的标签表在主进程里（`apps/shell/src/main/tab-manager.ts`），shell renderer 通过
`tabs:list` 读取、`tabs:changed` 接收变化。网页版没有主进程，标签表因此在服务端
（`src/server/tabs.ts`）：形状与上游 `TabSummary` 一致，shell 的标签栏照常渲染。

`home:open-path` 在上游是「打开文档」；这里它**开一个标签**，
标签带着文件路径，编辑器 iframe 凭 `tabId` 找到该打开什么。

**标签表是进程级全局状态**——首版没有登录，所有人共用一个工作区，
于是 A 打开的文档会出现在 B 的标签栏上，待打开的文档也是先到先得。
共享的是**文件**，不是**每个人的界面**：正式部署前要按浏览器会话隔离
（会话 id 走请求信封 ✓，与页面上下文同一条路 ✓）。

### 编辑器在 shell 页面里怎么活

上游的 shell renderer 里**没有 iframe**——编辑器是主进程摆在上层的原生 `WebContentsView`。
浏览器没有这个机制，于是 **bridge 脚本**（`src/host.ts`）在 shell 页面里挂一个 iframe，
盖住标签栏以下的内容区，跟着 `tabs:changed` 切换 `src`。上游 renderer 零改动。

iframe 是**替换元素**：`width: auto` / `height: auto` 时它保留固有的 300×150，
`left/right/top/bottom` 这四条边会被忽略。所以宽高必须写出来——
实测漏掉宽度时，编辑器在 300px 宽的框里排版，ribbon 挤成一列、画布是空的，
而 DOM 断言（ProseMirror 有内容）照样通过。**这类问题只有看截图才发现得了。**

### 安全上下文的缺口

浏览器只在**安全上下文**（HTTPS 或 localhost）里提供 `crypto.randomUUID`、`crypto.subtle`、
`navigator.clipboard` 等 API。部署在内网的 HTTP 上，这些**不存在**——
上游的文档渲染器启动时就会调 `crypto.randomUUID`，页面直接抛
"crypto.randomUUID is not a function"。

因此 bridge 在**每个页面**注入一个 polyfill 脚本（`src/polyfill.ts`）。
它不是塞进 bridge 包里的：上游不是每个 preload 都 import `electron`，
只有碰得到 shim 的页面才带得上 polyfill——所以 polyfill 走独立入口，由服务端注入。

### 字节：一次性 token 与一次性 URL

Electron 的 IPC 用结构化克隆，能直接传 `ArrayBuffer`；JSON 不能。两条方向各有做法：

| 方向 | 做法 |
| --- | --- |
| renderer → 服务端 | shim 先把二进制参数上传到字节端点，JSON 里只留 token；服务端消费 token 时取回字节 |
| 服务端 → renderer | 服务端把二进制结果放进字节存储，JSON 里回一个 token 形状的对象 |

**文档字节走的是上游自己的机制**：上游的 `docs:open-path` **不返回字节**，而是返回
`OpenDocxResult { path, name, dataUrl, hash }`，其中 `dataUrl` 是一次性 URL
（`genoffice-docx-media://handoff/<uuid>`，TTL 60s / 上限 8 个 / 1GB），
renderer 自己 `fetch` 那个 URL 取字节（`apps/docs/src/renderer/doc-bytes.ts:2`）。
网页版把 `dataUrl` 换成同源的 `/media/<token>`，**上游 renderer 代码一行不用改**。

同理，保存时上游传的是 `data: ArrayBuffer`（`apps/docs/src/preload/index.ts:119`），
shim 把它转成 token，服务端还原成字节交给存储层。

### 事件流：一条连接，客户端自己筛

上游的 `webContents.send` 是按窗口投递的。网页版的一条 SSE 连接要服务整个页面，
而页面的监听集合会随组件挂载/卸载变化。**按通道过滤 + 通道集合变了就重连**的做法有两个问题：
重连的缝隙里事件会静默丢失，而且每次挂载都要断一次。

所以：**每个页面一条连接，连上就不换**；订阅不带通道过滤，客户端按本地监听表分发。
服务端保留了按通道过滤的能力（`?channels=a,b`），给需要窄订阅的其他客户端用；
**空过滤 = 订阅全部**。

### 定向问题

上游的 `webContents.send` 是 **per-tab 定向**的：`menu:command`（docs）、`menu:action`（sheets）、`slides:menu`（slides）、`docs:mcp-command`、`sheets:mcp-command` 只发给某一个标签页。BroadcastChannel 是全页面广播，**必须带 tabId**，否则多标签串扰。

**落地方式**：事件流按 tab 订阅——浏览器的 EventSource URL 带上 `?tab=<id>`
（`client.ts` 从页面上下文取），服务端只把该 tab 的事件投递给这条连接
（`EventHub.publishToTab`）。没有 `?tab=` 的连接（shell 首页）收全部事件——
首页关心的是跨标签的 `tabs:changed`。

上游的幻灯片主进程在 worker 里，它推的事件（`slides:deck-changed`、
`slides:history-changed`）也走这条路：worker → 引擎协议 → HTTP 进程 → 事件流 → 那个 tab。

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

## 首片覆盖的通道

第一刀 = **在浏览器里打开一个 .docx → 编辑 → 保存回原文件**，外加首页文件树。

**docs**：`docs:open-path`、`docs:consume-pending-open`、`docs:save`、`docs:save-to`、
`docs:save-new`、`docs:recent`、`docs:font-aliases`、`docs:password-intent-revision`

**app（启动时读）**：`app:get-language`、`app:get-theme`、`app:get-document-theme`、
`app:get-ai-panel-prefs`、`app:get-author-name`、`app:auto-save-default`、`docs:system-locale`

**home（文件树）**：`home:folder-roots`、`home:folder-list`、`home:folder-create`、
`home:open-path`、`home:recents`、`home:starred`、`home:starred-groups`、`home:account-status`

**明确砍掉的两条原生通道**：`docs:open`（原生打开框）与 `docs:save-as`（原生保存框）——
网页版用首页文件树选路径，渲染器改走 `docs:open-path` / `docs:save-to` / `docs:save-new`。

**两处主进程弹原生框的通道必须改成二段式**：`docs:confirm-document-replace`（放弃修改确认）与
`docs:save` 遇到外部修改时的覆盖确认——服务端只返回状态（`reason: 'external-modified'`），
由渲染器自绘对话框再回调。这是原生能力缺口表里唯一两处「主进程主动弹窗」。

其余约 570 个通道（AI、打印、导出、tabs、集成、Zotero、拼写…）按需逐批补。

### 首页的「新建文件」卡片

上游的首页有六张新建卡片（文档/表格/演示/Markdown/HTML/PDF）。上游的做法是：
**开一个背后没有文件的视图，文件在保存时才落盘**——表格与 PDF 是例外，
它们先在主进程写出一个空白文件再打开。

网页版照搬这个语义：

| 卡片 | 上游 | 网页版 |
| --- | --- | --- |
| AI Docs | 空白文档视图 | 同上（`docs:consume-new-blank` 为空，渲染器自己进空白态） |
| AI Slides | 空白演示视图 | 同上（`slides:new-blank` 走上游的 handler，引擎造一份空白 deck） |
| AI Markdown / AI HTML | 空白缓冲区 | 同上 |
| AI PDF | 主进程先写空白 PDF | 引擎用上游的 pdf-lib 造空白 PDF，写进工作区再打开 |
| AI Sheets | 主进程先写空白 .xlsx | **做不到**：xlsx 引擎（Rust sidecar）还没接，通道明确报错 |

**为什么以前点了没反应**：这些通道当时没实现，未实现的 invoke 会 reject，
而上游渲染器写的是 `void item.action()`——错误被吞掉，界面毫无动静。
这类「点了没反应」在上游是靠主进程的原生错误对话框提示的，
网页版没有原生对话框，所以**能做的卡片必须真的做**。

### 服务端引擎的通道

有些通道的活儿在**服务端**做（上游在主进程里做）：pptx 的解析与渲染树由
`web/engine-pool` 的 worker 算好，通道只负责取回结果。

**slides**：上游的幻灯片主进程**整个跑在 worker 里**，它的 172 个通道原样可用——
通道的名单由上游自己给出（worker 问上游模块要），语义由上游的 handler 给出，
服务端只提供 tab id 的映射与路径的围栏。见 `web/engine-pool/SPEC.md` 的
「幻灯片：在服务端跑上游的主进程」。

服务端自己实现的只有两个「指名路径」的通道：`slides:consume-pending-open` 与
`slides:open-path`——它们先过 workspace-store 的围栏，路径不在工作区就不让上游碰磁盘。
打开与保存**也走上游的 handler**：deck 是上游主进程的东西（撤销栈、fit width、模型都在它手里），
自己实现就等于另立一套模型。

沾原生能力的通道**大多仍走上游 handler**：服务端的替身诚实地回答（对话框取消、剪贴板空、
没有打印机），上游渲染器因此走它正常的分支。只有真会崩的两条明确拒绝：
`slides:export-pdf`（要渲染窗口）与 `slides:print`（要 CUPS）。

**documents**：markdown / html / pdf 三个应用的主进程同样整个跑在 worker 里
（101 个 handler）。通道名单由上游自己给出（worker 问上游模块要），
语义由上游的 handler 给出。服务端自己实现的只有：

- `markdown:consume-pending` / `html:consume-pending` / `pdf:consume-pending`：
  除了返回路径，还在**上游打开文档**（`document:open` → 上游 `createXxxView`
  → 它授权路径、监视磁盘）。上游的保存 handler 靠这份授权找到文件，
  所以这一步不能省；
- `document:dialog-answer`：浏览器里的对话框回传原生对话框的结果。

「另存为」的路径选择界面还没做——后端链路已通（原生对话框的请求经引擎协议
回到 HTTP 进程，作为 `document:dialog` 事件投递给那个 tab），缺的是浏览器端的
文件树选择器。

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
   （通道级失败走 `200 + {ok:false, error}` 的信封：请求本身被理解了，失败的是通道；
   只有请求不合法才是 4xx）
4. API 类型只从上游 `shared/` 引入，本模块不定义第二套；
5. SSE 必须带 ping 保活，与上游 240 秒看门狗对齐；
   断开信号看**响应**（`res.on('close')`）——`req` 在请求体读完时就发 'close'，
   照着它拆流会让每个订阅在建立后立刻死掉，页面陷入重连循环、事件随机丢失；
6. 本模块不得直接访问文件系统；
7. 任何跨标签推送都必须带 tabId；
8. **通道契约只有一份**——上游的 preload 源码；本模块不手写通道表，也不改上游 preload；
9. 字节不进 JSON：走一次性 token（入站）与一次性 URL（出站）；
   token 带一个类型提示（`__as: 'u8'`）——上游多数通道拿的是 `ArrayBuffer`，
   但 PDF 的分块读要的是 `Uint8Array`（渲染器拿它 `set()` 进自己分配的缓冲区）；
10. 服务端访问文件一律经 `web/workspace-store`，不得绕过围栏；
11. **通道参数与上游一字不差**——上下文、tab、session 一律走信封或旁路，不得混进参数；
12. 上游 renderer 在启动路径上 `Promise.all` 的通道**必须能 resolve**：
    缺一个就会让整个 `Promise.all` reject，文档直接回落到空白页（实测：`docs:consume-new-blank`）；
13. **页面必须先于渲染器补齐安全上下文的 API**——非 HTTPS 的部署里
    `crypto.randomUUID` 不存在，上游文档渲染器启动即崩；
14. 编辑器 iframe 的宽高**必须写明**——替换元素的固有尺寸会让四条边失效。

## 风险

- `sendSync` 的同步语义需要专门方案（见「同步通道」）；
- 通道数量约 600，逐个实现容易漏——需要一份可自动核对的清单，且能力回归（S4）要覆盖它；
- `desktop` 命名空间在 docs 与 slides 下形状不同，注入时容易串；
- 上游 preload 强制单文件打包（sandbox 下多 chunk 会丢全局，见 `apps/docs/src/preload/index.ts:301-310`），网页版无此约束，但照抄 preload 源码时要注意 `aiNamingApi` 是内联而非 import 的。

---
id: engine-pool
type: module-design
status: draft
title: engine-pool —— 服务端引擎调度与 worker 池
parent: architecture
tags: [web, engine]
---

# engine-pool

## 职责

在服务端执行**属于服务端的那部分**格式引擎：把 CPU 密集的解析与保存从 HTTP 事件循环挪到 worker 线程，并统一管理 Rust sidecar 子进程。

引擎本身**全部复用上游**，本模块只负责调度、隔离与生命周期。

## docx 不在本模块（重要）

上游的 docx 解析与保存整个发生在 **renderer**：`apps/docs/src/renderer/file-actions.ts:493` 用 `parseDocxOffThread` 在 renderer 的 worker 线程里解析，`:940` 用 `saveDocx` 生成字节，再经 `window.desktop.saveDocxTo` 交给 main 落盘（`apps/docs/src/main/docs-main.ts:5227` 的 `docs:save` 只写字节）。

网页版照搬这个分工：**docx 的 parse/save 留在浏览器**，服务端只提供文件 IO。把它们搬到服务端就得改 docs 的编辑链路，也就破坏了“renderer 零改动”。

同理，上游 `packages/cli/src/formats/docx.ts:73-100` 的 `docsModules()` 用**相对路径**从 `apps/docs/src/renderer/**` 导入 Tiptap / convert / ops，并依赖 jsdom 的 DOM（`packages/cli/src/dom.ts:16`）——这层门面在服务端**不可直接复用**，也不需要复用。

## 边界

**允许依赖**：`web/workspace-store`（取字节与路径）、`web/render-service`（转发渲染类任务）；上游引擎包 `pptx-engine`、`pptx-ops`、`pptx-render`、`xlsx-gateway`、`pipelines`、`doc2docx`、`hwp2docx`、`odf2ooxml`、`pdf2docx`、`html2docx`、`file-parse`、`compound-file`、`zip-gate`、`font-metrics`；`docx-engine`（仅 main 侧用途：lazy-media、merge-data-source、byte-handoff）；上游门面层 `packages/cli/src/formats/`（**除 docx 那一支**）。

**禁止**：

- 不得在 HTTP 进程的事件循环上直接跑引擎；
- 不得改上游 `packages/`；
- 不得在 worker 里 import `electron`；
- 不得绕过 `web/workspace-store` 读文件；
- **不得把 docx 的 parse/save 搬进本模块**——它属于浏览器。

## 引擎门面（复用上游 `packages/cli/src/formats/`）

| 格式 | 关键入口 | 位置 |
| --- | --- | --- |
| pptx | `openDeck(bytes)` / `blankDeck()` / `saveDeck(opened)` | `formats/pptx.ts:42` / `:46` / `:50` |
| | `applyOps(opened, ops, opts)` | `formats/pptx.ts:136` |
| xlsx | `workbookSummary(path)` / `convertLegacyWorkbook()` | `formats/xlsx.ts:255` / `:264` |
| pdf | `loadPdfium()` / `pdfInfo()` / `pdfText()` / `convertPdf()` | `formats/pdf.ts:18` / `:94` / `:133` / `:191` |
| markdown | `markdownToDocx()` / `htmlToMarkdown()` / `markdownToHtml()` | `formats/markdown.ts:58` / `:102` / `:116` |
| html | `packages/html2docx` | —— |
| 渲染 | `renderToPngs()`（先导 PDF，再由 pdfium 栅格化） | `formats/render.ts` |
| 调用应用 | `exportViaApp(input, target, outputPath, opts)`（spawn 应用带 `--headless-export … --json`） | `formats/app-export.ts:33` |
| **docx** | **不在服务端**——`formats/docx.ts` 反向依赖 docs renderer 源码与 jsdom | 见上文「docx 不在本模块」 |

底层引擎包的入口：

- `pptx-engine`：`openPptx()`（`src/index.ts:704`）、`savePptx()`（`:746`）、`createBlankPptx()`（`src/blank.ts:146`）；
- `xlsx-gateway`：`ArchiveClient` 接口（`src/gateway/xlsx-package-io.ts:65`），四个方法 `archiveManifest` / `readEntries` / `scanEntries` / `saveArchive`，由 sidecar 客户端实现（`apps/sheets/src/main/xlsx-sidecar-client.ts:133/137/145/153`）；流式保存落在 `saveWorkbookViaSidecar()`（`xlsx-package-io.ts:183`）；
- `pptx-render`：**纯渲染树层**（`coords` / `fill` / `metrics` / `text-layout` / `build-slide`），不含 canvas 绘制，Konva 适配器在 `apps/slides/src/renderer/konva-adapter.ts`（renderer 侧）；
- `pipelines` = slides 生成规格（page-spec / deck-spec / outline / stage-check / layout-audit）。

**docx 的字节级保真机制**（浏览器侧，`packages/docx-engine`）：`saveDocx(parsed, saveBlocks, options)`（`src/patch.ts:751`）里，`SaveBlock` 标 `kind: 'original'` 的块按原始 `word/document.xml` 的**精确子串**复制，生成块产出新 OOXML，其余 zip entry 原样拷贝；若完全未改动，`isUnchanged` 逐项判定后**直接返回原始字节**（`patch.ts:757-820`）。网页版不得改动这套机制。

## Rust xlsx sidecar

- crate 名 `xlsx-sidecar`，源码在 `apps/sheets/native/xlsx-engine`（注意：仓库根的 `native/xlsx-engine` 只是构建产物目录，不是源码）；
- 协议：**stdio NDJSON**，一行一个 JSON 请求、一行一个 JSON 响应。`PROTOCOL_VERSION = 1`（`src/protocol.rs:22`），请求 `Request { version, requestId, command }`（`:139`），响应 `Response { version, requestId, ok, result, error }`（`:148`）；
- 命令集（`protocol.rs:30` 起）：`open`、`read_range`、`read_formula_cells`、`find_cells`、`read_row_outline`、`read_media`、`close`、`cancel`、`archive_manifest`、`read_entries`、`scan_entries`、`save_archive`、`convert_workbook`、`recalc_cells`、`external_links` 系列；
- 客户端 `XlsxSidecarClient`（`apps/sheets/src/main/xlsx-sidecar-client.ts:42`），spawn 在 `:325`。该文件**不依赖 Electron**（只用 `node:child_process` 与 `node:readline`），网页版可直接引用，与上游 CLI 的做法一致；
- 二进制定位：`XLSX_SIDECAR_PATH` 环境变量（上游 `packages/cli/src/resources.ts:60`）。

**进程策略与上游不同**：上游 CLI 每次调用起一个短命 sidecar 进程（`formats/xlsx.ts:214` `withSidecar` 的注释："One short-lived sidecar process per call; the CLI has no session to keep alive"）。服务端有长驻会话，**应常驻一个 sidecar 进程**并复用，崩溃可重启。

## worker 池

- `worker_threads`，`resourceLimits.maxOldGenerationSizeMb: 256`（与上游 file-index 的取法一致，见 `apps/shell/src/main/file-index/indexer.ts:258`）；
- **任务以文件路径为单位**：引擎只认字节与路径（上游 CLI 的语义就是如此），worker 之间不传大块字节——50MB 文档经 structured clone 反复拷贝会放大内存占用；必要时才读字节；
- 任务模型：请求-应答，带超时与取消；
- 队列在 HTTP 进程内维护，worker 只做纯计算。

## 服务端怎么编译上游的引擎代码

上游的引擎包是纯 TypeScript，但**把解析结果变成渲染树**的那一层在 app 的 main 进程里
（`apps/slides/src/main/session-state.ts` 的 `buildAllRenderSlides`），那个文件 import 了 Electron。
服务端没有窗口，所以 worker 构建时把 `electron` 别名到**服务端替身**
（`web/engine-pool/src/electron-shim.ts`）：窗口查不到、菜单不弹、对话框一律取消——
诚实地说「这个环境没有」，而不是假装成功。

worker 构建（`npm run build:worker`，vite ssr 目标）的三件特别的事：

- `electron` → 服务端替身（与浏览器侧同一手法，只是换了一边）；
- `?asset`（electron-vite 的约定，主进程按路径 import 资产）→ 资产随产物拷出、按相对路径引用，
  这样构建机与服务器可以不在同一个目录；
- `__dirname`（上游模块顶层就用它算 preload/renderer 路径）→ 按文件所在目录替换成真实路径。

引擎调用走 `packages/pptx-engine` 的 `openPptx` / `savePptx`（上游 CLI 门面
`packages/cli/src/formats/pptx.ts:42/50` 只是它们的一行包装，不额外引入依赖）。

**渲染树里的媒体 URL**：上游给幻灯片媒体发的是 `genoffice-slide-media://archive/<uuid>?mime=…`
（`apps/slides/src/main/session-state.ts:592`），浏览器取不到自定义 scheme。
服务端在把渲染树交给浏览器**之前**把这些 URL 改写成同源的 `/media/slide/<uuid>`，
字节由还持有该演示文稿的 worker 提供（上游的 `readSlideMedia`，`session-state.ts:606`）——
**不用改上游一行**。

## PDF：页面栅格化

上游的 PDF 模块在**主进程**用 PDFium（`@embedpdf/pdfium`，WASM）把页面栅格化成 PNG，
再交给渲染器画到 canvas 上。浏览器做不了这件事，所以引擎 worker 来做：

- 空白 PDF：上游的 `blankPdfBuffer`（pdf-lib）✓；
- 页面 PNG：上游的 `renderImagePng` / `renderPagePreviewPng` ✓。

两处环境差异要处理：

- **PDFium 的 wasm**：上游在开发时从 `node_modules` 找，打包后从
  `process.resourcesPath/wasm` 找。worker 没有 Electron，于是把
  `process.resourcesPath` 指到自己的目录，构建时把 wasm 拷到旁边 ✓。
- **`nativeImage`**：上游用 Electron 的 `nativeImage` 把位图编码成 PNG。
  服务端替身里自己写了一个最小 PNG 编码器（zlib + CRC ✓）——
  出来的字节和 Electron 的一样 ✓。

## 幻灯片：在服务端跑上游的主进程

上游把 deck 放在**主进程**里，renderer 通过 IPC 驱动它：「改这个字」→ 主进程把操作
应用到活的模型上 → 把重建的渲染树回给 renderer。网页版是同一个形状——浏览器就是 renderer，
**服务端就是主进程**——所以上游的主进程代码**原样跑在 worker 里**。

这件事是可行的（实验证实）：把上游 slides-main 用 vite ssr 打成 bundle、`electron` 别名到
服务端替身，模块加载后 `registerSlidesIpc()` 注册了 **172 个 handler**，其中 117 条是纯逻辑，
22 条沾原生能力。上游的 MCP 桥（`apps/shell/src/main/mcp/slides-bridge.ts:5`）本来就是
这么干的——它直接 import 上游的 `applySessionTxn` 与 `sessions`，在无 renderer 的地方驱动编辑。

因此**通道语义只有上游一份**：替身的 `ipcMain.handle` 把上游的注册**捕获**下来
（`electron-shim.ts` 的 `ipcHandlers`），worker 按通道名调用它们；
上游没有的通道，router 报 `unknown_channel`——真话。

### 上游要的两样东西

- **会话的键**：上游用 `e.sender.id`（webContents id）定位会话，浏览器没有这个 id。
  `slides-host.ts` 的 `SenderRegistry` 把 tab id 映射成数字 sender id，两向可查；
- **事件的去处**：上游用 `webContents.fromId(id)?.send(...)` 把事件推给 renderer
  （`slides:deck-changed`、`slides:history-changed`）。替身的 `webContents` 指向浏览器那一侧，
  事件经引擎协议回到 HTTP 进程，再由事件流投递给**那个 tab**——上游的事件是发给一个
  renderer 的，不是广播。

### 文件访问要过围栏

上游的主进程直接用 `node:fs` 读写 deck。服务端不行：每条到磁盘的路径都得过 workspace-store
的围栏，否则一个调用方可以让服务器写到工作区外面。

所以 worker 构建时把**上游模块**的 `node:fs` / `node:fs/promises` 导入重定向到
`src/fs-control.ts` 与 `src/fs-control-promises.ts`（`resolve.alias`）：工作区内的读写走 store
（围栏 + 原子写），工作区外的（应用数据目录、自动保存目录、临时文件）走真文件系统——
围栏是关于**用户的文档**的。引擎自己的模块与 store 保持真 fs。

**必须是 alias，不能是插件**：vite 对 Node 内置模块直接短路，插件的 `resolveId`
根本不会被问到——重定向会静默失效，上游的每一次读写都绕过围栏。
alias 也有自指的风险：实现文件与引擎自己的代码用**无前缀**的 `fs` 拿真文件系统，
而 alias 只匹配 `node:fs`。

上游的保存是「临时文件 → rename」（`packages/electron-utils/src/atomic-write.ts:197`），
它用的 `writeFile` / `rename` / `unlink` 全部经过受控 fs，因此也经过围栏 ✓。

同步的读写在工作区内被**拒绝**：store 没有同步面，同步写会绕过原子写。

## 文档应用：markdown / html / pdf

幻灯片的做法对三个文档应用同样成立：上游把打开的文档放在**主进程**里，
renderer 发送「保存这段文字」「磁盘上的文件变了」，主进程拥有路径、资产与写入本身。

- 三个主进程加载后注册了 **101 个 handler**（与 slides 同一套替身）；
  它们的注册在 `app.whenReady()` 的回调里，所以 worker 调上游导出的
  `startMarkdownStandalone()` / `startHtmlStandalone()` / `startPdfStandalone()`；
- **打开文档要走上游的 `createXxxView`**：它调用上游的 `grantAndTrack`，
  授权这个 view 可以读写哪些路径、开始监视磁盘。网页版因此把「打开」做成
  一个引擎作业（`document:open`），让上游的会话、授权与保存逻辑保持是上游的；
- **保存是上游的 handler**：`markdown:save` / `html:save` / `pdf:save`
  带着内容与模式进来，上游负责图片资产、冲突检测与原子写。网页版不另写一套；
- 上游的保存路径是**会话里的**（`savePathByWc` / `allowedByWc`），
  由 `grantAndTrack` 建立——所以文档必须先在上游打开。

### 对话框：原生对话框变成浏览器里的对话框

上游的「另存为」用 Electron 的原生对话框。浏览器没有原生对话框，
所以替身的 `dialog` 不再直接回答「取消」，而是**问浏览器**：
请求经引擎协议回到 HTTP 进程，作为 `document:dialog` 事件投递给那个 tab，
浏览器用 `document:dialog-answer` 通道回传结果。

这条路径对所有需要对话框的上游通道通用，不只是「另存为」。

### 自动保存

上游每 30 秒把脏的 deck 写进 `userData/slides-autosave/<sha1>.pptx`
（`apps/slides/src/main/slides-main.ts:630`），用于崩溃恢复。保留这个行为：
`userData` 指向服务端的应用数据目录，**不落在用户工作区**。

## 已知耦合

- `packages/cli/src/formats/xlsx.ts:45` 直接 import `apps/sheets/src/main/xlsx-sidecar-client`——上游的反向依赖（CLI 引 app 代码）。网页版**不改上游**，而是在 `web/engine-pool` 内引用同一个客户端文件，行为与上游 CLI 一致；
- `packages/cli/src/formats/docx.ts:73-100` 反向依赖 `apps/docs/src/renderer/**` 并需要 jsdom——这条路径在服务端不可用，也不需要（docx 走浏览器）；
- 上游 `apps/shell/src/main/index.ts:362` 用 electron-vite 专有的 `?modulePath` 后缀导入 worker 路径，搬到服务端时必须换成普通路径（file-index 模块遇到同一问题）。

## 不变量

1. 引擎只在 worker 或子进程里执行，HTTP 事件循环不做格式解析；
2. worker 之间不共享可变状态，每个任务自带上下文；
3. 引擎调用只认字节与路径，不认 Electron；
4. Rust sidecar 常驻单实例，崩溃可自动重启；
5. 所有路径先过 `web/workspace-store` 的围栏；
6. 每个任务有超时与取消；
7. 字节级保真语义不变——docx 侧的 `SaveBlock` + `isUnchanged` 机制原样使用，不做任何「整体重写」式优化；
8. **docx 的 parse/save 不得进入本模块**——它在浏览器侧，与上游分工一致。

## 风险

- 文档解析与保存是内存大户，50MB 文件 + worker 256MB 上限的组合需要在压测中确认；
- **docx 的重活在用户机器上**（浏览器），服务端不再为它背负载；但反过来，docx 的内存占用转移到了用户的浏览器，低配机器上需实测；
- 上游 `packages/cli` 的构建有守卫禁止 `require("electron")`（`packages/cli/build.mjs:67`），网页版引用 CLI 的门面层时沿用该约束；
- sidecar 常驻后，其内存占用会计入服务器可用内存（约 11 GB，见 [deployment](../../deployment.md)），需与 Chromium 渲染池一起分配预算。

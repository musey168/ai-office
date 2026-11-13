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

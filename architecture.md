---
id: architecture
type: architecture-design
status: active
title: AI Office 网页版架构设计
tags: [web, architecture]
parent: ai-office
---

# AI Office 网页版架构设计

一句话：**上游的 Electron 主进程换成同源的 Node 服务，上游的 renderer 原地不动。**

本设计服务于 [AI Office 的目标文档](goal-and-requirements.md) 的 G1–G5 与 S1–S5。

## 决策摘要

| 决策 | 选择 | 为什么 |
| --- | --- | --- |
| renderer ↔ 服务端通信 | 保持上游 preload 的全局对象与方法签名，底层换成 HTTP + SSE | renderer 零改动，直接兑现 G3（功能 1:1）与 G4（定期合上游） |
| 编辑器拓扑 | 单 origin + 路径路由（`/app/docs`、`/app/sheets`…） | 同源，postMessage、cookie、localStorage 不受限，AI 的 SSE 也能直连 |
| 服务端形态 | 单 HTTP 进程 + 引擎 worker 池 + 子进程 | 20 人规模够用；重活不在事件循环里；沿用上游 `node:http` 风格，不引 Web 框架 |
| 引擎执行位置 | 按上游实际分工：docx 的 parse/save 留在浏览器，pptx / xlsx / 转换 / 渲染在服务端 | 上游的 docx 引擎本来就在 renderer 的 worker 线程里跑（`apps/docs/src/renderer/file-actions.ts:493`、`:940`），搬到服务端就得改 renderer——而 renderer 零改动是 G3、G4 的地基 |
| 导出渲染 | 服务器装 Chromium（Playwright）做无头渲染 | 上游 Electron 的 `printToPDF` 底层就是 Chromium；上游 `packages/html2docx` 已有 playwright 驱动，这条路有现成先例 |
| 上游隔离 | web 化代码进新目录，上游文件只留极少插入点 | 把合并冲突面压到最小，保护 G4 |

支撑这六个决策的上游事实（已核实）：

- `apps/*/src/renderer` 下 **0 个文件** import `electron` 或 `node:`——UI 层本来就是浏览器纯的；
- **引擎的分工不对称**：docx 的 parse/save 在 renderer（`apps/docs/src/renderer/file-actions.ts:493` `parseDocxOffThread`、`:940` `saveDocx`），main 只落盘（`apps/docs/src/main/docs-main.ts:5227`）；pptx 在 main（`apps/slides/src/main/slides-main.ts:968` `openPptx`、`:2056` `savePptx`）；xlsx 在 main（`apps/sheets/src/main/sheets-main.ts:5037` `saveWorkbookViaSidecar`）。网页版照搬这个分工，renderer 才能零改动；
- 六个编辑器的 main 代码被编译进 **shell 单一主进程**，用 `WebContentsView` 装载、彼此不同 origin；主进程侧共 **625 处** `ipcMain.handle/on`；
- `packages/cli` **零 Electron 依赖**，且已有 `packages/cli/src/mcp/http.ts`（`node:http` + Bearer token + 文件上传下载 + 每会话 scratch 目录）——服务端 HTTP 底座的原型；
- `packages/agent-core` 定义了 `AgentTransport` 抽象（`packages/agent-core/src/types.ts:163`），`packages/ai-provider` 已是 SSE 流式；
- 全文索引在 `apps/shell/src/main/file-index/`，用 `node:sqlite` 的 FTS5 + CJK 预分词 + worker_thread；
- Rust `xlsx-sidecar` 是 stdio NDJSON 子进程，仅 sheets 与 CLI 使用。

## 拓扑

```mermaid
flowchart TB
  subgraph Browser["浏览器（单 origin）"]
    Shell["shell 应用<br/>Home + 标签栏"]
    Ed["六个编辑器<br/>/app/docs /app/sheets /app/slides<br/>/app/pdf /app/markdown /app/html"]
    Bridge["web/rpc-bridge<br/>注入 window.desktop / desktopApi / slidesApi…"]
    DocxEng["docx 引擎<br/>docx-engine parse/save<br/>（上游本就在 renderer worker）"]
  end

  subgraph Server["Node 服务端"]
    HTTP["HTTP 层<br/>node:http<br/>REST + SSE + 静态资源"]
    RPC["RPC 路由<br/>通道名 → 处理器"]
    Pool["引擎 worker 池<br/>worker_threads<br/>pptx / 转换 / 后处理"]
    Sidecar["Rust xlsx-sidecar<br/>stdio NDJSON"]
    Chrome["Chromium 渲染服务<br/>Playwright"]
    AI["AI 服务<br/>AgentTransport(SSE)"]
    Store["WorkspaceStore<br/>路径围栏 + 原子写"]
    Index["文件索引<br/>node:sqlite FTS5"]
  end

  Shell -->|"|>
  Ed --> Bridge
  Ed --> DocxEng
  Bridge -->|"fetch / SSE"| HTTP
  HTTP --> RPC
  RPC --> Pool
  RPC --> AI
  RPC --> Store
  RPC --> Index
  RPC --> Chrome
  Pool --> Sidecar
  Store --> FS[("服务器文件目录")]
  Index --> FS
```

## 进程与边界

只有三种进程角色，边界如下：

- **浏览器**（唯一的前端）：跑上游 renderer，零改动。shell 与编辑器在同一 origin 下用 iframe + `postMessage` 通信，取代上游 main 的转发。
- **HTTP 进程**（Node，`node:http`）：对外唯一入口，负责静态资源、REST、SSE、鉴权（内网无登录，仅保留 Bearer 供 MCP 通道用）、路径围栏校验。不做重活。
- **引擎 worker 池**（`worker_threads`）：服务端侧的 CPU 密集操作——pptx 的 parse/save、格式转换、后处理。调用方式与上游 CLI 相同——操作字节与路径，不碰 Electron API。
- **子进程**：Rust `xlsx-sidecar`（stdio NDJSON，定位用 `XLSX_SIDECAR_PATH`）、Chromium 渲染进程。

引擎侧一律复用上游包，不重写：`docx-engine`、`pptx-engine`、`xlsx-gateway`、`pipelines`、`pdf2docx`、`html2docx`、`file-parse`、`agent-core`、`ai-provider`、`project-store`。

**引擎分工照搬上游**：docx 的 `parseDocx` / `saveDocx` 跑在**浏览器**（上游 `apps/docs/src/renderer/file-actions.ts:493` 用 `parseDocxOffThread` 在 renderer 的 worker 线程里解析，`:940` 用 `saveDocx` 生成字节，再经 `window.desktop.saveDocxTo` 交给 main 落盘）；pptx 的 `openPptx` / `savePptx`（`apps/slides/src/main/slides-main.ts:968`、`:2056`）与 xlsx 的 sidecar（`apps/sheets/src/main/sheets-main.ts:5037`）跑在**服务端**。网页版不重新分配——重新分配就意味着改 renderer。

## renderer ↔ 服务端契约

**形状不变**：上游 preload 用 `contextBridge` 暴露的全局对象，网页版在页面里注入同名同签名的实现。

| 上游全局对象 | 所属 app | 上游通道数（量级） |
| --- | --- | --- |
| `desktop` | docs、slides | ~110 / ~212 |
| `desktopApi` | sheets | ~105 |
| `slidesApi` | slides | ~212 |
| `pdfApi` | pdf | ~82 |
| `markdownApi` | markdown | ~70 |
| `htmlApi` | html | ~61 |
| `aiOffice` / `aiOfficeTabs` | shell | ~171 |
| `projectApi` / `aiNamingApi` | 全部 | 共享 |

通道到协议的映射规则：

| 上游语义 | 网页版协议 |
| --- | --- |
| `ipcRenderer.invoke`（有返回值） | `POST /rpc/:channel`，请求体带参数，响应体带结果 |
| `ipcRenderer.send`（无返回值） | `POST /rpc/:channel`，响应体为空 |
| `ipcRenderer.on`（主进程推送） | `GET /events`（SSE），或 HTTP 轮询兜底 |
| AI 流式回合（`ai:stream` / `ai:stream-chunk`） | `POST /ai/stream` + `GET /ai/stream/:requestId`（SSE） |

类型契约直接沿用上游的 `apps/*/src/shared/ipc.ts`，作为网页端实现服务端处理器的依据——**这份类型文件是上游与网页版之间的唯一接口面**，上游改它时网页版跟着改，这是合上游时需要重点看的文件。

两个语义差异要显式处理：

- **推送类通道**在上游是主进程主动 `send`，网页版是服务端主动 SSE 推送，需要按订阅关系维护连接；
- **长耗时调用**（转换、渲染、AI 回合）上游靠 IPC 阻塞等待，网页版应改为「提交任务 + 轮询/SSE 取结果」，避免 HTTP 请求长时间挂起。

## 服务端模块边界

新增代码全部放在 `web/` 目录，不进上游 `apps/` 与 `packages/`。

模块清单只有一份，见「模块拆分」一节——职责、依赖上游与禁止事项都在那张表里，模块与 SPEC 的对应关系也在同一张表上。本节不再另列模块。

**已知需要先解开的耦合**：`packages/cli` 反向 import 了 `apps/sheets/src/main/atomic-write` 与 `xlsx-sidecar-client`。这两处要么把被依赖的代码提到 `packages/`，要么在 `web/` 里提供等价实现——前者对上游更友好（属上游重构，合并时需与上游沟通），后者对 fork 更干净。**默认选后者**，除非上游接受该重构。

## 文件与存储边界

`WorkspaceStore` 是服务端访问文件的唯一入口：

```
list(path) / read(path) → Uint8Array / write(path, bytes, {atomic})
move(src, dst) / delete(path) / stat(path) / search(query)
```

- **路径围栏**：所有路径先经 `assertAllowed` 校验（沿用 `packages/cli/src/fs.ts:71` 的 `GENOFFICE_ALLOWED_ROOTS` 思路），越界即拒绝，围栏不可绕过；
- **原子写**：沿用上游的同目录 tmp + rename 模式；
- **存储接口与实现分离**：接口在 `web/workspace-store`，本地目录实现是默认实现，将来换 MinIO/S3 只加实现、不动调用方；
- **工作区根目录**的划分方式取决于目标文档里的待决问题 ①（多人文件与协作模型）。当前做法：单一根目录、不按人隔离、不加编辑锁，与上游单机行为一致。

索引（全文搜索）用上游的 `node:sqlite` FTS5 + CJK 分词方案，数据库文件落在服务端的存储目录。

## AI 通道

- 上游的 `AgentTransport` 是一个纯接口，`createIpcTransport` 只是它的一种实现；网页版新增 `createSseTransport`，走 `POST /ai/stream` 发起回合、`GET /ai/stream/:requestId` 收增量块，**不改动 `packages/agent-core`**；
- provider 配置沿用上游的 `resolveAiSettings` 与 `GENOFFICE_AI_SETTINGS` 环境变量注入，服务端只配一份；
- 模型调用在服务端发起（浏览器不直连模型），与上游「主进程调模型、避开 renderer CORS」的意图一致；
- 具体接入方式（统一 BYOK / 每人自带 key / Genspark 账号）取决于目标文档的待决问题 ②，本设计对此保持中立：接口按「服务端持有一份配置」设计。

## 无头渲染与导出

上游的导出链路是 spawn 一个 Electron 应用跑 `--headless-export`，网页版没有 Electron，改由服务器上的 Chromium 承担：

- 渲染服务用 Playwright 驱动 Chromium 常驻进程池，替代上游 Electron 的 `printToPDF`；
- 渲染是**有状态**的：先在浏览器里排版，再由同一份 DOM 交给 Chromium 出 PDF，避免两套排版引擎产生差异；
- 渲染任务进队列，结果落盘并返回路径，与上游「写文件后返回路径」的语义一致。

## 原生能力缺口

上游有一批能力依赖 Electron 或桌面系统。网页版的处置：

| 上游能力 | 网页版处置 | 影响 |
| --- | --- | --- |
| 原生打开/保存对话框 | 首页文件树（打开 ✓ 已实现）；**另存为的路径选择界面未做** | 打开一个已有文件没问题；新开的空白文档要落盘时没有路径可选；`home:browse` 快捷卡片在网页版不可用 |
| 幻灯片的原生对话框（选图片/模型/导出目录/另存图片） | **走上游 handler**，服务端的对话框替身诚实地回答「用户取消」 | 点「插入图片」没有反应（对话框取消）而不是报错；浏览器有自己的文件选择器，接到它上面是后面的活 |
| 幻灯片的系统剪贴板 | **走上游 handler**，替身的剪贴板是空的 | 粘贴时没有外部内容可贴（内部复制粘贴走的是上游自己的元素剪贴板，不受影响）；「剪贴板里有东西」的状态永远是假 |
| 幻灯片的打印机（`slides:printers` / `slides:print`） | `printers` 走上游 handler（返回空列表）；**`print` 明确拒绝** | 没有打印机可选；打印功能不可用 |
| 幻灯片导出 PDF（`slides:export-pdf`） | **明确拒绝** | 导出 PDF 不可用；要导出得走 `web/render-service` |
| 幻灯片的全屏放映（`slides:show-fullscreen`） | 走上游 handler，替身不做任何事 | 放映时没有全屏 |
| 幻灯片的麦克风（`slides:microphone-access`） | 走上游 handler，替身返回「未授权」 | 录音旁白不可用 |
| 原生右键菜单（标签、文件、编辑器） | 移除 | 标签栏与文件树的右键菜单在网页版没有；文件操作只能走工具栏 |
| 本地打印（CUPS） | 浏览器打印；服务端 Chromium 出 PDF | 输出由浏览器打印管线决定 |
| 屏幕录制 | 移除 | 上游功能，网页版无对应 |
| 字体枚举与安装 | 服务端字体目录（与容器镜像绑定） | 幻灯片渲染字体与桌面不同，需在镜像里装齐字体；文档编辑器的字体度量改走内置 stand-in 链 |
| 分离窗口（拖出标签） | 移除 | 窗口管理不是网页版职责 |
| macOS Vision OCR | 移除或改服务端 OCR | 上游仅 macOS |
| 应用自动更新器 / 系统文件关联 | 移除（已在目标文档的非目标里） | 由部署流程接手 |
| PDF 证书与签名 | 待定 | 依赖服务端证书体系 |
| WebContentsView 分离窗口 | **改为 iframe**（见下） | 编辑器在 shell 页面的 iframe 里，位置由 bridge 维护 |
| 主进程弹窗（放弃修改、覆盖确认） | 改为服务端返回状态 + 渲染器自绘 | 需要渲染器侧的二段式对话 |

**网页版自己引入的共享状态**（首版没有登录，所有人共用一个工作区）：

| 事项 | 现状 | 上线前 |
| --- | --- | --- |
| 标签表在服务端，是进程级全局状态 | A 打开的文档会出现在 B 的标签栏上 | 按浏览器会话隔离 |
| 待打开的文档是一次性的 | 先到先得，后来的拿不到 | 同上 |
| 文件同名覆盖 | 后保存的人赢（与上游一致） | 保持上游语义，靠外部修改检测提示 |

**编辑器在页面里怎么活**（第一刀的实测结论）：

上游的 shell renderer **不知道**编辑器的存在——编辑器是主进程摆在上层的原生 `WebContentsView`，
renderer 只画标签栏和首页。浏览器没有这个机制，于是由 **bridge 脚本**在 shell 页面里挂一个
iframe，位置对齐上游的内容区（标签栏 40px 以下），并跟着 `tabs:changed` 切换。
上游 renderer 仍然零改动。

**标签与窗口的关系**：Electron 用 `event.sender.id` 把文档交给对应的窗口；浏览器没有这个 id，
页面自己声明「我是哪个 app、属于哪个 tab」（`RpcContext`），服务端据此定位。

移除项须在能力清单里显式标注，不能悄悄消失——目标文档 S1 要求「每项既有能力都能用」，上表就是这份对照表的入口。

## 上游隔离策略

**目录约定**：

```
web/                     ← 全部 web 化代码（新增，禁止上游碰）
apps/*/src/renderer/     ← 上游文件，原则上不改
apps/*/src/main/         ← 上游文件，原则上不改
packages/*/              ← 上游文件，原则上不改
```

**允许的插入点**（数量要控制住，每处都要写清为什么必须动上游）：

- renderer 入口挂载 `web/rpc-bridge` 的 bridge 脚本（否则拿不到 preload 替身）；
- `apps/*/src/shared/ipc.ts`——只跟上游改，不自己改；
- 构建配置（`electron.vite.config.ts` → 增加 web 产物），按 app 逐个增加；
- **docs 的 CSP**（`apps/docs/src/renderer/index.html:6-8`）——`img-src` / `connect-src` 里写死了 `genoffice-docx-media:`；
  - **实测结论（第一刀跑完后的更正）**：**不用改**。网页版不做「瘦身」（瘦身是上游**主进程**的行为，
    `apps/docs/src/main/lazy-media.ts:78 openLazyDocx`，只对媒体 ≥1MB 的文档做），
    于是 `packages/docx-engine/src/parse.ts:8544 mediaPartSrc()` 走的是内联分支——图片变成 `data:` URL，
    `img-src 'self' data: blob:` 已经允许。浏览器实测：文档里的图片正常渲染。
  - 只有将来要在服务端做瘦身（省浏览器的内存与传输）时，才需要把 `lazyMediaUrl()` 的 base 变成可配置的，
    那时把 `packages/docx-engine` 登记为新的插入点。
- **headless 分支**——渲染服务需要在 renderer 里区分「普通渲染」与「无头导出」，上游已有 `--headless-export` 的机制（`packages/electron-utils/src/headless-export.ts:235` `runHeadlessRendererExport`），网页版复用同一机制。

**禁改清单**要单独成文，列明上游目录里「改了会与上游冲突、且可以在 `web/` 内解决」的文件。

**合上游流程**：合并 `upstream/main` → 跑隔离自检（检查是否触碰了禁改清单、renderer 是否仍零 `electron` 依赖）→ 跑上游自带的测试与类型检查 → 用能力清单逐项回归（对应 S4）。回归清单必须版本化存放，否则 S4 无法验证。

## 部署形态

- 单台 Linux 服务器，一个 Node 进程（可用 systemd 或容器托管）；
- 数据目录：文件工作区、索引库、AI 设置、项目数据（`project-store` 的 baseDir）都在服务端可配路径下；
- 环境变量：`GENOFFICE_ALLOWED_ROOTS`（路径围栏）、`XLSX_SIDECAR_PATH`（Rust 二进制）、`GENOFFICE_AI_SETTINGS`（AI 配置）、Chromium 路径；
- 反向代理负责 TLS 与静态资源缓存；
- 内网访问，不做登录（目标文档已定）；MCP 通道沿用上游的 Bearer token。

## 不变量

1. **renderer 不得 import `electron` 或 `node:`**——一旦破了，网页版就跑不起来，且与上游冲突面扩大；
2. **上游 `packages/` 不得 import `web/`**——依赖方向永远是 web → 上游；
3. **引擎分工不重新分配**——浏览器只做上游 renderer 本来就在浏览器里做的事（docx 的 parse/save），其余引擎在服务端；不得为了“统一”而搬动引擎，搬动就意味着改 renderer；
4. **文件访问必须过路径围栏**——没有任何一条代码路径可以绕过 `WorkspaceStore` 直接拼路径；
5. **字节级保真语义不变**——「只重写被改动的部分」是上游的核心契约，网页版不得以性能为由整体重写；
6. **合并冲突面受控**——新增 web 化代码进 `web/`，对上游文件的改动必须逐条登记。

## 模块拆分

每个模块一份 SPEC，写在 `web/<模块>/SPEC.md`，与将来的代码目录同位。模块清单只有这一份：

| 模块 | 职责 | 依赖上游 | 边界要点 |
| --- | --- | --- | --- |
| [web-server](web/web-server/SPEC.md) | HTTP 层、静态资源、SSE、路由 | — | 不含引擎调用与文件 IO；不得直接 import `apps/*/src/main`；不得引入 Web 框架（沿用上游 `packages/cli/src/mcp/http.ts` 的 `node:http`） |
| [rpc-bridge](web/rpc-bridge/SPEC.md) | 服务端通道路由 + **浏览器端 preload 替身**（注入与上游同名同签名的全局对象） | 上游 `apps/*/src/shared/ipc.ts`（仅类型） | 契约来自上游 `shared/ipc.ts`；路由不得在浏览器侧执行；preload 替身不得含业务逻辑 |
| [workspace-store](web/workspace-store/SPEC.md) | `WorkspaceStore` 接口、本地实现、围栏 | `packages/cli/src/fs.ts` 的围栏与原子写 | 唯一文件入口；不得绕过围栏 |
| [engine-pool](web/engine-pool/SPEC.md) | `worker_threads` 池与引擎调度——调度**服务端侧**引擎调用（pptx / 转换 / 后处理） | `pptx-engine`、`xlsx-gateway`、`pdf2docx`、`html2docx` 等 | 只认字节与路径；不得调用 Electron API；**不承担 docx 的 parse/save**（按上游分工留在浏览器） |
| [render-service](web/render-service/SPEC.md) | Chromium 无头渲染，取代 `--headless-export` | — | 不得阻塞 HTTP 事件循环 |
| [ai-service](web/ai-service/SPEC.md) | `AgentTransport`(SSE) 实现、provider 配置注入 | `agent-core`、`ai-provider` | 不自行实现模型协议 |
| [file-index](web/file-index/SPEC.md) | 服务端 FTS5 全文索引 | 移植上游 `apps/shell/src/main/file-index/` | 不得放在 renderer 里 |

**`web/bridge` 的去留**：并入 `web/rpc-bridge`，不单列。[rpc-bridge 的 SPEC](web/rpc-bridge/SPEC.md) 把「浏览器端 preload 替身」列为该模块自己拥有的三样东西之一，不变量 1 也写明「上游 renderer 文件零改动，只在入口挂载**本模块的** bridge 脚本」——浏览器端替身是 rpc-bridge 的一个交付物，不是独立模块。按「一个模块一份 SPEC」的规矩把它单列，就得再写一份 `web/bridge/SPEC.md`，两份 spec 会就同一套通道契约分叉。

模块名以 SPEC 所在目录为准。合并前的旧名 `web/server`、`web/rpc`、`web/bridge`、`web/workspace`、`web/render`、`web/ai`、`web/index` 一律作废。

## 未决

三项未决问题记录在目标文档里，本设计对它们保持中立：多人文件与协作模型、AI 接入方式、存储后端是否换对象存储。任一项落定后，同时更新目标文档与本设计。

**closest look**：路径围栏与 `WorkspaceStore`——它是唯一挡在「浏览器请求」与「服务器文件系统」之间的东西，一旦有代码路径绕过它，内网部署就等于把文件系统暴露在 HTTP 上。

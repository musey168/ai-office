---
id: web-server
type: module-design
status: draft
title: web-server —— 唯一的对外 HTTP 入口
parent: architecture
tags: [web, http]
---

# web-server

## 职责

浏览器可见的一切都从这里出去：六个编辑器与 shell 的静态资源、REST 路由、SSE 事件流、错误响应。

它是服务端**唯一**的对外监听面。

## 边界

**允许依赖**：`web/rpc-bridge`（通道路由）、`web/workspace-store`、`web/file-index`；上游 `packages/cli/src/mcp/http.ts` 的 HTTP 骨架（`node:http`，零 Web 框架）。

**禁止**：

- 不得引入 Web 框架——上游没有，引入会增加合上游时的依赖冲突面；
- 不得在 HTTP 层直接调用引擎（重活转交 `web/engine-pool`）；
- 不得直接读写文件（经 `web/workspace-store`）；
- 不得在本模块内实现业务逻辑。

## 技术选型的上游依据

上游已经有一个可借鉴的 HTTP 骨架：`packages/cli/src/mcp/http.ts`。

| 上游做法 | 位置 | 网页版沿用 |
| --- | --- | --- |
| `node:http` 的 `createServer` | `mcp/http.ts:3,287` | 是，不引框架 |
| 路由表在单个 `route()` 里 | `mcp/http.ts:242` | 是 |
| Bearer token 鉴权（`timingSafeEqual`） | `mcp/http.ts:73` `authorized()` | 沿用；MCP 通道必须鉴权，网页 UI 通道内网不限身份 |
| 401 形状 `{ error: 'missing or invalid bearer token' }`、普通错误 `{ error: string }` | `mcp/http.ts:256`、`:65` `json()` | 沿用同一形状 |
| loopback 且无 token 时校验 Host 头，防 DNS rebinding | `mcp/http.ts:247-253` | 沿用 |
| 每会话独立 scratch 目录，LRU 上限 `MAX_SESSIONS=100` | `mcp/http.ts:94` `openSession`、`:47` | 沿用，防止会话间串文件 |
| JSON 体上限 `MAX_JSON_BYTES = 32MB` | `mcp/http.ts:45` | 沿用 |
| 文件传输上限 `MAX_TRANSFER_BYTES = 256MB` | `packages/cli/src/mcp/files.ts:22` | 沿用；文件传输必须留足 50MB 上限的余量 |
| 安全的文件名与 MIME | `mcp/files.ts:42` `mimeOf`、`:50` `safeName` | 沿用 |
| `/health` 健康检查（免鉴权） | `mcp/http.ts:244` | 沿用 |
| 默认不信 `X-Forwarded-*`，仅 `GENOFFICE_TRUST_PROXY_HEADERS=1` 时信任 | `mcp/http.ts:81` `baseUrlOf` | 沿用 |

## 路由表

| 路由 | 用途 | 归属 |
| --- | --- | --- |
| `GET /app/:app/*` | 六个编辑器 + shell 的 renderer bundle 与静态资源 | 本模块 |
| `POST /rpc/:channel` | 上游 IPC 通道的等价入口 | `web/rpc-bridge` |
| `GET /events` | SSE 事件流（主进程推送） | `web/rpc-bridge` |
| `POST /ai/stream` + `GET /ai/stream/:requestId` | AI 流式回合 | `web/ai-service` |
| `GET /tasks/:taskId` | 长耗时任务状态与结果 | `web/engine-pool` |
| `GET /bridge/<app>.js` | 编译好的上游 preload（通道契约的唯一一份） | `web/rpc-bridge` |
| `GET /bridge/polyfill.js` | 安全上下文的 API 补齐（每个页面都注入） | `web/rpc-bridge` |
| `GET /media/slide/<id>` | 幻灯片媒体（上游 `genoffice-slide-media://` 的同源替身） | `web/engine-pool` |
| `GET /media/<token>` | 文档字节的一次性 URL（上游 `genoffice-docx-media://handoff/<uuid>` 的同源替身） | `web/rpc-bridge` |
| `POST /bytes` + `GET /bytes/<token>` | 二进制出入（上传拿 token，取回即销毁） | `web/rpc-bridge` |
| `GET /health` | 健康检查 | 本模块 |
| MCP 通道（`POST /mcp`、`/files/*`） | 上游 CLI/MCP 的 HTTP 形态 | `web/engine-pool` 复用上游 `mcp/http.ts` |

## 上游 renderer 怎么变成浏览器 bundle

上游的 renderer 是 Vite + React 应用，构建走 `electron-vite`（产物在 `apps/<app>/out/renderer`）。
网页版不需要 Electron 那一层，只要 renderer 的那部分，所以**用 vite 直接编**：

- 入口是上游的 `apps/<app>/src/renderer/index.html`，**源码一个字不改**；
- 唯一改动是 **base**：`/app/<app>/`，让应用能待在路径前缀下（上游开发模式是六个不同端口、
  生产是六个不同 origin，网页版统一到一个 origin）；
- 产物落在 `web/web-server/dist/<app>/`，**不入库**（`dist/` 被忽略）；
- `@genoffice/*` 的子路径按规则解析到上游 checkout 的源码（与上游自己的 vite 配置同思路），
  上游新增子路径不必改我们的配置；
- 产物里**没有 electron 依赖**——renderer 本来就不 import electron。

shell 的 renderer 是多入口（`index` / `update` / `pdf-password`）；第一刀只编 `index`，
另两个是 Electron 专有窗口（自动更新、PDF 密码框），随各自的切片补。

## 根路径

`GET /` **跳转**到 `/app/shell/`（302）。应用本身就是首页，
让人在地址栏敲一个根路径然后看见 404，是没有理由的。

## 事件按 tab 定向

上游的 `webContents.send` 是发给**某一个** renderer 的。事件流因此按 tab 订阅：
浏览器的 EventSource URL 带 `?tab=<id>`，服务端只把该 tab 的事件投递给这条连接。
没有 `?tab=` 的连接（shell 首页）收全部事件——首页关心的是跨标签的 `tabs:changed`。

引擎 worker 推的事件（上游幻灯片主进程的 `slides:deck-changed`、
`slides:history-changed`）走同一条路。

**原生对话框也走这条路**：上游的「另存为」用 Electron 原生对话框，
浏览器没有，worker 把请求经引擎协议送回 HTTP 进程，作为 `document:dialog`
事件投递给那个 tab，浏览器用 `document:dialog-answer` 通道回传结果。

## 缓存

- renderer 的资源文件名**带哈希** → `immutable` 一年 ✓；
- **bridge 的文件名不带哈希**（`/bridge/docs.js`）→ 必须 `no-cache`，
  否则重新部署之后，浏览器还在用旧的那份 bridge ✓。

## 静态资源

上游打包后 renderer 产物在 `apps/*/out/renderer`，由 `apps/shell/src/main/index.ts:7127` 的 `installRendererProtocol` 映射到 `genoffice-app://<host>/index.html`（URL 构造见 `packages/electron-utils/src/renderer-scheme.ts:59` `rendererUrl`）。开发模式下上游用 5173–5178 六个端口。

网页版改成**同源路径**：

```
/app/docs/      /app/sheets/    /app/slides/
/app/pdf/       /app/markdown/  /app/html/
/app/shell/
```

要点：

- **同源是硬要求**——上游六个模块是不同 origin（`genoffice-app://docs` vs `://sheets`），网页版统一到一个 origin，postMessage、cookie、localStorage、SSE 才不受同源策略限制；
- help 模式复用 shell 自己的 renderer bundle（上游 `installRendererProtocol` 的 `help` 项指向 shell 的 `../renderer`），网页版同此处理；
- **静态资源只有 PDF 编辑器特殊**：它用 `viteStaticCopy` 拷了 pdfjs 的 `cmaps/`、`standard_fonts/`、`wasm/` 到 renderer 的 `pdfjs/` 下，renderer 以 `new URL('pdfjs/', document.baseURI)` 引用（`apps/pdf/src/renderer/view-config.ts:2`）。网页版要把这三个目录一并提供；
- **只有 PDF 编辑器有额外资源**——docs renderer 自带的字体（Aptos / Caladea / Cambria 等，`apps/docs/src/renderer/fonts/*.ttf`）已经打包成 hashed assets，随 bundle 走，不需要单独分发；
- `GENOFFICE_PDFIUM_WASM` 指向的 pdfium.wasm（上游 `packages/cli/src/resources.ts:48`）同样要随服务分发；
- Vite 默认产物名是 `assets/index-<hash>.js`（各 `electron.vite.config.ts` 未改 `output`），bundle 文件名带 hash → 可长期缓存；`index.html` 不缓存；
- **bridge 脚本由服务端注入**：在 HTML 里第一个 module script 之前插入
  `<script type="module" src="/bridge/<app>.js">`。module script 按文档顺序执行，
  所以 bridge 先跑，渲染器启动时 `window.desktop` / `window.aiOffice` 已经就位；
  上游 HTML 文件本身不动；
- shell renderer 是多入口（`index` / `update` / `pdf-password`，见 `apps/shell/electron.vite.config.ts:30-36`），网页版要一并产出。

**上游没有静态文件服务器**——`web-server` 的静态层要从零写。唯一值得复用的是 `packages/electron-utils/src/renderer-scheme.ts:81` `resolveRendererFile()` 的路径逃逸防护（pathname 长度 ≤ 4096、禁 `\0`、`\` 归一为 `/`、必须落在 root 内），以及 `packages/cli/src/mcp/files.ts:50` 的 `safeName`。

## SSE

- SSE 响应必须禁用反向代理缓冲（`X-Accel-Buffering: no`），否则事件会被代理攒着不发；
- 断线重连由浏览器 `EventSource` 自动完成，事件必须带 id 以便续传；
- 心跳与 `ping` 保活由 `web/rpc-bridge` 负责（对应上游 240 秒静默看门狗）；
- **断开信号是响应关闭**（`res.on('close')`），不是请求关闭：`req` 在请求体读完时就发 'close'，
  照着它拆流会让订阅刚建立就死掉；
- 关闭服务时要 `closeAllConnections()`——事件流是长连接，否则关不干净；
- 按通道过滤是可选的（`?channels=a,b`）；**空过滤 = 订阅全部**。

## 请求与错误

- 请求体大小有上限，沿用上游 `MAX_TRANSFER_BYTES`（256 MB）；
- 错误响应结构统一：通道未实现必须**显式报错**并说明原因，不得静默返回空结果——这是 `web/rpc-bridge` 的不变量之一；
- 长耗时操作不在 HTTP 连接上阻塞等待，改为提交任务 + 轮询 `GET /tasks/:taskId`。

## 错误与状态码

- **通道级失败**（通道未实现、参数不对、文件不存在）→ `200` + `{ok:false, error:{code, message}}`。
  请求本身是被理解了的，失败的是通道；把它做成 4xx 只会让浏览器控制台堆满红线，
  而上游的 renderer 并不区分这两种失败。
- **请求本身不合法**（body 不是 JSON）→ `400`。
- **路由不存在** → `404` + `{error}`（上游 MCP 的形状）。
- 静态资源找不到 → `404` + `{error}`。

## 不变量

1. 只有一个对外监听面，浏览器可见的一切都从这里出；
2. 不引入 Web 框架；
3. 所有静态资源走同源路径，不用跨 origin 的自定义 scheme；
4. SSE 响应禁用代理缓冲；
5. 请求体有明确上限；
6. 长耗时操作不阻塞 HTTP 连接；
7. 本模块不实现业务逻辑、不碰文件、不调引擎；
8. 上游 HTML 不改：bridge 的注入发生在响应时；
9. 路径前缀只有一个：`/app/<app>/`，与上游六个 origin 的差别由 base 参数消化。

## 风险

- 反向代理（Nginx）的缓冲与超时配置不当会表现为「AI 不流式」或「页面一直转圈」，排查时先看这一层；
- 六个 renderer bundle 体积可观，静态资源缓存策略没配好会让每次打开都重新下载；
- 内网无登录意味着任何能访问该端口的人都能读工作区里的文件——围栏是唯一防线，见 [workspace-store](../web/workspace-store/SPEC.md)。

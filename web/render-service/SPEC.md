---
id: render-service
type: module-design
status: draft
title: render-service —— 服务器端无头渲染
parent: architecture
tags: [web, render]
---

# render-service

## 职责

在服务器上用无头 Chromium 把文档渲染成 PDF / PNG，取代上游「spawn 一个 Electron 应用跑 `--headless-export`」的做法。

## 上游是怎么做的

| 事实 | 位置 |
| --- | --- |
| PDF 导出 = Chromium 的 `printToPDF`，打印的是 **renderer 的实时 DOM**，页面几何由 renderer 提供（twips → 英寸） | `apps/docs/src/main/docs-main.ts:5878`、`:5934`、`:6104` |
| **实时打印** 与 **无头导出** 是两条不同的路 | 前者 `event.sender.printToPDF` 打印当前页面；后者在隐藏窗口里重新渲染 |
| 无头导出的宿主**不 spawn 任何进程**——它在同一个 Electron 进程内用隐藏 `BrowserWindow` 跑完 | `apps/shell/src/main/index.ts:7083-7088` 注册 exporters、`:7097` `runHeadlessExportEntry`、`:7105-7114` 打印 envelope 后 `app.exit(headlessExitCode(outcome))` |
| 真正 spawn 的是 **CLI 侧** | `packages/cli/src/formats/app-export.ts:33-109`（`spawn(launch.command, ['--headless-export', input, '--to', target, '--out', out, '--json'])`，超时 180s） |
| 无头导出的 argv 语法：`<app binary> --headless-export <input-file> --to <format> --out <path> [--json]` | `packages/electron-utils/src/headless-export.ts:1-13` |
| 退出码：`0` 成功 / `1` 参数错 / `2` 输入文件错 / `3` 转换失败 | 同上 `HEADLESS_EXIT` |
| 模块与可导出格式的对应表：`docs → pdf/html/md`、`sheets → pdf`、`slides → pdf`、`markdown → pdf`、`html → pdf/docx` | 同上 `HEADLESS_TARGETS` |
| 宿主在导出后校验「文件存在 + mtime 新鲜」（`MTIME_SLACK_MS=2000`） | `apps/shell/src/main/headless-export.ts:62`、`:121` `runHeadlessExport` |
| PDF → PNG 是两步：先导出临时 PDF，再用 pdfium 栅格化 | `packages/cli/src/formats/render.ts` `renderToPngs` |
| 可渲染的扩展名清单 | 同上 `RENDERABLE` |
| **slides → PDF 不是直接排版**：slides renderer 先把每页画成 PNG（`apps/slides/src/renderer/export-svg.ts:137` `toDataURL`），main 再用 Chromium 打印 | `apps/slides/src/main/slides-main.ts:4793` |
| **上游已经有 Playwright 路径**：`packages/html2docx` 带 `src/drivers/electron.ts` 与 `src/drivers/playwright.ts` 两套驱动 | `packages/html2docx/src/drivers/` |

**关键推论**：上游的 PDF 质量取决于「renderer 的 DOM + Chromium 的打印管线」。网页版若改用服务端重新排版，会引入第二套排版引擎，输出必然与上游不一致。因此网页版**必须让服务端的 Chromium 加载同一个 renderer 页面**。

## 做法

用 Playwright 驱动常驻的 Chromium，加载**与用户浏览器完全相同的编辑器页面**，额外带一个 headless 标记；页面按上游 headless-export 协议产出目标文件。

**协议与退出码语义照搬上游**（上游 CLI 与 MCP server 依赖它），只换承载方式：Electron 应用 → 无头 Chromium 加载网页。

```
POST /rpc/<app>:consume-headless-export
  → 渲染服务在 Chromium 中打开 /app/<app>/?headless=1&input=…&to=pdf&out=…
  → 页面产出文件后回传 { ok: true, outPath } / { ok: false, code: 1|2|3 }
```

上游 `packages/html2docx` 已经带了一套 Playwright 驱动（`src/drivers/playwright.ts`，用 playwright-core 驱动本机 Chrome），说明这条路在上游已被验证过——网页版直接沿用它的思路。

**实时打印与无头导出分开**：上游的实时打印（`event.sender.printToPDF`）打印的是用户正在看的那个页面；无头导出则在隐藏窗口里重新渲染。网页版对应地：

- 实时打印 → 浏览器自己的打印（打印的是当前 DOM，与上游语义一致）；
- 无头导出 → 服务端 Chromium 重新加载页面再打印（与上游隐藏窗口语义一致）。

两者不可合并：用服务端渲染去做实时打印，会丢掉用户当前页面的状态。

## 边界

**允许依赖**：`web/engine-pool`（转发渲染任务、pdfium 栅格化）、`web/workspace-store`（读写产物路径）。

**禁止**：

- 不得 import `electron`；
- 不得自己实现 PDF 生成——PDF 产出走 Chromium 打印管线，栅格化走 pdfium（`packages/cli/src/formats/pdf.ts:18` `loadPdfium`）；
- 不得在 HTTP 事件循环上同步等渲染完成；
- 不得让渲染任务绕过 `web/workspace-store` 写文件。

## Chromium 进程池

- 常驻进程池，按任务创建独立 browser context（隔离 cookie / storage / 缓存）；
- **并发上限**：部署机可用内存约 11 GB（见 [deployment](../../deployment.md)），Chromium 与 Rust sidecar 共享这份预算，两者都要限量；
- 每个任务有超时与取消；崩溃时重启对应实例；
- 页面加载走内网同源地址，不出网。

## 字体

幻灯片与 PDF 的渲染质量取决于字体集合。桌面端由 `apps/slides/src/main/fonts.ts` 枚举系统字体，网页版没有这一步——**字体来自容器镜像里的确定集合**。

镜像需预装：中文与西文常用字体、PDF 标准字体（上游 PDF 编辑器拷了 pdfjs 的 `standard_fonts`，见 `apps/pdf/electron.vite.config.ts:38`）。字体缺失会导致渲染结果与桌面端不一致（换行位置、表格宽度都会变）。

## 不变量

1. 渲染产物与上游走同一条路径：renderer DOM → Chromium 打印 → pdfium 栅格化；
2. headless-export 的 argv 语法、目标格式表与退出码语义不变；
3. Chromium 池有明确的并发上限与内存上限；
4. 渲染不阻塞 HTTP 事件循环；
5. 渲染任务的输入与输出路径都过围栏；
6. 字体来自镜像内的确定集合，不依赖宿主环境；
7. 渲染失败必须区分「参数错 / 输入文件错 / 转换失败」，与上游退出码一一对应。

## 风险

- 无头 Chromium 与用户浏览器的版本差异会带来细微排版差异——需在能力回归（S4）里用同一批样本文件比对；
- 页面在无头模式下要走与用户端不同的分支（headless 标记），这条分支必须在上游 renderer 里存在——**这是唯一需要向上游插入的改动之一**，需登记在禁改清单的例外里；
- Chromium 的内存占用在没有并发上限时会迅速吃掉可用内存；
- 幻灯片导出 PDF 必须真的加载 slides 页面（上游是 renderer 出 PNG 再由 Chromium 打印），不能只调 `packages/pptx-render` 的引擎——它只产渲染树，不含 canvas 绘制。

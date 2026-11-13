---
id: file-index
type: module-design
status: draft
title: file-index —— 服务端文件全文索引
parent: architecture
tags: [web, search]
---

# file-index

## 职责

服务端的文件全文索引：扫描工作区、抽取文本、建立 FTS5 索引、回答搜索。

它是 `web/workspace-store` 的 `search()` 的实现方，索引的存储位置与其它服务端状态同属 `<data-dir>/`。

## 边界

**允许依赖**：`web/workspace-store`（读取被索引的文件）；上游 `apps/shell/src/main/file-index/` 的 store / tokenize / scan / extract 逻辑——**移植到 `web/` 目录，不改上游**。

**禁止**：

- 不得绕过 `web/workspace-store` 直接读文件；
- 不得在 renderer 或浏览器里建索引；
- 不得修改上游 `apps/shell/src/main/file-index/`。

上游这套实现在 Electron 主进程里，调度器也在一起；网页版要把「调度器」与「worker」一起搬到服务端，存储格式不变。

## 存储

数据库文件：`<data-dir>/file-index.db`，用 Node 内置 `node:sqlite` 的 `DatabaseSync`（上游 `apps/shell/src/main/file-index/store.ts:1`），开启 WAL。

Schema（上游 `store.ts:80-100`）：

- `meta(key, value)`——放 `TOKENIZER_VERSION` 等元信息；
- `files(id, path UNIQUE, name, ext, mtime_ms, size_bytes, status, body)`——`body` 存抽取出的正文；
- `file_fts`——FTS5 **contentless** 虚表，列为 `name, path, body, name_u, path_u, body_u`，其中 `_u` 后缀列是 unigram 流；`tokenize='unicode61 remove_diacritics 2'`。

`TOKENIZER_VERSION = 2`（上游 `store.ts:17`）。版本不匹配时**丢弃重建**：drop `file_fts`、清空 `files`（上游 `store.ts:114-117`）。

## 分词

FTS5 的 unicode61 分词器不切中文，因此上游自己预分词后用空格拼接（`tokenize.ts:92` `toIndexText`）：

- `tokenize.ts:16-31` 定义 CJK 区间，含扩展 B–H（`0x20000-0x323af`）；
- `tokenize.ts:74` `tokenize()` 产出 **CJK bigram + unigram 双流**，拉丁文按整词；
- `tokenize.ts:49` `fold()` 做 NFKC + 小写；
- 查询侧 `tokenize.ts:110` `parseQuery` 支持：空格 AND、`"短语"`、`-排除`、末词前缀 `*`；`tokenize.ts:143` `termExpr` 按 `bigramSafe` 决定查 `{name path body}` 还是 `{name_u path_u body_u}`。

网页版**沿用这套分词与查询语法**——搜索框的行为由上游 renderer 决定，不能改。

## 调度

移植上游 `indexer.ts` 的流程：

- 扫描在 worker 里做：`indexer.ts:258` `new Worker(this.workerPath, { resourceLimits: { maxOldGenerationSizeMb: 256 } })`，worker 处理 `scan` / `extract` 两类消息（`extract-worker.ts:16`）；
- **worker 路径要改**：上游用 electron-vite 专有的 `?modulePath` 后缀导入 worker 文件（`apps/shell/src/main/index.ts:362`），搬到服务端必须换成普通路径；
- 主线程只做 diff：`indexer.ts:137` `diff(seen, complete)`——mtime 与 size 相同则跳过（`:151`），变化才入队；
- 抽取串行执行（`indexer.ts:171` `drain()`）；
- 重扫防抖 1.5 秒（`RESCAN_DEBOUNCE_MS = 1500`，`:23`）；请求超时 120 秒后回收 worker（`WORKER_REQUEST_TIMEOUT_MS = 120000`，`:29`）；空闲 5 秒回收 worker（`WORKER_IDLE_MS = 5000`，`:44`）。

网页版唯一的调度差异：**索引范围是服务端的工作区目录，而不是某台机器的本地磁盘**。扫描的根目录由 `web/workspace-store` 提供。

上游的启动时机：启动后 4 秒首次扫描（`apps/shell/src/main/index.ts:7126`），查询前先 `refreshIfStale(60_000)`（`apps/shell/src/main/index.ts:4867`）。网页版沿用。

## 查询

沿用上游的查询链路（`apps/shell/src/main/index.ts:4867` → `store.ts:225` `search`）：

- 查询串截断 200 字符；默认 `limit` 50，上限 200（`store.ts:287`）；
- `parseQuery`（`tokenize.ts:110`）→ `termExpr`（`:143`）→ FTS5 匹配表达式；
- **两级匹配**：先按精确词命中并用 `bm25()` 排序（`store.ts:344` `matchScored`），无命中时按字符覆盖率 ≥ 0.5 且 token 数 ≥ 3 放宽（`store.ts:363` `relaxedMatches`）；
- 排除项用 `NOT` 删除候选（`store.ts:254-258`）；
- 排序优先级：全命中 → 名称前缀命中 → 名称/目录命中 → 精确词数 → 覆盖率 → BM25 → mtime（`store.ts:270-284`）；
- 片段：`fetchBodies`（`store.ts:401`）→ `buildSnippet`（`snippet.ts:12`，窗口 150 / 前导 40）；
- 可选的 LLM 重排（`rerank.ts:109` `SearchReranker`，通道 `HOME_CHANNELS.rerankSearch`）——保持可选，默认不开。

## 文本抽取

沿用上游 `extract.ts:27` → `packages/file-parse`：

- HTML/HTM 走自写 `stripMarkup()`（`extract.ts:15`），其余走 `parseFileToText(path, { maxChars })`（`packages/file-parse/src/parse.ts:97`）；
- **二进制嗅探**：`sniffBinary(bytes)`（`packages/file-parse/src/parse.ts:77`）识别 zip / PDF（`%PDF-`）/ OLE2（`D0CF11E0`），并校验扩展名与嗅探结果一致（`:119`）；文本解码 BOM 感知，UTF-8 失败回落 windows-1252；
- 各格式抽取器在 `packages/file-parse/src/index.ts:7-12`；**PDF 用 pdf.js**，需要 `DOMMatrix` polyfill（`packages/file-parse/src/pdf.ts:28`）与 `standardFontDataUrl`（`:9`）——服务端跑 pdf.js 时这两个前置要一并满足。

## 扫描与抽取的限制

沿用上游的上限：

| 限制 | 位置 | 值 |
| --- | --- | --- |
| 扫描深度 | `scan.ts:25` `scanFiles` | 32 |
| 文件数上限 | 同上 | 20 万 |
| 符号链接目录 | 同上 | 不跟随 |
| 超大文件 | `extract.ts:27` `extractText` | > 64 MB 只索引文件名 |
| 正文长度 | 同上 | 截断到 100 万字符 |

## 不变量

1. 索引只覆盖工作区根目录内的文件；
2. 索引状态最终与工作区一致——靠 mtime + size 判定变化，变更后重扫；
3. 分词器版本变更必须能触发全量重建，且重建路径可复现；
4. 重活在 worker 里做，主线程不因扫描或抽取而卡顿；
5. 查询语法与上游一致，搜索框行为不变。

## 风险

- 上游 `extract.ts` 的文本抽取依赖各格式的解析器，PDF 与 docx 的抽取路径要在移植时确认（见上游 `packages/file-parse`）；
- 20 万文件上限在测试环境的实际工作区规模下可能过早触发，需按实际规模复核；
- 索引库与服务端状态同目录，备份策略要与工作区一起考虑。

# AGENTS.md

给在这个仓库里干活的 AI 代理与人类贡献者的指引。

> **本文件会屏蔽同目录的上游 `CLAUDE.md`。** pi 的上下文文件发现顺序是
> `AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD`，
> 同一目录里命中第一个就停。根目录放了本文件之后，上游那份 `CLAUDE.md` 不再自动进上下文——
> 这是有意的：它讲的是上游 Electron 桌面版的规矩（主题令牌、preload 重建、i18n 分片），
> 对网页版 fork 不适用。需要时自己按路径去读。

## 这是什么仓库

- 上游：[genspark-ai/genoffice](https://github.com/genspark-ai/genoffice)（Apache-2.0）——Electron 桌面办公套件，六个编辑器 + 自研 docx/pptx 引擎 + Rust xlsx 引擎 + CLI / MCP server。
- 本仓库是上游的 fork，基线 `upstream@d7516961`（`git remote upstream` 指向上游仓库）。
- 目标：把那套桌面应用改造成**浏览器网页版**——上游 renderer 原地不动，Electron 主进程换成同源的 Node 服务端。
- 我们自己的东西只有两处：`web/` 目录（网页版自有代码），以及根级 spec 文档（`goal-and-requirements.md`、`architecture.md`、`web/<模块>/SPEC.md`）。
- 其余目录（`apps/`、`packages/`、`native/`、`ee/`、`e2e/`、`tools/`、`docs/`）都是上游的，只读。

## 工作方式：spec-driven

**先读 spec，再写代码。spec 是唯一事实来源。**

1. 改行为就改 spec——先改 spec，再改实现，同一个提交里。
2. 实现与 spec 冲突时以 spec 为准；发现 spec 本身错了，先改 spec 并写清理由，别让代码偷偷偏离。
3. 不要在代码里另立一份「真相」：第二套类型定义、第二份通道表、第二份围栏逻辑，都会在合上游时静默出错。要么引用上游，要么引用 spec 指的地方。
4. 每条结论落到**具体文件 + 行号**（上游事实写上游路径与行号）。别写「我记得上游是……」。
5. spec 文档带 frontmatter，pi 里用 `spec_search` / `spec_grep` / `spec_get` 按关键词定位章节，比在仓库里 grep 快。

## 读法顺序

1. `goal-and-requirements.md` —— 目标、范围、非目标、成功条件。
2. `architecture.md` —— 架构决策、模块边界、不变量。
3. `web/<模块>/SPEC.md` —— 只读这次要动的那几个模块。
4. 然后才看代码。

改动落在哪个模块就读哪个模块的 SPEC；跨模块就读全部涉及的 SPEC。模块清单以 `architecture.md` 的「模块拆分」一节为准（只有那一份）。

## 目录口径

- `web/` 下是网页版自有代码，新代码默认放这里。
- **不得改动**上游 `apps/`、`packages/` 目录。例外只有 `architecture.md`「上游隔离策略」里明确登记过的「允许的插入点」；动之前先在那份清单里确认位置，并写清为什么必须动上游。
- 依赖方向永远是 `web/` → 上游。上游 import `web/` 是硬禁区。
- 上游 renderer（`apps/*/src/renderer`）保持零改动——「renderer 一行不改」是整套设计的地基，破了它就得改一整条链路。
- `web/` 之外不新增业务代码。

## 禁止事项

- **不要引入 Web 框架**。服务端 HTTP 用 `node:http`，骨架照抄上游 `packages/cli/src/mcp/http.ts`。上游没有的东西这里也不要加——框架只会扩大合上游时的冲突面。
- **不要改上游 `packages/`**（`architecture.md` 登记的插入点除外）。
- **不要在 `web/` 之外新增业务代码**。
- **不要绕过 spec**。没有 spec 支撑的行为不许进代码；spec 里写了的行为也不许只做一半。
- 不要重新分配引擎分工：docx 的 parse/save 留在浏览器，pptx / xlsx / 转换 / 渲染在服务端。搬动引擎就意味着改 renderer。
- 不要绕过 `WorkspaceStore` 直接拼路径访问文件——路径围栏是服务端的安全底线。
- 不要顺手重构上游代码。上游的问题记进 spec 或 issue，别夹在自己的改动里。
- `upstream` 是只读的上游 remote，不要往它 push。

## 会话与上下文

- 计划（todo）按会话存：`.thinkrail/context/todos/<sessionId>.json`。**新会话不继承旧会话的计划**——换会话后先重新看一眼 todo 列表，别假设上个会话的进度还在。
- 上下文会被压缩。压缩后你手上只有「保留的最近消息 + 摘要」，早期细节可能已经没了；重要结论写进 spec 或代码注释，别只留在对话里。
- 仓库根的 `.pi/settings.json` 是团队共享的 pi 配置（当前用来调压缩触发阈值）。改之前先读它。

## 提交

- 提交信息一行祈使句、英文散文式，描述这次改动本身（例：`Add agent guide and merge the module inventory`）。
- 一个提交只做一件事，只提交自己改的文件。

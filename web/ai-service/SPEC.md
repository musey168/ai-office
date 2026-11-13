---
id: ai-service
type: module-design
status: draft
title: ai-service —— 服务端 AI 回合
parent: architecture
tags: [web, ai]
---

# ai-service

## 职责

在服务端承载完整的 AI 回合：调用模型、跑 agent loop、装配技能、把增量结果流回浏览器。

模型密钥只在服务端，浏览器永远不直连模型。

## 上游是怎么做的

| 事实 | 位置 |
| --- | --- |
| `AgentTransport` 是**纯接口**：`stream(request, callbacks): AgentStreamHandle`，handle 只有 `cancel()` | `packages/agent-core/src/types.ts:163` |
| 上游只提供了一种实现 `createIpcTransport`——走 Electron IPC 桥 | `packages/agent-core/src/electron-transport.ts:73` |
| `AgentLoop` 与其选项：`transport`、`skill`、`events`、`maxTurns`、`maxHistory`、`compaction`、`captureSnapshot`、`formatUserMessage`、`systemSuffix` | `packages/agent-core/src/loop.ts:61`、`:506` |
| 单回合模型调用次数上限 `DEFAULT_MAX_TURNS = 100`，历史默认 200 条消息 | `packages/agent-core/src/loop.ts` |
| `AgentSkill`：`id`、`systemPrompt`、`tools`、`buildContext?`、`executeTool(call, signal)`、`verifyResponse?`；`composeSkills` 合并多技能 | `packages/agent-core/src/skill.ts` |
| 三个内置技能：附件、知识库、CLI | `attachments-skill.ts:37`、`knowledge-base-skill.ts:49`、`cli-skill.ts:48` |
| **CLI 的 spawn 由宿主负责**，技能自己不 spawn | `packages/agent-core/src/cli-skill.ts:8` 注释 |
| provider 目录 `AI_PROVIDERS`、配置解析 `resolveAiSettings(stored, defaults)` | `packages/ai-provider/src/providers.ts:51`、`:740` |
| provider 适配器注册表 `getProviderAdapter(providerId)` | `packages/ai-provider/src/registry.ts:384` |
| 流式入口 `streamForProvider` / `chatForProvider` | `packages/ai-provider/src/stream.ts:26`、`chat.ts:18` |
| 设置文件 `ai-settings.json` 落在 userData | `apps/docs/src/main/docs-main.ts:4440`、`apps/shell/src/main/ai-naming-service.ts:27` |
| 对模型隐藏内容（redact）：占位符生成与校验 | `packages/agent-core/src/redact-core.ts`（`sanitizeLabel` `:56`、`placeholderSource` `:80`、`checkPlaceholders` `:128`）、`redact-range.ts`（`redactTextBetween` `:98`） |
| **redact 标记写进 OOXML**：docx 用 `mc:PreserveElements` 包住 `go:redact` 节点，pptx 用 `a:ext` 写同一标记 | `packages/docx-engine/src/patch.ts:2049-2088`、`packages/pptx-engine/src/redaction-xml.ts:50-111`（常量 `REDACT_EL = 'go:redact'`） |
| **出站脱敏**：`sanitizeAgentPayload()` 把私钥 / API key / URL 凭据 / `password=` 替换为 `[REDACTED_*]` | `packages/agent-core/src/loop.ts:1450`，在 `beginRun` `:737` 与 `foldStaleContexts` `:701` 注入 |
| AI 通道由 shell 注册一次供六个模块共用 | `apps/docs/src/main/docs-main.ts:4456` `registerAiIpc`，`apps/shell/src/main/index.ts:7032` 调用 |
| `ai:stream` 的具体实现：`streamForProvider(...)` 带 `onActivity` 每 5 秒发一次 ping | `apps/docs/src/main/docs-main.ts:4514`、`:4580-4602` |

## 做法

在 `web/ai` 下新增一个 `AgentTransport` 实现 `createSseTransport`，**不改 `packages/agent-core`**：

```
stream(request, callbacks) → handle
  ├─ POST /ai/stream（起回合，服务端返回 requestId）
  ├─ 服务端跑 AgentLoop，把 chunk 经 SSE 推到 GET /ai/stream/:requestId
  └─ handle.cancel() → POST /ai/stream-cancel → AbortController.abort()
```

chunk 的形状沿用上游 `IpcStreamChunk`（`packages/agent-core/src/electron-transport.ts:15`）：`requestId`、`type: 'delta' | 'reasoning' | 'tool-call' | 'usage' | 'done' | 'error' | 'ping'`、`text?`、`toolCall?`、`error?`、`errorCode?`、`stopReason?`、`usage?`。

**必须复刻静默看门狗**：上游 `IPC_STREAM_SILENCE_TIMEOUT_MS = 240_000`（同文件 `:49`），靠 `type: 'ping'` 的块保活；renderer 侧的看门狗超时比主进程长，两者竞争时以主进程为准。SSE 不送 ping 就会在 240 秒后被判死。

## 技能的装配

| 技能 | 依赖注入 | 网页版的提供方 |
| --- | --- | --- |
| 附件 | `AttachmentsSkillDeps`：`list()`、`read(path, offset, maxChars)`、`pathsInContext?`、`labels?` | `web/workspace-store` 读文件；附件目录来自工作区 |
| 知识库 | `KnowledgeBaseDeps`：`listFiles()`、`search(query, limit)`、`read(path, offset)`、`alsoCitable?` | `web/file-index` 提供检索；`web/workspace-store` 提供读取 |
| CLI | `CliSkillDeps`（宿主负责 spawn） | **服务端 spawn `genoffice` CLI**——与上游最大的差异：上游的 CLI 跑在用户机器上，网页版的 CLI 跑在服务器上 |

CLI 在服务器上执行时，其路径参数同样受 `web/workspace-store` 的围栏约束。

## provider 配置

- 服务端持有唯一一份 `ai-settings.json`（落在 `<data-dir>/`），用 `resolveAiSettings(stored, defaults)` 解析（上游 `providers.ts:740`）；也支持上游的 `GENOFFICE_AI_SETTINGS` 环境变量覆盖；
- provider 适配器沿用上游注册表，网页版不新增协议实现；
- 具体接入方式（统一 BYOK / 每人自带 key / Genspark 账号）取决于目标文档的待决问题 ②，本模块按「服务端持有一份配置」设计，接口不做死。

## AI 通道清单

`ai:stream`、`ai:stream-cancel`、`ai:chat`、`ai:get-settings`、`ai:set-settings`、`ai:settings-changed`、`ai:gsk-status`、`ai:gsk-login`、`ai:web-search`、`ai:image-search`、`ai:fetch-image`、`ai:generate-image`、`ai:analyze-media`、`ai:insert-image-url`、`ai:replace-picture-url`、`ai:run-cli`、`ai:log-run-failure`、`ai:skills-list`、`ai:skill-text`、`ai:open-skills-settings`、`ai:open-model-settings`、`ai:suggest-file-name`、`ai:save-sidecar`、`ai:save-style-template`、`ai:list-style-templates`、`ai:load-style-template`、`ai:codex-models`、`ai:custom-models`、`ai:search-test`、`ai:media-test`。

通道名与语义照搬上游；路由由 `web/rpc-bridge` 负责分发到本模块。

## 不变量

1. 模型调用只在服务端发起，浏览器不直连模型、不持有密钥；
2. `packages/agent-core` 与 `packages/ai-provider` **不改**——新增的 transport 实现只存在于 `web/ai`；
3. SSE 必须复刻 240 秒 ping 保活语义（上游的 `onActivity` 每 5 秒一次 ping）；
4. 回合有模型调用次数上限，沿用上游默认 100；
5. 技能的工具执行一律经 `web/workspace-store` / `web/engine-pool`，不得直接碰文件系统；
6. AI 侧的文件访问（含 CLI 的路径参数）同样受围栏约束；
7. 取消必须真正中止——上游的 `executeTool(call, signal)` 收到 `AbortSignal` 后应尽快停止，本模块要把同一个 signal 贯穿到模型请求与工具执行；
8. 流式内容有单回合上限（上游 `TURN_STREAM_MAX_CHARS = 2 MiB`），避免失控的流吃光内存；
9. **出站脱敏不得绕过**：`sanitizeAgentPayload` 必须在每一轮发往模型前生效；
10. **redact 标记必须原样往返**：`go:redact` 标记由浏览器写进 OOXML，服务端的 pptx / xlsx 引擎与写回路径不得破坏它。

## 风险

- 服务端统一配置意味着所有人共用一份额度，成本无法按人分摊——这是待决问题 ② 的直接后果，决策落定后本模块可能要支持多份配置；
- 长回合会长时间占用服务端的连接与内存；
- CLI 跑在服务器上后，它看到的路径语义与用户本地不同，`ai:run-cli` 的引用与报错措辞需要复核；
- 图片生成、网页搜索等工具需要出网，与「文件不出内网」的边界需要分清——上游这些工具本来就出网，但网页版应由服务端统一出网口。

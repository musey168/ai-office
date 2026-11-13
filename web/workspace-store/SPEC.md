---
id: workspace-store
type: module-design
status: draft
title: workspace-store —— 服务端文件访问的唯一入口
parent: architecture
tags: [web, storage, security]
---

# workspace-store

## 职责

服务端访问文件的**唯一**入口：路径解析与归一、围栏判定、原子写、目录列举、元数据、外部变更检测的存储侧实现。

它拥有：

- `WorkspaceStore` 接口；
- 本地目录实现（默认实现，可替换）；
- 路径围栏——服务端的安全底线；
- 原子写与救回副本；
- 服务端数据目录布局（上游 `userData` 的服务端等价物）。

## 边界

**允许依赖**：上游 `packages/cli/src/fs.ts` 的围栏与原子写逻辑（该文件无 Electron 依赖）；上游 `packages/electron-utils/src/atomic-write.ts` 的 `atomicWriteFile` / `atomicCopyFile` / `atomicWriteVia` / `writeJsonAtomic`；上游 `packages/project-store/src/store.ts` 的路径归一与 id 校验。

**禁止**：

- 不得被绕过——任何模块要碰文件都必须经本模块；
- 不得依赖 Electron API；
- 不得自行实现 URL 校验，沿用上游的 `packages/electron-utils/src/safe-remote-url.ts`（SSRF 守卫）与 `safe-external-url.ts`（协议白名单）。

## 接口

```
list(dirPath)          → Entry[]
read(path)             → Uint8Array
write(path, bytes)     → void
move(src, dst)         → void
delete(path)           → void
stat(path)             → FileMeta
snapshot(path)         → FileSnapshot
isExternallyModified(snapshot) → boolean
```

**不提供 `search()`**：检索属 `web/file-index`，两个模块各持一半会让边界失守。

**路径语义**：相对路径以工作区根为基准；绝对路径按文件系统绝对路径处理，但必须落在某个根内；空路径即工作区根（文件树的顶层节点发过来的就是它）。围栏判定会解析符号链接，所以工作区内指向外部的链接会被拒绝。

**错误码词表**（存储层与界面层之间的契约，现在定死）：

`outside_allowed_roots` · `file_not_found` · `not_a_file` · `not_a_directory` ·
`permission_denied` · `invalid_argument` · `output_exists` · `resource_limit` · `io_error`

命名沿用上游 CLI 的 `reason` 词表风格（`packages/cli/src/result.ts` 一带）。

**字节所有权**：上游 `readInput` 返回的是共享 buffer 的**视图**而非拷贝（`packages/cli/src/fs.ts:178`）。经 HTTP 传输必然拷贝，因此本模块的 `read` 返回独占副本，调用方无需关心；大文件走一次性 handoff 而不是 JSON。

## 落点与依赖策略

代码落在 `web/workspace-store/`，**自包含**：自带 `package.json` 与自己的 `node_modules`（typescript + vitest + @types/node），**零 `@genoffice/*` 依赖**。

| 理由 | 说明 |
| --- | --- |
| 合上游零冲突 | 目标文档 G4 是硬要求；对上游 `package.json` / `vitest.config.ts` 的任何改动都会变成每次合并的 recurring 成本 |
| 不必装整个上游 | 上游根 `npm install` 会拉 Electron 与全部 workspace 依赖；本模块只需三个开发依赖 |
| 依赖版本与上游一致 | typescript `^5.9.3`、vitest `^4.1.12`、@types/node `^24.10.1` |

代价：上游已有的原子写与围栏逻辑要自己写一遍（约 100 行纯逻辑）——但围栏那三处缺陷本来就要改。`tsconfig.json` 只读继承仓库根的 `tsconfig.base.json`，不改上游。

## 路径围栏

沿用上游 `packages/cli/src/fs.ts` 的四段式判定：`allowedRoots`（`:41`）→ `realizedPath`（`:52`，取最近存在祖先的 `realpath`）→ `isInside`（`:65`，用 `relative()` 而非字符串前缀）→ `assertAllowed`（`:71`）。

**但上游有一处行为必须改**：CLI 的「未设置 `GENOFFICE_ALLOWED_ROOTS` = 不受限」（`fs.ts:41-42` 注释 "Unset means unrestricted"）在桌面端成立，在服务端是危险的——HTTP 暴露在局域网里，无围栏等于把整个文件系统开放。网页版**必须显式配置工作区根目录，未配置则拒绝提供文件服务**。

上游另有一条事实：Electron 主进程**完全不使用**这道围栏（`GENOFFICE_ALLOWED_ROOTS` 在 `apps/` 下 0 命中）。搬用上游逻辑时不能照抄它「默认不限」的假设。

### 上游已知的三处缺陷，服务端要补

| 缺陷 | 位置 | 补法 |
| --- | --- | --- |
| `relative()` 大小写敏感，`C:\Users\x` 与 `c:\users\x` 可绕过 | `fs.ts:65` | 比较前归一大小写；macOS 统一按大小写不敏感处理 |
| macOS HFS+/APFS 的 NFD 与 NFC 未归一 | 同上 | 参照 `packages/project-store/src/store.ts:150-152` 的 `realpathSync.native(p).normalize('NFC')` |
| 检查后使用（TOCTOU） | `fs.ts:71` | `open` 后用 fd 校验（`fstat` 与 `realpath` 一致）；写操作对父目录复核 realpath |

符号链接：上游靠 `realizedPath` 化解已存在的部分，但**新建文件的父目录**若被替换成指向外部的链接，`realizedPath` 只查最近存在祖先——写操作必须额外复核父目录。

## 目录布局

上游的 `app.getPath('userData')` 在服务端被照搬为一个可配置的数据目录（上游用 `GENOFFICE_USER_DATA` 表达该语义，直接沿用）：

```
<workspace-root>/          工作区根：用户可见的文件，唯一可读可写的用户数据
<data-dir>/                服务端数据（上游 userData 的等价物）
  app-settings.json        默认保存目录等设置
  ai-settings.json         AI provider 配置
  projects/                project-store 布局（index.json / <projectId>/project.json / chats/*.jsonl）
  file-index.db            FTS5 索引
  autosave/                救回副本（上游 userData/docs-autosave 的等价物）
  generated-images/        AI 生成图片
  tmp/                     临时文件
```

`project-store` 的 id 校验可直接沿用上游 `packages/project-store/src/store.ts:123` 的 `assertSafeId`（`SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/`，拒绝 `..`、`/`、`\`）。

工作区根的具体划分方式取决于目标文档的待决问题 ①（多人文件与协作模型）。当前做法：单一根目录，不按人隔离，不加编辑锁——与上游单机行为一致。

## 原子写

上游有三套并存，语义不同：

| 实现 | 失败时的行为 |
| --- | --- |
| `packages/cli/src/fs.ts:113` `writeOutput` | 原地覆盖目标 |
| `packages/electron-utils/src/atomic-write.ts:117` `atomicWriteFile` | 原地覆盖，但先留 `<name>.unsaved.tmp` 救回副本（`:45` `rescuePathFor`），成功后删除（`:74`） |
| `apps/shell/src/main/atomic-write.ts:16` | **绝不碰目标** |

**选择 `packages/electron-utils/src/atomic-write.ts` 的 `atomicWriteFile`**：六个编辑器都用它，用户在桌面端体验到的保存行为就是它；救回副本在服务端是纯收益——保存失败时文件不丢。`apps/shell` 那套是 shell 专用的更保守变体，网页版不必照搬。

**本模块镜像它的完整语义**（自己实现，不引用上游源码）：

1. 同目录暂存文件 `<name>.<6 位随机 hex>.tmp`——**不带前导点**，macOS SMB 会把点文件标记为隐藏且该标记在 rename 后仍留在正式文档上；
2. 写暂存 → best-effort fsync → 失败则删暂存并抛错；
3. rename 覆盖目标，并对瞬时失败（Windows 杀软/索引器锁、网络挂载拒绝覆盖）重试；
4. rename 失败 → 退回**原地写**；
5. 原地写也失败 → 把新字节**救回副本** `<name>.unsaved.tmp`（同目录、固定名，不带随机后缀，否则每次重试都在目录里堆一个新文件），再抛错；
6. 成功 → 删除过期的救回副本。

救回副本用 `copyFile` 而非 `rename`：目标可能已存在（上一次失败的副本），且 Windows 拒绝 rename 覆盖已有文件；`copyFile` 留在内核里，几百 MB 的文件不会进内存。

救回副本落位：上游放在 `userData/docs-autosave/<sha1(path)>.docx`（`apps/docs/src/main/docs-main.ts:4056-4067`），服务端放在 `<data-dir>/autosave/` 下，保持同样的按路径哈希命名。

## Electron 专有文件能力的替代

| 上游 | 通道 / 位置 | 网页版 |
| --- | --- | --- |
| `dialog.showOpenDialog` | `HOME_CHANNELS.browse` 等 30 余处 | 服务端文件树（`list`）+ 上传入口 |
| `dialog.showSaveDialog` | `pdf:save-as-request` 等 | 服务端路径输入或文件树选择；或浏览器下载（服务端生成 + `Content-Disposition`） |
| `webUtils.getPathForFile` | `packages/electron-utils/src/drop-open.ts:129` | 上传 |
| `shell.openPath` | `apps/shell/src/main/index.ts:6897` | 网页版不需要打开本地应用 |
| `shell.openExternal` | 30 余处 | 浏览器 `window.open`，**必须保留协议白名单**（`packages/electron-utils/src/safe-external-url.ts:21`） |
| `shell.showItemInFolder` | `HOME_CHANNELS.revealPath` | 无对应物 → 降级为「复制绝对路径」 |
| 自定义 scheme | `packages/electron-utils/src/renderer-protocol.ts`、`apps/docs/src/main/lazy-media.ts:5` | HTTP 端点 + 一次性 token |
| `app.getPath('userData'/'temp'/'home'/'documents')` | 数十处 | 服务端配置项 |

## 外部文件的处理

允许从工作区外导入文件时：**复制进工作区**，不原地引用、不原地写回。否则围栏外的路径会成为可写逃逸点。

上传入口（`<input type=file>` / 拖放）落盘路径必须在围栏内，并做类型与大小校验（对应上游 `apps/slides/src/main/attachments-ipc.ts:23/76`）。

## 外部变更检测

镜像上游 `apps/docs/src/main/external-change.ts` 的 `isExternallyModified` 两级判定：

- 没有记录，或文件已不存在 → **不算冲突**（保存照常进行并重建文件）；
- `mtimeMs` 与 `size` 都一致 → 不算冲突；
- 否则才读文件算 hash，与记录的 hash 比较，不同才算冲突。

上游的 hash 由调用方提供；本模块内部用 `node:crypto` 的 sha256 实现，`snapshot()` 一次给出 `mtimeMs` / `size` / `hash`。

## 不变量

1. 文件访问只有一个入口——没有任何模块绕过本模块直接拼路径；
2. 围栏必须显式配置，未配置则拒绝提供文件服务（与上游 CLI 的默认相反）；
3. 路径比较用真实路径经大小写与 Unicode 归一后的形式，不用字符串前缀；
4. 写入是原子的，失败不留半截文件；
5. 从工作区外导入的文件先复制进来；
6. 对外 URL 一律走 `safe-remote-url.ts` 的 SSRF 守卫（逐跳重验 + 地址钉住，`safe-remote-url.ts:270`）与 `safe-external-url.ts` 的协议白名单；
7. 打开文件后必须用 fd 复核围栏（TOCTOU），写操作额外复核父目录的真实路径。

## 风险

- 围栏判定是安全底线，任何一条绕过路径都等于把服务器文件系统开放给局域网；
- 上游 Electron 主进程没有围栏，搬用其逻辑时容易连「默认不限」一起搬过来；
- 50MB 文件的读写会长时间占用 worker，字节所有权与拷贝策略要定死，避免隐式复制放大内存；
- 上游 `disk-watch` 用**轮询**而非 inotify（`packages/electron-utils/src/disk-watch.ts:26`），服务端若要「外部变更通知」同样得轮询或 `fs.watch` + 轮询兜底；
- 大小写归一按平台切换（darwin/win32 不敏感、linux 敏感），若将来把工作区放到网络挂载上而该挂载的语义与平台假设不同，需重新核对。

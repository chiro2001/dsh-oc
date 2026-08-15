# dsh-oc 实现规划

> 状态：方案已确认，待执行。执行者应先阅读本文，再阅读同目录的 `PROTOCOL.md`。
> 仓库：`chiro2001/dsh-oc`（后续可能转移为 `chiro/dsh-oc`）。
> 目标读者：后续按本计划实施 dsh-oc 的模型/工程师。

---

## 1. 目标与边界

### 1.1 目标

用 OpenCode 的 TUI 作为 DeepSeek Harness（dsh）的终端前端：

- **前端**：opencode 官方 CLI 以 `attach` 模式运行，只负责渲染、键盘、终端生命周期。
- **后端**：dsh 负责全部 Agent 逻辑、Session、工具、模型调用、权限与用户提问。
- **连接**：dsh-oc 在 dsh 进程内实现一个 OpenCode 兼容的 HTTP/SSE 服务，把 opencode TUI 的协议请求翻译成 dsh 服务调用。

### 1.2 非目标（首版不做）

- 不 fork、不复制 opencode TUI 源码；TUI 使用官方发布二进制。
- 不让 opencode 启动自己的 server / agent / session / tool 运行时。
- 不覆盖 opencode 全部 162 条 HTTP 路由；未实现的外围能力返回 schema-valid 空数据或显式 501。
- 不改 dsh 核心仓库；dsh-oc 是外置 profile bundle。
- 不在 dsh 运行时中使用 Bun。

---

## 2. 架构

```text
┌──────────────────────────── dsh (Node) ─────────────────────────────────┐
│                                                                          │
│ profile "oc" = dsh-base + dsh-oc                                         │
│                                                                          │
│ dsh-base:                                                                 │
│   agents, sessions, tools, llm, approval, userQuestions,                 │
│   sessionProjections, attachments, settings, credentials                 │
│                                                                          │
│ dsh-oc bundle 额外挂载：                                                  │
│   - workspace registry (@deepseek-ai/dsh-workspace)                      │
│   - directory picker  (@deepseek-ai/dsh-host-directory-picker-auto)      │
│   - api proxy        (@deepseek-ai/dsh-host-apiproxy)                    │
│   - oc-bridge        本仓库 /bridge 子路径                               │
│   - oc-tui           本仓库 /tui 子路径                                  │
│                                                                          │
│ oc-bridge:                                                                │
│   node:http loopback server                                              │
│   实现 OpenCode v1 + v2 兼容路由                                          │
│   调用 ctx.apiProxy.*                                                     │
│   订阅 ctx.apiProxy.events.mux() 并转发 SSE                               │
│                                                                          │
│ oc-tui:                                                                   │
│   解析/缓存 opencode 二进制                                                │
│   spawn `opencode attach http://127.0.0.1:<port>`                        │
│   stdio: inherit                                                          │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ HTTP + SSE, 仅 loopback
                                   ▼
                  opencode 官方二进制（attach 模式）
                  · 只运行 TUI/client 代码
                  · 不创建 opencode 后端实例
                  · 所有状态从 oc-bridge 读取
```

---

## 3. 关键决策

| 决策 | 结论 | 理由 |
|---|---|---|
| TUI 来源 | 官方 `opencode-ai` 二进制 + `opencode attach` | 持续复用官方发布物，不维护 UI fork |
| 后端归属 | dsh 唯一后端 | 用户目标：opencode 只做前端 |
| 协议范围 | 实现 TUI 真实使用的 v1 + v2 路由子集 | 探针证明 TUI 同时调用两代 API |
| 模型配置 | 不向 opencode 注入 DeepSeek API key | dsh 后端自己调 DeepSeek；opencode TUI 只显示 dsh 模型目录 |
| opencode 数据目录 | 隔离到 `$DSH_HOME/opencode` | 避免读取全局 opencode 的配置、凭据和会话 |
| 二进制分发 | 缓存/已装优先，缺失时从 GitHub Release 惰性下载 | 避免 350MB npm 双二进制依赖与 postinstall 自愈 |
| 进程边界 | dsh=Node，opencode 子进程=官方 Bun 自包含二进制 | 互不侵入 |
| 兼容策略 | 对未实现路由返回合法空响应/501，UI 不崩 | 控制首版范围 |

---

## 4. 版本与依赖基线

### 4.1 opencode

- npm 包：`opencode-ai@1.18.18`
- 源码 commit：`4643e65`（仓库 `anomalyco/opencode`，dev 分支）
- GitHub Release：`v1.18.18`
- Release asset 命名：`opencode-<linux|darwin|windows>-<x64|arm64>[-baseline][-musl].tar.gz`（Windows 为 `.zip`）
- 版本更新方式：dsh-oc 仓库内保存 `opencode-version.json`；升级 = 更新该文件 + 重新生成 asset sha256 manifest + 跑协议回归。

### 4.2 dsh

- 运行时由已安装的 `@deepseek-ai/dsh` CLI 提供（`dsh plugin --profile oc add ...`）。
- 开发时使用同一份 `deepseek-harness` checkout（建议 clone 到 dsh-oc 的兄弟目录）。
- 本仓库对 dsh 包采用 `peerDependencies` + `devDependencies` 的方式引用，运行时通过 profile 的 module fallback 解析。
- 直接使用的 dsh 服务/类型：
  - `@deepseek-ai/cordis`
  - `@deepseek-ai/dsh-cmdline`（`ctx.cmdlineArgs`、`ctx.appExit`）
  - `@deepseek-ai/dsh-home-paths`（`resolveDshHome`）
  - `@deepseek-ai/dsh-host-apiproxy`（`ctx.apiProxy` 类型；其插件由 patch 行挂载）
  - `@deepseek-ai/dsh-settings` / `dsh-credentials`（类型与 brand helper）
  - `@deepseek-ai/dsh-session`（SessionEvent 类型）
  - `@deepseek-ai/dsh-llm`（ContentBlock / ModelSelection 类型）

---

## 5. 目标仓库结构

```text
dsh-oc/
├─ package.json
├─ tsconfig.json
├─ tsdown.config.ts
├─ cordis.patch.yml
├─ opencode-version.json            # pinned opencode version + commit
├─ opencode-assets.json             # 生成：平台 asset -> url/sha256/size
├─ src/
│  ├─ index.ts                      # bundle 入口（只导出类型/常量，无副作用）
│  ├─ bridge/
│  │  ├─ index.ts                   # oc-bridge 插件：server 生命周期 + ctx.apiProxy 装配
│  │  ├─ router.ts                  # OpenCode v1/v2 路由表
│  │  ├─ http.ts                    # node:http 封装、CORS/错误信封
│  │  ├─ sse.ts                     # SSE encoder / client registry
│  │  ├─ events.ts                  # DSH mux frame -> OpenCode GlobalEvent
│  │  ├─ convert/
│  │  │  ├─ session.ts              # DSH SessionSummary -> OpenCode Session
│  │  │  ├─ message.ts              # DSH SessionEvent[] -> OpenCode Message/Part
│  │  │  ├─ tool.ts                 # tool/call + tool/result -> ToolPart
│  │  │  ├─ model.ts                # DSH ModelProviderGroup -> OpenCode Provider/Model
│  │  │  ├─ permission.ts           # DSH approval frame -> PermissionRequest
│  │  │  ├─ question.ts             # DSH question frame -> QuestionRequest
│  │  │  └─ todo.ts                 # DSH todos projection -> Todo[]
│  │  ├─ stubs.ts                   # 外围路由的 schema-valid 空实现
│  │  └─ errors.ts                  # DSH RPC error -> OpenCode HTTP error
│  └─ tui/
│     ├─ index.ts                   # oc-tui 插件：spawn/信号/退出
│     ├─ binary.ts                  # 二进制定位与惰性下载
│     ├─ download.ts                # GitHub Release 下载 + sha256 + 原子落盘
│     └─ platform.ts                # platform/arch/musl/AVX2 选择
├─ tests/
│  ├─ convert/*.spec.ts
│  ├─ bridge-router.spec.ts
│  ├─ binary.spec.ts
│  ├─ fixtures/
│  │  ├─ opencode/                  # 协议探针录制的请求/响应 fixture
│  │  └─ dsh/                       # DSH session-event fixture
│  └─ e2e/
│     ├─ mock-llm.ts                # 复用 dsh-llm-mock-server 或本地 mock
│     ├─ attach-boot.e2e.ts         # 官方 attach 能启动并请求 oc-bridge
│     └─ session-turn.e2e.ts        # TUI 发 prompt -> DSH Agent -> 消息回流
└─ docs/
   ├─ PLAN.md                       # 本文
   └─ PROTOCOL.md                   # 协议探针结果与路由清单
```

---

## 6. package.json 与 cordis.patch.yml 规格

### 6.1 package.json 要点

```json
{
  "name": "@deepseek-ai/dsh-oc",
  "version": "0.1.0-rc.1",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./bridge": "./lib/bridge/index.js",
    "./tui": "./lib/tui/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "opencode-version.json", "opencode-assets.json"],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.0",
    "@deepseek-ai/dsh-cmdline": ">=0.0.1-rc.1",
    "@deepseek-ai/dsh-home-paths": ">=0.0.1-rc.1"
  }
}
```

> 类型级 devDependencies（发布时不需要）：`@deepseek-ai/dsh-host-apiproxy`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-credentials`。
> 构建建议使用 `tsdown` 或 `tsc`，入口生成 `lib/bridge/index.js` 与 `lib/tui/index.js`。

### 6.2 cordis.patch.yml

```yaml
# 叠加在 dsh-base 之上；插入顺序决定依赖激活顺序。
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'

    - id: directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-auto'

    - id: api-proxy
      name: '@deepseek-ai/dsh-host-apiproxy'

    - id: oc-bridge
      name: '@deepseek-ai/dsh-oc/bridge'
      inject: [apiProxy]

    - id: oc-tui
      name: '@deepseek-ai/dsh-oc/tui'
      inject: [ocBridge]
```

- `workspace` 和 `directory-picker` 是 `@deepseek-ai/dsh-host-apiproxy` 的静态 inject 依赖，必须由 dsh-oc 补上。
- `oc-bridge` 发布 `ocBridge` service：`{ url: string, port: number }`。
- `oc-tui` 只在 `ocBridge` 就绪后启动；`--help` 时 launcher 不挂 `appExit` 终止？实际实现按 dsh app 约定处理。

### 6.3 安装方式

```bash
# 本地开发
cd dsh-oc
pnpm install && pnpm build
dsh plugin --profile oc add .
dsh --profile oc

# 发布后
dsh plugin --profile oc add @deepseek-ai/dsh-oc
dsh --profile oc
```

`dsh plugin` 会初始化 `$DSH_HOME/profiles/oc`，先写 `["@deepseek-ai/dsh-base"]`，检测到本包声明 `dsh.bundle` 后追加为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-oc"]`。

---

## 7. oc-bridge 设计

### 7.1 HTTP 服务

- 使用 `node:http`，监听 `127.0.0.1` 随机端口（`port: 0`，启动后从 `server.address()` 读取）。
- 仅接受 loopback 连接；所有响应允许 CORS `*`（attach 模式无需鉴权，后续可加 dsh/openCode 同款 basic auth）。
- JSON 错误统一为 opencode 的 `EffectHttpApiError*` / `NotFoundError` 形状，避免 TUI 把合法 stub 当致命错误。
- 启动后通过 Cordis service `ocBridge` 暴露 `{ url }`。

### 7.2 DSH 调用封装

`ctx.apiProxy` 的方法是 RPC envelope 风格，oc-bridge 统一封装：

```ts
async function call<K extends keyof DshApiProxy>(
  method: K,
  payload: RequestPayload<K>,
  signal?: AbortSignal,
): Promise<ResponseValue<K>> {
  const rpcId = randomUUID()
  const response = await api[method]({ rpcId, payload }, signal)
  return response.payload
}
```

所有 DSH RPC error 必须映射为 opencode HTTP error，保留 `code`。

### 7.3 路由清单（核心子集）

以下路由是 **P1/P2 必须实现** 的；其余按 `PROTOCOL.md` 表格返回 stub。

#### v1（TUI sync 与主交互使用）

| 方法/路径 | 实现 |
|---|---|
| `GET /path` | 返回 `{ path, worktree, directory }`，来自 `ctx.apiProxy.host` / `process.cwd()` |
| `GET /project/current` | 单项目 stub，`id/worktree` 用 dsh 进程 cwd 生成稳定值 |
| `GET /project/global/directories` | 返回 `[{ id, worktree: cwd, path: cwd }]` 或空数组 |
| `GET /config` | 返回 `{}`（opencode TUI 本地配置由 attach 进程自己的 `OPENCODE_CONFIG_DIR` 管） |
| `GET /config/providers` | 返回空配置视图或从 dsh `llm.providers` 转换 |
| `GET /provider` | 返回 dsh provider 列表（含模型） |
| `GET /provider/auth` | 返回 `{}`；dsh 凭据不由 opencode 管理 |
| `GET /agent` | 返回一个 primary agent 视图或空数组 |
| `GET /command` | 从 dsh command registry 转换；首版可空数组 |
| `GET /session?start=…&path=…` | `apiProxy.sessions.list` → `Session[]` |
| `GET /session/status` | 根据 `apiProxy.sessions.list` 的 running 标志返回 `Record<id, SessionStatus>` |
| `POST /session` | `apiProxy.sessions.create`，返回 opencode `Session` |
| `GET /session/{id}` | `apiProxy.sessions.history` + `list` 中对应项 → `Session` |
| `PATCH /session/{id}` | `apiProxy.sessions.rename` |
| `GET /session/{id}/message` | `apiProxy.sessions.history` → `Message[]` |
| `POST /session/{id}/prompt` | `apiProxy.sessions.prompt`，content 由 opencode `PromptInput` 转 `PromptContentPart[]` |
| `POST /session/{id}/abort` | `apiProxy.sessions.cancel` |
| `GET /session/{id}/todo` | dsh `todos` projection → `Todo[]` |
| `GET /session/{id}/diff` | 有 produced-files 投影则转换，否则 `[]` |
| `GET /global/event` | SSE：订阅 `apiProxy.events.mux`，翻译后推送 |
| `GET /permission` | 当前 pending approvals → `PermissionRequest[]` |
| `POST /permission/{id}/reply` | 映射到 dsh `apiProxy.respond` 的 approval response |
| `GET /question` | 当前 pending questions → `QuestionRequest[]` |
| `POST /question/{id}/reply` | 映射到 dsh `apiProxy.respond` 的 question response |
| `POST /question/{id}/reject` | 以 cancelled client-response 调 `apiProxy.respond` |

#### v2（`/api/...`，TUI data layer 使用）

| 方法/路径 | 实现 |
|---|---|
| `GET /api/location` | 返回 `{ directory: cwd, workspaceID? }` |
| `GET /api/agent` | dsh subagent/preset 信息；首版空数组或 primary agent |
| `GET /api/model` | `apiProxy.llm.models` → opencode `Model[]` |
| `GET /api/provider` | `apiProxy.llm.models/providers` → opencode `Provider[]` |
| `GET /api/command` | 空数组或 dsh commands 转换 |
| `GET /api/skill` | 空数组或 dsh skills 转换 |
| `GET /api/reference` | `[]` |
| `GET /api/integration` | `[]` |
| `GET /api/permission/saved` | `[]`（首版不支持 always-save） |
| `GET /api/session` | 同 v1 list |
| `POST /api/session` | 同 v1 create |
| `GET /api/session/{id}` | 同 v1 get |
| `GET /api/session/{id}/message` | 同 v1 messages |
| `GET /api/session/{id}/permission` | pending approvals for session |
| `POST /api/session/{id}/permission/{rid}/reply` | 同 v1 permission reply |
| `GET /api/session/{id}/question` | pending questions for session |
| `POST /api/session/{id}/question/{rid}/reply` | 同 v1 question reply |
| `POST /api/session/{id}/question/{rid}/reject` | 同 v1 question reject |

> 注意：探针显示 TUI 同时调用 `/session*` 与 `/api/session*`，两套必须并存，共享同一套 service 实现，只有 URL 前缀不同。

### 7.4 SSE 事件桥

`GET /global/event` 保持长连接：

1. 为每个 SSE client 创建一个 dsh mux consumer：
   ```ts
   for await (const frame of apiProxy.events.mux({ rpcId, payload: {} }, signal)) {
     const event = convertMuxFrameToOpencodeEvent(frame)
     if (event) sse.write(`data: ${JSON.stringify(event)}\n\n`)
   }
   ```
2. 至少翻译以下 mux frame：
   - `session/event`：
     - `session/created`、`session/title` → `session.updated`
     - `turn/start` → `session.status`（busy）
     - `turn/end` → `session.idle`
     - `user/message`、`assistant/message`、`tool/result` → 重建对应 `message.updated` / `message.part.updated`
     - `approval/asked|decided` → `permission.asked/replied`
     - `todo/write` → `todo.updated`
   - `approval/requested|resolved` → `permission.asked/replied`
   - `question/requested|resolved` → `question.asked/replied/rejected`
   - `session/queue` 和 `session/jobs` 首版可忽略或映射为 session update。
3. 事件必须带 `directory`（session cwd）与 `project`/`workspace` 可选字段；opencode TUI 按 directory 过滤事件。
4. SSE 断开时取消 dsh mux consumer（用 `AbortController`）。

### 7.5 关键对象转换

#### Session

OpenCode `Session` 与 dsh `SessionSummary` 映射：

```text
id            = dsh sessionId
slug          = id
directory     = summary.cwd ?? process.cwd()
projectID     = stable dsh-project-id（cwd 哈希）
title         = summary.projections?.sessionTitle ?? ''
time.created  = dsh header.createdAt
time.updated  = summary.updatedAt
model         = session 当前 model（无则默认）
agent         = agentPreset ?? 'build'
```

#### Message / Part

由 `apiProxy.sessions.history` 的 `events` 折叠生成：

- 每个 `user/message`：
  - 生成 `UserMessage` + 文本 `TextPart`；图片转为 `FilePart`（URL 使用 `GET /file/content` 或 data URL，首版可仅支持文本）。
- 每个 `assistant/message`：
  - 生成 `AssistantMessage`；
  - `message.content` 中 text block → `TextPart`；
  - reasoning block → `ReasoningPart`；
  - `tool/result` 与对应的 `tool/call` 配对生成 `ToolPart`；
  - 首版可以把整个 assistant 消息重建为 `message.updated` 事件，减少 part 级增量事件。
- `assistant/chunk`：
  - SSE 期间可暂不翻译为 delta；在 `assistant/message` 或 `turn/end` 时发完整 message，保证正确性优先。

#### ToolPart

dsh `tool/call` 与 `tool/result` 映射：

```text
callId      = dsh callId
tool        = dsh tool name
state:
  call only       -> pending（raw input）
  result success  -> completed（input + output）
  result error    -> error
title        = tool presentation 的 `title` 或 tool name
metadata     = dsh meta（JSON-safe）
```

#### Model / Provider

`apiProxy.llm.models` 的 `ModelProviderGroup` 映射：

- dsh provider `deepseek-official` → opencode provider id `deepseek`（对外显示名 `DeepSeek`）。
- model id、name、description 原样；`limit.context/output` 使用 dsh 能力值，缺失时用安全默认（context 128000、output 8192）。
- `capabilities` 给默认值：`toolcall: true`、`reasoning: true`、`temperature: false`、input/output text。
- 模型选择回写：`POST /api/session/{id}/model` 或 TUI 对应调用 → `apiProxy.sessions.selectModel`。

#### Permission

- 建立 `opencodePermissionId -> dshRpcId` 映射表（内存）。
- mux `approval/requested` 到达时：
  - 生成 opencode `PermissionRequest`：
    - `permission` 用 `toolName` 对应类别（bash → `bash`，fs → `edit`/`read`，其余 → `unknown`）
    - `patterns`、`metadata` 用 toolName/callId/reason 填充
  - 同时写 `/permission` 列表与 SSE `permission.asked`。
- TUI 提交：
  - `once` → dsh `allowed-once`
  - `reject` → dsh `rejected`
  - `always` → 首版按 `allowed-once` 处理，并在 `docs/PROTOCOL.md` 记录限制。

#### Question

- 建立 `opencodeQuestionId -> dshRpcId` 映射表。
- dsh `question/requested` 的 `questions[]`（含 `id`）转 opencode `QuestionRequest`：
  - opencode 的 `QuestionInfo[]` 按 dsh 顺序排列；opencode answer 按数组顺序返回。
  - 回写时用 index 映射回 dsh 的 `{ id, selected[], custom? }`。
- `multiSelect`、`header`、`detail` 按 dsh 字段原样转。

#### Todo

- dsh `todos` projection 是 `TodoItem[]`，字段接近 opencode `Todo`：
  - `status`: dsh `pending|in_progress|completed` → opencode 同名；无 priority 时给 `medium`。
- 没有 projection 时返回 `[]`。

### 7.6 外围 stub 规则

`GET /lsp`、`/mcp`、`/formatter`、`/experimental/resource`、`/experimental/console`、`/experimental/capabilities`、`/vcs`、`/experimental/workspace*`：

- 返回 **合法空数组/空对象**，不返回 HTML 或裸 500。
- `experimental.capabilities` 必须返回 `{ backgroundSubagents: false }`。
- `vcs` 返回 `{ branch: '', status: [] }` 等最小形状。
- 所有 stub 用官方 opencode server 的同路由真实响应作为 fixture，校验 schema。

---

## 8. oc-tui 设计

### 8.1 二进制获取优先级

```text
1. env DSH_OC_OPENCODE_BIN（绝对路径）
2. $DSH_HOME/opencode/bin/<version>/opencode(.exe) 缓存，且 --version 匹配
3. PATH 上的 opencode，且 --version 匹配
4. profile 内已安装的 opencode-ai 包（若存在，自动运行其官方 postinstall 后使用）
5. 从 GitHub Release 惰性下载官方单平台 asset
```

- 版本来自 `opencode-version.json`，当前固定 `1.18.18`。
- 缓存路径：`$DSH_HOME/opencode/bin/1.18.18/opencode`（Windows `.exe`）。
- 下载 URL 与 sha256 来自 `opencode-assets.json`，该文件由脚本生成（见 `PROTOCOL.md` 附录）。

### 8.2 平台选择

复制 opencode 官方 postinstall 的选择逻辑：

- `process.platform` → darwin/linux/win32
- `process.arch` → x64/arm64
- Linux：
  - musl 检测：`/etc/alpine-release` 或 `ldd --version`
  - x64 且无 AVX2：选择 `-baseline`（读取 `/proc/cpuinfo`）
- 资产后缀：
  - Linux/macOS：`.tar.gz`
  - Windows：`.zip`

### 8.3 下载、校验、落盘

1. 使用 Node `fetch` 下载到 `$DSH_HOME/opencode/tmp/<uuid>`。
2. 用 `crypto.createHash('sha256')` 校验 `opencode-assets.json` 中的 digest；失败删除重试一次。
3. 解包：
   - POSIX：`tar -xzf`
   - Windows：PowerShell `Expand-Archive`
4. `chmod 0755` 后原子 rename 到缓存目录；再次运行 `--version` 验证。
5. 代理：尊重 `HTTPS_PROXY`/`HTTP_PROXY`；若 Node fetch 不自动代理，加 `undici` 的 `ProxyAgent` 或文档化 `DSH_OC_OPENCODE_MIRROR` 镜像 URL。
6. 下载失败时打印明确指引：
   - 设置 `DSH_OC_OPENCODE_BIN`
   - 或 `dsh plugin --profile oc add opencode-ai@1.18.18`
   - 或手动下载 asset 放入缓存路径。

### 8.4 启动

```text
spawn(opencodeBin, ['attach', bridgeUrl, ...tuiArgs], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: childEnv,
})
```

- `tuiArgs` 只传 `attach` 支持的参数：`--continue`、`--session`、`--fork`、`--dir`、`--mini`（P0 可先只支持 `--continue/--session/--dir`）。
- 对 `attach` 不支持的参数（如 `--model`、`--prompt`）打印警告并忽略，禁止静默丢弃。
- `childEnv`：
  - 继承 `process.env`
  - `OPENCODE_CONFIG_DIR=$DSH_HOME/opencode/config`
  - `XDG_DATA_HOME=$DSH_HOME/opencode/data`
  - `XDG_STATE_HOME=$DSH_HOME/opencode/state`
  - `XDG_CACHE_HOME=$DSH_HOME/opencode/cache`
  - **不要设置** `OPENCODE_CONFIG_CONTENT` 来配置 DeepSeek provider/key；模型与凭据由 dsh 后端处理。

### 8.5 信号与退出

- 插件通过 `ctx.cmdlineArgs` 读取参数，通过 `ctx.appExit(code)` 退出。
- spawn 成功后：
  - 子进程持有终端 raw mode；
  - 父进程收到 SIGINT/SIGTERM 时转发给子进程，不在子进程退出前强杀；
  - 子进程退出后调用 `ctx.appExit(childExitCode)`。
- 插件 dispose 时子进程仍存活：SIGTERM → 5s → SIGKILL。
- 需要 PTY e2e 验证终端恢复（alternate screen、cursor、raw mode 复位）。

---

## 9. 测试策略

### 9.1 单元测试

| 模块 | 覆盖点 |
|---|---|
| `convert/session.ts` | SessionSummary → Session 全字段 |
| `convert/message.ts` | user/assistant/tool event 折叠、compaction replace、空历史 |
| `convert/tool.ts` | pending/running/completed/error 四态 |
| `convert/model.ts` | provider/model 映射、缺失字段默认值 |
| `convert/permission.ts` | id 映射、once/reject/always 语义 |
| `convert/question.ts` | 多问题顺序、multiSelect、custom |
| `bridge/router.ts` | 每个核心路由 200/错误/空数据 |
| `bridge/events.ts` | mux frame → SSE 事件全集 |
| `tui/platform.ts` | linux musl/AVX2、darwin、windows 选择 |
| `tui/binary.ts` | 优先级顺序、缓存命中、自愈、下载失败 |

### 9.2 协议回归

- 用 `docs/PROTOCOL.md` 中的方法重新录 fixture。
- 启动一个 mock oc-bridge，运行官方 `opencode attach`，断言：
  - TUI 进入全屏；
  - 所有 `GET` 得到 200 且 schema 合法；
  - 没有 TUI 侧 unhandled 错误日志。

### 9.3 DSH 后端 e2e

- 复用 dsh 测试基础设施，挂载 mock LLM（`@deepseek-ai/dsh-llm-mock-server` 或本地 HTTP mock）。
- 通过 oc-bridge 的 HTTP API 直接测试：
  - create session → prompt → 读 history → 消息/工具卡正确
  - cancel/steer
  - approval/question 全流程
- 通过 PTY 跑 `dsh --profile oc`，模拟按键：
  - 新建会话
  - 输入 prompt
  - 等待 DSH Agent 回复
  - 退出并确认终端恢复

---

## 10. 实施阶段与验收门

### P0：协议探针与最小 mock（目标：官方 attach 能稳定启动）

交付：
- `docs/PROTOCOL.md` 更新（含 fixture 生成脚本）
- `src/bridge/stubs.ts` 覆盖探针发现的全部启动路由
- `tests/e2e/attach-boot.e2e.ts`

验收：
- `opencode attach http://127.0.0.1:<mock>` 进入 TUI
- 所有启动请求 200 且 schema 合法
- 无未捕获异常

### P1：核心会话通路（目标：TUI 能操作 dsh session）

交付：
- dsh-oc bundle patch 挂载 workspace/directory-picker/api-proxy
- oc-bridge 核心 `/session*`、`/api/session*`、`/global/event`
- convert session/message/tool
- oc-tui binary resolver + spawn + signal

验收：
- `dsh --profile oc` 启动
- TUI 新建会话
- 发送 prompt 后 DSH Agent 执行（用 mock LLM）
- 文本、reasoning、tool card 在 TUI 中实时出现
- 会话列表与历史 resume 正确

### P2：交互与模型（目标：完整人机闭环）

交付：
- permission/question 双向映射与 SSE
- model/provider 列表与 model 选择回写
- todo/diff 映射
- 错误映射

验收：
- bash 工具触发 approval，TUI 弹权限，allow once/reject 生效
- `ask_user_question` 在 TUI 弹窗，答案回到 DSH
- 模型选择器显示 DSH 目录，切换后 DSH 用新模型

### P3：外围路由与硬化（目标：无明显 UI 破窗）

交付：
- command/skill/file-search/vcs 等 map 或合法 stub
- 下载缓存、镜像、代理
- Windows/macOS 基础验证（至少 binary resolver + attach boot）

验收：
- 全部探针路由返回 200/501 且 schema 合法
- TUI 各主要菜单不崩
- 断网缓存命中可启动
- 协议回归通过

### P4：发布

交付：
- README 安装/使用/限制
- `opencode-assets.json` 生成脚本
- npm publish dry-run / CI

验收：
- 新环境按 README 三步可运行
- `dsh plugin --profile oc add .` 成功写入 bundle 列表

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| opencode TUI 同时依赖 v1/v2，协议细节多 | P0 用真实二进制录 fixture；核心路由共享实现；每版跑回归 |
| DSH 与 opencode 消息模型差异导致渲染丢失 | 以 DSH `history` 的 event+view 为准，SSE 发完整 message 而非精细 delta |
| `always` 权限无 DSH 等价 | 首版降级为 `once` 并明示；后续评估 DSH 权限预设扩展 |
| opencode 二进制升级破坏 attach 路由 | 版本精确锁定，升级必须过协议回归 |
| 下载源不可达 | 缓存优先；支持 mirror；支持用户预装 `opencode-ai` |
| dsh RPC 错误未正确映射导致 TUI 崩溃 | 统一错误信封 + schema fixture 测试 |
| 终端 raw mode 恢复失败 | PTY e2e 必须覆盖正常退出、信号退出、超时强杀 |

---

## 12. Definition of Done

首版完成的判据：

1. `dsh plugin --profile oc add @deepseek-ai/dsh-oc` 后 `dsh --profile oc` 可启动官方 opencode TUI。
2. TUI 只连接 dsh-oc bridge；不出现 opencode 本地 server/agent 路径。
3. 会话创建、列表、历史、prompt、cancel 全部由 dsh 执行，TUI 正确渲染。
4. approval、ask_user_question、模型选择在 TUI 中可操作并回写 dsh。
5. opencode 二进制来自官方发布物，版本与 sha256 校验。
6. 核心 PTY e2e 与协议回归通过。
7. 未实现路由的行为在 `docs/PROTOCOL.md` 中有明确说明。
8. README 说明安装、参数透传限制、会话/数据隔离、与 dsh-web 的差异。

---

## 13. 参考材料

- `docs/PROTOCOL.md`：探针结果、路由分类、fixture 方法
- opencode 源码（开发时 clone 到 `../opencode`）：
  - `packages/tui/src/context/{sdk,sync,data}.tsx`
  - `packages/tui/src/component/prompt/index.tsx`
  - `packages/opencode/src/cli/cmd/attach.ts`
  - `packages/opencode/src/server/routes/instance/httpapi/`
  - `packages/sdk/openapi.json`
  - `packages/opencode/script/postinstall.mjs`
- dsh 源码（开发时 clone 到 `../deepseek-harness`）：
  - `packages/host/apiproxy/src/api-proxy.ts`
  - `packages/host/apiproxy/src/api/{sessions,events,llm,approvals,questions}.ts`
  - `packages/core/session/src/types.ts`
  - `packages/core/agent/src/index.ts`
  - `packages/bundle/{base,web-app}/cordis.patch.yml`
  - `apps/cli/src/{args,profile-boot,plugin}.ts`

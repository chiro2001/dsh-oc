# OpenCode TUI 协议探针与兼容矩阵

> 本文件是 `PLAN.md` 的配套文档。执行 P0 前必须先读本文件。
> 功能状态入口：先读 [FEATURES.md](FEATURES.md)，再回到本文件核对路由/协议细节。
> 探针基准：`opencode-ai@1.18.18`（GitHub Release `v1.18.18`，commit `4643e65`）。

---

## 1. 为什么需要兼容 v1 和 v2

官方 TUI 当前同时使用两代 API：

- `packages/tui/src/context/sync.tsx` 使用 `@opencode-ai/sdk/v2` 的 client，但调用的是 **v1 路径**：`/session`、`/config`、`/provider` 等。
- `packages/tui/src/context/data.tsx` 调用 **v2 路径**：`/api/location`、`/api/session/{id}`、`/api/permission` 等。
- `packages/tui/src/routes/session/*` 与 `component/prompt/index.tsx` 的交互（permission/question 回复、session create/prompt）也走 **v1 路径**。

因此 dsh-oc bridge 必须同时暴露两套前缀，共享同一实现。

---

## 2. 探针方法（可复现）

### 2.1 准备

```bash
# 安装官方二进制
npm pack opencode-ai@1.18.18
# 或者直接解包 node_modules/opencode-ai/bin/opencode.exe

# clone opencode 源码用于对照
git clone --depth 50 https://github.com/anomalyco/opencode.git ../opencode
git -C ../opencode checkout 4643e65
```

### 2.2 记录 TUI 启动请求

```bash
# 1. 启动真实 opencode server（只用于录协议，不是 dsh-oc 运行时）
DEEPSEEK_API_KEY=test \
OPENCODE_CONFIG_CONTENT='{"provider":{"deepseek":{"options":{"baseURL":"http://127.0.0.1:19876","apiKey":"test-key"}}},"enabled_providers":["deepseek"],"model":"deepseek/deepseek-chat","autoupdate":false,"share":"disabled"}' \
opencode serve --port 4097

# 2. 启动日志代理：19877 -> 127.0.0.1:4097，打印 method/url/headers/status
node tools/log-proxy.mjs

# 3. PTY 中启动 attach
script -qec "opencode attach http://127.0.0.1:19877" /dev/null

# 4. 抓取 /global/event SSE 与各响应 body，存为 tests/fixtures/opencode/
```

### 2.3 抓取 schema

权威 schema 来源：

- `../opencode/packages/sdk/openapi.json`
- `../opencode/packages/sdk/js/src/v2/gen/types.gen.ts`（生成后）
- npm 包 `@opencode-ai/sdk@1.18.18` 的 `dist/**/*.d.ts`

---

## 3. 实测启动路由清单（P0 必须全部响应）

`opencode attach` 启动阶段真实请求（记录于 2026-08-15，TTY 环境）：

```text
GET /path
GET /project/current
GET /config/providers
GET /provider
GET /experimental/capabilities
GET /experimental/console
GET /agent
GET /config
GET /global/event                       # SSE 长连接
GET /project/global/directories
GET /session?start=...&path=...
GET /api/location
GET /api/agent
GET /api/integration
GET /api/model
GET /api/provider
GET /api/reference
GET /api/command
GET /api/skill
GET /command
GET /lsp
GET /mcp
GET /experimental/resource
GET /formatter
GET /session/status
GET /provider/auth
GET /vcs
GET /experimental/workspace
GET /experimental/workspace/status
GET /api/model?location[directory]=...
GET /api/provider?location[directory]=...
GET /api/reference
GET /api/integration?location[directory]=...
```

> 不同目录/工作区模式下还会重复请求 `/api/model`、`/api/provider` 若干次。实现必须幂等。

---

## 4. 路由分类

图例：

- **MAP**：必须翻译到 dsh 服务。
- **STUB**：返回 schema-valid 空数据。
- **LATER**：首版可 501/空，但记录在测试中。

### 4.1 v1 路由

| 路由 | 分类 | dsh 数据源 / stub 形状 |
|---|---|---|
| `GET /path` | MAP | cwd、worktree、directory |
| `GET /project/current` | STUB | 单项目对象 |
| `GET /project/global/directories` | STUB | `[]` |
| `GET /config` | STUB | `{}` |
| `GET /config/providers` | STUB | `[]` 或从 `apiProxy.llm.providers` 转 |
| `GET /provider` | MAP | `apiProxy.llm.models` |
| `GET /provider/auth` | STUB | `{}` |
| `GET /agent` | STUB/MAP | 首版 `[]` |
| `GET /command` | MAP | 注册 `/preset`、`/goal`、`/help`（TUI slash 弹层） |
| `GET /session` | MAP | `apiProxy.sessions.list` |
| `GET /session/status` | MAP | list 的 running 状态 |
| `POST /session` | MAP | `apiProxy.sessions.create` |
| `POST /session/{id}/fork` | MAP | `apiProxy.sessions.fork`（opencode `messageID` 换算为 dsh `atSeq`） |
| `POST /session/{id}/summarize` | MAP | dsh `/compact` command registry（TUI `/compact` 实际调用此路由） |
| `POST /session/{id}/compact` | MAP | 同上（v1 兼容别名） |
| `POST /session/{id}/command` | MAP | `/preset`、`/goal`（dsh command registry）、`/help`（bridge 本地） |
| `GET /session/{id}` | MAP | history + summary |
| `PATCH /session/{id}` | MAP | `apiProxy.sessions.rename` |
| `GET /session/{id}/message` | MAP | `apiProxy.sessions.history` |
| `GET /session/{id}/message/{messageID}` | MAP | 复用 v1 转换，按 `info.id` 单条查询；未找到 404 |
| `POST /session/{id}/prompt` | MAP | `apiProxy.sessions.prompt` |
| `POST /session/{id}/abort` | MAP | `apiProxy.sessions.cancel` |
| `POST /session/{id}/init` | MAP | no-op 成功 `true`（dsh 会话创建即初始化） |
| `GET /session/{id}/todo` | MAP | dsh `todos` projection + `goal` 投影/事件（goal 为首条） |
| `GET /session/{id}/diff` | MAP/LATER | produced-files 投影或 `[]` |
| `GET /permission` | MAP | pending approval map |
| `POST /permission/{id}/reply` | MAP | `apiProxy.respond` |
| `POST /session/{id}/permissions/{permissionID}` | MAP | SDK v2 权限回复别名（body `response`：once/always/reject），同 `permissionReply` |
| `GET /question` | MAP | pending question map |
| `POST /question/{id}/reply` | MAP | `apiProxy.respond` |
| `POST /question/{id}/reject` | MAP | `apiProxy.respond` cancelled |
| `GET /global/event` | MAP | `apiProxy.events.mux` + SSE |
| `GET /lsp` | STUB | `[]` |
| `GET /mcp` | STUB | `{}` |
| `GET /formatter` | STUB | `[]` |
| `GET /experimental/resource` | STUB | `[]` |
| `GET /experimental/console` | STUB | `{ consoleManagedProviders: [], switchableOrgCount: 0 }` |
| `GET /experimental/capabilities` | MAP | `{ backgroundSubagents: true }`（dsh 后台子代理真实可用） |
| `POST /experimental/session/{id}/background` | MAP | no-op 成功 `true`（dsh 会话服务端常驻） |
| `GET /vcs` | STUB | `{ branch: '', status: [] }` 或空形状 |
| `GET /experimental/workspace` | STUB | `[]` |
| `GET /experimental/workspace/status` | STUB | 空状态 |
| 其他未列路由 | LATER | 501 或 schema-valid 空响应 |

### 4.2 v2 `/api` 路由

| 路由 | 分类 | dsh 数据源 / stub 形状 |
|---|---|---|
| `GET /api/location` | MAP | `{ directory: cwd }` |
| `GET /api/health` | MAP | `{ healthy: true }`（客户端探活） |
| `GET /api/agent` | STUB/LATER | `[]` |
| `GET /api/integration` | STUB | `[]` |
| `GET /api/model` | MAP | `apiProxy.llm.models` |
| `GET /api/provider` | MAP | `apiProxy.llm.models/providers` |
| `GET /api/reference` | STUB | `[]` |
| `GET /api/command` | MAP | 注册 `/preset`、`/goal`、`/help` |
| `GET /api/skill` | STUB/LATER | `[]` |
| `GET /api/session` | MAP | 同 v1 |
| `GET /experimental/session` | MAP | GlobalSession 列表（搜索/目录过滤/limit 子集，复用 `convertSessionSummary`） |
| `POST /api/session` | MAP | 同 v1 |
| `POST /api/session/{id}/fork` | MAP | 同 v1 fork，返回 v2 信封 |
| `POST /api/session/{id}/compact` | MAP | 同 v1 summarize/compact（SDK v2 路由，204） |
| `POST /api/session/{id}/interrupt` | MAP | 同 v1 abort：`apiProxy.sessions.cancel`（SDK v2 打断入口，204） |
| `POST /session/{id}/command` | MAP | `/preset`、`/goal` 经 dsh command registry 执行并广播 busy/idle；`/help` 本地返回能力摘要 |
| `GET /session/{id}/children` | MAP | 会话列表中 `parentSessionId == id` 的 subagent 子会话（`convertSessionSummary`） |
| `GET /api/session/{id}` | MAP | 同 v1 |
| `GET /api/session/{id}/message` | MAP | 同 v1 |
| `GET /api/session/{id}/permission` | MAP | pending approvals per session |
| `POST /api/session/{id}/permission/{rid}/reply` | MAP | `apiProxy.respond` |
| `GET /api/session/{id}/question` | MAP | pending questions per session |
| `POST /api/session/{id}/question/{rid}/reply` | MAP | `apiProxy.respond` |
| `POST /api/session/{id}/question/{rid}/reject` | MAP | `apiProxy.respond` cancelled |
| `GET /api/permission/saved` | STUB | `[]` |
| 其他未列路由 | LATER | 501 或 schema-valid 空响应 |

---

## 5. SSE 事件映射表

DSH `apiProxy.events.mux()` 产出 `MuxFrame`，oc-bridge 翻译为 opencode `GlobalEvent`。

| DSH mux frame | opencode GlobalEvent |
|---|---|
| `session/event: session/created` | `session.created`（properties.sessionID, info=Session） |
| `session/event: session/title` | `session.updated` |
| `session/event: turn/start` | `session.status`（busy） |
| `session/event: turn/end` | `session.status`（idle） + `session.idle` |
| `session/event: user/message` | 重建 Session 后发 `message.updated` |
| `session/event: assistant/message` | `message.updated` + `message.part.updated` |
| `session/event: assistant/chunk (tool-call-delta)` | `session.next.tool.input.started/delta/ended` + v1 ToolPart 增量（节流合并） |
| `session/event: tool/call` | `session.next.tool.called` + `progress` + `message.part.updated`（ToolPart pending） |
| `session/event: tool/result` | `session.next.tool.success/failed` + `message.part.updated`（ToolPart completed/error） |
| `session/event: todo/write` | `todo.updated` |
| `session/event: goal/change` | `todo.updated`（合并 goal 为首条） |
| `session/event: approval/asked` | `permission.asked` |
| `session/event: approval/decided` | `permission.replied` |
| `approval/requested` | `permission.asked` |
| `approval/resolved` | `permission.replied` |
| `question/requested` | `question.asked` |
| `question/resolved` | `question.replied` / `question.rejected` |
| `session/projection: todos` | `todo.updated` |
| `session/projection: goal` | `todo.updated`（合并 goal 为首条） |
| `session/projection: produced-files` | `session.diff` |
| `session/queue`, `session/jobs` | P1 忽略；P3 再评估 |

> **已知行为（文本 delta 成对重复）**：dsh 0.1.0-rc.6 对同一段流式文本同时下发
> `assistant/chunk`（text-delta）与 packed `text-chunks` 两种编码，且新 mux 订阅
> 会先重放历史再进入实时，因此 bridge 的 `message.part.delta` 可能把同一字符发送
> 两次（两种编码分块/偏移不同，无法无损合并）。opencode 1.18.18 TUI 以最终
> `message.updated` 的全量文本为准，实测渲染正常、无重复；`e2e-tui-abort.sh` 的
> v2 段按“新 SSE 流出现 delta”检测，不依赖 delta 文本连续性。

GlobalEvent 必需字段：

```ts
{
  directory: string,
  project?: string,
  workspace?: string,
  payload: { id: string, type: ..., properties: ... }
}
```

---

## 6. opencode 关键类型位置

以下类型是实现 `convert/*` 的权威依据：

```text
@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:
  Session, Message, UserMessage, AssistantMessage,
  Part, TextPart, ReasoningPart, FilePart, ToolPart, ToolState,
  StepStartPart, StepFinishPart, Provider, Model, ModelRef,
  Agent, Command, Todo, SessionStatus,
  PermissionRequest, PermissionV2Reply,
  QuestionRequest, QuestionInfo, QuestionAnswer,
  GlobalEvent
```

dsh 类型位置：

```text
deepseek-harness/packages/core/session/src/types.ts:
  SessionEvent, SessionEventMap, SurfaceOp, UserMessage, AssistantMessage
deepseek-harness/packages/host/apiproxy/src/api/:
  sessions.ts, events.ts, llm.ts, approvals.ts, questions.ts, rpc.ts
deepseek-harness/packages/host/apiproxy/src/api-proxy.ts:
  createApiProxy / ApiProxyService
```

---

## 7. opencode asset manifest 生成

`opencode-assets.json` 结构：

```json
{
  "version": "1.18.18",
  "assets": {
    "linux-x64": {
      "platform": { "os": "linux", "arch": "x64", "baseline": false, "musl": false },
      "npm": "opencode-linux-x64",
      "npmIntegrity": "sha512-...",
      "url": "https://github.com/anomalyco/opencode/releases/download/v1.18.18/opencode-linux-x64.tar.gz",
      "sha256": "0cddc222418b8553669905a8980c0cda7088f00da24d83d6ac76b01c9fdb2aaf",
      "size": 60386126
    }
  }
}
```

生成命令：

```bash
gh api repos/anomalyco/opencode/releases/tags/v1.18.18 \
  --jq '[.assets[] | select(.name | test("^opencode-(linux|darwin|windows)-(x64|arm64)(-baseline)?(-musl)?\\.(tar\\.gz|zip)$")) | {name, digest, size, browser_download_url}]'
```

- 将 `digest` 的 `sha256:` 前缀去掉写入 manifest。
- `platform` 记录该 key 的 os/arch/baseline/musl；`npm` 是对应官方 npm 平台包名，
  `npmIntegrity` 是 npm registry 的 tarball sha512，由包管理器在安装时校验。
- 必须覆盖以下平台：
  - `linux-x64`、`linux-x64-baseline`、`linux-x64-musl`、`linux-x64-baseline-musl`
  - `linux-arm64`、`linux-arm64-musl`
  - `darwin-x64`、`darwin-x64-baseline`、`darwin-arm64`
  - `windows-x64`、`windows-x64-baseline`、`windows-arm64`

### 7.1 多 arch 二进制分发

`src/tui/binary.ts` 的优先级（详细见 README 与 FEATURES.md）：

```text
env DSH_OC_OPENCODE_BIN → 版本化缓存 → PATH → 官方 npm 平台包
  → profile 内 opencode-ai 包 → GitHub Release（per-platform sha256）
```

官方 npm 平台包安装到 `$DSH_HOME/opencode/packages/<platform-key>`，候选顺序与
官方 `postinstall.mjs` 的 platform/arch/musl/AVX2 选择一致；GitHub asset 只作为
fallback，且每个平台使用各自 manifest 条目独立校验，不是全局单一 hash。

---

## 8. 已知协议限制（首版）

1. **`always` 权限降级**：opencode TUI 提供 `Allow always`，dsh approval 只有 `allowed-once / rejected`。首版将 `always` 映射为 `allowed-once`，并在 TUI 外日志中提示。后续若 dsh 增加持久权限预设，再改回真 `always`。
2. **attach 参数受限**：`opencode attach` 只接受 `--continue/--session/--fork/--dir/--mini/--password/--username`。`dsh --profile oc --model X` 等参数首版打印警告并忽略；模型切换走 TUI 内模型选择器。
3. **文件附件**：`file` part 支持文本（data URL / cwd 内本地文件）与图片（data URL），映射为 dsh `text`/`image` part；PDF 等二进制附件返回 400。
4. **session diff**：无 produced-files 投影时返回 `[]`，不伪造 diff。
5. **opencode v1/v2 双协议**：任何升级必须重新跑第 2 节探针并更新本文件。

## 9. e2e 实测实现状态（2026-08-15）

下列状态来自 `chore-release` 分支 profile-fix 之后的真实 e2e（mock LLM +
dsh 0.1.0-rc.6 + opencode 1.18.18，TUI 与 bridge 均实际跑通）：

| 路由/能力 | 状态 | 备注 |
|---|---|---|
| §3 启动 GET 矩阵（31 条，含带 query 的 `/session`、`/api/model?location[...]` 等） | 200 + JSON | 全部经 curl+jq 断言 |
| `GET /global/event` | 200 SSE | `retry: 3000` 首帧；每帧含 `directory` |
| `GET /agent`、`GET /api/agent` | MAP | 首版返回单个 `build` 主 agent（含 `model`），否则 TUI prompt 无法提交 |
| `POST /session/{id}/message` | MAP | opencode SDK v1 实际 prompt 路由 |
| `POST /session/{id}/fork`、`POST /api/session/{id}/fork` | MAP | dsh fork；child session 的 `parentID` 正确 |
| `POST /session/{id}/summarize`、`POST /session/{id}/compact`、`POST /api/session/{id}/compact` | MAP | TUI `/compact` 走 summarize 路由，经 dsh command registry 执行 `/compact` |
| `GET /session`、`GET /api/session` | MAP | child session 输出 `parentID`；subagent 带 `metadata.origin` 与标题标识 |
| `POST /session/{id}/prompt` | 别名 | 官方 SDK 无此路由；dsh-oc 提供 v1 兼容别名（e2e 矩阵使用） |
| `POST /api/session/{id}/prompt` | MAP | opencode SDK v2 官方路由，返回 `{ data: SessionInputAdmitted }` |
| `GET /provider` | MAP | 返回 `ProviderListResponse` 对象 `{ all, default, connected }`（协议对象，非裸数组） |
| `GET /api/model` | MAP | 返回 `{ location, data: ModelV2Info[] }`（协议对象，非裸数组） |
| `GET /permission` + `POST /permission/{id}/reply` | MAP | 需保持至少一个 SSE 连接（与真实 TUI 一致）才能收到 mux approval 帧 |
| `GET /session/{id}/todo` + `goal/change` | MAP | goal 与 todos 合并（goal 首条）；`scripts/e2e-api-goal.sh` |
| `POST /session/{id}/command` `/goal` | MAP | 创建/查看 goal；真实 TUI sidebar 可见（`scripts/e2e-tui-goal.sh`） |
| `DSH_PERMISSION_MODE=ask` | 不支持 | dsh 只接受 `read-only`/`workspace-write`/`danger-full-access`；approval=ask 用 `workspace-write` |
| oc profile 宿主行 | 已并入 bundle patch | `storage`/`storage-json`/`storage-domain`/`webserver` 已由 `cordis.patch.yml` 挂载；`dsh --profile oc` 直接启动（无需宿主 overlay） |
| `--print-logs` | 透传 | oc-tui 已把 `--print-logs` 传给 `opencode attach`（opencode 顶层全局选项，设置 `OPENCODE_PRINT_LOGS=1`） |
| 时间戳 | 默认开启 | `DSH_OC_TUI_TIMESTAMPS=1` 写入 `kv.json` 的 `timestamps: show` 并绑定 `ctrl+shift+t` / `/timestamps`；e2e 见 `scripts/e2e-tui-timestamps.sh` |
| tarball 安装 e2e | PASSED | `DSH_OC_E2E_ADD_SPEC=<tgz>` 下 `e2e-api.sh` / `e2e-tui-boot.sh` / `e2e-tui-turn.sh` / `e2e-tui-timestamps.sh` 全部通过；profile 安装的是 npm tarball，不再使用本地路径 |

---

## 10. 自动化协议探针

`scripts/probe-opencode.mjs` 对照 `tests/fixtures/opencode/routes.json`
（本文件 §3/§4 的 TUI 真实请求清单）检查 oc-bridge 是否注册了全部路由，并校验
opencode 二进制与 `@opencode-ai/sdk` 的版本锁定：

```bash
pnpm run probe
node scripts/probe-opencode.mjs --version 1.18.18 --bin /path/to/opencode \
  --out .e2e/protocol-probe.json
```

输出：缺失路由（`FAIL missing-route` + 修复建议）、二进制/SDK 版本不匹配；
全绿时退出码 0 并打印 `PASSED`。升级 opencode 的流程：

1. 更新 `opencode-version.json`；
2. `node scripts/update-opencode-assets.mjs` 重新生成 asset manifest；
3. `pnpm install`（SDK 版本）后运行 `pnpm run probe`；
4. 按探针结果补齐路由或 stub，并更新本文件的兼容矩阵。

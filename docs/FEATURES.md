# dsh-oc 功能支持矩阵

> 状态图例：✅ 已支持；🟡 部分支持/有限制；❌ 未实现或仅 stub。
> 本文件是功能状态入口；路由/协议细节见 [PROTOCOL.md](PROTOCOL.md)。
> 运行 `pnpm run features:update` 可刷新文末“自动追踪”部分，手动状态矩阵保留。

## 下一阶段

> 下一阶段需求见 [ROADMAP.md](ROADMAP.md)：自动更新关闭、流式 tool progress、goal、性能测试、协议升级探针、README//help 能力矩阵。

## 1. 模型

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| Provider / 模型目录展示（v1 + v2） | ✅ | `GET /provider`、`GET /api/model`、`src/bridge/convert/model.ts` | `tests/convert/model.spec.ts`、`scripts/e2e-api.sh` | `f30b156` |
| 默认 build agent 携带可用模型 | ✅ | `GET /agent`、`GET /api/agent`、`src/bridge/router.ts` | `tests/bridge-router.spec.ts` | `f30b156` |
| 模型选择器回写 dsh（`/api/session/:id/model`） | ✅ | `POST /api/session/:sessionID/model`、`POST /session/:id/message` body model | `tests/bridge-router.spec.ts`、`e2e-api.sh` | 本提交 |
| Reasoning effort / variant 展示与切换 | ✅ | `Model.variants`、`ModelV2Info.variants`、session model `variant` | `tests/convert/model.spec.ts`、TUI `ctrl+t` | 本提交 |
| dsh agent preset 展示与切换（minimal 等） | ✅ | `GET /agent`、`GET /api/agent`、`POST /api/session/:sessionID/agent`、`POST /session/:id/command` `/preset` | `tests/bridge-router.spec.ts`；隔离 profile 无 minimal 时仅 build | 本提交 |
| 模型/Provider 错误映射 | ✅ | `src/bridge/errors.ts`、`src/bridge/rpc.ts` | `tests/bridge-router.spec.ts`（404/409/400/501） | `f30b156` |

## 2. 会话

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 会话列表 / 状态 | ✅ | `GET /session`、`GET /session/status`、`GET /api/session` | `tests/bridge-router.spec.ts`、`e2e-api.sh` | `f30b156` |
| 新建 / 重命名 / 历史 / 消息 | ✅ | `POST /session`、`PATCH /session/:id`、`GET /session/:id/message` 等 | `tests/bridge-router.spec.ts`、`e2e-tui-turn.sh` | `f30b156` |
| Prompt（v1 message、v1 alias、v2 prompt） | ✅ | `POST /session/:id/message`、`POST /session/:id/prompt`、`POST /api/session/:sessionID/prompt` | `e2e-api.sh`、`e2e-tui-turn.sh` | `f30b156` |
| Abort / cancel | ✅ | `POST /session/:id/abort` | `e2e-api.sh` | `f30b156` |
| Fork（`parentID`） | ✅ | `POST /session/:id/fork`、`POST /api/session/:id/fork`，messageID→atSeq | `tests/bridge-router.spec.ts`、`e2e-api.sh` | 本提交 |
| Todo 投影 | ✅ | `GET /session/:id/todo`、`src/bridge/convert/todo.ts` | `tests/convert/todo.spec.ts`、`tests/bridge-router.spec.ts` | `f30b156` |
| Diff / produced-files / Modified Files | ✅ | `GET /session/:id/diff`、`GET /api/session/:id/diff`、`session.diff` + Snapshot/Patch part | `tests/bridge-router.spec.ts`、`e2e-tui-tools.sh` | 本提交 |
| SSE 会话/消息事件 | ✅ | `GET /global/event`、`src/bridge/events.ts` | `tests/bridge-events.spec.ts`、`e2e-api.sh`、`e2e-tui-stream.sh` | `f30b156` |

## 3. 工具

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| Tool call / result 四态映射 | ✅ | `src/bridge/convert/tool.ts`、`src/bridge/events.ts` | `tests/convert/tool.spec.ts`、`e2e-tui-turn.sh` | `f30b156` |
| 工具参数流式（`tool-call-delta` → input.started/delta/ended + v1 ToolPart 增量） | ✅ | `src/bridge/events.ts` `startToolInput`/`queueToolDelta`/`flushToolDelta` | `tests/bridge-events.spec.ts`、`scripts/e2e-api.sh` | 本提交 |
| v2 tool 生命周期（called/progress/success/failed） | ✅ | `src/bridge/events.ts` `endToolInput`/`completeToolInputImmediately` | `tests/bridge-events.spec.ts`、`scripts/e2e-api.sh` | 本提交 |
| 高频 chunk 节流/批处理 | ✅ | `MuxEventTranslator` `toolFlushMs` + 合并 pending delta | `tests/bridge-events.spec.ts`（fake timer） | 本提交 |
| bash/pwsh 实时输出 progress | 🟡 | dsh 0.1.0-rc.6 无实时输出帧；参数流式已实时，输出仅在 result 时可见 | `docs/PROTOCOL.md`、`tests/bridge-events.spec.ts` | 本提交 |
| 工具执行由 dsh 后端完成 | ✅ | `ctx.apiProxy.sessions.prompt`、dsh tool 注册表 | `e2e-api.sh`（bash 工具） | `f30b156` |
| read/write/edit 文件变化展示 | ✅ | tool result → ToolPart metadata/diff + `session.diff` + Modified Files | `tests/convert/tool.spec.ts`、`e2e-tui-tools.sh` | 本提交 |
| dsh 多种编辑模式映射（view/create/str_replace/insert/undo_edit） | ✅ | `src/bridge/convert/tool.ts` 映射为 read/edit 卡片并保留 mode | `tests/convert/tool.spec.ts`、`e2e-tui-tools.sh` | 本提交 |
| 文本附件/文件 part | 🟡 | `src/bridge/router.ts` 仅接受 `data:` image part | `tests/bridge-router.spec.ts`（400 拒绝未知 part） | `f30b156` |
| MCP / LSP / formatter 等外围工具 | ❌ | `src/bridge/stubs.ts` 返回 schema-valid 空数据 | `e2e-api.sh` 路由矩阵 | `f30b156` |

## 4. 权限

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| Permission ask / once / reject | ✅ | `GET /permission`、`POST /permission/:id/reply`、v2 对偶路由 | `tests/convert/permission.spec.ts`、`e2e-api.sh` | `f30b156` |
| “Always” 降级为 once | 🟡 | `src/bridge/router.ts` `permissionReply` | `tests/bridge-router.spec.ts`（degrade always） | `f30b156` |
| Saved permissions | ❌ | `GET /api/permission/saved` 返回 `[]` | `tests/bridge-router.spec.ts` | `f30b156` |

## 5. 子代理

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 主 agent（build）展示 | ✅ | `GET /agent`、`GET /api/agent`、`src/bridge/router.ts` | `tests/bridge-router.spec.ts` | `f30b156` |
| Background subagents | ❌ | `GET /experimental/capabilities` 返回 `{ backgroundSubagents: false }` | `e2e-api.sh` | `f30b156` |
| 子代理会话树 / parent-child 渲染 | ✅ | `Session.parentID`、child cwd/parent 继承、child 历史复用 | `tests/convert/session.spec.ts`、`e2e-api.sh` fork lineage | 本提交 |

## 6. 命令

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 命令列表 | ✅ | `GET /command`、`GET /api/command` 注册 `/preset` | `e2e-api.sh`、`tests/bridge-router.spec.ts` | 本提交 |
| `/compact` / summarize | ✅ | `POST /session/:id/summarize`、`POST /session/:id/compact`、`POST /api/session/:id/compact` | `e2e-api.sh`、`tests/bridge-router.spec.ts` | 本提交 |
| Skills / references / integrations | ❌ | `GET /skill`、`GET /api/skill`、`GET /reference`、`GET /integration` 等返回 `[]` | `e2e-api.sh` | `f30b156` |

## 7. TUI

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| `opencode attach` 启动/退出/信号转发 | ✅ | `src/tui/index.ts` `startOpenCodeTui` | `tests/tui/index.spec.ts`、`e2e-tui-boot.sh` | `f30b156` |
| attach 参数过滤（`--session/--dir/--mini/--print-logs/...`） | ✅ | `src/tui/index.ts` `filterSupportedArgs` | `tests/tui/index.spec.ts` | `f30b156` |
| 数据隔离（config/data/state/cache 在 `$DSH_HOME/opencode`） | ✅ | `src/tui/index.ts` `buildChildEnv` | `tests/tui/index.spec.ts` | `f30b156` |
| 消息时间戳默认开启 | ✅ | `DSH_OC_TUI_TIMESTAMPS=1` → `kv.json` `timestamps: show` + `tui.json` 快捷键 | `tests/tui/index.spec.ts`、`scripts/e2e-tui-timestamps.sh` | 本提交 |
| 时间戳运行时切换 | ✅ | `tui.json` 绑定 `session_toggle_timestamps` / `messages_toggle_timestamps` 为 `ctrl+shift+t`，也可用 `/timestamps` | 手工 TUI 验证 | 本提交 |
| 二进制版本校验（`--version` 精确匹配 + 显式覆盖报错） | ✅ | `src/tui/binary.ts` `parseOpenCodeVersion`/`verifyOpenCodeVersion` | `tests/tui/binary.spec.ts`、`scripts/e2e-tui-version-lock.sh` | 本提交 |
| 自动更新/热更新关闭 | ✅ | `OPENCODE_DISABLE_AUTOUPDATE=1` + 隔离配置 `autoupdate: false` | `tests/tui/index.spec.ts`、`scripts/e2e-tui-offline.sh` | 本提交 |
| 后台外网行为关闭（models fetch / LSP download） | ✅ | `OPENCODE_DISABLE_MODELS_FETCH=1`、`OPENCODE_DISABLE_LSP_DOWNLOAD=1` | `tests/tui/index.spec.ts` | 本提交 |
| `dsh --profile oc --help` 能力摘要 | ✅ | `src/tui/index.ts` `ocHelp`/`helpRequested` | `tests/tui/index.spec.ts`、`scripts/e2e-tui-help.sh` | 本提交 |
| DSH OC 品牌启动 logo（替换 OpenCode 字符画） | ✅ | `tui-branding/` TUI 插件（figlet 生成，`scripts/generate-tui-branding-art.mjs`）+ `prepareOpenCodeTuiState` 注入 `tui.json` | `tests/tui/branding-art.spec.ts`、`tests/tui/index.spec.ts`、`scripts/e2e-tui-brand.sh` | 本提交 |

## 8. 分发

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 多 arch 平台矩阵（linux/darwin/windows × x64/arm64 + musl/baseline） | ✅ | `src/tui/platform.ts`、`opencode-assets.json` | `tests/tui/platform.spec.ts`、`tests/scaffold.spec.ts` | 本提交 |
| 官方 npm 平台包优先（`opencode-<platform>-<arch>[-baseline][-musl]@1.18.18`） | ✅ | `src/tui/binary.ts` `npmPackage*`、`$DSH_HOME/opencode/packages/<key>` | `tests/tui/binary.spec.ts`（候选顺序/回退） | 本提交 |
| GitHub Release fallback 按平台独立 `sha256` 校验 | ✅ | `src/tui/download.ts`、`opencode-assets.json` | `tests/tui/download.spec.ts`、`tests/scaffold.spec.ts` | `f30b156` |
| 代理 / 镜像 | ✅ | `src/tui/download.ts` `resolveAssetUrl` | `tests/tui/download.spec.ts` | `f30b156` |

## 9. 测试

| 功能 | 状态 | 实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 单元/转换/桥/分发测试 | ✅ | `tests/**/*.spec.ts` | `pnpm test` | `f30b156` |
| API e2e 路由矩阵 + 权限流 | ✅ | `scripts/e2e-api.sh` | `bash scripts/e2e-api.sh` | `f30b156` |
| TUI boot / turn / stream e2e | ✅ | `scripts/e2e-tui-boot.sh`、`scripts/e2e-tui-turn.sh`、`scripts/e2e-tui-stream.sh` | 对应脚本输出 `PASSED` | `f30b156` |
| TUI 时间戳 e2e | ✅ | `scripts/e2e-tui-timestamps.sh` | `bash scripts/e2e-tui-timestamps.sh` | 本提交 |
| 离线启动 / 版本锁定 e2e | ✅ | `scripts/e2e-tui-offline.sh`、`scripts/e2e-tui-version-lock.sh` | 对应脚本输出 `PASSED` | 本提交 |
| Help e2e | ✅ | `scripts/e2e-tui-help.sh` | `bash scripts/e2e-tui-help.sh` | 本提交 |
| 品牌 logo e2e | ✅ | `scripts/e2e-tui-brand.sh` | `bash scripts/e2e-tui-brand.sh` | 本提交 |
| 协议探针（路由清单 + 二进制/SDK 版本校验） | ✅ | `scripts/probe-opencode.mjs`、`tests/fixtures/opencode/routes.json` | `pnpm run probe`、`tests/protocol-probe.spec.ts` | 本提交 |
| 流式工具事件 API e2e | ✅ | `scripts/e2e-api.sh` 审批流断言 started/delta/called/success | `bash scripts/e2e-api.sh` | 本提交 |
| 功能矩阵自动追踪 | ✅ | `scripts/update-feature-matrix.mjs` | `pnpm run features:update` | 本提交 |
| 会话性能测试（生成器 + 指标 + 报告） | ✅ | `scripts/perf.mjs` + `scripts/perf-session-gen.mjs`（dsh Session API 合成日志、zstd 分帧写入） | `pnpm run perf`、`tests/perf.spec.ts` | 本提交 |
| perf 生成器单测（编码/round-trip/子代理场景） | ✅ | `tests/perf.spec.ts` | `pnpm test` | 本提交 |

<!-- FEATURES:AUTO:START -->
## 自动追踪（脚本生成）

> 运行 `pnpm run features:update` 重新生成。生成时 HEAD：`0de1c30`（2026-08-15）。

### 路由注册表

来自 `src/bridge/router.ts` 与 `src/bridge/stubs.ts` 的注册路由；`for` 循环展开的
`/command`、`/skill`、`/reference`、`/integration` 及 `/api/*` 对偶路由会在
路由源码中以 `register` 动态注册，此处列出已解析的字面量 + stub 路由。

| Method | Route | Kind | 来源 |
|---|---|---|---|
| `GET` | `/agent` | json | `src/bridge/router.ts` |
| `GET` | `/api/agent` | json | `src/bridge/router.ts` |
| `GET` | `/api/command` | json | `src/bridge/router.ts` |
| `GET` | `/api/integration` | json | `src/bridge/router.ts` |
| `GET` | `/api/location` | json | `src/bridge/router.ts` |
| `GET` | `/api/model` | json | `src/bridge/router.ts` |
| `GET` | `/api/permission/saved` | json | `src/bridge/router.ts` |
| `GET` | `/api/provider` | json | `src/bridge/router.ts` |
| `GET` | `/api/reference` | json | `src/bridge/router.ts` |
| `GET` | `/api/session` | json | `src/bridge/router.ts` |
| `GET` | `/api/session/:sessionID` | json | `src/bridge/router.ts` |
| `GET` | `/api/session/:sessionID/diff` | json | `src/bridge/router.ts` |
| `GET` | `/api/session/:sessionID/message` | json | `src/bridge/router.ts` |
| `GET` | `/api/session/:sessionID/permission` | json | `src/bridge/router.ts` |
| `GET` | `/api/session/:sessionID/question` | json | `src/bridge/router.ts` |
| `GET` | `/api/skill` | json | `src/bridge/router.ts` |
| `GET` | `/command` | json | `src/bridge/router.ts` |
| `GET` | `/config` | json | `src/bridge/router.ts` |
| `GET` | `/config/providers` | json | `src/bridge/router.ts` |
| `GET` | `/experimental/capabilities` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/console` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/resource` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/workspace` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/workspace/status` | json | `src/bridge/stubs.ts` |
| `GET` | `/formatter` | json | `src/bridge/stubs.ts` |
| `GET` | `/global/event` | sse | `src/bridge/router.ts` |
| `GET` | `/integration` | json | `src/bridge/router.ts` |
| `GET` | `/lsp` | json | `src/bridge/stubs.ts` |
| `GET` | `/mcp` | json | `src/bridge/stubs.ts` |
| `GET` | `/path` | json | `src/bridge/router.ts` |
| `GET` | `/permission` | json | `src/bridge/router.ts` |
| `GET` | `/project/current` | json | `src/bridge/router.ts` |
| `GET` | `/project/global/directories` | json | `src/bridge/router.ts` |
| `GET` | `/provider` | json | `src/bridge/router.ts` |
| `GET` | `/provider/auth` | json | `src/bridge/router.ts` |
| `GET` | `/question` | json | `src/bridge/router.ts` |
| `GET` | `/reference` | json | `src/bridge/router.ts` |
| `GET` | `/session` | json | `src/bridge/router.ts` |
| `GET` | `/session/:id` | json | `src/bridge/router.ts` |
| `GET` | `/session/:id/diff` | json | `src/bridge/router.ts` |
| `GET` | `/session/:id/message` | json | `src/bridge/router.ts` |
| `GET` | `/session/:id/todo` | json | `src/bridge/router.ts` |
| `GET` | `/session/status` | json | `src/bridge/router.ts` |
| `GET` | `/skill` | json | `src/bridge/router.ts` |
| `GET` | `/vcs` | json | `src/bridge/stubs.ts` |
| `PATCH` | `/session/:id` | json | `src/bridge/router.ts` |
| `POST` | `/api/session` | json | `src/bridge/router.ts` |
| `POST` | `/api/session/:sessionID/agent` | json | `src/bridge/router.ts` |
| `POST` | `/api/session/:sessionID/compact` | json | `src/bridge/router.ts` |
| `POST` | `/api/session/:sessionID/fork` | json | `src/bridge/router.ts` |
| `POST` | `/api/session/:sessionID/model` | json | `src/bridge/router.ts` |
| `POST` | `/api/session/:sessionID/permission/:requestID/reply` | json | `src/bridge/router.ts` |
| `POST` | `/api/session/:sessionID/prompt` | json | `src/bridge/router.ts` |
| `POST` | `/api/session/:sessionID/question/:requestID/reject` | json | `src/bridge/router.ts` |
| `POST` | `/api/session/:sessionID/question/:requestID/reply` | json | `src/bridge/router.ts` |
| `POST` | `/permission/:requestID/reply` | json | `src/bridge/router.ts` |
| `POST` | `/question/:requestID/reject` | json | `src/bridge/router.ts` |
| `POST` | `/question/:requestID/reply` | json | `src/bridge/router.ts` |
| `POST` | `/session` | json | `src/bridge/router.ts` |
| `POST` | `/session/:id/abort` | json | `src/bridge/router.ts` |
| `POST` | `/session/:id/command` | json | `src/bridge/router.ts` |
| `POST` | `/session/:id/compact` | json | `src/bridge/router.ts` |
| `POST` | `/session/:id/fork` | json | `src/bridge/router.ts` |
| `POST` | `/session/:id/message` | json | `src/bridge/router.ts` |
| `POST` | `/session/:id/prompt` | json | `src/bridge/router.ts` |
| `POST` | `/session/:id/summarize` | json | `src/bridge/router.ts` |

### 测试覆盖

| 测试文件 | 用例数 | 最后更新 |
|---|---|---|
| `tests/bridge-events.spec.ts` | 27 | 0de1c30 feat(bridge): stream tool input deltas and v2 tool lifecycle events |
| `tests/bridge-git.spec.ts` | 1 | b24d9d5 fix(bridge): independent fork sessions and git-tracked sidebar diffs |
| `tests/bridge-router.spec.ts` | 41 | 34f5695 feat(bridge): goal projection, /goal command and sidebar todo merge |
| `tests/convert/goal.spec.ts` | 5 | 34f5695 feat(bridge): goal projection, /goal command and sidebar todo merge |
| `tests/convert/message.spec.ts` | 19 | 87406ba feat(bridge): subagent child sessions, fork and compact |
| `tests/convert/model.spec.ts` | 7 | d86e5fa feat(bridge): model variants, reasoning effort and dsh presets |
| `tests/convert/permission.spec.ts` | 4 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/question.spec.ts` | 5 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/session.spec.ts` | 7 | b24d9d5 fix(bridge): independent fork sessions and git-tracked sidebar diffs |
| `tests/convert/todo.spec.ts` | 3 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/tool.spec.ts` | 14 | 45630d9 feat(bridge): tool file changes and dsh edit-mode presentation |
| `tests/perf.spec.ts` | 5 | 3d8a88d feat(perf): session history generator and bridge performance harness |
| `tests/protocol-probe.spec.ts` | 2 | de7fe57 feat(probe): protocol route/version probe with missing-route reporting |
| `tests/scaffold.spec.ts` | 7 | 4ddba09 feat(profile): mount dsh agent presets so /preset can switch minimal etc |
| `tests/tui/binary.spec.ts` | 18 | ef1419f feat(tui): disable opencode auto-update/background network and enforce version lock |
| `tests/tui/branding-art.spec.ts` | 3 | 3c3984c feat(tui): generate DSH OC home logo with figlet tooling |
| `tests/tui/download.spec.ts` | 7 | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `tests/tui/index.spec.ts` | 26 | 3c3984c feat(tui): generate DSH OC home logo with figlet tooling |
| `tests/tui/platform.spec.ts` | 7 | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |

### 关键实现最后更新

| 文件 | 最后更新 |
|---|---|
| `src/bridge/convert/common.ts` | d86e5fa feat(bridge): model variants, reasoning effort and dsh presets |
| `src/bridge/convert/goal.ts` | 34f5695 feat(bridge): goal projection, /goal command and sidebar todo merge |
| `src/bridge/convert/message.ts` | 34f5695 feat(bridge): goal projection, /goal command and sidebar todo merge |
| `src/bridge/convert/model.ts` | d86e5fa feat(bridge): model variants, reasoning effort and dsh presets |
| `src/bridge/convert/permission.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/convert/question.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/convert/session.ts` | b24d9d5 fix(bridge): independent fork sessions and git-tracked sidebar diffs |
| `src/bridge/convert/todo.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/convert/tool.ts` | 0de1c30 feat(bridge): stream tool input deltas and v2 tool lifecycle events |
| `src/bridge/errors.ts` | d86e5fa feat(bridge): model variants, reasoning effort and dsh presets |
| `src/bridge/events.ts` | 0de1c30 feat(bridge): stream tool input deltas and v2 tool lifecycle events |
| `src/bridge/git.ts` | b24d9d5 fix(bridge): independent fork sessions and git-tracked sidebar diffs |
| `src/bridge/http.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/index.ts` | 87406ba feat(bridge): subagent child sessions, fork and compact |
| `src/bridge/router.ts` | 0de1c30 feat(bridge): stream tool input deltas and v2 tool lifecycle events |
| `src/bridge/rpc.ts` | a40801a Merge branch 'feat-subagent-fork' into feat-integrate-round2 |
| `src/bridge/sse.ts` | 18b1438 feat(bridge): one-shot slash command ux and visible compact execution |
| `src/bridge/state.ts` | 87406ba feat(bridge): subagent child sessions, fork and compact |
| `src/bridge/stubs.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/index.ts` | f574dfb feat(tui): dsh --profile oc --help capability summary and README matrix |
| `src/tui/binary.ts` | ef1419f feat(tui): disable opencode auto-update/background network and enforce version lock |
| `src/tui/download.ts` | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `src/tui/index.ts` | 91b2ad0 feat(tui): replace OpenCode home logo with DSH OC branding plugin |
| `src/tui/node-undici.d.ts` | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `src/tui/platform.ts` | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `src/types.ts` | 6ecf354 feat(tui): timestamps, feature matrix and multi-arch binary resolution |
| `scripts/e2e-api-goal.sh` | 34f5695 feat(bridge): goal projection, /goal command and sidebar todo merge |
| `scripts/e2e-api.sh` | 0de1c30 feat(bridge): stream tool input deltas and v2 tool lifecycle events |
| `scripts/e2e-tui-boot.sh` | 042b5d3 test(e2e): api route matrix, sse turn, dsh profile boot and real opencode tui attach |
| `scripts/e2e-tui-brand.sh` | 3c3984c feat(tui): generate DSH OC home logo with figlet tooling |
| `scripts/e2e-tui-command.sh` | 18b1438 feat(bridge): one-shot slash command ux and visible compact execution |
| `scripts/e2e-tui-goal.sh` | 34f5695 feat(bridge): goal projection, /goal command and sidebar todo merge |
| `scripts/e2e-tui-help.sh` | f574dfb feat(tui): dsh --profile oc --help capability summary and README matrix |
| `scripts/e2e-tui-offline.sh` | ef1419f feat(tui): disable opencode auto-update/background network and enforce version lock |
| `scripts/e2e-tui-stream.sh` | 5509bb3 test(e2e): measure streamed text prefix across wrapped pane |
| `scripts/e2e-tui-timestamps.sh` | 6ecf354 feat(tui): timestamps, feature matrix and multi-arch binary resolution |
| `scripts/e2e-tui-tools.sh` | b24d9d5 fix(bridge): independent fork sessions and git-tracked sidebar diffs |
| `scripts/e2e-tui-turn.sh` | 042b5d3 test(e2e): api route matrix, sse turn, dsh profile boot and real opencode tui attach |
| `scripts/e2e-tui-version-lock.sh` | ef1419f feat(tui): disable opencode auto-update/background network and enforce version lock |
| `scripts/generate-tui-branding-art.mjs` | 3c3984c feat(tui): generate DSH OC home logo with figlet tooling |
| `scripts/perf-session-gen.mjs` | 3d8a88d feat(perf): session history generator and bridge performance harness |
| `scripts/perf.mjs` | 3d8a88d feat(perf): session history generator and bridge performance harness |
| `scripts/probe-opencode.mjs` | de7fe57 feat(probe): protocol route/version probe with missing-route reporting |
| `scripts/update-feature-matrix.mjs` | 6ecf354 feat(tui): timestamps, feature matrix and multi-arch binary resolution |
| `scripts/update-opencode-assets.mjs` | 6ecf354 feat(tui): timestamps, feature matrix and multi-arch binary resolution |
<!-- FEATURES:AUTO:END -->
















# dsh-oc 功能支持矩阵

> 状态图例：✅ 已支持；🟡 部分支持/有限制；❌ 未实现或仅 stub。
> 本文件是功能状态入口；路由/协议细节见 [PROTOCOL.md](PROTOCOL.md)。
> 运行 `pnpm run features:update` 可刷新文末“自动追踪”部分，手动状态矩阵保留。

## 1. 模型

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| Provider / 模型目录展示（v1 + v2） | ✅ | `GET /provider`、`GET /api/model`、`src/bridge/convert/model.ts` | `tests/convert/model.spec.ts`、`scripts/e2e-api.sh` | `f30b156` |
| 默认 build agent 携带可用模型 | ✅ | `GET /agent`、`GET /api/agent`、`src/bridge/router.ts` | `tests/bridge-router.spec.ts` | `f30b156` |
| 模型选择器回写 dsh（`/api/session/:id/model`） | ❌ | 未注册路由，TUI 会收到 501 | 手工 TUI 模型选择器 | `f30b156` |
| 模型/Provider 错误映射 | ✅ | `src/bridge/errors.ts`、`src/bridge/rpc.ts` | `tests/bridge-router.spec.ts`（404/409/400/501） | `f30b156` |

## 2. 会话

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 会话列表 / 状态 | ✅ | `GET /session`、`GET /session/status`、`GET /api/session` | `tests/bridge-router.spec.ts`、`e2e-api.sh` | `f30b156` |
| 新建 / 重命名 / 历史 / 消息 | ✅ | `POST /session`、`PATCH /session/:id`、`GET /session/:id/message` 等 | `tests/bridge-router.spec.ts`、`e2e-tui-turn.sh` | `f30b156` |
| Prompt（v1 message、v1 alias、v2 prompt） | ✅ | `POST /session/:id/message`、`POST /session/:id/prompt`、`POST /api/session/:sessionID/prompt` | `e2e-api.sh`、`e2e-tui-turn.sh` | `f30b156` |
| Abort / cancel | ✅ | `POST /session/:id/abort` | `e2e-api.sh` | `f30b156` |
| Fork（`parentID`） | 🟡 | `POST /session`/`POST /api/session` 内 `session.fork` | `tests/bridge-router.spec.ts`；TUI 内 fork 未专门 e2e | `f30b156` |
| Todo 投影 | ✅ | `GET /session/:id/todo`、`src/bridge/convert/todo.ts` | `tests/convert/todo.spec.ts`、`tests/bridge-router.spec.ts` | `f30b156` |
| Diff / produced-files | 🟡 | `GET /session/:id/diff`、`src/bridge/events.ts` | `tests/bridge-router.spec.ts`；无投影时返回 `[]` | `f30b156` |
| SSE 会话/消息事件 | ✅ | `GET /global/event`、`src/bridge/events.ts` | `tests/bridge-events.spec.ts`、`e2e-api.sh`、`e2e-tui-stream.sh` | `f30b156` |

## 3. 工具

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| Tool call / result 四态映射 | ✅ | `src/bridge/convert/tool.ts`、`src/bridge/events.ts` | `tests/convert/tool.spec.ts`、`e2e-tui-turn.sh` | `f30b156` |
| 工具执行由 dsh 后端完成 | ✅ | `ctx.apiProxy.sessions.prompt`、dsh tool 注册表 | `e2e-api.sh`（bash 工具） | `f30b156` |
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
| 子代理会话树 / parent-child 渲染 | ❌ | 未提供专门 subagent 路由 | 手工验证 | `f30b156` |

## 6. 命令

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| 命令列表 | ❌ | `GET /command`、`GET /api/command` 返回 `[]` | `e2e-api.sh` | `f30b156` |
| Skills / references / integrations | ❌ | `GET /skill`、`GET /api/skill`、`GET /reference`、`GET /integration` 等返回 `[]` | `e2e-api.sh` | `f30b156` |

## 7. TUI

| 功能 | 状态 | 路由/实现 | 验证方式 | 最后更新 |
|---|---|---|---|---|
| `opencode attach` 启动/退出/信号转发 | ✅ | `src/tui/index.ts` `startOpenCodeTui` | `tests/tui/index.spec.ts`、`e2e-tui-boot.sh` | `f30b156` |
| attach 参数过滤（`--session/--dir/--mini/--print-logs/...`） | ✅ | `src/tui/index.ts` `filterSupportedArgs` | `tests/tui/index.spec.ts` | `f30b156` |
| 数据隔离（config/data/state/cache 在 `$DSH_HOME/opencode`） | ✅ | `src/tui/index.ts` `buildChildEnv` | `tests/tui/index.spec.ts` | `f30b156` |
| 消息时间戳默认开启 | ✅ | `DSH_OC_TUI_TIMESTAMPS=1` → `kv.json` `timestamps: show` + `tui.json` 快捷键 | `tests/tui/index.spec.ts`、`scripts/e2e-tui-timestamps.sh` | 本提交 |
| 时间戳运行时切换 | ✅ | `tui.json` 绑定 `session_toggle_timestamps` / `messages_toggle_timestamps` 为 `ctrl+shift+t`，也可用 `/timestamps` | 手工 TUI 验证 | 本提交 |
| 二进制版本校验（`--version` 匹配） | ✅ | `src/tui/binary.ts`、`src/tui/download.ts` | `tests/tui/binary.spec.ts`、`tests/tui/download.spec.ts` | `f30b156` |

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
| 功能矩阵自动追踪 | ✅ | `scripts/update-feature-matrix.mjs` | `pnpm run features:update` | 本提交 |

<!-- FEATURES:AUTO:START -->
## 自动追踪（脚本生成）

> 运行 `pnpm run features:update` 重新生成。生成时 HEAD：`f30b156`（2026-08-15）。

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
| `POST` | `/api/session/:sessionID/permission/:requestID/reply` | json | `src/bridge/router.ts` |
| `POST` | `/api/session/:sessionID/prompt` | json | `src/bridge/router.ts` |
| `POST` | `/api/session/:sessionID/question/:requestID/reject` | json | `src/bridge/router.ts` |
| `POST` | `/api/session/:sessionID/question/:requestID/reply` | json | `src/bridge/router.ts` |
| `POST` | `/permission/:requestID/reply` | json | `src/bridge/router.ts` |
| `POST` | `/question/:requestID/reject` | json | `src/bridge/router.ts` |
| `POST` | `/question/:requestID/reply` | json | `src/bridge/router.ts` |
| `POST` | `/session` | json | `src/bridge/router.ts` |
| `POST` | `/session/:id/abort` | json | `src/bridge/router.ts` |
| `POST` | `/session/:id/message` | json | `src/bridge/router.ts` |
| `POST` | `/session/:id/prompt` | json | `src/bridge/router.ts` |

### 测试覆盖

| 测试文件 | 用例数 | 最后更新 |
|---|---|---|
| `tests/bridge-events.spec.ts` | 14 | f30b156 fix(bridge): expose assistant finish so tui shows message duration |
| `tests/bridge-router.spec.ts` | 23 | 042b5d3 test(e2e): api route matrix, sse turn, dsh profile boot and real opencode tui attach |
| `tests/convert/message.spec.ts` | 18 | 47138cd feat(bridge): stream assistant chunks and report real message duration |
| `tests/convert/model.spec.ts` | 6 | 43ca32f fix(bridge): align model limits/names and reasoning durations with opencode |
| `tests/convert/permission.spec.ts` | 4 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/question.spec.ts` | 5 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/session.spec.ts` | 5 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/todo.spec.ts` | 3 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/tool.spec.ts` | 5 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/scaffold.spec.ts` | 7 | 68d8be5 fix(profile): bundle storage and webserver host rows so dsh --profile oc boots directly |
| `tests/tui/binary.spec.ts` | 11 | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `tests/tui/download.spec.ts` | 7 | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `tests/tui/index.spec.ts` | 19 | 5161477 fix(tui): isolate opencode xdg config under DSH_HOME |
| `tests/tui/platform.spec.ts` | 7 | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |

### 关键实现最后更新

| 文件 | 最后更新 |
|---|---|
| `src/bridge/convert/common.ts` | 47138cd feat(bridge): stream assistant chunks and report real message duration |
| `src/bridge/convert/message.ts` | f30b156 fix(bridge): expose assistant finish so tui shows message duration |
| `src/bridge/convert/model.ts` | 43ca32f fix(bridge): align model limits/names and reasoning durations with opencode |
| `src/bridge/convert/permission.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/convert/question.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/convert/session.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/convert/todo.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/convert/tool.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/errors.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/events.ts` | f30b156 fix(bridge): expose assistant finish so tui shows message duration |
| `src/bridge/http.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/index.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/router.ts` | 10bbb52 fix(bridge): per-client sse writes and correct assistant parent id |
| `src/bridge/rpc.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/sse.ts` | 10bbb52 fix(bridge): per-client sse writes and correct assistant parent id |
| `src/bridge/state.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/bridge/stubs.ts` | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `src/index.ts` | 6310216 feat(scaffold): project skeleton, dsh bundle patch and opencode asset manifest |
| `src/tui/binary.ts` | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `src/tui/download.ts` | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `src/tui/index.ts` | 5161477 fix(tui): isolate opencode xdg config under DSH_HOME |
| `src/tui/node-undici.d.ts` | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `src/tui/platform.ts` | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `src/types.ts` | 6310216 feat(scaffold): project skeleton, dsh bundle patch and opencode asset manifest |
| `scripts/e2e-api.sh` | 68d8be5 fix(profile): bundle storage and webserver host rows so dsh --profile oc boots directly |
| `scripts/e2e-tui-boot.sh` | 042b5d3 test(e2e): api route matrix, sse turn, dsh profile boot and real opencode tui attach |
| `scripts/e2e-tui-stream.sh` | 47138cd feat(bridge): stream assistant chunks and report real message duration |
| `scripts/e2e-tui-timestamps.sh` | — |
| `scripts/e2e-tui-turn.sh` | 042b5d3 test(e2e): api route matrix, sse turn, dsh profile boot and real opencode tui attach |
| `scripts/update-feature-matrix.mjs` | — |
| `scripts/update-opencode-assets.mjs` | 6310216 feat(scaffold): project skeleton, dsh bundle patch and opencode asset manifest |
<!-- FEATURES:AUTO:END -->








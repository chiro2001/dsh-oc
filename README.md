# dsh-oc

DeepSeek Harness 的 OpenCode TUI 前端：以官方 opencode TUI 为终端前端，
dsh 作为后端提供 Agent、会话、工具与模型能力。

[![CI](https://github.com/chiro2001/dsh-oc/actions/workflows/ci.yml/badge.svg)](https://github.com/chiro2001/dsh-oc/actions/workflows/ci.yml)
[![e2e](https://github.com/chiro2001/dsh-oc/actions/workflows/e2e.yml/badge.svg)](https://github.com/chiro2001/dsh-oc/actions/workflows/e2e.yml)

- **前端**：opencode 官方 CLI（`attach` 模式），直接使用官方二进制，只做 TUI。
- **后端**：DeepSeek Harness（dsh）负责 Agent、Session、工具、模型、权限和用户提问。
- **连接**：dsh-oc 在 dsh 进程内提供 OpenCode 兼容的 HTTP/SSE 桥（`oc-bridge`），并启动官方 TUI 客户端（`oc-tui`）。

```text
dsh (Node) ── dsh-oc bundle ── oc-bridge (HTTP/SSE) <── opencode TUI (attach)
                  │
                  └─ DSH Agent/Session/Tools/LLM/Approval/Questions
```

## 演示

<img src="docs/demo/dsh-oc-demo.gif" alt="dsh-oc 核心功能演示（真实 DeepSeek 模型）" width="900">

真实录制：`dsh --profile oc` → 品牌启动画面 → 真实模型运行 `pnpm test` →
266 个测试全部通过 → 退出提示。cast 源文件在
[docs/demo/dsh-oc-demo.cast](docs/demo/dsh-oc-demo.cast)，可
`asciinema play` 回放。

## 能力状态

> 完整矩阵见 [docs/FEATURES.md](docs/FEATURES.md)，路由细节见
> [docs/PROTOCOL.md](docs/PROTOCOL.md)；`dsh --profile oc --help` 展示同一摘要。

| 能力 | 状态 |
|---|---|
| 会话列表/新建/续聊/fork/compact、SSE 流式消息 | ✅ |
| 会话列表真实标题（标题 → 目录名 → id 回退） | ✅ |
| 模型目录、reasoning effort、agent preset 切换 | ✅ |
| 工具卡片（bash/read/write/edit）、diff 与 Modified Files | ✅ |
| 工具参数流式显示 | ✅ |
| 权限/提问流、子代理会话树与后台子代理 | ✅ |
| Goal 创建/查看（sidebar + `/goal`） | ✅ |
| Esc 打断/取消（全量双按、mini 单按） | ✅ |
| 文本/图片附件 | ✅（PDF 等二进制暂不支持） |
| `Allow always` 权限 | ✅（会话内内存记忆，重启清空） |
| MCP / LSP / formatter / skills / integration 等外围路由 | ❌（schema-valid stub） |

opencode 子进程直接使用官方二进制（锁定 `1.18.18`），并关闭自动更新、远程模型
目录与 LSP 下载等后台外网行为；细节见 AGENTS.md。

## 安装使用

```bash
dsh plugin --profile oc add chiro2001/dsh-oc
dsh --profile oc
```

> `chiro2001/dsh-oc` 解析为 GitHub 源 `git+https://github.com/chiro2001/dsh-oc.git`
> 的 `main` 分支；如需固定版本/分支，可用 `github:chiro2001/dsh-oc#develop` 等
> pnpm git spec。pnpm 提示缺少 `@deepseek-ai/cordis` 等 peer 属于预期警告，
> 由 dsh-base/宿主在运行时提供，可忽略。

## 参数透传

支持透传给 `opencode attach` 的参数：

- `--continue` / `-c`、`--session` / `-s`、`--fork`、`--dir`、`--mini`、
  `--print-logs`、`--log-level`

示例：

```bash
dsh --profile oc --session <session-id>
dsh --profile oc --dir ~/project --mini
```

`--dir` 还会写入 bridge 工作目录（路径、新建会话、附件校验以此为基准）。
其它参数会显式打印 `ignored unsupported arg` 警告，不会静默丢弃。

## 数据隔离

opencode 的配置、数据、状态与缓存全部隔离在 `$DSH_HOME/opencode` 下；
模型与凭据由 dsh 后端管理，dsh-oc 不向 opencode 注入 provider/key。

## 已知限制

- `Allow always`：仅会话内内存记忆，重启清空。
- 退出 splash：官方退出画面无法替换，dsh-oc 在其下方补一行 dsh 恢复说明
  （`DSH_OC_DISABLE_EXIT_NOTE=1` 可关）。
- Esc 打断：`--mini` 单按、全量 TUI 连按两次；dsh-oc 会转为 `session.cancel`。
- 附件：支持文本与图片，PDF 等二进制暂不支持。
- 外围路由（MCP/LSP/formatter/skills/integration）：schema-valid stub，不伪造结果。
- 模型与权限：由 dsh 后端管理。

## 自测

```bash
pnpm run e2e:api   # 快速 API 回归
pnpm run e2e       # 全量 e2e（真实 opencode TUI）
```

完整自测门槛见 [AGENTS.md](AGENTS.md)。

## 开发者 / Agent

开发环境、常用命令、自测门槛、分支与提交流程、安装/更新与二进制策略见
[AGENTS.md](AGENTS.md)；人类贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
其它文档：[docs/PLAN.md](docs/PLAN.md)、[docs/ROADMAP.md](docs/ROADMAP.md)、
[docs/CHANGELOG.md](docs/CHANGELOG.md)。

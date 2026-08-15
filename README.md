# dsh-oc

DeepSeek Harness 的 OpenCode TUI 前端。

[![CI](https://github.com/chiro2001/dsh-oc/actions/workflows/ci.yml/badge.svg)](https://github.com/chiro2001/dsh-oc/actions/workflows/ci.yml)
[![e2e](https://github.com/chiro2001/dsh-oc/actions/workflows/e2e.yml/badge.svg)](https://github.com/chiro2001/dsh-oc/actions/workflows/e2e.yml)

GitHub Actions 手动触发的 `e2e` 工作流运行 API e2e（`e2e-api.sh` +
`e2e-api-goal.sh`）与可选压测；完整 TUI e2e 因 CI 终端时序限制保留在本地
`bash scripts/check-all.sh --e2e` 运行。

- **前端**：opencode 官方 CLI，以 `attach` 模式运行，只做 TUI。
- **后端**：DeepSeek Harness（dsh）负责 Agent、Session、工具、模型、权限和用户提问。
- **连接**：dsh-oc 在 dsh 进程内提供 OpenCode 兼容的 HTTP/SSE 桥（`oc-bridge`），并启动官方 TUI 客户端（`oc-tui`）。

```text
dsh (Node) ── dsh-oc bundle ── oc-bridge (HTTP/SSE) <── opencode TUI (attach)
                  │
                  └─ DSH Agent/Session/Tools/LLM/Approval/Questions
```

## 演示

[![dsh-oc 核心功能演示](https://asciinema.org/a/PTxhTFDZED74S0jk.svg)](https://asciinema.org/a/PTxhTFDZED74S0jk)

演示内容：DSH OC 品牌启动画面 → 会话列表真实标题 → 打开历史会话 →
工具调用卡片 → 慢速流式回复 → Esc 打断 → 错误提示 → 推理回复 → 退出提示说明。
点击图片在 asciinema 在线播放器播放；也可下载
[dsh-oc-demo.cast](docs/demo/dsh-oc-demo.cast) 后用 `asciinema play` 原速重放。

## 文档

- [docs/PLAN.md](docs/PLAN.md)：总体实现规划、阶段、验收标准。
- [docs/PROTOCOL.md](docs/PROTOCOL.md)：OpenCode TUI 协议探针结果、路由兼容矩阵、SSE 映射。
- [docs/FEATURES.md](docs/FEATURES.md)：当前功能支持矩阵（自动追踪）。
- [docs/ROADMAP.md](docs/ROADMAP.md)：下一阶段需求与验收标准。
- [docs/CHANGELOG.md](docs/CHANGELOG.md)：版本变更记录。
- [AGENTS.md](AGENTS.md)：面向 AI Agent / 开发者的仓库指南（结构、命令、自测门槛）。
- [docs/FEATURES.md](docs/FEATURES.md)：功能支持状态矩阵（含自动追踪部分）。

## 开发完成状态（2026-08-15）

- ROADMAP N1–N6 全部完成：自动更新关闭/版本锁定、流式 toolcall/progress、Goal
  完整生命周期、会话性能测试、协议升级探针、能力矩阵与 `--help`。
- 额外能力：DSH OC 品牌启动 logo、文本/图片附件、`Always` 权限会话记忆、v2
  会话搜索/分页/排序、SSE mux/host 重连与重放去重、dsh skills 目录与斜杠命令、
  GitHub Actions CI（build/typecheck/test/probe）。
- 详细状态与验收方式见 [docs/ROADMAP.md](docs/ROADMAP.md) 与
  [docs/FEATURES.md](docs/FEATURES.md)。

## 近期更新（2026-08-16）

- 会话列表真实标题补读（小规模全量、大列表后台补温）。
- Esc 打断/取消（全量双按、mini 单按），`/preset` 新会话继承 preset。
- 退出 splash 下方输出 dsh 恢复说明。
- 路由注册按域拆分（`src/bridge/routes/`），协议探针自动扫描。
- push 自动跑 API e2e 子集；完整变更见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

## 安装使用

```bash
dsh plugin --profile oc add chiro2001/dsh-oc
dsh --profile oc
```

> `chiro2001/dsh-oc` 会解析为
> `git+https://github.com/chiro2001/dsh-oc.git`，安装 `main` 分支的最新版本。
> 如需固定版本或分支，可使用 pnpm 支持的完整 git spec，例如
> `dsh plugin --profile oc add 'github:chiro2001/dsh-oc#main'`。
>
> 安装时 pnpm 可能提示 `missing peer @deepseek-ai/cordis` /
> `@deepseek-ai/dsh-cmdline` / `@deepseek-ai/dsh-home-paths`：这些 peer 由
> dsh-base/宿主在运行时提供，属于预期警告，可忽略；`dsh --profile oc` 能正常
> 启动即说明解析成功。

## 更新

从 GitHub 源安装时，更新到最新 `main`：

```bash
dsh plugin --profile oc add chiro2001/dsh-oc
dsh --profile oc --help            # 验证新版本已生效
```

> 注意：仓库 `package.json` 里的 npm 包名是 `@chiro2001/dsh-oc@0.1.0-rc.1`，
> 目前**没有发布到 npm registry**；安装与更新一律走 GitHub 源
> `chiro2001/dsh-oc`。

本地开发时（仓库已 clone 到本地），重新构建并指向本地路径即可：

```bash
cd dsh-oc
pnpm build
dsh plugin --profile oc add .
```

> 本地安装会以 `link:` 方式链接仓库，`pnpm build` 后新逻辑立即生效；
> 但 `lib/` 仍需随提交一起推送，GitHub 直装才会包含最新构建产物。

首次启动会解析并缓存 opencode 官方二进制（版本锁定 `1.18.18`）。分发优先级：

1. `DSH_OC_OPENCODE_BIN`（绝对路径）
2. `$DSH_HOME/opencode/bin/<version>/opencode(.exe)` 缓存
3. `PATH` 上版本匹配的 `opencode`
4. 官方 npm 平台包（`opencode-<platform>-<arch>[-baseline][-musl]@1.18.18`），惰性安装到
   `$DSH_HOME/opencode/packages/<platform-key>`，由 npm integrity 校验
5. profile 内已安装的 `opencode-ai` 包（自动运行官方 postinstall）
6. GitHub Release 惰性下载（`opencode-assets.json` 中每个平台独立的 `sha256` 校验）

`opencode-assets.json` 覆盖 linux/darwin/windows 的 x64/arm64、musl 与 baseline 变体，
每个 asset 都带有自己的 `sha256`、npm 包名与 npm tarball integrity；不会退化为单一全局 hash。
下载支持代理（`HTTPS_PROXY`/`HTTP_PROXY`）与镜像。
也可以通过环境变量控制二进制来源：

- `DSH_OC_OPENCODE_BIN`：绝对路径指向已安装的 opencode 可执行文件（优先于下载）。
- `DSH_OC_OPENCODE_MIRROR`：GitHub Release asset 的镜像前缀，用于下载源不可达时。
- `DSH_OC_TUI_TIMESTAMPS=1`：让 TUI 消息默认显示时间戳（写入隔离的 `kv.json`，
  并绑定 `ctrl+shift+t` / `/timestamps` 用于运行时切换）。

## 开发者 / Agent

开发环境、常用命令、自测门槛、分支与提交流程、实现约定与陷阱见
[AGENTS.md](AGENTS.md)（面向接手仓库的 AI Agent 与开发者）与
[CONTRIBUTING.md](CONTRIBUTING.md)（人类贡献流程）。

一句话提醒：改 `src/` 后必须 `pnpm build` 并连同 `lib/` 一起提交，否则
GitHub 直装不会包含新逻辑。

## 参数透传

支持透传给 `opencode attach` 的参数：

- `--continue` / `-c`
- `--session` / `-s`
- `--fork`
- `--dir`
- `--mini`
- `--print-logs`
- `--log-level`

示例：

```bash
dsh --profile oc --session <session-id>
dsh --profile oc --dir ~/project --mini
```

`--dir` 不仅传给 `opencode attach`，还会写入 bridge 的工作目录：`/path`、
新建会话和文件附件路径校验都以该目录为准。

其它参数（例如 `--model X`）会被显式打印 `ignored unsupported arg` 警告并忽略，
不会静默丢弃。

## 能力状态

> 完整矩阵见 [docs/FEATURES.md](docs/FEATURES.md)，路由细节见
> [docs/PROTOCOL.md](docs/PROTOCOL.md)。`dsh --profile oc --help` 展示同一摘要。

| 能力 | 状态 |
|---|---|
| 会话列表/新建/续聊/fork/compact、SSE 流式消息 | ✅ |
| 模型目录、reasoning effort、agent preset 切换 | ✅ |
| 工具卡片（bash/read/write/edit）、diff 与 Modified Files | ✅ |
| 工具参数流式显示（v1 ToolPart + v2 tool input/lifecycle 事件） | ✅ |
| 权限/提问流、子代理会话树 | ✅ |
| Goal 创建/查看（sidebar 状态 + `/goal` 命令） | ✅ |
| 自动更新关闭、二进制版本锁定 | ✅ |
| DSH OC 品牌启动 logo（替换 OpenCode 字符画） | ✅ |
| 文本/图片附件 | ✅（PDF 等二进制暂不支持） |
| `Allow always` 权限 | ✅（会话内内存记忆，重启清空） |
| MCP / LSP / formatter / skills / integration 等外围路由 | ❌（schema-valid stub） |

网络与二进制策略：opencode 子进程不主动访问 `api.opencode.ai` / GitHub release
（自动更新、模型目录抓取、LSP 下载均被关闭），版本锁定为 `opencode-version.json`
中的 `1.18.18`；详见下文「网络与更新策略」。

## 数据隔离

opencode 的配置、数据、状态与缓存全部隔离在 `$DSH_HOME/opencode` 下：

```text
$DSH_HOME/opencode/{config,data,state,cache}
```

模型与凭据由 dsh 后端管理；dsh-oc 不向 opencode 注入 DeepSeek provider/key。

## 自测

全部自测命令与门槛见 [AGENTS.md](AGENTS.md)；常用入口：

```bash
pnpm run e2e:api   # 快速 API 回归
pnpm run e2e       # 全量 e2e（真实 opencode TUI）
```

## 网络与更新策略

opencode 子进程启动时被强制关闭后台外网行为（以 1.18.18 源码验证为准）：

- `OPENCODE_DISABLE_AUTOUPDATE=1`：禁用自动更新检查（`cli/upgrade.ts` 直接短路）。
- `OPENCODE_DISABLE_MODELS_FETCH=1`：不主动拉取远程模型目录。
- `OPENCODE_DISABLE_LSP_DOWNLOAD=1`：不下载 LSP 二进制。
- 隔离配置中写入 `autoupdate: false`，即使未来版本改变环境变量名也不下载/热替换。

二进制锁定：运行前 `resolveOpenCodeBinary` 与 `verifyOpenCodeVersion` 双重校验
`--version` 必须等于 `opencode-version.json` 中的 `1.18.18`；显式指定的
`DSH_OC_OPENCODE_BIN` 版本不匹配时会直接报错退出，不会静默回退到 PATH 上的其它版本。
缓存错误时清除 `$DSH_HOME/opencode/bin` 或设置匹配版本的 `DSH_OC_OPENCODE_BIN`。

## 已知限制

- **`always` 权限记忆**：TUI 的 `Allow always` 在 bridge 内存中保存（同会话同工具自动放行），
  当前请求仍以 dsh 的 `allowed-once` 提交；进程重启后记忆清空。
- **退出 splash**：opencode 官方 TUI（全量与 `--mini`）在会话有内容时退出会打印
  自己的 logo + “Session …” 与 `opencode -s <id>` / `opencode --mini -s <id>`
  恢复命令。该画面由官方二进制在滚动缓冲区渲染，无法通过插件替换；dsh-oc 会在
  会话有内容（新输入或恢复的旧会话有历史）时于其下方补一行说明，提示其中的
  `<id>` 是 dsh 会话 id、恢复请用
  `dsh --profile oc --session <id>`，不要直接运行 opencode 的恢复命令。
  设置 `DSH_OC_DISABLE_EXIT_NOTE=1` 可关闭这行说明。
- **打断模型执行**：`--mini` 按一次 `Esc` 打断；全量 TUI 需要在运行中连按两次
  `Esc`（官方二进制行为，第一次只是“待打断”状态）。dsh-oc 会把这些按键转成
  `session.cancel`，停止当前 LLM 流；相关 e2e：`scripts/e2e-tui-abort.sh`。
- **文件附件**：支持 `file` part 的文本文件（data URL 或 cwd 内本地路径）与
  图片（data URL）；PDF 等二进制附件暂不支持，会返回明确 400。
- **未实现路由**：返回 schema-valid 空数据或显式 501，不伪造 diff。
- **模型/权限**：由 dsh 后端管理；TUI 内模型选择器显示 dsh 模型目录。

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

## 文档

- [docs/PLAN.md](docs/PLAN.md)：总体实现规划、阶段、验收标准。
- [docs/PROTOCOL.md](docs/PROTOCOL.md)：OpenCode TUI 协议探针结果、路由兼容矩阵、SSE 映射。
- [docs/FEATURES.md](docs/FEATURES.md)：当前功能支持矩阵（自动追踪）。
- [docs/ROADMAP.md](docs/ROADMAP.md)：下一阶段需求与验收标准。
- [docs/FEATURES.md](docs/FEATURES.md)：功能支持状态矩阵（含自动追踪部分）。

## 开发完成状态（2026-08-15）

- ROADMAP N1–N6 全部完成：自动更新关闭/版本锁定、流式 toolcall/progress、Goal
  完整生命周期、会话性能测试、协议升级探针、能力矩阵与 `--help`。
- 额外能力：DSH OC 品牌启动 logo、文本/图片附件、`Always` 权限会话记忆、v2
  会话搜索/分页/排序、SSE mux/host 重连与重放去重、dsh skills 目录与斜杠命令、
  GitHub Actions CI（build/typecheck/test/probe）。
- 详细状态与验收方式见 [docs/ROADMAP.md](docs/ROADMAP.md) 与
  [docs/FEATURES.md](docs/FEATURES.md)。

## 安装使用

```bash
dsh plugin --profile oc add chiro2001/dsh-oc
dsh --profile oc
```

> `chiro2001/dsh-oc` 会解析为
> `git+https://github.com/chiro2001/dsh-oc.git`，安装 `main` 分支的最新版本。
> 如需固定版本或分支，可使用 pnpm 支持的完整 git spec，例如
> `dsh plugin --profile oc add 'github:chiro2001/dsh-oc#main'`。

## 更新

从 GitHub 源安装时，更新到最新 `main`：

```bash
dsh plugin --profile oc add chiro2001/dsh-oc
dsh --profile oc --help            # 验证新版本已生效
```

> 包的 npm 名称仍是 `@deepseek-ai/dsh-oc`（安装源是
> `github:chiro2001/dsh-oc`）；也可在 `$DSH_HOME/profiles/oc` 下用
> `pnpm update @deepseek-ai/dsh-oc` 更新。

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

## 本地开发

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm run features:update   # 刷新 docs/FEATURES.md 的自动追踪部分
pnpm run perf              # 会话性能测试（生成合成历史 → 启动真实 bridge → 输出 JSON 报告）
dsh plugin --profile oc add .
dsh --profile oc
```

> `lib/` 已纳入版本库：GitHub 直装依赖已构建产物。修改 `src/` 后请运行
> `pnpm build` 并连同 `lib/` 一起提交，否则 `chiro2001/dsh-oc` 安装的版本不会更新。

## 性能测试

`pnpm run perf` 会生成合成 dsh 会话历史（复用 `@deepseek-ai/dsh-session` 的校验路径），
启动真实 `dsh --profile oc` bridge，并测量会话列表、消息分页、SSE 首事件延迟与进程内存，
输出 p50/p95/max 的 JSON 报告：

```bash
pnpm run perf -- --sessions 1000 --messages-per-session 6 --tools --todos --children 10
node scripts/perf.mjs --sessions 200 --no-boot   # 只生成不启动
node scripts/perf.mjs --sessions 5000 --keep     # 保留临时 DSH_HOME 供排查
```

常用参数：`--sessions N`、`--messages-per-session M`（别名 `--turns K`）、`--tools`、
`--todos`、`--children C`、`--repeats R`、`--seed N`、`--report PATH`。
报告默认写入 `.perf/report-*.json`（`.perf/` 已忽略），示例见 `docs/perf/report-example.json`。

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

```bash
bash scripts/e2e-api.sh        # HTTP/SSE 路由矩阵 + 会话循环 + 权限流
bash scripts/e2e-tui-boot.sh   # 真实 opencode TUI 启动/退出 + 终端恢复
bash scripts/e2e-tui-turn.sh   # 真实 TUI 键盘输入完成一轮对话
bash scripts/e2e-tui-timestamps.sh  # DSH_OC_TUI_TIMESTAMPS=1 下时间戳文本出现
bash scripts/e2e-tui-offline.sh     # 代理不可达 + 清空缓存时 TUI 仍能启动
bash scripts/e2e-tui-version-lock.sh  # 显式二进制版本不匹配时明确报错退出
bash scripts/e2e-tui-help.sh        # dsh --profile oc --help 输出能力摘要并退出
bash scripts/e2e-tui-brand.sh       # TUI 首页显示 DSH OC 品牌 logo（替换 OpenCode 字符画）
bash scripts/e2e-tui-dir.sh         # attach --dir 切到指定工作目录
bash scripts/e2e-tui-fork.sh        # attach --fork --session 生成 fork #1
bash scripts/e2e-tui-continue.sh    # attach --continue 恢复最新会话
bash scripts/e2e-tui-mini.sh        # attach --mini 最小界面启动渲染
bash scripts/e2e-tui-print-logs.sh  # --print-logs 透传给 opencode 子进程
bash scripts/e2e-tui-skill.sh      # 技能斜杠命令（DSH_OC_E2E_FAKE_SKILLS 注入）
pnpm run probe                     # 协议路由清单 + 二进制/SDK 版本校验
bash scripts/check-all.sh          # 一键自测：typecheck+单测+探针+性能冒烟
bash scripts/check-all.sh --e2e    # 再加全量 TUI/API e2e
bash scripts/check-all.sh --scale 5000  # 再加 5000 sessions 性能压测
```

tarball 验证模式（用 npm tarball 而不是本地路径安装）：

```bash
pnpm pack --pack-destination /tmp/dsh-oc-pack-release
TGZ="$(echo /tmp/dsh-oc-pack-release/deepseek-ai-dsh-oc-0.1.0-rc.1.tgz)"
DSH_OC_E2E_ADD_SPEC="$TGZ" bash scripts/e2e-api.sh
DSH_OC_E2E_ADD_SPEC="$TGZ" bash scripts/e2e-tui-boot.sh
DSH_OC_E2E_ADD_SPEC="$TGZ" bash scripts/e2e-tui-turn.sh
DSH_OC_E2E_ADD_SPEC="$TGZ" bash scripts/e2e-tui-timestamps.sh
```

四个脚本必须全部输出 `PASSED`；该模式下 profile 安装的是 tarball 而非本地路径。

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
- **`--mini` 退出 splash**：opencode 官方 `--mini` 直连模式会在退出时打印自己的
  logo + “Session …” 与 `opencode --mini -s <id>` 恢复命令。该画面由官方二进制
  在滚动缓冲区渲染，无法通过插件替换；其中的 `<id>` 就是 dsh 会话 id，恢复时请用
  `dsh --profile oc --session <id>`，不要直接运行 `opencode --mini -s`。
- **文件附件**：支持 `file` part 的文本文件（data URL 或 cwd 内本地路径）与
  图片（data URL）；PDF 等二进制附件暂不支持，会返回明确 400。
- **未实现路由**：返回 schema-valid 空数据或显式 501，不伪造 diff。
- **模型/权限**：由 dsh 后端管理；TUI 内模型选择器显示 dsh 模型目录。

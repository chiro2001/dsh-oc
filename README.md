# dsh-oc

DeepSeek Harness 的 OpenCode TUI 前端。

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

## 安装使用

```bash
dsh plugin --profile oc add chiro2001/dsh-oc
dsh --profile oc
```

> `chiro2001/dsh-oc` 会解析为
> `git+https://github.com/chiro2001/dsh-oc.git`，安装 `main` 分支的最新版本。
> 如需固定版本或分支，可使用 pnpm 支持的完整 git spec，例如
> `dsh plugin --profile oc add 'github:chiro2001/dsh-oc#main'`。

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
dsh plugin --profile oc add .
dsh --profile oc
```

> `lib/` 已纳入版本库：GitHub 直装依赖已构建产物。修改 `src/` 后请运行
> `pnpm build` 并连同 `lib/` 一起提交，否则 `chiro2001/dsh-oc` 安装的版本不会更新。

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
| 权限/提问流、子代理会话树 | ✅ |
| 自动更新关闭、二进制版本锁定 | ✅ |
| DSH OC 品牌启动 logo（替换 OpenCode 字符画） | ✅ |
| 文本/data image 附件 | 🟡 |
| `Allow always` 权限 | 🟡（降级为 once） |
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

- **`always` 权限降级**：TUI 的 `Allow always` 映射为 dsh 的 `allowed-once`，并在日志中提示。
- **文件附件**：首版只支持文本 prompt；图片/file part 后续按
  `apiProxy.sessions.prompt` 的 `PromptContentPart` 能力补齐。
- **未实现路由**：返回 schema-valid 空数据或显式 501，不伪造 diff。
- **模型/权限**：由 dsh 后端管理；TUI 内模型选择器显示 dsh 模型目录。

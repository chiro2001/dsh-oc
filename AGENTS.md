# AGENTS.md — dsh-oc 开发/Agent 指南

本文件面向接手本仓库的 AI Agent 与开发者，替代 README 中的开发章节。
使用者文档见 [README.md](README.md)；人类贡献流程见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目是什么

dsh-oc 是 DeepSeek Harness（dsh）的 OpenCode TUI 前端：

- **前端**：官方 opencode CLI（`attach` 模式），只负责渲染、键盘、终端生命周期。
- **后端**：dsh 负责 Agent、Session、工具、模型、权限、提问。
- **桥接**：dsh-oc 在 dsh 进程内提供 OpenCode 兼容的 HTTP/SSE 服务（`oc-bridge`），
  并启动官方 TUI 子进程（`oc-tui`）。

```text
dsh (Node) ── dsh-oc bundle ── oc-bridge (HTTP/SSE) <── opencode TUI (attach)
                  │
                  └─ DSH Agent/Session/Tools/LLM/Approval/Questions
```

仓库：`chiro2001/dsh-oc`；npm 包名 `@chiro2001/dsh-oc@0.1.0-rc.1`（未发布
registry，安装/更新走 GitHub 源 `#main` / `#develop`）。

## 代码结构

```text
src/
  bridge/            # OpenCode 协议桥
    router.ts        # 核心：SSE、缓存/预取、命令/权限 helper、桥服务接线
    routes/          # 路由注册（按域拆分，聚合于 routes.ts）
      boot.ts        # v1/v2 启动与目录路由（/path /project /config /provider /agent ...）
      session-v1.ts  # v1 会话路由（列表、消息、prompt、abort、command、todo、diff）
      session-v2.ts  # v2 会话路由
      permission.ts  # permission / question 路由
    routes.ts        # 聚合器（注册顺序即匹配顺序，勿乱）
    events.ts        # SSE 事件翻译（turn.*、message.*、session.*、工具流、权限）
    state.ts         # 桥内存状态（缓存、标题、preset、活动标记）
    convert/         # dsh 事件 → opencode 消息/会话/模型/权限转换
    http.ts sse.ts rpc.ts errors.ts stubs.ts git.ts
  tui/               # opencode 子进程解析/下载/spawn、信号转发、退出处理
  help.ts            # --help / /help 静态能力摘要
tui-branding/        # DSH OC 品牌 logo TUI 插件
scripts/             # 自测/压测/能力矩阵/清理工具
tests/               # vitest 单测 + e2e（scripts/e2e-*）
docs/                # FEATURES / PROTOCOL / ROADMAP / CHANGELOG / perf
lib/                 # 构建产物（必须随提交推送，GitHub 直装依赖它）
```

## 常用命令

```bash
pnpm install
pnpm build                 # tsdown → lib/
pnpm typecheck             # tsc --noEmit
pnpm test                  # vitest
pnpm run probe             # opencode 1.18.18 协议路由探针（62/62）
pnpm run e2e               # 全量 e2e（真实 opencode TUI，约 8 分钟）
pnpm run e2e:api           # API e2e 子集（快速回归）
pnpm run perf              # 会话性能压测（--sessions N --scale ...）
pnpm run features:update   # 刷新 docs/FEATURES.md 自动追踪
bash scripts/check-all.sh --e2e          # 一键全量门槛
bash scripts/check-all.sh --e2e --scale 5000
```

本地直连 dsh profile（实时验证）：`dsh plugin --profile oc add .`；改代码后
`pnpm build` 立即生效（link 方式）。从 GitHub 分支安装验证：
`dsh plugin --profile oc add 'github:chiro2001/dsh-oc#<branch>'`。

## 安装、更新与本地开发

使用者只关心安装命令时见 README；Agent/开发者用以下方式验证与更新：

GitHub 源安装/更新（与 README 同款命令，重复执行即更新到该分支最新）：

```bash
dsh plugin --profile oc add chiro2001/dsh-oc                       # #main
dsh plugin --profile oc add 'github:chiro2001/dsh-oc#develop'      # 指定分支
dsh --profile oc --help                                            # 验证版本
```

- npm 包名 `@chiro2001/dsh-oc` 未发布 registry；安装/更新一律走 GitHub 源。
- 本地开发：`dsh plugin --profile oc add .` 以 `link:` 方式链接仓库，改
  `src/` 后 `pnpm build` 立即生效；但 `lib/` 必须随提交推送，GitHub 直装才
  会包含最新构建产物。

## opencode 二进制与网络策略

- 直接使用官方 opencode 二进制，版本锁定 `opencode-version.json`（当前
  `1.18.18`）；启动时 `resolveOpenCodeBinary` + `verifyOpenCodeVersion` 双重
  校验，显式 `DSH_OC_OPENCODE_BIN` 版本不匹配会直接报错，不回退到 PATH 上
  的其它版本。
- 解析优先级：`DSH_OC_OPENCODE_BIN` → `$DSH_HOME/opencode/bin/<version>`
  → PATH 上版本匹配的 `opencode` → 官方 npm 平台包（惰性安装，npm integrity
  校验）→ profile 内 `opencode-ai` 包 → GitHub Release 惰性下载。
  `opencode-assets.json` 覆盖各平台/架构变体，每个 asset 独立 sha256 与 npm
  tarball integrity；下载支持代理（`HTTPS_PROXY`/`HTTP_PROXY`）与
  `DSH_OC_OPENCODE_MIRROR` 镜像前缀。
- 网络策略：子进程强制 `OPENCODE_DISABLE_AUTOUPDATE=1` /
  `OPENCODE_DISABLE_MODELS_FETCH=1` / `OPENCODE_DISABLE_LSP_DOWNLOAD=1`，并在
  隔离配置写 `autoupdate: false`，关闭后台外网行为。
- 缓存错误时清除 `$DSH_HOME/opencode/bin` 或设置匹配版本的
  `DSH_OC_OPENCODE_BIN`；`DSH_OC_TUI_TIMESTAMPS=1` 可让 TUI 默认显示时间戳
  （`ctrl+shift+t` / `/timestamps` 运行时切换）。

## 自测门槛（提交/合并前必须全绿）

1. `pnpm typecheck && pnpm test`
2. `pnpm run probe`（62/62）
3. 涉及协议/桥接/TUI 的改动：至少跑相关 `scripts/e2e-*.sh`；完整回归用
   `bash scripts/check-all.sh --e2e`
4. `pnpm run features:update`（涉及能力清单时）并提交结果
5. `lib/` 构建产物随提交；检查机器相关绝对路径：
   `rg -n --hidden -g '!node_modules' -g '!.git' 'chiro' . | rg -v 'chiro2001|/home/chiro/'`

e2e 脚本只允许在 `main` / `develop` 与 `chore-*` / `fix-*` / `docs-*` /
`perf-*` / `test-*` / `feat-*` 分支运行（白名单在 `tests/e2e/common.sh` 与
`tests/e2e/env.mjs`，与 CI 触发分支保持一致）。

## 分支与发布

- `main`：稳定发布线，README 安装命令默认 `#main`。
- `develop`：集成交付线，日常开发与用户实时验证；稳定后回合 main。
- 功能分支：`feat-*` / `fix-*` / `docs-*` / `perf-*` / `test-*` / `chore-*`，
  从 develop 拉出，短生命周期。
- 提交规范：Conventional Commits（feat/fix/docs/perf/test/chore/refactor）。
- 遗留 feat-* 分支均已并入 main；清理工具 `scripts/cleanup-merged-branches.sh`
  （默认 dry-run，`--apply` 本地删除，`--remote` 同步远端）。

## 关键实现约定与陷阱

- **路由注册顺序即匹配顺序**：`src/bridge/routes.ts` 按 boot → session-v1 →
  permission → session-v2 → SSE 顺序调用；新增路由放在对应域文件。
- **会话列表标题**：dsh `session.list` 不返回 title 投影；bridge 从
  `session.history` tail 投影补读（≤40 非空会话同步全量，大列表后台低并发补
  24，绝不阻塞列表请求）。标题优先级：投影标题 → 目录 basename → session id。
- **在途合并与缓存**：`session.list` / `session.history` 的在途 RPC 共享
  （`InteractionState` 内 loading promise），失效用 generation 计数防竞态。
- **SSE turn 事件**：`turn/start` 广播 `session.status busy` + `turn.wait`；
  `turn/end` 广播 `session.status idle` + `session.idle` + `turn.idle`。
  TUI 的 Esc 打断依赖 `phase === "running"`，没有 `turn.wait` 就不会打断。
- **reasoning 时长**：reasoning part 的 `end` 取该块最后一条 chunk 的时间；
  text 块开始时、以及 turn/end（中断无最终消息）时都会关闭仍打开的
  reasoning part，避免 thinking 一直转圈。
- **agent preset 锁定**：dsh 在会话产生首条回复后锁定 agent preset
  （409 `agent-preset-locked`）。Tab/`/preset` 只能对空白会话生效；对已开始
  的会话，prompt 体携带 agent 时 bridge 会尝试切换，失败后在第一条消息后
  广播一次「Agent switch locked」提示（按 session+agent 去重）。
- **退出 splash**：官方 opencode 二进制在会话有内容时打印自己的 logo 与
  `opencode -s <id>` 恢复命令，无法替换；dsh-oc 在下方补一行 dsh 恢复说明
  （`DSH_OC_DISABLE_EXIT_NOTE=1` 可关）。
- **--mini**：通过 `POST /session/:id/prompt_async` 提交；退出打断按一次 Esc，
  全量 TUI 连按两次。
- **协议探针**：`scripts/probe-opencode.mjs` 自动扫描 `router.ts` +
  `routes.ts` + `src/bridge/routes/` + `stubs.ts`；新增路由文件需被扫描到。
- **e2e mock LLM**：`tests/e2e/mock-llm.mjs` 包装
  `@deepseek-ai/dsh-llm-mock-server`；长时间流用 `partial_disconnect` +
  `repeatLast`，慢速块用 `chunkDelayMs/chunkSize`（注意 `success` 行为固定
  0 延迟）。env.mjs 启动的 mock 随父进程退出，手动测试要在同一进程内自建。
- **性能回归警惕**：任何在列表/history 请求路径上加同步工作的改动都要跑
  `pnpm run perf -- --sessions 5000` 对比；此前标题补温曾把冷读拖到 10s+。

## 文档入口

- [docs/FEATURES.md](docs/FEATURES.md)：能力矩阵（自动追踪）。
- [docs/PROTOCOL.md](docs/PROTOCOL.md)：协议路由与 SSE 映射。
- [docs/ROADMAP.md](docs/ROADMAP.md)：下一阶段需求。
- [docs/CHANGELOG.md](docs/CHANGELOG.md)：版本变更。
- [docs/perf/results-2026-08-15.md](docs/perf/results-2026-08-15.md)：性能数据。

## 演示录制与发布（README 演示）

面向还没用过 dsh-oc 的用户：用真实模型 + 有意义的任务，不要用 mock 或无意义
任务。GitHub README 不执行 `<script>`，无法直接嵌入 asciinema 播放器；按
asciinema 官方建议用 `agg` 生成 GIF 以 `<img>` 嵌入，cast 源文件保留在仓库。

依赖：`asciinema`（`pip install asciinema`）与 `agg`
（`gh release download -R asciinema/agg -p 'agg-<platform>'` 或
`cargo install agg`）。

1. 在已安装的 dsh 上准备：先手动启动一次 `dsh --profile oc` 预热 opencode
   二进制与缓存，避免正式录制里出现首次下载/解析的长等待。
2. 在 tmux / PTY 中录制，`-i 2` 会把播放时的空闲段压缩到最多 2 秒：
   `asciinema rec --cols 110 --rows 30 -i 2 -t 'dsh-oc demo' -q docs/demo/dsh-oc-demo.cast`
   然后启动 `dsh --profile oc`，用真实模型完成一个有意义的短任务（例如
   「运行 `pnpm test` 并汇报结果」），最后 Ctrl+C 退出并结束录制。保留真实
   启动段（shell 提示符 → 输入命令 → logo），不要裁剪开头；空闲由 `-i` /
   `--idle-time-limit` 压缩。
3. 生成 GIF（README 用）：
   `agg --font-family 'Hack,Noto Sans Mono CJK SC' --idle-time-limit 1 --speed 1.2 --fps-cap 15 --font-size 14 docs/demo/dsh-oc-demo.cast docs/demo/dsh-oc-demo.gif`
   - `Hack` 是等宽字体，`Noto Sans Mono CJK SC` 兜底中文；不要用 SVG 方案，
     尺寸/字体/报错渲染都容易出问题。
   - 可选上传：`asciinema upload docs/demo/dsh-oc-demo.cast`，匿名上传 7 天
     过期，需在 asciinema.org 认领；README 的主嵌入仍是 GIF。

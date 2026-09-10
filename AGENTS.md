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

仓库：`chiro2001/dsh-oc`；npm 包名 `@chiro2001/dsh-oc@0.2.0-rc.4`（未发布
registry，安装/更新走 GitHub 源 `#main` / `#develop`）。

当前 prerelease 面向 dsh `>=0.1.5-rc.2`（0.2.0-rc.3 及以前面向
`>=0.1.2-rc.1`，事件模型不兼容，不再支持）。PR #1/#2/#3 没有原样合入；RC 版本将其
有效语义与 dsh host-services 迁移重新整合，详见 CHANGELOG。

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
      vcs.ts         # 真实 git 信息/状态/diff 路由
      fs.ts          # 工作区文件读取/列表/查找路由
    events.ts        # SSE 事件翻译（assistant-stream、turn.*、message.*、session.*、工具流、权限）
    state.ts         # 桥内存状态（缓存、标题、preset、活动标记）
    file-uploads.ts  # dsh 0.1.5 headless fileUploads provider（见下）
    convert/         # dsh 事件 → opencode 消息/会话/模型/权限转换
    http.ts sse.ts rpc.ts errors.ts stubs.ts git.ts fs.ts
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
pnpm run probe             # opencode 1.18.18 协议路由探针（63/63）
pnpm run e2e               # 全量 e2e（真实 opencode TUI，稳定套件约 15–20 分钟）
pnpm run e2e:api           # API e2e 子集（快速回归）
pnpm run perf              # 会话性能压测（--sessions N --scale ...）
pnpm run features:update   # 刷新 docs/FEATURES.md 自动追踪
bash scripts/check-all.sh --e2e          # 一键全量门槛
bash scripts/check-all.sh --e2e --scale 5000
bash scripts/verify-release-artifacts.sh # 发布工件审计（check-all 内置：lib 零差异、pack 无绝对路径、产物哈希）
bash scripts/e2e-install-rollback.sh     # manual：远端 full SHA 冷装 + TUI smoke + 回滚演练
bash scripts/cleanup-e2e-runs.sh --keep 20 --apply   # 清理 .e2e 旧 run（默认 dry-run）
bash scripts/replay-session-audit.sh <session.jsonl[.zstd]>
                                          # 真实会话回放审计：桥翻译无未处理事件/错误
bash scripts/audit-local-sessions.sh [sessions-dir]
                                          # 批量审计 $DSH_HOME/sessions 全部会话（含消息 id/role 冲突检查）
bash scripts/e2e-recovery-crash.sh        # 故障域：SIGKILL 中途崩溃后 --session 重启恢复
bash scripts/e2e-recovery-sse-reconnect.sh # 故障域：观察者 SSE 断流重连后 exactly-once
node scripts/build-replay-corpus.mjs      # 重新生成 tests/fixtures/replay 合成语料（结构保持，无真实内容）
node scripts/replay-corpus-manifest.mjs   # 扫描真实会话的 feature 覆盖，输出语料覆盖差集（无内容外泄）
bash scripts/e2e-golden-trace.sh          # 冻结/校验 1.18.18 黄金 SSE 轨迹（DSH_OC_GOLDEN_OVERWRITE=1 刷新）
bash scripts/e2e-queued-order-repro.sh    # 工具+排队+后续文本的官方 TUI 顺序复现记录
bash scripts/upgrade-lane.sh --bin <candidate>
                                          # 候选 opencode 升级 lane：黄金轨迹语义差分
bash scripts/update-local-install.sh [ref]
                                          # 更新本地 dsh profile 安装并校验 resolved commit/version
bash scripts/e2e-real-queued-order.sh     # manual：真实模型排队错序 wire/面板证据
bash scripts/e2e-minimal-server-repro.sh  # 官方最小 server 归因：脚本化事件 → 官方 TUI 渲染顺序
scripts/monitor-process-io.sh --pid <pid> --log <tsv> # 默认 observe-only，正常退出静默
scripts/e2e-tui-subagent.sh             # dsh subagent → OpenCode task + child 导航
scripts/e2e-tui-shell.sh                # 官方 TUI `!` shell → OS shell tool card
tests/e2e/fake-opencode-idle.sh           # fake attach 空闲无 EOF 忙循环回归
tests/e2e/monitor-process-io-attach.sh    # exact attach PID/log/无目标 kill shell 回归
 ```

本地直连 dsh profile（实时验证）：`dsh plugin --profile oc add .`；改代码后
`pnpm build` 立即生效（link 方式）。从 GitHub 分支安装验证：
`dsh plugin --profile oc add 'github:chiro2001/dsh-oc#<branch>'`。`#develop`
是可变 ref，pnpm 可能复用旧解析 SHA；重复执行 add 会刷新锁文件，用
`rg 'codeload.github.com/chiro2001/dsh-oc/tar.gz' pnpm-lock.yaml` 核对实际
解析到的 commit。

## 安装、更新与本地开发

使用者只关心安装命令时见 README；Agent/开发者用以下方式验证与更新：

GitHub 源安装/更新（与 README 同款命令，重复执行即更新到该分支最新）：

```bash
dsh plugin --profile oc add chiro2001/dsh-oc                       # #main
dsh plugin --profile oc add 'github:chiro2001/dsh-oc#develop'      # 指定分支
dsh --profile oc --help                                            # 验证版本
```

- `bin/dsh-oc.mjs` 提供 `dsh-oc` 简写（`dsh --profile oc` 参数透传、退出码
  透传）；安装后位于 profile 的 `node_modules/.bin`，README 提供 PATH 指引；
  本机可直接 `ln -sf ~/.dsh/profiles/oc/node_modules/.bin/dsh-oc
  ~/.local/bin/dsh-oc` 让简写常驻 PATH。
- npm 包名 `@chiro2001/dsh-oc` 未发布 registry；安装/更新一律走 GitHub 源。
- 本地开发：`dsh plugin --profile oc add .` 以 `link:` 方式链接仓库，改
  `src/` 后 `pnpm build` 立即生效；但 `lib/` 必须随提交推送，GitHub 直装才
  会包含最新构建产物。

## opencode 二进制与网络策略

- 直接使用官方 opencode 二进制，版本锁定 `opencode-version.json`（当前
  `1.18.18`）；启动时 `resolveOpenCodeBinary` + `verifyOpenCodeVersion` 双重
  校验，显式 `DSH_OC_OPENCODE_BIN` 版本不匹配会直接报错，不回退到 PATH 上
  的其它版本。
- OpenTUI 1.18.18/Bun 的 native 临时文件泄漏由 dsh-oc 隔离到
  `$DSH_HOME/opencode/tmp/tui-<pid>`；正常退出清理，下一次启动回收已退出
  dsh 进程目录。不会搜索任意用户插件缓存，也不会关闭官方版本/完整性校验。
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
- **opencode 按 vendor ABI 对待**：升级候选版本必须以“黄金 HTTP/SSE 轨迹 +
  真实 TUI 回放”的语义差分为门槛，不能只看 SDK 类型与路由数量；为候选
  新版本建独立 upgrade lane，不直接替换锁定版本。
- **真实模型回归定位为 smoke**：`scripts/e2e-real-llm.sh` 覆盖真实文本、
  工具、goal、variant 与 TUI attach，但随机模型输出不承担桥接正确性的
  唯一 oracle；确定性回放语料（脱敏真实 session）是更优先的回归手段。
- **恢复故障域按路径分别验证**：`client-sse-reconnect` /
  `mux-resubscribe` / `process-crash-recovery` 不是同一条重连路径。共享
  oracle 在 `tests/e2e/recovery-lib.sh`（v1/v2 签名、权威 idle、前缀/全图
  比较）；改动 bridge SSE/历史转换时至少跑
  `e2e-recovery-consistency.sh` + `e2e-recovery-crash.sh` +
  `e2e-recovery-sse-reconnect.sh`。

- **status 热路径**：官方 TUI 等待回合时会高频轮询 `/session/status`；bridge
  从 dsh `api-session/status`/`api-session/activity` 维护内存 authoritative map，
  冷启动最多一次有界 `session.list` seed，避免每秒扫描全量持久化 session。
- **SSE 断线契约**：`SseHub` 保留受事件数/序列化字节双上限约束的 ring，消费
  `Last-Event-ID` 严格回放其后的事件；游标淘汰或未知时记录告警并回放当前
  status/control snapshot。每连接不触发 history/list 扫描。
- **e2e TUI I/O 观察**：设置 `DSH_OC_E2E_MONITOR_IO=1` 后，
  `tests/e2e/common.sh` 在 `e2e_tui_wait_attach` 中精确解析当前 run 的
  `opencode attach` PID，以 observe-only monitor 记录到该 run 目录；默认
  `0.25s` / `32MiB` read 窗口可由 `DSH_OC_E2E_MONITOR_INTERVAL` /
  `DSH_OC_E2E_MONITOR_READ_THRESHOLD` 覆盖。监控随目标退出，不按名称结束目标；
  必要清理只允许结束 monitor 自身 PID。需要把正常退出写到 stderr 时显式加
  `--report-exit`；阈值告警无论如何仍写 stderr。
- **兼容边界**：dsh-dcp rc.6 仍读取已移除的 `session.events`，bridge 暂时
  安装 `snapshotEvents()` getter shim；dcp 升级到兼容 dsh 0.1.5 后删除。
- **dsh 0.1.5 host ABI**：
  - `dsh-api-session-controller` 新增硬依赖 `fileUploads`；官方 provider
    （`dsh-client-file-upload`）是浏览器传输插件、inject `connection`，oc-bridge 不挂。
    `@chiro2001/dsh-oc/file-uploads`（`src/bridge/file-uploads.ts`）提供 headless
    实现，必须在 `cordis.patch.yml` 中插在 `session-controller` 之前；`bindPrompt`
    必须返回带 `Symbol.dispose` 的对象（0.1.5 用显式资源管理包裹它，普通对象会
    报 `TypeError: Object not disposable`）。
  - 实时流：`assistant/chunk` 会话事件已删除；改订阅进程内
    `agent/assistant-stream`（`start` 带 turn/step，`chunk` 带 attemptId/revision/
    index + 同一 `StreamChunk` 载荷），`index.ts` 维护 attempt→turn/step 映射并
    feed `session/assistant-stream` 帧；对缺失 start 的迟到帧直接丢弃。
  - 持久化历史：`SessionHistoryRecord` 不再有 `chunks`；`assistant/message` /
    `assistant/attempt` 内嵌 `stream: AssistantStreamRecord[]`。`expandRecord` 把
    packed run 还原成 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 行，
    `assistantStreamTiming` 从 raw `block-start`/`block-end`/`finish` 还原部件时长
    与 finish reason；`assistant/attempt` 在 live/history 都无 TUI surface。
  - `dsh-tool-fs` 的 `write`/`edit` 是 0.1.5 的文件工具（`str_replace_editor` 只
    在 0.1.2 base 行、已 opt-in 化）；新文件 `write` 的 result meta 是空 diffs，
    bridge 从调用参数合成 diff，保证 opencode edit 卡片有 `metadata.diff`。
  - **首回合标签**：所有 provisional 卡片（live SSE、prompt 响应 placeholder、流式
    中 v1/v2 history 合并、shell 合成卡片）必须用
    `state.sessionModelSelectionFor()` + `sessionAgentFor()` 取会话实际值，禁止回退
    到 `build`/`deepseek-chat`；prompt 未携带模型时用
    `placeholderSessionOptionsForPrompt` 回退部署默认模型。TUI 的映射默认 agent
    `build` 由 `applyAgentFromBody` 解析成部署默认 preset，保证首回合显示真实 preset。

## 自测门槛（提交/合并前必须全绿）

1. `pnpm typecheck && pnpm test`
2. `pnpm run probe`（63/63）
3. 涉及协议/桥接/TUI 的改动：至少跑相关 `scripts/e2e-*.sh`；完整回归用
   `bash scripts/check-all.sh --e2e`
4. 发布工件审计：`check-all` 内置 `verify-release-artifacts.sh`（HEAD 干净
   重建后 committed `lib/` 零差异、npm pack 无机器绝对路径、记录产物哈希）；
   单独跑 `bash scripts/verify-release-artifacts.sh`
5. `pnpm run features:update`（涉及能力清单时）并提交结果
6. `lib/` 构建产物随提交；检查机器相关绝对路径：
   `rg -n --hidden -g '!node_modules' -g '!.git' 'chiro' . | rg -v 'chiro2001|/home/chiro/'`

e2e 脚本只允许在 `main` / `develop` 与 `chore-*` / `fix-*` / `docs-*` /
`perf-*` / `test-*` / `feat-*` 分支运行（白名单在 `tests/e2e/common.sh` 与
`tests/e2e/env.mjs`，与 CI 触发分支保持一致）。

## 分支与发布

- `main`：稳定发布线，README 安装命令默认 `#main`。
- `develop`：集成交付线，日常开发与用户实时验证；稳定后回合 main。
- 发布候选（rc.N）按 `docs/RELEASE.md` 执行：版本 bump、全套门禁、
  full-SHA 远端安装/回滚演练、真实模型 smoke、受保护 tag；npm 保持 NO-GO。
- 功能分支：`feat-*` / `fix-*` / `docs-*` / `perf-*` / `test-*` / `chore-*`，
  从 develop 拉出，短生命周期。
- 提交规范：Conventional Commits（feat/fix/docs/perf/test/chore/refactor）。
- 遗留 feat-* 分支均已并入 main；清理工具 `scripts/cleanup-merged-branches.sh`
  （默认 dry-run，`--apply` 本地删除，`--remote` 同步远端）。

## 关键实现约定与陷阱

- **路由注册顺序即匹配顺序**：`src/bridge/routes.ts` 按 boot → session-v1 →
  permission → session-v2 → vcs → fs → SSE 顺序调用；新增路由放在对应域文件。
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
  reasoning part，避免 thinking 一直转圈。0.1.5 的 live 时间来自
  `agent/assistant-stream` 帧的 `time`，冷读来自内嵌 stream 的
  `block-start`/`block-end`（见 `assistantStreamTiming`）。
- **agent preset 锁定**：dsh 在会话产生首条回复后锁定 agent preset
  （409 `agent-preset-locked`）。Tab/`/preset` 只能对空白会话生效；对已开始
  的会话，prompt 体携带 agent 时 bridge 会尝试切换，失败后在第一条消息后
  广播一次「Agent switch locked」提示（按 session+agent 去重）。
- **退出 splash**：官方 opencode 二进制在会话有内容时打印自己的 logo 与
  `opencode -s <id>` 恢复命令，无法替换；dsh-oc 在下方补一行 dsh 恢复说明
  （`DSH_OC_DISABLE_EXIT_NOTE=1` 可关）。
- **--mini**：通过 `POST /session/:id/prompt_async` 提交；流式回合打断按两次
  Esc（与官方 opencode 1.18.18 handler 一致），全量 TUI 也按两次。
- **mini e2e 退出码**：`scripts/e2e-tui-mini.sh` 的三次 C-c 可能由 SIGINT
  结束并返回 130；脚本接受 0/130，但仍必须断言 dsh-oc 退出提示。
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

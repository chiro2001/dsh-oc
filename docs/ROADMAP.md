# dsh-oc 下一阶段需求（Roadmap）

> 本文档是当前用户确认的下一阶段工作清单。新 agent 接续时先读本文，再读 `docs/FEATURES.md`、`docs/PLAN.md`、`docs/PROTOCOL.md`。
> 基线：`main` 当前为协议补全阶段版本（2026-08-16，权限/vcs/fs/lifecycle 已合入）。

## 协议补全记录（2026-08-16）

以下 SDK v2 端点已从 stub/缺失升级为真实实现，全部有单测 + e2e：

- 权限面：`GET /api/permission/request`、`GET /api/question/request`、
  `GET /api/session/{id}/permission/{rid}`、`DELETE /api/permission/saved/{id}`，
  saved 列表对齐 `PermissionSavedInfo`；授权按 session+tool 内存隔离。
- VCS 面：`GET /vcs`、`GET /vcs/status`、`GET /vcs/diff`、`GET /vcs/diff/raw`
  （真实 git 读取，untracked 不进入 status）。
- 文件系统面：`GET /api/fs/read/{path}`（`*` 通配、越界 400、5 MiB 上限）、
  `GET /api/fs/list`、`GET /api/fs/find`（跳过依赖/构建目录）。
- 生命周期面：`GET /global/health`、`POST /global/dispose`、
  `POST /instance/dispose`（dispose 为 no-op 确认，dsh 拥有进程生命周期）。

已实现：`/api/session/{id}/history`（`limit` + `after` 事件 seq 游标，
返回 `{ data: SessionMessage[], hasMore }`，复用 v2 消息转换并带消息锚点
seq，`after` 非负整数否则 400）。

> 2026-08-16 深夜：响应增加 `next`（本页最旧锚点 seq）供独立客户端连续
> 分页；`after` 为**独占上界**（dsh 原生 `beforeSeq`，向后翻页），不再
> 全量折叠后过滤。20k 消息单会话全量分页 ~1.2s、单页延迟有界，基准见
> `docs/perf/results-2026-08-15.md`。

仍为 LATER 的 SDK 路由：`/api/pty/*`（dsh 无 PTY RPC）、`/api/integration/*`
与 `/api/credential/*`（dsh 凭据面未暴露）、`/global/upgrade`（自动更新
明确关闭）。

## 优先级总览

| 编号 | 需求 | 优先级 | 建议分支 | 状态 |
|---|---|---|---|---|
| N1 | 关闭 opencode 子进程自动更新/热更新 | P0 | `feat-no-autoupdate` | ✅ 已完成（2026-08-15） |
| N2 | 流式 toolcall / progress | P0 | `feat-stream-tool` | ✅ 已完成（2026-08-15） |
| N3 | Goal 功能完整支持 | P0 | `feat-goal` | ✅ 已完成（2026-08-15） |
| N4 | 会话性能测试（临时 DB + 生成历史） | P1 | `feat-perf` | ✅ 已完成（2026-08-15） |
| N5 | 协议自测 UT / 升级探针 | P1 | `feat-protocol-ut` | ✅ 已完成（2026-08-15） |
| N6 | README 与 `/help` 展示能力矩阵 | P1 | `feat-capability-help` | ✅ 已完成（2026-08-15） |

建议执行顺序：`N1` 单独先做（影响稳定性和外网）；`N2`/`N3` 可并行；`N4`/`N5`/`N6` 可并行或紧随其后。

## 顶级模型审阅后新增（2026-08-16，round-0001）

外部顶级模型审阅结论：适合受控 RC/canary 交付；下一阶段功能冻结，按
60% 稳定性/一致性、30% 安装发布与 CI、10% 文档投入。接受项与处置见
`expert-advice/round-0001/decision.md`。落地顺序：

- 实验 1：真实事件差分回放 + 恢复一致性 + 已知错序裁决（live/重连/重启/
  `--continue`/`--session` 规范化消息图 exactly-once；10k 事件单会话
  history 冷读/分页基准；官方 TUI 最小复现）。同时给
  `/api/session/{id}/history` 建立分页性能基线。
- 实验 2：`v0.1.0-rc.2` 不可变候选的干净安装/升级/回滚演练（GitHub spec
  冷装、`lib` 与源码一致、旧会话恢复、`dsh-oc` PATH）。
- 实验 3：flake 统计审计（固定 commit × 50 次，按签名分类，保留首败证据；
  之后收紧无条件整脚本重试）。
- 支持矩阵：至少 Linux x64 + macOS arm64 发布冒烟；Windows/ARM 按“声明即
  测”原则收缩。

## 顶级模型审阅后新增（2026-08-17，round-0002）

round-0002 结论：rc.2 当前为条件性 NO-GO；现有恢复一致性测试是 warm/cold
history 投影对比，不是 live SSE 对比，父链断言恒为空。接受项与处置见
`expert-advice/round-0002/decision.md`。调整后的执行顺序：

- 实验 1a（2026-08-17 已完成首轮）：修正恢复 oracle —— 等待权威 idle
  （`/api/session/{id}/wait`）代替固定 sleep；v1+v2 双面签名（v1 父链解析
  非空，v2 逐消息 part + tool name/status/output，用户文本并入），不再
  全局扁平比较。oracle 首跑即发现并修复 v1 warm 历史 `parentID` 未随 surface
  id remap 的悬空父链缺陷；恢复一致性 e2e 29s PASSED，已入稳定套件。
- 实验 1b（2026-08-17 已完成首轮）：三故障域矩阵 ——
  `process-crash-recovery`（SIGKILL 中途中止后 `--session` 重启：持久前缀
  不丢/不伪造完成/可续聊，20s PASSED）、`client-sse-reconnect`（观察者 SSE
  断流重连后消息图 exactly-once，13s PASSED）已入稳定套件；
  `mux-resubscribe` 以单测覆盖（重放 chunk 跨 translator 重建去重）。恢复
  契约（durable exactly-once；崩溃前缀不丢/不伪造完成/回 idle/可续聊；纯
  内存表面列为 transient）仍为实验后续断言基线。
- 实验 1c（2026-08-17 已落地首轮+覆盖扫描）：确定性合成回放语料
  `scripts/build-replay-corpus.mjs` → `tests/fixtures/replay/`（10 个
  fixture，覆盖 reasoning、单/多工具、排队、工具错误、compaction、打断、
  goal、plugin-context、session-title、unfinished-turn），
  `tests/replay-corpus.spec.ts` 断言无未处理/错误、工具配对与终态、live
  完成态与 durable 一致、durable v1/v2 一致，并运行时生成 10k 事件长会话
  用例。语料审计首跑即发现并修复**多工具回合完成态缺陷**（单槽 pending →
  按 message 多槽，turn/end 全部完成）。真实会话 feature 覆盖扫描
  `scripts/replay-corpus-manifest.mjs` 显示 64 会话/58,609 事件的 12 个
  特征已被语料全覆盖（结果见 docs/perf/coverage-real-sessions-2026-08-17.md）。
  官方 1.18.18 黄金轨迹基线已落地（`scripts/e2e-golden-trace.sh` +
  `scripts/normalize-golden-trace.mjs`）：真实 TUI 工具+后续文本场景的桥
  SSE 归一化轨迹（去 id/时间/路径）提交为
  `tests/fixtures/golden/recovery-tool-followup-1.18.18.sse.jsonl`，结构
  可跨运行复现并已入稳定套件。错序复现记录
  `scripts/e2e-queued-order-repro.sh`：慢流工具+后续文本 + 键盘排队第二条
  prompt，逐帧抓拍瞬态顺序并冻结第二份黄金基线
  `tests/fixtures/golden/queued-followup-1.18.18.sse.jsonl`（116 事件）；
  mock 场景连续运行未复现瞬态错序；真实模型版
  `scripts/e2e-real-queued-order.sh`（manual）连续两次复现 wire 前提
  （后续文本 delta 在排队用户事件后继续到达），面板帧 45/50 存在回复内容
  渲染在排队卡片下方。官方最小 server 归因已落地
  （`scripts/minimal-oc-server.mjs` + `scripts/e2e-minimal-server-repro.sh`）：
  用桥组件 + 脚本化事件序列（queued-mid-followup fixture）喂官方 TUI，
  TUI 渲染顺序正确（完整后续文本在排队卡片上方）；桥新增
  `src/bridge/router-entry.ts` 导出（lib/bridge/router-entry.js）供外部
  harness 使用。真实会话原始 JSONL 与完整桥 SSE 轨迹回放已接入（raw
  直放模式），并新增 `SseHub.enqueue` 预连接缓冲；当前 raw 直放下官方
  TUI 仅短暂连接后即断开（接收缓冲冲刷后不保持），对话未渲染，列为后续
  实验项；fixture 回放与真实模型 live 证据已完成。
- 实验 2（2026-08-17 已落地工具与首轮演练）：`v0.1.0-rc.2` 以 full SHA
  为真相源 —— `scripts/verify-release-artifacts.sh` 已加入 check-all 门禁：
  HEAD 源码 clean rebuild 后 committed `lib/` 零差异、npm pack 无机器绝对
  路径、记录 package version/tarball sha256/package-tree hash；
  `scripts/e2e-install-rollback.sh`（manual）从远端 full SHA 冷装候选并跑
  真实 TUI smoke（28s），再回滚到前版 spec 复跑（23s），并探测同 profile
  内 re-add 行为。版本号未 bump 前 in-place 结果不可作为缓存安全证明；
  待 rc.2 版本 bump 后重跑并打受保护 tag。
- vendor ABI 升级 lane（2026-08-17 已落地）：`scripts/upgrade-lane.sh`
  对候选 opencode 二进制跑黄金场景（版本检查经
  `DSH_OC_BYPASS_VERSION_CHECK=1` 旁路，仅手动 lane 使用），归一化轨迹与
  1.18.18 基线语义差分；同版本验证零差异。候选版本升级流程：
  `bash scripts/upgrade-lane.sh --bin <candidate>`，全绿后才考虑更新
  `opencode-version.json`/asset 清单。
- 实验 3：flake 分层统计（最小高风险 case 各 10 次，零失败后扩到 30–60
  次；release-lane 预算 30–45 分钟；语义首败不 retry）。
- 实验 3 首轮（2026-08-17）：`scripts/flake-mini-scan.sh` 已落地；恢复三
  故障域各 10 次全绿（consistency 29–30s、crash 21–24s、sse 15–16s，见
  `docs/perf/results-flake-recovery-2026-08-17.md`）。扫描首跑发现 crash
  oracle 过严（把崩溃边界内未落盘 chunk 的合法恢复判失败），已改为
  “持久前缀 or 尾部文本前缀”语义。
- 实验 3 第二轮（2026-08-17）：queue-live 与 agent-tab 各 10 次全绿
  （19–20s / 11–12s，见
  `docs/perf/results-flake-tui-2026-08-17.md`）；permission 最小 case
  拆分后补跑。
- 实验 3 第三轮（2026-08-17）：permission 最小 case
  `scripts/e2e-tui-permission-mini.sh`（单次 Allow-once，10–11s）首跑
  10/10 全绿并加入 stable 套件；完整 permission 矩阵仍每次回归覆盖。
- `--continue` 完整消息图变体不再优先：保留 `e2e-tui-continue.sh` 选择
  契约，后续可补低成本 `-c` 选择契约。

### 恢复契约（草案，实验 1b 的断言基线）

- 已完成 durable turn：角色、顺序、文本/reasoning、tool
  input/output/error、part 归属和引用关系 exactly-once。
- 进程崩溃时的 in-flight turn：恢复已持久化前缀；不伪造成功；重启后得到
  明确 aborted/idle 终态；下一条 prompt 可被接受。
- title/goal/todo 等持久 projection：冷启动后恢复。
- queued message / pending permission/question：dsh 有权威 snapshot 则
  重发，否则明确取消，不留下不可操作的 TUI 卡片。
- `Allow always`、bridge 合成 command/error 文本等纯内存/临时表面：允许
  不恢复，但文档必须明确列为 transient。

---

## N1. 关闭 opencode 子进程自动更新与热更新

### 背景
oc-tui 以子进程运行官方 `opencode attach`。opencode 自身可能检查新版本、自动下载/热更新，导致：
- 启动时连接外网，可能超时；
- 二进制版本脱离 `opencode-version.json` 锁定，与 dsh-oc bridge 协议不匹配。

### 要求
1. 在 `src/tui/index.ts` 的 `buildChildEnv` 中显式关闭 opencode 自动更新：
   - 先查 opencode 1.18.18 支持的 env/flag：`OPENCODE_DISABLE_AUTOUPDATE`、`OPENCODE_AUTOUPDATE=false`、`OPENCODE_DISABLE_AUTOUPDATE_CHECK` 等，以源码为准。
   - 同时设置 `OPENCODE_DISABLE_UPDATE=true`（如果存在该开关）。
   - 不使用不确定的开关；不确定时用 opencode 源码验证。
2. 避免 opencode 热替换自身：
   - 若官方机制只是“提示更新”，确认不会下载；若可能下载，必须阻止。
   - 对 opencode 数据目录使用只读/隔离目录（现状已在 `$DSH_HOME/opencode` 下），并确保自动更新状态也写入该目录。
3. 版本锁定审计：
   - 运行时解析的 opencode 二进制必须始终 `--version` 匹配 `OPENCODE_VERSION`。
   - 在 `resolveOpenCodeBinary` 后再次校验；不匹配则报错并提示清缓存/指定 `DSH_OC_OPENCODE_BIN`。
4. 网络策略：
   - 子进程不应主动访问 `api.opencode.ai` / GitHub release（除 resolver 明确下载外）。
   - 最好提供 `OPENCODE_DISABLE_NETWORK` 或等价参数，后续桥接层完全控制外网。

### 验收
- 单元测试：`buildChildEnv` 包含所有可用的关闭更新 env。
- 离线 e2e：在 `HTTPS_PROXY/HTTP_PROXY` 指向不可达端口、清空 opencode 缓存后，TUI 仍能在超时内启动。
- `opencode --version` 与 `OPENCODE_VERSION` 不一致时，dsh-oc 明确报错。

---

## N2. 流式 toolcall / progress

### 背景
当前文本/reasoning 已流式，但工具调用只发 pending/final，中间过程不可见。用户需要看到 bash 等工具命令的实际执行情况和进度。

### 要求
1. 翻译 dsh 工具流事件：
   - 至少覆盖 dsh 的 `tool/call`、`tool/call-chunks`（或 `tool-call-chunks`）、`tool/result`。
   - 查 opencode 1.18.18 对应事件：
     - `session.next.tool.input.started`
     - `session.next.tool.input.delta`
     - `session.next.tool.input.ended`
     - `session.next.tool.called`
     - `session.next.tool.progress`
     - `session.next.tool.success`
     - `session.next.tool.failed`
   - 兼容 v1 `message.part.updated` 增量更新 ToolPart（opencode 1.18.18 TUI 实际消费路径）。
2. 工具参数流式：
   - dsh 工具 arguments 按 delta 出现时，TUI 输入区/工具卡应逐步显示。
   - 避免大参数一次性刷新导致卡顿。
3. 工具执行过程：
   - bash/pwsh 输出需要实时 progress，而不是只有最终 output。
   - read/write/edit 文件工具显示阶段标题。
4. 失败与取消：
   - 工具失败、abort、超时在 TUI 显示错误状态和原因。
5. 性能保护：
   - 高频 chunk 事件节流/批处理，避免 SSE 刷屏。

### 验收
- 单测：`tool-call-chunks` → ToolPart input/state 增量。
- API e2e：mock LLM 触发 bash，SSE 中出现 input.delta/progress/success。
- TUI e2e：`tmux capture-pane` 在工具执行中能看到部分命令输出。

---

## N3. Goal 功能完整支持

### 背景
Goal 是 dsh 高频功能，opencode TUI 没有原生 goal UI；dsh-oc 需要把 dsh goal 映射成 opencode 可理解的状态（todo/projection/session 事件/命令）。

### 要求
1. dsh goal 生命周期：
   - `goal/start`、`goal/update`、`goal/end` 等事件翻译为 opencode todo 或 session 消息。
   - 至少让用户看到 goal 标题、状态、步骤。
2. `/goal` 命令：
   - `GET /command` 暴露 `/goal`。
   - 支持创建/查看/切换 goal（若 dsh 有命令注册表）。
3. 会话历史中的 goal：
   - `GET /session/:id/todo` 优先返回 goal 步骤。
   - `GET /session/:id/message` 中 goal 事件映射为系统消息/压缩摘要。
4. 与 plan mode / todo 协作：
   - 当前 todo projection 继续工作，goal 不覆盖 todo。

### 实现状态（2026-08-15）

- `goal/change` 与 `goal` 投影 → 合并 `todo.updated`（goal 为首条 sidebar todo，
  `active → in_progress`、`paused/blocked → pending`、`complete → completed`）。
- `GET /session/:id/todo` 优先返回 goal（投影或历史事件折叠），dsh todos 保留在后。
- `GET /command` / `GET /api/command` 注册 `/goal`；`POST /session/:id/command` 与
  prompt 路由捕获 `/goal [objective|clear|edit ...|pause|resume]`，经 dsh command
  registry 执行并广播 busy/idle 结果。
- v1/v2 历史消息把 `goal/change` 折叠为 assistant 文本 note。
- 验收：`tests/convert/goal.spec.ts`、`tests/bridge-events.spec.ts`、
  `tests/bridge-router.spec.ts`、`scripts/e2e-api-goal.sh`、
  `scripts/e2e-tui-goal.sh`（真实 TUI sidebar 可见 goal）全部通过。

### 验收
- 单测：goal 事件 → todo/session 消息。
- API e2e：创建 goal、goal 步骤变化可见。
- TUI e2e：用户能看到 goal 状态并继续任务。

---

## N4. 会话性能测试

> 状态：已完成（2026-08-15）。实现见 `scripts/perf.mjs`、`scripts/perf-session-gen.mjs`，
> 单测见 `tests/perf.spec.ts`，示例报告见 `docs/perf/report-example.json`。
> 运行：`pnpm run perf -- --sessions 1000 --messages-per-session 6 --tools --todos --children 10`。

### 背景
需要模拟大量 dsh session 历史，验证列表/搜索/SSE/history 的体验性能。

### 要求
1. 生成器：
   - 用临时 DSH_HOME + SQLite/JSONL 直接生成 dsh session 历史，数据可来自：
     - `~/.codex/history.jsonl`
     - opencode 历史 JSONL
     - 合成 fixture
   - 支持 `--sessions N`、`--messages-per-session M`、`--turns K`、`--tools`。
2. 指标：
   - `GET /session` 冷启动/热启动延迟
   - `GET /session/:id/message` 分页延迟
   - SSE 首次事件延迟
   - 1000/5000/10000 sessions 下的内存占用
3. 场景：
   - 冷启动：无 profile 缓存
   - 热启动：已加载 profile
   - 大量 subagent child
   - 大量 todos/produced-files
4. 输出：JSON/文本报告，包含 p50/p95/max。

### 验收
- `pnpm run perf` 可重复运行。
- CI 可选跑 smoke 规模（例如 1000 sessions）。
- 若有 >500ms 的明显退化，记录问题并修复。

### 实测基线（本机，30 会话 × 4 消息，2026-08-15）
- boot（bridge URL 就绪）：约 0.8s
- `GET /session` p50 ≈ 14ms / p95 ≈ 28ms（含冷启动首请求）
- `GET /session/:id/message?limit=50` p50 ≈ 15ms / p95 ≈ 40ms
- SSE 首事件（触发后）：< 1ms
- dsh 进程 RSS：约 250 MB
- 更多数字见 `docs/perf/report-example.json`；大规模场景（1000/5000/10000）请在本机完整运行。

---

## N5. 协议自测 UT / opencode 升级探针

### 背景
opencode 版本升级后，API 路由/类型可能变化；需要用户可自助跑协议自测。

### 要求
1. 现有 `tests/bridge-router.spec.ts` 继续作为核心 UT。
2. 新增协议探针脚本：
   - `scripts/probe-opencode.sh` 或 `scripts/probe-opencode.mjs`
   - 可指定 `OPENCODE_VERSION` 和 opencode 二进制路径。
   - 启动真实/本地 opencode server 或 mock bridge，抓取启动请求。
3. 输出兼容报告：
   - 缺失路由
   - 路由 method/query 变化
   - SDK schema 变化
4. 升级流程：
   - 更新 `opencode-version.json`
   - 运行 `node scripts/update-opencode-assets.mjs`
   - 运行 probe
   - 更新 `docs/PROTOCOL.md` 兼容矩阵
5. 可选：缓存多版本 SDK 类型，diff 生成报告。

### 验收
- 在当前 1.18.18 上运行 probe 全绿。
- 模拟一个缺失路由时，probe 报错并给出修复建议。

---

## N6. README 与 `/help` 展示能力矩阵

### 背景
用户需要明确知道哪些原版 opencode 功能可用、哪些是 stub/不支持。

### 要求
1. README：
   - 增加“能力状态”表格，引用 `docs/FEATURES.md`。
   - 用 ✅ / 🟡 / ❌ 标注：可用、部分可用、不可用。
   - 明确网络、自动更新、二进制锁定策略。
2. `/help`：
   - `dsh --profile oc --help` 输出应展示：
     - 版本
     - 支持的 attach 参数
     - 核心能力摘要
     - 已知限制
     - 文档入口
   - 可复用 `docs/FEATURES.md` 自动生成。
3. 动态更新：
   - `scripts/update-feature-matrix.mjs` 同时更新 README 和 FEATURES.md。
   - 新功能落地必须更新矩阵，否则 UT 失败。

### 验收
- README 与 FEATURES.md 内容一致。
- `dsh --profile oc --help` 能看到能力矩阵。
- `pnpm run features:update` 后 git diff 最小。

---

## M 系列：维护与工程化（2026-08-15 起）

功能主线（N1–N6）完成后进入维护阶段，目标是把项目做成可持续迭代、易参与、
易验证的仓库。当前处于 `develop` 分支集成交付模式。

### 优先级总览

| 编号 | 方向 | 状态 |
|---|---|---|
| M1 | 文档与已知限制同步 | ✅ README（用户）与 AGENTS.md（Agent/开发）分离，CHANGELOG/FEATURES 自动追踪 |
| M2 | 开发流程与 CI | ✅ CI 覆盖 `main`/`develop`/`feat-*`/`fix-*`/`docs-*`/`perf-*`/`test-*`/`chore-*`；push 自动跑稳定 e2e 套件，手动触发全量 e2e + 压测 |
| M3 | 社区贡献流程 | ✅ `CONTRIBUTING.md`、PR 模板、Issue 模板（bug/feature） |
| M4 | 分支策略与清理 | ✅ `scripts/cleanup-merged-branches.sh`（dry-run 默认）；历史 `feat-*` 已全部并入 main |
| M5 | 重构（router 拆分/缓存统一） | ✅ 路由注册按域拆到 `src/bridge/routes/`；缓存/在途合并与失效 generation 已统一 |

### M1 文档

- README 已知限制与 `docs/FEATURES.md` 保持一致；新增行为（如退出 splash 说明）必须
  同步两处。
- 涉及能力清单的改动运行 `pnpm run features:update` 并提交自动追踪结果。

### M2 开发流程

- 单测/探针/性能冒烟由 `scripts/check-all.sh` 一键执行；完整 e2e 用 `--e2e`。
- GitHub Actions：`ci.yml` 自动跑 build/typecheck/test/probe；`e2e.yml` push
  自动跑稳定 e2e 套件、手动触发全量 e2e 与压测。
- e2e 分支白名单：`main` / `develop` 与 `chore-*` / `fix-*` / `docs-*` /
  `perf-*` / `test-*` / `feat-*`。

### M3 社区贡献

- 开发环境、分支策略、提交规范与自测门槛见 `CONTRIBUTING.md`。
- Issue/PR 模板位于 `.github/`，按模板填写。

### M4 分支策略与清理

- `main` 稳定发布、`develop` 集成交付、短生命周期功能分支。
- 已并入 `main` 的历史 `feat-*` 分支可安全清理：
  `bash scripts/cleanup-merged-branches.sh`（dry-run 先看，`--apply` 删本地，
  `--remote` 同时删远端；工作树中仍检出的分支会跳过）。

### M5 重构（已完成）

- 路由注册按域拆到 `src/bridge/routes/{boot,session-v1,session-v2,permission}.ts`，
  `router.ts` 从约 2200 行降到约 1600 行，协议探针自动扫描路由目录。
- `InteractionState` 缓存/在途合并/失效 generation 统一管理。
- 后续可选：`tests/e2e/common.sh` tmux/等待辅助收敛、helper 进一步下沉
  （当前命令域 helper 互相耦合，收益有限，暂不拆）。

---

## 统一验收门槛

1. `pnpm install && pnpm build && pnpm typecheck && pnpm test` 全部通过。
2. 相关 e2e 脚本全部通过，且新增脚本覆盖新功能。
3. `docs/FEATURES.md` 自动部分刷新；README/ROADMAP 更新。
4. `lib/` 构建产物提交。
5. 每个分支独立 commit，集成后再合并 main 并推送。

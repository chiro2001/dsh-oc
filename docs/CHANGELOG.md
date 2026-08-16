# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号遵循 semver。当前 npm 包名 `@chiro2001/dsh-oc`，尚未发布 registry，
安装/更新走 GitHub 源（`#main` / `#develop`）。

## [Unreleased]

### 新增

- `bridge-router.spec.ts` 新增分页边界不变量测试：`limit` 切过工具回合时，
  `after`/`next` 以已转换消息的最旧 seq 为锚点，工具事件（tool/call、
  tool/result 不独立成消息）整体落在同一侧页，跨页合并后工具 part 恰好
  一次且为 completed。
- `AGENTS.md` 更新 e2e 时长表述（稳定套件已扩展到约 15–20 分钟）。
- `docs/ROADMAP.md` 修正 LATER 说明：`/api/credential/*` 实际存在 dsh
  `credentials.describe/set/unset` RPC，但 opencode SDK 1.18.18 无消费
  路由，维持 LATER 待上游协议出现。
- `docs/RELEASE.md` 增加“当前候选就绪状态（12ca493）”汇总：本地/CI 门禁、
  flake/性能/真实模型/安装链路/归因实验证据一览。
- `dsh-oc --version` 在 dsh 缺失时与其他路径一致：退出 127 并输出安装提示
  （此前以 1 退出且无提示）；新增 bin 单测。
- `docs/PROTOCOL.md` 补齐 v2 路由表：`/api/session/{id}/history`
  （`after` 独占上界 + `next` 游标语义）、`prompt`/`model`/`agent` 端点，
  并注明跨页分页不变量。
- `e2e-tui-turn.sh` 增加工具 part 恰好一次断言：历史中 bash 工具卡片只能
  出现 1 次（“动态工具调用两次相同显示”回归项）。
- `e2e-tui-preset-inherit.sh`：对话前 `/preset minimal`（含选择器确认
  Enter）后创建新会话，断言新 dsh 会话继承 minimal preset（“对话前
  /preset 无法改变 preset”回归项）；已入稳定套件，本地 3/3 通过。
- `scripts/update-local-install.sh`：一键把本地 dsh profile 更新到指定
  GitHub ref，并校验 resolved commit 与 `dsh-oc --version` 双版本输出。
- 工件审计新增 pack 内容校验：tarball 不得含 `src/`，且
  `bin/dsh-oc.mjs`、`lib/index.js`、`lib/bridge/router-entry.js`、
  `opencode-version.json`、`cordis.patch.yml` 必须在包内。
- `e2e-queued-order-repro.sh` 稳定性修复：第二条 prompt 改为在工具 part
  出现（而非完成后）即发送，保证仍处于 busy 窗口、QUEUED 徽标必然出现；
  后续文本加长到 15 段。本地 10/10 flake 扫描通过（48s/次），修复 CI
  slow-runner 下 “queued prompt not shown” 的失败；queued-followup 黄金
  基线已刷新到新场景（180 事件）。
- 5000 会话性能基准记录（commit `609ccd6`）：列表/消息/历史/分页/标题补温/
  RSS 数据见 docs/perf/results-5000-2026-08-17.md，与 8-15 基线量级一致。
- `e2e-real-llm.sh` 强化断言（round-0002 指出真实回归偏弱）：queue probe
  现在验证 FIFO 内容顺序（第二条 prompt 是最后一条 user、最后回复含“完成”），
  不再只数 user 总数；TUI 键盘输入改为等待投递与回复 idle，并断言恰好新增
  一条 user 且面板留档。顺带修复 TUI 阶段 bridge URL 未刷新的潜在 bug，
  `wait_idle`/计数函数对瞬时 API 失败容错。
- flake 合并基线：6 个最小高风险脚本各 10 次共 60 次首跑全绿（当前 HEAD），
  结果见 docs/perf/results-flake-consolidated-2026-08-17.md。
- `e2e-cli-bin.sh` 增加 `dsh-oc --version` 断言：输出必须是
  `dsh-oc <semver> (dsh <version>)` 双版本格式。
- `SseHub.enqueue`：无客户端连接时缓冲事件，首个 SSE 客户端接入时立即
  冲刷（raw 回放/恢复场景的晚连接不再丢事件）；新增单测锁定缓冲与即时
  广播行为。
- 最小 server 支持 raw SSE 直放模式（`minimal-oc-server.mjs --sse <trace.raw>`）：
  把录制的桥 SSE 事件按原序广播给官方 TUI；复现驱动支持自定义 marker、
  事件延迟、CJK 启发式与抓拍时长（`DSH_OC_MINIMAL_*`）。真实会话原始
  JSONL 与完整桥 SSE 轨迹的回放均已接入：fixture 回放渲染顺序正确；raw
  直放定位到官方 TUI 的 `/global/event` 连接为短暂探针（fixture 模式依赖
  连接内流式事件在窗口内送达，外部广播窗口太短），暂不渲染对话，列为后续
  实验项；截取关键区段 + 80ms 慢速重放仍未渲染，raw 直放路线关闭（工具
  保留）；raw 模式下 mux 保持挂起避免桥主动断连。`e2e-real-queued-order.sh`
  改为首个 prompt 前开始录全量 `/global/event` 轨迹，真实模型连续三次
  复现 wire 前提。
- 官方最小 server 归因 harness：`scripts/minimal-oc-server.mjs` 用桥组件 +
  脚本化事件序列（无 dsh、无真实模型）提供完整 OpenCode 兼容面，
  `scripts/e2e-minimal-server-repro.sh` 驱动官方 1.18.18 TUI attach 并
  逐帧分析排队/后续文本顺序；首次运行官方 TUI 渲染顺序正确（后续文本在
  排队卡片上方）。桥新增 `src/bridge/router-entry.ts` 构建入口导出
  `createBridgeRouter`/`startBridgeServer` 供 harness 使用。
- 真实模型排队错序复现 `scripts/e2e-real-queued-order.sh`（manual，真实
  DeepSeek API）：工具完成后立即键盘排队第二条 prompt，记录 bridge SSE
  时序证据（后续文本 delta 是否在排队用户事件后到达）与流式面板帧；
  连续两次运行 `wire_follow_after_queued=1`，面板 45/50 帧回复内容渲染在
  排队卡片下方。同时修正 e2e-real-llm/e2e-real-queued-order 的
  `DSH_OC_REAL_KEEP_RUN=1` 清理逻辑（此前反向，keep 时反而删除）。
- 候选 opencode 升级 lane `scripts/upgrade-lane.sh`：对候选二进制跑黄金
  场景并把归一化 SSE 轨迹与 1.18.18 基线语义差分（`--bin`/`--out`），
  同版本验证零差异；版本检查旁路 `DSH_OC_BYPASS_VERSION_CHECK=1` 仅作用于
  lane 场景，生产路径仍强制版本一致。
- 错序复现记录 `scripts/e2e-queued-order-repro.sh`：工具+慢流后续文本期间
  从键盘排队第二条 prompt，逐帧抓拍官方 TUI 面板顺序（瞬态错序检测），并
  冻结第二份 1.18.18 黄金 SSE 基线
  `tests/fixtures/golden/queued-followup-1.18.18.sse.jsonl`；mock 驱动连续
  运行未观察到瞬态错序，记录作为 renderer/bridge 归因证据。
- 1.18.18 黄金 SSE 轨迹基线：`scripts/e2e-golden-trace.sh` 在真实 TUI 上
  跑“工具+后续文本”场景并用观察者 SSE 录轨，`scripts/normalize-golden-trace.mjs`
  归一化（去随机 id、绝对时间、机器路径），基线提交到
  `tests/fixtures/golden/`；重复运行结构一致，已入 stable 套件，供未来
  vendor 升级语义差分。
- 最小 permission e2e `scripts/e2e-tui-permission-mini.sh`：真实 TUI 单次
  Allow-once 循环（弹窗 → 批准 → 工具完成 → 恰好一次回复 → 无残留权限），
  10–11s；已入 stable 套件，flake 扫描 10/10 全绿。
- flake 扫描第二轮：`e2e-tui-queue-live.sh` 与 `e2e-tui-agent-tab.sh`
  各 10 次首跑全绿（此前 CI 偶发 flake 的两个脚本），结果见
  docs/perf/results-flake-tui-2026-08-17.md。
- 真实会话 feature 覆盖扫描 `scripts/replay-corpus-manifest.mjs`：只输出
  事件类型/特征计数，不接触真实内容；64 个真实会话的 12 个特征已全部被
  合成语料覆盖（long-session 由 spec 运行时生成覆盖），报告见
  docs/perf/coverage-real-sessions-2026-08-17.md。
- 确定性回放语料（实验 1c）：`scripts/build-replay-corpus.mjs` 生成 10 个
  结构保持的合成 fixture（reasoning、单/多工具、排队、工具错误、compaction、
  打断、goal、plugin-context、session-title、unfinished-turn）到
  `tests/fixtures/replay/`；`tests/replay-corpus.spec.ts` 回放审计：无未处理/
  翻译错误、工具调用配对且终态、live 完成态与 durable 一致、durable v1/v2
  消息面一致、运行时 10k 事件长会话。
- 预算化 flake 扫描 `scripts/flake-mini-scan.sh`：对最小高风险 e2e 脚本
  重复 N 次（默认 10），记录首败与耗时，语义失败立即停止且不重试；恢复
  三故障域首轮各 10 次全绿（结果见 docs/perf）。
- 恢复 oracle 增加崩溃语义：`recovery_assert_crash_prefix` 允许重启图是
  观察图的完整消息前缀，或等长时最后文本 part 是观察文本的前缀（SIGKILL
  落在最后 chunk 落盘边界内属正常崩溃一致性，不是数据丢失）。
- 发布工件审计 `scripts/verify-release-artifacts.sh`（已入 `check-all` 门禁）：
  从 HEAD 源码干净重建并断言 committed `lib/` 零差异；npm pack 扫描机器
  绝对路径；输出 package version、tarball sha256 与 package-tree hash。
- 安装/升级/回滚演练 `scripts/e2e-install-rollback.sh`（manual）：从远端
  GitHub full SHA 冷装候选并跑真实 TUI smoke，回滚到前版 spec 复跑，同
  profile 内探测 re-add 行为；版本 bump 前 in-place 结果仅作命令路径验证。
- 恢复故障域 e2e 矩阵：
  - `scripts/e2e-recovery-crash.sh`：SIGKILL dsh 在慢流中途，`--session`
    重启后断言持久前缀 exactly-once（不丢、不伪造完成）、会话回 idle（必要时
    显式取消在途回合）且新 prompt 可继续（20s）。
  - `scripts/e2e-recovery-sse-reconnect.sh`：观察者 SSE 断流重连，断言重连
    后继续收事件且最终 v1/v2 消息图 exactly-once（13s）。
  - mux 重订阅单测：重放的 text-chunks 跨 translator 重建由连接级 replay
    guard 去重，不重复发送 delta。
- 恢复断言 helper 收敛到 `tests/e2e/recovery-lib.sh`（v1/v2 签名、权威
  idle、前缀/完全一致比较），`e2e-recovery-consistency.sh` 复用同一 oracle。
- `GET /api/session/{id}/history`：SDK v2 历史端点（`limit` + `after` 事件
  seq 游标），返回 `{ data: SessionMessage[], hasMore, next }`；`after` 为
  独占上界（dsh 原生 `beforeSeq`，向后翻页），单页延迟有界；v2 消息转换
  新增消息锚点 seq 记录，`after` 为负数返回 400。
- 后台子代理能力开启：`GET /experimental/capabilities` 返回
  `{ backgroundSubagents: true }`，并新增
  `POST /experimental/session/{id}/background` no-op 成功路由（dsh 会话
  服务端常驻，`subagent` 工具默认后台运行）。
- `GET /session/{id}/children`：按 `parentSessionId` 返回 subagent 子会话
  列表，配合后台子代理能力供 TUI 子代理树查询。
- `GET /experimental/session`：GlobalSession 列表（支持 search/目录过滤/limit
  子集），补齐 experimental 会话列表面。
- `POST /session/{id}/init`：no-op 成功 `true`（dsh 会话创建即初始化）。
- `GET /session/{id}/message/{messageID}`：单条消息查询（v1 转换复用，
  未找到返回 404）。
- `POST /session/{id}/permissions/{permissionID}`：SDK v2 权限回复别名
  （body 用 `response` 字段），映射到同一 `permissionReply`。
- `GET /api/health`：返回 `{ healthy: true }` 供客户端探活。
- `GET /api/session/active`：返回当前活动会话（`{ data: { [sessionId]: { type: "running" } } }`）。
- `POST /api/session/{id}/wait`：有界轮询等待会话空闲（≤30s，空闲 204）。
- `GET /api/session/{id}/context`：返回 `{ data: SessionMessage[] }`（v2 消息转换复用）。
- `GET /api/session/{id}/event`：按会话过滤的 SSE 事件流（`/global/event` 子集）。
- `GET /api/session/{id}/message/{messageID}`：v2 单条消息查询（`{ data: SessionMessage }`）。
- `GET /api/provider/{id}`：单 provider 查询（`{ location, data: ProviderV2Info }`）。
- SDK v2 权限面补全：`GET /api/permission/request`、`GET /api/question/request`
  （全局 pending 列表，`{ location, data }`）、`GET /api/session/{id}/permission/{rid}`
  （单条查询，session 不匹配 404）、`DELETE /api/permission/saved/{id}`
  （删除 `sessionID:toolName` 内存授权）；`GET /api/permission/saved` 输出对齐
  SDK `PermissionSavedInfo`（`projectID/action/resource`，保留 `sessionID/grantedAt`）。
- 真实 VCS 面：`GET /vcs`、`GET /vcs/status`、`GET /vcs/diff`、`GET /vcs/diff/raw`
  从 stub 升级为真实 git 读取（当前分支、origin 默认分支、staged+unstaged
  文件状态与行数、每文件/原始 unified diff；untracked 不进入 status）。
- 工作区文件系统面：`GET /api/fs/read/{path}`（原始字节，越界路径 400，
  单文件 5 MiB 上限）、`GET /api/fs/list`、`GET /api/fs/find`（递归查找，
  跳过依赖/构建目录并限制结果数）；路由匹配新增尾段 `*` 通配支持。
- 生命周期面：`GET /global/health`（`{ healthy: true, version }`）、
  `POST /global/dispose` 与 `POST /instance/dispose`（no-op 确认，进程由 dsh 管理）。
- 会话列表真实标题补读：dsh `session.list` 不返回 title 投影，bridge 按会话
  补读 history tail 投影并缓存（≤40 全量同步；更大列表不阻塞，后台低并发
  补最近 24 个、并发 2），恢复的旧会话也会在退出提示中正确识别。
- Esc 打断/取消：`turn.wait` / `turn.idle` 事件驱动 TUI 运行态；全量 TUI
  连按两次 Esc、`--mini` 按一次 Esc 会调用 `session.cancel` 停止在途流。
- `/preset` 新会话继承：最近选择的 agent preset 会应用到后续 `/new` 创建的
  会话；切换后广播 `session.updated` 携带新 agent。
- 退出提示说明：opencode 官方退出 splash（全量/`--mini`）无法替换，dsh-oc
  在会话有内容时于其下方输出一行说明（session id 属于 dsh，恢复用
  `dsh --profile oc --session <id>`）；`DSH_OC_DISABLE_EXIT_NOTE=1` 可关闭。

### 工程化

- CI e2e 每个脚本带 `timeout -k` 执行（默认 300s，`E2E_TIMEOUT` 可覆盖），
  挂死套件快速失败并重试一次，不再拖住整个 job。
- CI 失败工件改为打包上传（排除 `node_modules` 与 `work/.git`），上传步骤
  限时 5 分钟，避免 `.e2e` 上传挂起数小时。
- `scripts/cleanup-merged-branches.sh` 现在同时枚举本地与远端已合并分支
  （dry-run 即可列出 `origin/feat-*`、`origin/chore-*` 遗留），
  `--apply --remote` 可一键清理。
- `CONTRIBUTING.md`、PR/Issue 模板、分支策略（main 发布 / develop 集成 /
  短生命周期功能分支）。
- CI：push 到 `main`/`develop`/`feat-*`/`fix-*`/`docs-*`/`perf-*`/`test-*`/
  `chore-*` 自动跑稳定 e2e 套件（`CI_E2E_SUBSET=1`）；手动触发全量 e2e + 压测。
- M5 重构：路由注册从 `router.ts` 抽出，并按域拆分为
  `src/bridge/routes/{boot,session-v1,session-v2,permission}.ts`；
  协议探针自动扫描路由目录。
- `scripts/cleanup-merged-branches.sh`：列出/删除已并入 main 的遗留分支
  （默认 dry-run，`--apply` 本地删除，`--remote` 同步删除远端）。
- `scripts/cleanup-e2e-runs.sh`：清理 `.e2e` 下旧的 e2e run 目录
  （默认 dry-run，`--keep N` 保留最近 N 个，`--apply` 删除；测试产物可再生）。
- `pnpm run e2e` / `pnpm run e2e:api`：一键跑全量或 API 子集 e2e。
- `scripts/e2e-tui-permission.sh`：真实 TUI 权限/提问 e2e（workspace-write +
  mock LLM 升级工具调用），覆盖 Allow once、Allow always + 会话内自动放行、
  Reject（错误回传且不落盘）、`ask_user_question` 选项对话框，以及
  `--mini` 模式下的 once/always+自动放行/reject/question 与单次回复渲染。
- `scripts/e2e-api-permission.sh`：API 权限 e2e 补全（v1 once 不落授权、
  v2 always/别名 reject、保存授权不跨会话泄漏、删除后重新询问、question
  第二选项回复与 v2 reject、400/404 错误分支）。
- `scripts/e2e-tui-permission-ext.sh`：TUI 键盘面扩展（question 选项 Down
  高亮移动、question Esc 取消、permission Esc=reject：standard 直接拒绝、
  `--mini` 先弹确认层）。
- `scripts/e2e-tui-mini.sh`：`--mini` 优雅退出（三连 Ctrl+C）后断言 dsh-oc
  退出提示可见。
- `scripts/e2e-tui-continue.sh`：种子会话带显式标题，`--continue` 恢复后断言
  会话列表返回真实标题（历史“恢复会话无标题”回归项）。
- `scripts/perf.mjs` 新增 `measurements.titleCoverage`：量化列表真实标题覆盖率。
- `e2e-tui-abort.sh`：mini 分支改为等 SSE 出现真实流式增量后再按 Esc，断言确实
  打断进行中的流（长 mock 开启 `repeatLast`，修复此前第二次请求被 500 拒绝的假通过）。
- `e2e-tui-queue.sh`：权限弹窗阻塞第一轮时发送第二条 prompt，断言 TUI 显示
  QUEUED，批准后第二条按序处理。
- `e2e-tui-queue-live.sh`：慢流进行中从 TUI 键盘发送第二条 prompt，断言 QUEUED
  显示后打断并干净退出（“模型运行中无法发送新消息”回归项）。
- `e2e-tui-agent-tab.sh`：Tab 切换 agent 后随 prompt 生效，dsh 会话 preset
  真实切换（build → standard）。
- `e2e-tui-abort.sh` 追加 spinner 停止断言：打断后两次捕获不得出现变化的
  spinner 帧（“打断后 thinking 一直转圈”回归项）。
- `scripts/e2e-real-llm.sh`：本地真实 LLM 全流程回归（headless 文本+工具、
  FIFO 队列顺序、`/goal` 创建、variant 保留、TUI sidebar 与发送、干净退出；
  仅本地手动运行，消耗真实 token）。
- README 按评审精简：能力状态前置、移除 cast 录制细节（保留在 AGENTS.md）、
  二进制说明只保留“官方二进制”，补充更新命令与 npm 包名说明。
- README 演示改为真实模型录制的 GIF：asciinema cast（`docs/demo/`）经官方
  `agg` 渲染成 GIF 嵌入 README（GitHub 不执行 `<script>`，无法用播放器脚本），
  cast 保留供 `asciinema play` 交互回放；录制用真实 DeepSeek 模型完成真实任务，
  不用 mock。
- 报错显示：dsh `host/agent-error` 现在除了 `session.error` 还会广播一条可见的
  assistant 文本消息（`[错误] …`），TUI 对话区能直接看到错误，不再静默或渲染异常。
- 排队消息可见：dsh pending inbox（`session/queue` 初始化 +
  `agent/inbox/spliced` 增量）映射为 opencode 用户消息，TUI 显示 QUEUED；
  同时移除 300ms 相同文本防抖（掩盖“排队无反馈→用户重发”的根因）。
- `tool-call-chunks` 历史回放：dsh 持久化主流编码（真实会话 701 vs 39 条
  live delta）经共享 feed 管线恢复流式工具参数。
- slash 命令队列提示：`/goal`、`/preset`、`/help` 执行时若队列还有待处理
  用户消息，结果末尾追加“队列中还有 N 条消息待处理”。
- 已知日志型会话事件（`step/start`、`request/header|context`、
  `session/title-llm-request`、`permission/preset`、`sandbox/mode`、
  `approval/policy`、`command/run|done`）显式静默，真正未知类型仍打日志。
- 顶级模型 round-0002 审阅（gpt-5.6-sol / max）：确认 rc.2 为条件性
  NO-GO，恢复一致性主证据需从 warm/cold history 投影升级为 v1+v2 双面
  oracle；`--continue` 消息图变体延后，优先三故障域（SSE 断线、mux 重订阅、
  进程崩溃）与 full SHA 不可变安装/升级/回滚演练；错序归因措辞降为中性
  已知限制，待官方 1.18.18 最小复现。

### 修复

- 同一回合存在多个含 tool-call 的 assistant 消息时，turn/end 现在为**每个**
  工具消息补发 completed（此前 pending 完成态是单槽，只有最后一个工具
  消息收到 completed，前面的工具卡在 live 视图缺少完成态；语料审计首跑
  发现并修复，新增多工具完成态单测）。
- v1 历史消息的 `parentID` 现在随桥接 surface id 一起 remap：此前 warm
  进程内父链仍指向原始 dsh id，消息 id 却已换成桥接 id，导致客户端无法在
  返回列表内解析父链（cold `--session` 无映射反而能解析）；修复后 warm/cold
  v1 图在规范化索引下一致。
- `e2e-recovery-consistency.sh` 升级为恢复一致性双面 oracle：等待权威
  idle（`POST /api/session/:id/wait`）代替固定 sleep；同时比较 v1（父链/
  part 归属）与 v2（逐消息 parts，用户文本并入）；工具 part 纳入
  `name/status/output`，并断言至少一个 completed 工具输出与父链全部可解析
  （不再是无父链空断言）。
- 首条回复不再重复渲染：dsh 注入的插件上下文消息（`Current runtime
  context`）不再覆盖“父锚点”，助手消息始终使用为该 prompt 注册的桥接 id，
  与历史接口 id 一致，TUI 只渲染一次。
- 对话前 Tab / `/preset` 切换 preset 后，TUI 侧边栏 agent 标签不再回退：
  bridge 按会话跟踪真实 agent，并贯穿用户消息、助手消息、`session.updated`
  与 v1/v2 历史；prompt 回显在 agent 应用后再广播；助手消息补齐官方运行时
  的 `agent` 字段。
- 流式错误在侧边栏显示可读文本：`session.error` 按官方判别联合
  （`UnknownError` / `MessageAbortedError` / `ProviderAuthError`）发出，
  不再渲染成 `[object Object]`。
- v1/v2 历史按桥接 id 合并同回合的工具调用与后续文本为单条消息，与实时
  SSE 一致（此前历史返回两条同 id 消息，TUI 合并后会把工具卡/文本重复
  渲染）；“工具+排队”即时视图错序为官方 TUI 1.18.18 中观察到的显示限制
  （bridge 持久数据正确，`--session` 重新进入顺序正确；具体归因待官方
  最小复现实验闭合）。
- `turn/end` 跳过已定稿消息的 pending 完成时同时删除记录，避免残留到下一
  回合补发重复的 `message.updated`。
- `/api/session/active` 只在会话实际 `running` 时返回该会话，空闲/不存在时返回
  `{ data: {} }`（此前无条件标记为 running）。
- 文档化 SSE 文本 delta 成对重复的已知行为（dsh 双编码 + mux 重放；TUI 以
  `message.updated` 全量文本渲染，实测不受影响）。
- Thought（reasoning）时长：`end` 改为最后一条 reasoning chunk 的时间，不再错误地
  等于整条回复的完成时间（历史读取与实时流均生效）。
- 打断/流式转圈：text 块开始时立即关闭 reasoning part（带 end 时间）；中断
  （无最终 assistant/message）时 turn/end 也会关闭仍打开的 reasoning part，
  TUI 的 thinking 指示不再一直转圈。
- Tab/agent 选择随 prompt 生效：v1/v2 全部 prompt 路由现在会应用请求体里的
  `agent`；dsh 对已产生回复的会话锁定 agent preset（409），此时第一条消息后
  会在 TUI 显示一次“Agent switch locked”提示，不再静默失效。
- 含未完成工具调用的 assistant 消息不再提前标记 `completed`，`step/end` /
  `turn/end` 时补发，官方 TUI 的 QUEUED 判定（最后一个未完成 assistant 之后
  的用户消息）正确生效。

## [0.1.0-rc.1] - 2026-08-15

### 新增

- 基于 OpenCode 1.18.18 的 HTTP/SSE bridge 与真实 TUI attach。
- DSH OC 品牌启动 logo（替换 OpenCode 字符画）。
- 自动更新关闭与二进制版本锁定 1.18.18。
- 流式 toolcall/progress、Goal 完整生命周期、dsh 模型目录/preset 切换。
- 文本/图片附件、`Always` 权限会话内存记忆、skills 目录与斜杠命令。
- v2 会话搜索/分页/排序、`--dir` 目录过滤。
- SSE mux/host 重连与重放去重、todo/goal 跨重连状态保留。
- 会话性能压测（200/1000/5000/10000）与协议升级探针。
- 一键自测 `scripts/check-all.sh` 与 GitHub Actions CI。

### 修复

- `--mini` 无回复（补 `POST /session/:id/prompt_async`）。
- `--mini` 回复渲染两次（流式/最终 part id 复用）。
- 会话历史列表无标题（持久标题 → 项目目录 basename → session id 回退）。
- 旧包名迁移导致 `duplicate loader entry id: storage`（清理 profile 中残留的
  `@deepseek-ai/dsh-oc` 依赖与 bundle 项即可恢复）。

### 重构

- 包名从 `@deepseek-ai/dsh-oc` 迁移到 `@chiro2001/dsh-oc`。
- 路由注册从 `router.ts` 抽出到 `src/bridge/routes.ts`。

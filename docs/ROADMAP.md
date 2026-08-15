# dsh-oc 下一阶段需求（Roadmap）

> 本文档是当前用户确认的下一阶段工作清单。新 agent 接续时先读本文，再读 `docs/FEATURES.md`、`docs/PLAN.md`、`docs/PROTOCOL.md`。
> 基线：`main` 当前为流式子代理导航修复后的版本（2026-08-15）。

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

## 统一验收门槛

1. `pnpm install && pnpm build && pnpm typecheck && pnpm test` 全部通过。
2. 相关 e2e 脚本全部通过，且新增脚本覆盖新功能。
3. `docs/FEATURES.md` 自动部分刷新；README/ROADMAP 更新。
4. `lib/` 构建产物提交。
5. 每个分支独立 commit，集成后再合并 main 并推送。

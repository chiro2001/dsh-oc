# Round 0002 decision — 执行 Agent 对专家建议的处置

审阅模型：`gpt-5.6-sol`（profile `sss`，max，`codex exec`），基线 commit
`4c43254`。结论：接受整体方向（先修恢复 oracle、做故障域矩阵、用 full SHA
不可变候选收敛 rc.2），部分接受/延期执行，详见下。

## 一、总体结论（accept）

- “rc.2 当前为条件性 NO-GO：现有测试是 warm/cold history 投影对比而非
  live SSE 对比；父链断言恒为空”：**接受**。先把 `e2e-recovery-consistency.sh`
  的 oracle 修正为可证的 v1+v2 一致性断言，再谈恢复一致性收尾。
- “暂不优先做 `--continue` 消息图变体，优先 SSE 断线/mux 重订阅/进程崩溃”：
  **接受**，替换上一轮“先加 `--continue` 变体”的执行顺序。
- “rc.2 仍是 RC/canary，不是稳定版”：**接受**。

## 二、按条处置

1. **恢复一致性主证据降级为 warm vs cold history regression，并修正
   oracle（父链非空、part 归属、tool terminal data、等待权威 idle）。**
   accept（本轮立即执行）。`signature()` 增加 v1 面比较（父链/引用），v2
   part 改为逐消息比较并纳入 tool `name/status/content`；`sleep 3` 替换为
   session idle 等待（复用 `/api/session/{id}/wait` 或 turn 终态轮询）。
2. **三个故障域分别命名并优先实验：client-sse-reconnect、mux-resubscribe、
   process-crash-recovery。** accept（计划）。写入 ROADMAP，作为 rc.2
   门槛 2；每域先做 2–3 个最高风险 cut point。
3. **错序措辞闭合：要么官方 1.18.18 最小复现，要么降为中性已知限制。**
   accept（本轮立即执行文档措辞）：README/MANUAL-TEST 改为“在官方 TUI
   1.18.18 中观察到的即时显示限制，bridge 侧持久数据正确，具体归因待最小
   复现”；最小复现列为实验 1c，不单独阻断 rc.2。
4. **mock 全绿 + 一次真实 smoke 不充分。** accept（文档口径）：AGENTS
   中 real-model 定位保持 smoke；离线脱敏 corpus + feature manifest 列为
   实验 1c。
5. **GitHub 安装以 full SHA 为真相源，rebuild 后 `lib/` 零差异，受保护
   tag。** accept（计划，rc.2 前置）：按第七节流程演练，并把“同版本可变
   ref 缓存行为”列为需实验。
6. **vendor ABI：先在 1.18.18 冻结黄金轨迹，候选版本独立 lane，用语义
   差分而非逐个试。** accept（计划）：黄金轨迹基线列为实验 1c 的一部分；
   真正双版本 lane 在下次升级前完成。
7. **flake 统计成本控制：先最小高风险 case 各 10 次，零失败后扩到 30–60
   次；release-lane 预算 30–45 分钟。** accept（替代原“每项 50 次”方案）；
   语义首败不得靠 retry 变绿。
8. **脱敏 corpus：feature manifest + allowlist 结构化脱敏 + 人工 golden，
   不以“10+ 会话”为合格标准。** accept（实验 1c 方法）。
9. **冻结恢复契约（durable exactly-once、crash 前缀不丢/不伪造完成/可续聊、
   transient 明确列出）。** accept：契约草案写入 ROADMAP，作为故障域实验
   的断言基线。
10. **官方最小复现作为 rc.2 硬门槛** reject（改为中性措辞即可通过门槛）；
    最小复现本身仍列入实验 1c。

## 三、reject/defer

- “先实现 Last-Event-ID ring buffer / 持久 bridge state” —— defer：先用
  实验判定官方 TUI 的 refetch/upsert 是否已满足契约，再决定设计。
- “完整 50×全脚本 flake 统计卡住发布” —— defer：按分层预算执行。
- “`--continue` 完整消息图变体” —— defer/reject：保留现有
  `e2e-tui-continue.sh` 选择契约即可，后续可补低成本 `-c` 选择契约。
- “Windows/ARM 扩展支持矩阵” —— defer：按“声明即测”收缩。
- “等待上游修复即时错序” —— defer：rc 只需可复核归因或中性文档。

## 四、后续执行项（已列入 ROADMAP 待办）

- 实验 1a：恢复 oracle 修正（本轮立即执行：idle 等待、v1+v2 双面、父链/
  part/工具终态非空断言）。
- 实验 1b：三故障域矩阵（client-sse-reconnect、mux-resubscribe、
  process-crash-recovery），各 2–3 个 cut point。
- 实验 1c：脱敏真实 corpus + feature manifest + 1.18.18 黄金轨迹/官方最小
  复现。
- 实验 2：`v0.1.0-rc.2` full SHA 不可变候选的干净安装/升级/回滚演练
  （rebuild 后 `lib/` 零差异、远端 SHA 冷装、双平台 smoke）。
- 实验 3：flake 分层统计（每最小 case 10 → 30–60 次，release-lane 预算
  30–45 分钟，语义首败不 retry）。

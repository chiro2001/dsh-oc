# Round 0001 decision — 执行 Agent 对专家建议的处置

审阅模型：`gpt-5.6-sol`（profile `sss`，max，`codex exec`）。
结论：接受整体方向（受控 RC 交付 + 稳定性优先），部分接受/延期执行，详见下。

## 一、总体结论（accept）

- “适合受控 RC/canary，不足以宣称稳定版”：**接受**。下一次交付按不可变
  RC 候选（`v0.1.0-rc.2` tag/commit）处理，README/AGENTS 已注明安装渠道
  语义；实际打 tag 与发布由用户确认后执行。
- “功能冻结 1–2 个迭代，稳定性/一致性优先”：**接受为下一阶段默认方向**，
  已写入 ROADMAP 待办。

## 二、按条处置

1. **工具+排队显示错序：先做一次有边界的因果轨迹实验，再决定归上游。**
   accept（实验设计采纳）。立即动作：把该残余在 README“已知限制”中显式
   列出；已存在 MANUAL-TEST §11 记录。实验本身（规范化消息图差分 +
   官方最小复现）列为下一迭代首项，不阻塞 RC。
2. **CI 无条件整脚本重试会掩盖真实回归：保留首败证据、语义失败不重试。**
   accept（部分落地）：check-all 现在保留首次日志副本
   （`/tmp/check-all-<s>.first.log`）并打印首败 rc；重试策略暂保持为兜底，
   语义断言类失败的重试分类留待 flake 统计实验后收紧。
3. **最大长期风险是 dsh/bridge/TUI 三状态机语义漂移；把 opencode 当
   vendor ABI，保留黄金轨迹。** accept（方向）。立即动作：AGENTS 增加
   “升级以语义差分 + 真实 TUI 回放为门槛”的约定；黄金轨迹采集列为
   后续实验。
4. **发布/安装链路（GitHub 不可变 spec 冷装、升级、回滚）未成为门槛。**
   accept（计划）。立即动作：AGENTS/README 明确“GitHub 直装依赖已提交
   `lib/`，发布前必须从干净 profile 按 spec 安装验证”；完整演练列为
   rc.2 发布前置。
5. **实时/重连/重启后的消息身份一致性。** accept（实验）。列为下一迭代
   实验 1 的一部分。
6. **真实模型回归断言偏弱（应称 smoke）。** accept（文档口径）。已将
   e2e-real-llm.sh 的定位在 AGENTS 描述为 smoke；确定性 replay corpus
   列为后续。
7. **history 端点 O(N) 与无 next 游标。** accept（小步落地）：本轮给
   `/api/session/:id/history` 响应增加 `next`（本页最大锚点 seq），并把
   “全量折叠成本”记录到 PROTOCOL/CHANGELOG；单大会话性能基准列为后续。
8. **标题补温文档过度承诺（120/24 陈旧描述、README ✅）。** accept：
   本轮修正 CHANGELOG 陈旧数字，README 能力表措辞改为“渐进补温 +
   目录名/id 回退”。
9. **平台/宿主矩阵。** accept（计划）：支持矩阵写入 AGENTS 待办，
   至少 Linux x64 + macOS arm64 冒烟列为 rc.2 前置。

## 三、reject/defer

- “只在最终失败时上传工件”——保留现状（避免每轮上传体积），但首败日志
  本地保留；若 flake 统计实验需要，再调整为随绿 job 上传 first-attempt
  摘要。
- “视觉稳定断言改为连续 3 帧相同”——defer 到 flake 统计实验（当前
  agent-tab 已做有界轮询，先采集数据再收紧）。
- “扩大支持矩阵到 Windows/ARM 全平台”——defer（资源限制），文档按
  “声明即测”原则收缩。

## 四、后续执行项（已列入 ROADMAP 待办）

- 实验 1：真实事件差分回放 + 恢复一致性 + 已知错序裁决。
- 实验 2：`v0.1.0-rc.2` 不可变候选的干净安装/升级/回滚演练。
- 实验 3：flake 统计审计（50 次/项，按签名分类，关闭无条件整脚本重试后
  复核）。

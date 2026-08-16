# Round 0002 context — 恢复一致性收尾：--continue 变体、断线/崩溃重连与发布门槛

## 仓库与当前状态

- 仓库：`chiro2001/dsh-oc`；分支 `develop` 与 `main` 同步。
- commit：`4c43254`（`test(e2e): widen tool slots in TUI permission run A`）。
- 包名：`@chiro2001/dsh-oc@0.1.0-rc.1`（未发布 registry，安装/更新走
  GitHub 源 `#main` / `#develop`）。
- 工作区干净；本地全量 `check-all.sh --e2e` PASSED；双分支 CI e2e success。

## 项目定位

dsh-oc 是 DeepSeek Harness（dsh）的 opencode TUI 前端：直接使用官方
opencode 1.18.18 二进制，通过 oc-bridge 把 dsh 的会话/工具/权限/goal 等
协议翻译成 opencode SDK v2 面，并在 TUI 侧做品牌与行为修正。

## round-0001 结论与执行情况（2026-08-16 深夜至今）

- 结论：受控 RC/canary 交付，功能冻结 1–2 个迭代，稳定性/一致性优先。
- 已修复：历史 part id 与实时 SSE 对齐（不再重复渲染）；工具回合+后续文本
  合并为单条历史消息；后续文本独立 id（实时 4 条 vs 重连 5 条结构不一致）；
  history 分页（`after` 独占上界事件 seq + `next` 游标）；CI 首败日志保留。
- 新增 `scripts/e2e-recovery-consistency.sh`：实时快照 vs 新进程 `--session`
  重连快照，断言消息数/角色/父链/部件完全一致（33s PASSED），已入稳定套件。
- 10k 事件单会话 history 分页基准已记录（docs/perf/results-2026-08-15.md）。
- 已知错序裁决：工具+忙碌中排队消息的即时视图错序为上游 TUI 渲染行为，
  停止桥接试错，已在 MANUAL-TEST §11 / README 文档化。

## 本轮计划（尚未动代码）

1. 给 `e2e-recovery-consistency.sh` 增加 `--continue` 变体：live 快照 →
   `e2e_exit` → 清 `dsh-exit.txt` → `e2e_tui_start "-c"` → 比对 v2 消息图。
   需要先确认官方 opencode `-c` 的语义（继续最近会话）与 dsh-oc 透传行为。
2. 剩余实验 1 项：SSE 断线重连、bridge 崩溃重启、10+ 脱敏真实 session
   回放（reasoning 有/无、单/多工具、权限拒绝、错误、打断、compaction、
   插件上下文）。
3. 实验 2：`v0.1.0-rc.2` 不可变候选的干净安装/升级/回滚演练（GitHub spec
   冷装，不依赖本地 checkout/build；确认 `lib/` 与源码一致）。
4. 实验 3：flake 统计审计（50 次/项，按签名分类，保留首败证据）。

## 必读输入

- `README.md`、`AGENTS.md`、`docs/ROADMAP.md`、`docs/CHANGELOG.md`
- `expert-advice/round-0001/recommendation.md`、`decision.md`
- `scripts/e2e-recovery-consistency.sh`、`tests/e2e/common.sh`
- `src/bridge/events.ts`、`src/bridge/convert/message.ts`、
  `src/bridge/routes/session-v2.ts`、`src/bridge/state.ts`
- `docs/MANUAL-TEST.md` 第 11 节、`docs/perf/results-2026-08-15.md`

## 执行方式

沿用专家咨询流程（codex -p sss，gpt-5.6-sol / max / workspace-write）：

```sh
cd /home/chiro/projects/dsh-oc/dsh-oc
codex -p sss -c 'model="gpt-5.6-sol"' -c 'model_reasoning_effort="max"' \
  -s workspace-write -C "$PWD" \
  exec -o expert-advice/round-0002/response.md - < expert-advice/round-0002/prompt.md
```

执行 Agent 随后写 `decision.md` 并落实接受项。

## 禁止事项

- 不修改 `expert-advice/round-0002/` 之外的文件；不执行安装/构建/测试/git
  写操作；不查看无关仓库。

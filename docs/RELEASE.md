# dsh-oc 发布流程（0.2.0-rc.1）

本地候选版本为 `0.2.0-rc.1`，对应 dsh `>=0.1.2-rc.1`。它是 ABI breaking
minor：PR #1/#2/#3 没有原样合入，而是与 dsh 0.1.2 host-services 迁移、status
热路径、SSE ring、OpenTUI temp 隔离等语义重新整合。

发布决策依据 `expert-advice/round-0002/decision.md`；npm 继续 NO-GO。包
`@chiro2001/dsh-oc` 只走 GitHub 源安装，发布物以**完整 commit SHA** 为真相源，
`lib/` 构建产物必须随提交且与源码零差异。

## 前置条件（每次候选都需满足）

1. `pnpm typecheck && pnpm test` 全绿；probe 62/62。
2. `bash scripts/verify-release-artifacts.sh` PASSED（HEAD 干净重建后
   committed `lib/` 零差异；npm pack 无机器绝对路径；记录 tarball/tree hash）。
3. `bash scripts/check-all.sh --e2e` 全绿（含恢复故障域、golden trace、
   queued-order-repro、permission-mini 等 stable 套件）。
4. 稳定基线：`scripts/flake-mini-scan.sh` 在 release-lane 预算内跑过
   最小高风险脚本（参考 docs/perf/results-flake-consolidated-2026-08-17.md）。

## 候选步骤

1. **版本 bump**：`package.json` 与 `src/index.ts` 的 `DSH_OC_VERSION`
   同步改为 `0.2.0-rc.1`；`pnpm build` 重建 `lib/` 并提交。
2. **本地门禁**：typecheck + 单测 + probe + 工件审计 + 全量 e2e；本轮本地
   候选仅完成无 TUI 门禁，真实 TUI/e2e 交给后续独立验证。
3. **推送 develop** 并等 CI 全绿（ci + 双分片 e2e）。
4. **远端 full-SHA 演练**：
   ```bash
   bash scripts/e2e-install-rollback.sh \
     --candidate "github:chiro2001/dsh-oc#<full-sha>" \
     --previous "github:chiro2001/dsh-oc#<同 dsh-0.1.2-ABI 的上一不可变 sha>"
   ```
   验证：冷装成功、包版本为 `0.2.0-rc.1`、TUI smoke 通过、旧会话可恢复、
   回滚可操作；脚本同时断言 `pnpm-lock.yaml` 实际解析到指定 full SHA，不能只
   用相同版本号冒充回滚成功。
   同版本可变 ref 的 in-place 结果不作为缓存安全证明（版本号变化 +
   full SHA 才是）。
5. **真实模型 smoke（远端候选）**：
   ```bash
   bash scripts/e2e-real-llm.sh --quick --add-spec "github:chiro2001/dsh-oc#<full-sha>"
   ```
6. **合并 main** 并推送；记录发布四元组：
   `{opencode 1.18.18, asset sha256, package tree hash, dsh-oc commit}`。
7. **受保护 tag**：`v0.2.0-rc.1` 指向已演练的 full SHA；Release notes
   写明 full SHA、tarball/tree hash、已知限制（工具+排队即时视图错序、
   `Allow always` 重启清空、退出 splash 等）。
8. **更新本地安装**：`dsh plugin --profile oc add github:chiro2001/dsh-oc#v0.2.0-rc.1`，
   `dsh-oc --version` 应输出 `dsh-oc 0.2.0-rc.1 (dsh 0.1.2-rc.1)`。

## 当前候选就绪状态（本地整合，2026-09-07）

本地工作树已完成版本元数据与构建；本地 commit 后才具备 full-SHA 安装候选。
本轮未执行远端安装、artifact audit、完整 e2e 或真实 TUI：

- dsh ABI：host services 直连、legacy dcp rc.6 compat shim、history follow/page
  iterator close、errors/approval/question 已有 targeted tests。
- bridge：status 内存热路径、api-session/status/activity、bounded SSE ring、
  reconnect status replay、queue/history/model/preset/subagent 回归已覆盖。
- 构建：`pnpm typecheck`、targeted/full unit 曾通过、`pnpm build`、`probe 62/62`。
- TUI temp：OpenTUI native 临时目录隔离/清理及安全 I/O monitor shell self-tests
  已通过。

## 回滚

任何一步出现 blocker（stale/missing `lib`、版本仍不是 `0.2.0-rc.1`、远端 SHA 安装
失败、旧会话不兼容、恢复不一致、CI 语义失败靠 retry 洗绿），停止发布；
修复后从**全新 profile** 重跑对应演练，不在污染环境续测。当前 RC 是 dsh ABI
breaking minor：同 dsh `0.1.2-rc.1` 内回滚可重新安装同 ABI 的前一不可变 SHA；
若回滚到 `dsh-oc v0.1.0`，必须同时将 dsh CLI 回滚到 `0.1.0-rc.6`。只降
dsh-oc、保留 dsh 0.1.2 会因旧版 `apiProxy` 与新版 `sessionController` 契约不同
而无法启动。

## opencode 二进制升级（独立 lane，不混入本候选）

opencode 版本升级不混入 `0.2.0-rc.1`：先用
`bash scripts/upgrade-lane.sh --bin <candidate>` 对黄金轨迹做语义差分，
全绿后才考虑更新 `opencode-version.json`/asset 清单并走独立候选流程。

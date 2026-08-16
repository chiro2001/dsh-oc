# dsh-oc 发布流程（rc.2 起）

发布决策与门槛依据 `expert-advice/round-0002/decision.md`。npm 保持
NO-GO：包 `@chiro2001/dsh-oc` 只走 GitHub 源安装，发布物以**完整 commit
SHA** 为真相源，`lib/` 构建产物必须随提交且与源码零差异。

## 前置条件（每次候选都需满足）

1. `pnpm typecheck && pnpm test` 全绿；probe 62/62。
2. `bash scripts/verify-release-artifacts.sh` PASSED（HEAD 干净重建后
   committed `lib/` 零差异；npm pack 无机器绝对路径；记录 tarball/tree hash）。
3. `bash scripts/check-all.sh --e2e` 全绿（含恢复故障域、golden trace、
   queued-order-repro、permission-mini 等 stable 套件）。
4. 稳定基线：`scripts/flake-mini-scan.sh` 在 release-lane 预算内跑过
   最小高风险脚本（参考 docs/perf/results-flake-consolidated-2026-08-17.md）。

## 候选（rc.2）步骤

1. **版本 bump**：`package.json` 与 `src/index.ts` 的 `DSH_OC_VERSION`
   同步改为 `0.1.0-rc.2`；`pnpm build` 重建 `lib/` 并提交。
2. **本地门禁**：typecheck + 单测 + probe + 工件审计 + 全量 e2e。
3. **推送 develop** 并等 CI 全绿（ci + 双分片 e2e）。
4. **远端 full-SHA 演练**：
   ```bash
   bash scripts/e2e-install-rollback.sh \
     --candidate "github:chiro2001/dsh-oc#<full-sha>" \
     --previous "github:chiro2001/dsh-oc#<上一不可变 sha>"
   ```
   验证：冷装成功、包版本为 rc.2、TUI smoke 通过、旧会话可恢复、回滚可操作。
   同版本可变 ref 的 in-place 结果不作为缓存安全证明（版本号变化 +
   full SHA 才是）。
5. **真实模型 smoke（远端候选）**：
   ```bash
   bash scripts/e2e-real-llm.sh --quick --add-spec "github:chiro2001/dsh-oc#<full-sha>"
   ```
6. **合并 main** 并推送；记录发布四元组：
   `{opencode 1.18.18, asset sha256, package tree hash, dsh-oc commit}`。
7. **受保护 tag**：`v0.1.0-rc.2` 指向已演练的 full SHA；Release notes
   写明 full SHA、tarball/tree hash、已知限制（工具+排队即时视图错序、
   `Allow always` 重启清空、退出 splash 等）。
8. **更新本地安装**：`dsh plugin --profile oc add github:chiro2001/dsh-oc#v0.1.0-rc.2`，
   `dsh-oc --version` 应输出 `dsh-oc 0.1.0-rc.2 (dsh ...)`。

## 回滚

任何一步出现 blocker（stale/missing `lib`、版本仍为 rc.1、远端 SHA 安装
失败、旧会话不兼容、恢复不一致、CI 语义失败靠 retry 洗绿），停止发布；
修复后从**全新 profile** 重跑对应演练，不在污染环境续测。回滚用户侧 =
重新安装前一不可变 SHA/tag。

## opencode 二进制升级（独立 lane）

opencode 版本升级不混入 rc.2：先用
`bash scripts/upgrade-lane.sh --bin <candidate>` 对黄金轨迹做语义差分，
全绿后才考虑更新 `opencode-version.json`/asset 清单并走独立候选流程。

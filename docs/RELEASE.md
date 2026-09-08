# dsh-oc 发布与回滚流程

`v0.2.0-rc.1` 已于 2026-09-07 发布；`v0.2.0-rc.2` 已于 2026-09-08 发布，
面向 dsh `>=0.1.2-rc.1`。后续候选复用本清单，把文中的
`<candidate-version>` 替换为实际版本。

发布决策依据见 `expert-advice/round-0002/decision.md`；npm 继续 NO-GO。包
`@chiro2001/dsh-oc` 只走 GitHub 源安装，发布物以**完整 commit SHA** 为真相源，
`lib/` 构建产物必须随提交且与源码零差异。

## 前置条件（每次候选都需满足）

1. `pnpm typecheck && pnpm test` 全绿；`pnpm run probe` 的全部 fixture 路由、协议和
   版本检查通过（当前基线输出 63/63；新增路由后以 fixture 全通过为准）。
2. `bash scripts/verify-release-artifacts.sh` PASSED（HEAD 干净重建后
   committed `lib/` 零差异；npm pack 无机器绝对路径；记录 tarball/tree hash）。
3. `bash scripts/check-all.sh --e2e` 全绿（含恢复故障域、golden trace、
   queued-order-repro、permission-mini 等 stable 套件）。
4. 稳定基线：`scripts/flake-mini-scan.sh` 在 release-lane 预算内跑过
   最小高风险脚本（参考 docs/perf/results-flake-consolidated-2026-08-17.md）。

## 候选步骤

1. **版本 bump**：`package.json` 与 `src/index.ts` 的 `DSH_OC_VERSION`
   同步改为 `<candidate-version>`；`pnpm build` 重建 `lib/` 并提交。
2. **本地门禁**：typecheck + 单测 + probe + 工件审计 + 全量 e2e；协议或 TUI
   改动必须包含对应的 tmux/官方 TUI 回归。
3. **推送 develop** 并等 CI 全绿（ci + 双分片 e2e）。
4. **远端 full-SHA 演练**：
   ```bash
   bash scripts/e2e-install-rollback.sh \
     --candidate "github:chiro2001/dsh-oc#<full-sha>" \
     --previous "github:chiro2001/dsh-oc#<同 dsh-0.1.2-ABI 的上一不可变 sha>"
   ```
   验证：冷装成功、包版本为 `<candidate-version>`、TUI smoke 通过、旧会话可恢复、
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
7. **受保护 tag**：`v<candidate-version>` 指向已演练的 full SHA；Release notes
   写明 full SHA、tarball/tree hash、已知限制（工具+排队即时视图错序、
   `Allow always` 重启清空、退出 splash 等）。
8. **更新本地安装**：`dsh plugin --profile oc add github:chiro2001/dsh-oc#v<candidate-version>`，
   再用 `dsh-oc --version` 核对 dsh-oc 与 dsh 的版本。

## v0.2.0-rc.1 发布记录（2026-09-07）

该候选已完成发布门禁和远端演练：

- dsh ABI：host services 直连、legacy dcp rc.6 compat shim、history follow/page
  iterator close、errors/approval/question 已有 targeted tests。
- bridge：status 内存热路径、api-session/status/activity、bounded SSE ring、
  reconnect status replay、queue/history/model/preset/subagent 回归已覆盖。
- 构建与审计：`pnpm typecheck`、418 个单元测试、`pnpm build`、协议 probe fixture
  全部通过、5000 会话性能测试和 release artifact audit 已通过（rc.1 发布基线
  为 62/62；rc.2 发布基线为 63/63）。
- TUI 与远端：完整真实 TUI e2e、高风险 flake scan 30/30、GitHub CI、full-SHA
  冷装、真实 TUI smoke、同 ABI 回滚和真实 DeepSeek quick smoke 已通过。
- 发布四元组：opencode `1.18.18`、dsh-oc commit、tarball SHA256、package
  tree hash，详见 GitHub prerelease notes。

## v0.2.0-rc.2 发布记录（2026-09-08）

- 新增官方 OpenCode `!` shell mode；用户命令和输出通过非唤醒 context 注入下一次
  模型 prompt，并保留精确 PID/进程组取消和输出预算。
- 修复 `/preset` 最终 assistant 卡片的模型/variant 回显与 `QUEUED` 完成状态，
  增加 v1/v2 history 与真实 TUI 回归。
- 完善 profile 隔离与 dsh-tui/dsh-dcp ABI 排障文档；修复构建工件跨路径 hash 漂移，
  并收紧 TUI e2e 的状态驱动等待。
- 协议 probe 发布基线为 63/63；完整 commit SHA、tarball SHA256、package tree hash
  与 opencode asset SHA256 以
  [GitHub prerelease notes](https://github.com/chiro2001/dsh-oc/releases/tag/v0.2.0-rc.2)
  为准，本文不复制可漂移的发布标识。

## 回滚

任何一步出现 blocker（stale/missing `lib`、版本与 `<candidate-version>` 不符、远端 SHA 安装
失败、旧会话不兼容、恢复不一致、CI 语义失败靠 retry 洗绿），停止发布；
修复后从**全新 profile** 重跑对应演练，不在污染环境续测。当前 RC 是 dsh ABI
breaking minor：同 dsh `0.1.2-rc.1` 内回滚可重新安装同 ABI 的前一不可变 SHA；
若回滚到 `dsh-oc v0.1.0`，必须同时将 dsh CLI 回滚到 `0.1.0-rc.6`。只降
dsh-oc、保留 dsh 0.1.2 会因旧版 `apiProxy` 与新版 `sessionController` 契约不同
而无法启动。

## opencode 二进制升级（独立 lane，不混入当前候选）

opencode 版本升级不混入 `<candidate-version>`：先用
`bash scripts/upgrade-lane.sh --bin <candidate>` 对黄金轨迹做语义差分，
全绿后才考虑更新 `opencode-version.json`/asset 清单并走独立候选流程。

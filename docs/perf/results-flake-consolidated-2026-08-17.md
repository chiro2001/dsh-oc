# Flake 合并扫描 — 当前 HEAD（2026-08-17）

`scripts/flake-mini-scan.sh --runs 10`，6 个最小高风险脚本各 10 次，固定
commit `e1817df`，本机 Linux x64，opencode 1.18.18，mock LLM。语义失败
立即停止、扫描内不重试、保留首败日志。

| 脚本 | runs | passes | failures | 单次耗时 |
|---|---|---|---|---|
| e2e-recovery-consistency.sh | 10 | 10 | 0 | 29–30s |
| e2e-recovery-crash.sh | 10 | 10 | 0 | 19–21s |
| e2e-recovery-sse-reconnect.sh | 10 | 10 | 0 | 13–14s |
| e2e-tui-permission-mini.sh | 10 | 10 | 0 | 10–11s |
| e2e-tui-queue-live.sh | 10 | 10 | 0 | 19–20s |
| e2e-tui-agent-tab.sh | 10 | 10 | 0 | 11–12s |

合计 60 次首跑全绿。按 10 次样本，单侧 95% 上界约 26%；要收紧到 2%
以下需 149 次零失败（release-lane 预算内后续按需扩跑）。

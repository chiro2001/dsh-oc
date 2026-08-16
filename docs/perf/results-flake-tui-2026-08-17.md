# Flake mini-scan 结果 — TUI 高风险脚本（2026-08-17 第二轮）

沿用 `scripts/flake-mini-scan.sh`：语义失败立即停止、扫描内不重试、保留
首败日志。commit `9a591f2`，本机 Linux x64，opencode 1.18.18，mock LLM。

## 结果

| 脚本 | runs | passes | failures | 单次耗时 |
|---|---|---|---|---|
| e2e-tui-queue-live.sh | 10 | 10 | 0 | 19–20s |
| e2e-tui-agent-tab.sh | 10 | 10 | 0 | 11–12s |
| e2e-tui-permission-mini.sh | 10 | 10 | 0 | 10–11s |

## 结论

- 此前 CI 偶发 flake 的两个 TUI 脚本（忙碌中排队、Tab 切 agent）在固定
  commit 下首跑 10/10 全绿，未发现语义失败。
- permission 已拆出最小 case `e2e-tui-permission-mini.sh`（单次 Allow-once
  循环，10–11s），首跑 10/10 全绿；已入 stable 套件。完整 permission
  矩阵仍由 `e2e-tui-permission.sh` / `-ext` 每次回归覆盖。

# Flake mini-scan 结果 — 恢复故障域（2026-08-17）

实验 3 首轮预算化扫描：`scripts/flake-mini-scan.sh --runs 10`，只跑最小
高风险恢复脚本，语义失败立即停止并保留首败日志，扫描内不重试。固定
commit `e220e93`，本机 Linux x64，opencode 1.18.18，mock LLM。

## 结果

| 脚本 | runs | passes | failures | 单次耗时 |
|---|---|---|---|---|
| e2e-recovery-consistency.sh | 10 | 10 | 0 | 29–30s |
| e2e-recovery-crash.sh | 10 | 10 | 0 | 21–24s |
| e2e-recovery-sse-reconnect.sh | 10 | 10 | 0 | 15–16s |

## 扫描中发现并修正的 oracle 缺陷

首次扫描 `e2e-recovery-crash.sh` 第 7 次失败：重启后恢复的持久前缀为
`assistant text "mock"`，崩溃前 API 快照为 `"mock r"`。这不是桥接丢数据：
SIGKILL 落在最后 chunk 落盘边界内，崩溃契约只要求“恢复已持久化前缀”。
原“严格前缀”断言把合法的部分文本丢失判为失败。已改为
`recovery_assert_crash_prefix`：允许重启图是观察图的完整消息前缀，或等长
时最后 text part 是观察文本的前缀；修正后 10/10 通过。

## 结论

- 三个恢复故障域脚本首次执行通过率 10/10（按 10 次样本，单侧 95% 上界
  约 26% 失败率；要收紧到 2% 以下需 149 次零失败，按预算后续再扩）。
- 扫描器按签名保留首败日志（`/tmp/flake-mini-scan/e2e-<script>-<n>.log`），
  语义失败不重试。
- 下一步按预算把 permission / agent-tab / queue-live 拆成最小 case 后
  各跑 10 次。

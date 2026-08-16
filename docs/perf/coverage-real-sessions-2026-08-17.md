# 真实会话 feature 覆盖扫描（2026-08-17）

工具：`scripts/replay-corpus-manifest.mjs`（只输出类型/特征计数，不读取或
落盘任何真实内容）。扫描范围：`~/.dsh/sessions`。

## 汇总

- 会话数：64；事件数：58,609。
- 高频事件类型：reasoning-chunks、assistant/chunk、text-chunks、
  tool-call-chunks、tool/call、tool/result、assistant/message、
  turn/start|end、agent/inbox/spliced。

## 特征覆盖（真实会话 vs 合成语料）

| 特征 | 真实会话数 | 语料 fixture |
|---|---|---|
| queue | 46 | multi-tool-queued |
| reasoning | 45 | plain-text-reasoning |
| session-title | 45 | session-title |
| text | 41 | plain-text-reasoning 等 |
| tool | 19 | single-tool-followup 等 |
| multi-tool | 14 | multi-tool-queued |
| plugin-context | 8 | plugin-context |
| interrupt | 8 | interrupted |
| tool-error | 3 | tool-error |
| goal | 3 | goal-change |
| long-session（≥10k 事件） | 2 | spec 运行时生成（不落库） |
| unfinished-turn | 1 | unfinished-turn |

语料独有（真实样本未观测到，属预期补充）：compaction、followup-text、
streamed-args。

## 结论

- 合成语料已覆盖真实会话全部 12 个特征（long-session 由
  `tests/replay-corpus.spec.ts` 生成的 10k 事件用例覆盖，避免仓库膨胀）。
- 覆盖差集为空；后续真实会话新增事件形态时，用
  `node scripts/replay-corpus-manifest.mjs` 重新扫描并对照差集补 fixture。

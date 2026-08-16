# Expert advice archive

此目录保存外部顶级模型对 dsh-oc 开发计划的独立审阅与修订轮次。每轮使用
不可覆盖的 `round-NNNN/`：

```text
prompt.md      请求与问题
context.md     仓库 commit、输入文件与实际执行方式
response.md    模型最终回复
decision.md    执行 Agent 对每条建议的 accept/reject/defer 处置
```

核心约定（与 dsh-dynamic-context-pruning 的专家咨询流程一致）：

- 咨询模型以 `gpt-5.6-sol` + `max` reasoning 运行（profile `sss`，非交互
  `codex exec`），工作区可写，但只允许写入本目录 `round-NNNN/` 下的输出
  文档，不得改动源码、规划文档或构建目录。
- 顶级模型建议不是证明，也不自动改变规划；执行 Agent 阅读 `response.md`
  后写 `decision.md`，接受的建议必须落到 ROADMAP/CHANGELOG 或后续实现中。
- 不可用/失败时只记录 `blocked.md` 与错误，不伪造回复，不阻塞主流程。
- 不在本目录提交认证信息、环境变量值或未脱敏数据。

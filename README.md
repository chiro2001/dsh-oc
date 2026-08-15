# dsh-oc

DeepSeek Harness 的 OpenCode TUI 前端。

- **前端**：opencode 官方 CLI，以 `attach` 模式运行，只做 TUI。
- **后端**：DeepSeek Harness（dsh）负责 Agent、Session、工具、模型、权限和用户提问。
- **连接**：dsh-oc 在 dsh 进程内提供 OpenCode 兼容的 HTTP/SSE 桥（`oc-bridge`），并启动官方 TUI 客户端（`oc-tui`）。

```text
dsh (Node) ── dsh-oc bundle ── oc-bridge (HTTP/SSE) <── opencode TUI (attach)
                  │
                  └─ DSH Agent/Session/Tools/LLM/Approval/Questions
```

## 文档

- [docs/PLAN.md](docs/PLAN.md)：总体实现规划、阶段、验收标准。
- [docs/PROTOCOL.md](docs/PROTOCOL.md)：OpenCode TUI 协议探针结果、路由兼容矩阵、SSE 映射。

## 状态

规划已完成，实现待开始。当前仓库只包含文档，尚无 `src/` 实现。

## 目标使用方式（实现完成后）

```bash
dsh plugin --profile oc add @deepseek-ai/dsh-oc
dsh --profile oc
```

## 关键边界

- 不 fork opencode 源码；TUI 使用官方 `opencode-ai` 发布物，版本与 sha256 锁定。
- opencode 二进制只运行 `attach` 客户端模式，不创建 opencode server/agent/session。
- opencode 的配置、会话和缓存隔离在 `$DSH_HOME/opencode` 下。
- 首版不覆盖 opencode 全部路由；未实现能力返回 schema-valid 空数据或 501。

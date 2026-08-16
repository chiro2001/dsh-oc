# Round 0001 context — dsh-oc 当前状态、近期修复与下一步方向

## 仓库与当前状态

- 仓库：`chiro2001/dsh-oc`；分支 `develop` 与 `main` 同步。
- commit：`3c28389`（`test(e2e): widen agent-tab settle window...`）。
- 包名：`@chiro2001/dsh-oc@0.1.0-rc.1`（未发布 registry，安装/更新走
  GitHub 源 `#main` / `#develop`）。

## 项目定位

dsh-oc 是 DeepSeek Harness（dsh）的 opencode TUI 前端：直接使用官方
opencode 1.18.18 二进制，通过 oc-bridge 把 dsh 的会话/工具/权限/goal 等
协议翻译成 opencode SDK v2 面，并在 TUI 侧做品牌与行为修正。

## 近期已完成（2026-08-16）

- 修复首条回复重复渲染（插件上下文消息不再劫持父锚点，助手消息使用稳定
  桥接 id）。
- 对话前 Tab / `/preset` 切换 preset 后侧边栏 agent 不再回退（会话级 agent
  跟踪贯穿消息/历史/回显）。
- `session.error` 按官方判别联合输出（不再渲染 `[object Object]`）。
- 工具回合完成推迟到 `turn/end`；pending 完成不再跨回合残留。
- QUEUED 排队（键盘/API）、`/goal` 完整输入、Esc 打断、Thought 时长等
  均有单测 + e2e。
- 新增 `GET /api/session/{id}/history`（limit + after 事件 seq 游标），
  关闭 ROADMAP 最后一个可实现的 SDK v2 缺口。
- CI：稳定 e2e 分片并行、每脚本超时 + 单次重试、失败工件打包上传限时。

## 已知残余

- 工具调用回合的后续文本在“忙碌中排队第二条消息”场景下，TUI 转录顺序
  可能错位（内容完整、无重复、数据正确；官方 opencode 同类场景甚至不保留
  该后续文本），疑似上游 TUI 渲染行为。
- CI 偶发权限/agent-tab 时序 flake（已有重试与稳定帧轮询兜底）。

## 必读输入

- `README.md`、`AGENTS.md`、`docs/ROADMAP.md`、`docs/CHANGELOG.md`
- `docs/MANUAL-TEST.md` 第 11 节（与官方 opencode 的显示对比）
- `src/bridge/events.ts`、`src/bridge/convert/message.ts`、
  `src/bridge/routes/session-v2.ts`、`src/bridge/state.ts`
- `scripts/check-all.sh`、`.github/workflows/e2e.yml`

## 执行方式

沿用专家咨询流程（codex -p sss，gpt-5.6-sol / max / workspace-write）：

```sh
cd /home/chiro/projects/dsh-oc/dsh-oc
codex -p sss -c 'model="gpt-5.6-sol"' -c 'model_reasoning_effort="max"' \
  -s workspace-write -C "$PWD" \
  exec -o expert-advice/round-0001/response.md - < expert-advice/round-0001/prompt.md
```

执行 Agent 随后写 `decision.md` 并落实接受项。

## 禁止事项

- 不修改 `expert-advice/round-0001/` 之外的文件；不执行安装/构建/测试/git
  写操作；不查看无关仓库。

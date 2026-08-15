# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号遵循 semver。当前 npm 包名 `@chiro2001/dsh-oc`，尚未发布 registry，
安装/更新走 GitHub 源（`#main` / `#develop`）。

## [Unreleased]

### 新增

- 后台子代理能力开启：`GET /experimental/capabilities` 返回
  `{ backgroundSubagents: true }`，并新增
  `POST /experimental/session/{id}/background` no-op 成功路由（dsh 会话
  服务端常驻，`subagent` 工具默认后台运行）。
- `GET /session/{id}/children`：按 `parentSessionId` 返回 subagent 子会话
  列表，配合后台子代理能力供 TUI 子代理树查询。
- `GET /experimental/session`：GlobalSession 列表（支持 search/目录过滤/limit
  子集），补齐 experimental 会话列表面。
- `POST /session/{id}/init`：no-op 成功 `true`（dsh 会话创建即初始化）。
- `GET /session/{id}/message/{messageID}`：单条消息查询（v1 转换复用，
  未找到返回 404）。
- `POST /session/{id}/permissions/{permissionID}`：SDK v2 权限回复别名
  （body 用 `response` 字段），映射到同一 `permissionReply`。
- `GET /api/health`：返回 `{ healthy: true }` 供客户端探活。
- `GET /api/session/active`：返回当前活动会话（`{ data: { [sessionId]: { type: "running" } } }`）。
- `POST /api/session/{id}/wait`：有界轮询等待会话空闲（≤30s，空闲 204）。
- `GET /api/session/{id}/context`：返回 `{ data: SessionMessage[] }`（v2 消息转换复用）。
- 会话列表真实标题补读：dsh `session.list` 不返回 title 投影，bridge 按会话
  补读 history tail 投影并缓存（≤40 全量同步，大列表同步 12 + 后台 120），
  恢复的旧会话也会在退出提示中正确识别；大列表改为后台低并发补温
  （24 个、并发 2），不阻塞列表请求。
- Esc 打断/取消：`turn.wait` / `turn.idle` 事件驱动 TUI 运行态；全量 TUI
  连按两次 Esc、`--mini` 按一次 Esc 会调用 `session.cancel` 停止在途流。
- `/preset` 新会话继承：最近选择的 agent preset 会应用到后续 `/new` 创建的
  会话；切换后广播 `session.updated` 携带新 agent。
- 退出提示说明：opencode 官方退出 splash（全量/`--mini`）无法替换，dsh-oc
  在会话有内容时于其下方输出一行说明（session id 属于 dsh，恢复用
  `dsh --profile oc --session <id>`）；`DSH_OC_DISABLE_EXIT_NOTE=1` 可关闭。

### 工程化

- `CONTRIBUTING.md`、PR/Issue 模板、分支策略（main 发布 / develop 集成 /
  短生命周期功能分支）。
- CI：push 到 `main`/`develop`/`feat-*`/`fix-*`/`docs-*`/`perf-*`/`test-*`/
  `chore-*` 自动跑 API e2e 子集；手动触发全量 e2e + 压测。
- M5 重构：路由注册从 `router.ts` 抽出，并按域拆分为
  `src/bridge/routes/{boot,session-v1,session-v2,permission}.ts`；
  协议探针自动扫描路由目录。
- `scripts/cleanup-merged-branches.sh`：列出/删除已并入 main 的遗留分支
  （默认 dry-run，`--apply` 本地删除，`--remote` 同步删除远端）。
- `pnpm run e2e` / `pnpm run e2e:api`：一键跑全量或 API 子集 e2e。
- `scripts/e2e-tui-permission.sh`：真实 TUI 权限/提问 e2e（workspace-write +
  mock LLM 升级工具调用），覆盖 Allow once、Allow always + 会话内自动放行、
  Reject（错误回传且不落盘）、`ask_user_question` 选项对话框，以及
  `--mini` 模式下的 once/always+自动放行/reject/question 与单次回复渲染。
- `scripts/e2e-tui-mini.sh`：`--mini` 优雅退出（三连 Ctrl+C）后断言 dsh-oc
  退出提示可见。
- `scripts/e2e-tui-continue.sh`：种子会话带显式标题，`--continue` 恢复后断言
  会话列表返回真实标题（历史“恢复会话无标题”回归项）。
- `scripts/perf.mjs` 新增 `measurements.titleCoverage`：量化列表真实标题覆盖率。
- `e2e-tui-abort.sh`：mini 分支改为等 SSE 出现真实流式增量后再按 Esc，断言确实
  打断进行中的流（长 mock 开启 `repeatLast`，修复此前第二次请求被 500 拒绝的假通过）。
- README 演示改为真实模型录制的 GIF：asciinema cast（`docs/demo/`）经官方
  `agg` 渲染成 GIF 嵌入 README（GitHub 不执行 `<script>`，无法用播放器脚本），
  cast 保留供 `asciinema play` 交互回放；录制用真实 DeepSeek 模型完成真实任务，
  不用 mock。
- 报错显示：dsh `host/agent-error` 现在除了 `session.error` 还会广播一条可见的
  assistant 文本消息（`[错误] …`），TUI 对话区能直接看到错误，不再静默或渲染异常。

### 修复

- 文档化 SSE 文本 delta 成对重复的已知行为（dsh 双编码 + mux 重放；TUI 以
  `message.updated` 全量文本渲染，实测不受影响）。
- Thought（reasoning）时长：`end` 改为最后一条 reasoning chunk 的时间，不再错误地
  等于整条回复的完成时间（历史读取与实时流均生效）。
- 打断/流式转圈：text 块开始时立即关闭 reasoning part（带 end 时间）；中断
  （无最终 assistant/message）时 turn/end 也会关闭仍打开的 reasoning part，
  TUI 的 thinking 指示不再一直转圈。
- Tab/agent 选择随 prompt 生效：v1/v2 全部 prompt 路由现在会应用请求体里的
  `agent`；dsh 对已产生回复的会话锁定 agent preset（409），此时第一条消息后
  会在 TUI 显示一次“Agent switch locked”提示，不再静默失效。

## [0.1.0-rc.1] - 2026-08-15

### 新增

- 基于 OpenCode 1.18.18 的 HTTP/SSE bridge 与真实 TUI attach。
- DSH OC 品牌启动 logo（替换 OpenCode 字符画）。
- 自动更新关闭与二进制版本锁定 1.18.18。
- 流式 toolcall/progress、Goal 完整生命周期、dsh 模型目录/preset 切换。
- 文本/图片附件、`Always` 权限会话内存记忆、skills 目录与斜杠命令。
- v2 会话搜索/分页/排序、`--dir` 目录过滤。
- SSE mux/host 重连与重放去重、todo/goal 跨重连状态保留。
- 会话性能压测（200/1000/5000/10000）与协议升级探针。
- 一键自测 `scripts/check-all.sh` 与 GitHub Actions CI。

### 修复

- `--mini` 无回复（补 `POST /session/:id/prompt_async`）。
- `--mini` 回复渲染两次（流式/最终 part id 复用）。
- 会话历史列表无标题（持久标题 → 项目目录 basename → session id 回退）。
- 旧包名迁移导致 `duplicate loader entry id: storage`（清理 profile 中残留的
  `@deepseek-ai/dsh-oc` 依赖与 bundle 项即可恢复）。

### 重构

- 包名从 `@deepseek-ai/dsh-oc` 迁移到 `@chiro2001/dsh-oc`。
- 路由注册从 `router.ts` 抽出到 `src/bridge/routes.ts`。

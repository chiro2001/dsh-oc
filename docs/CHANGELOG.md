# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号遵循 semver。当前 npm 包名 `@chiro2001/dsh-oc`，尚未发布 registry，
安装/更新走 GitHub 源（`#main` / `#develop`）。

## [Unreleased]

### 新增

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
- `scripts/perf.mjs` 新增 `measurements.titleCoverage`：量化列表真实标题覆盖率。
- `e2e-tui-abort.sh`：mini 分支改为等 SSE 出现真实流式增量后再按 Esc，断言确实
  打断进行中的流（长 mock 开启 `repeatLast`，修复此前第二次请求被 500 拒绝的假通过）。
- README 新增核心功能演示：asciinema 录制真实 TUI，上传 asciinema.org 在线
  播放器（cast 源文件存 `docs/demo/`），覆盖品牌 logo、会话标题、流式回复、
  Esc 打断、工具卡片、退出提示。
- 报错显示：dsh `host/agent-error` 现在除了 `session.error` 还会广播一条可见的
  assistant 文本消息（`[错误] …`），TUI 对话区能直接看到错误，不再静默或渲染异常。

### 修复

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

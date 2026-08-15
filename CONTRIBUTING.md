# 参与 dsh-oc 开发

> AI Agent 接手仓库请先读 [AGENTS.md](AGENTS.md)（结构、命令、自测门槛与陷阱）；
> 本文面向人类贡献者。

dsh-oc 是 DeepSeek Harness × OpenCode TUI 前端：dsh 负责全部后端逻辑，opencode
官方 TUI 只负责渲染与键盘，dsh-oc 在 dsh 进程内提供 OpenCode 兼容的 HTTP/SSE
bridge。仓库：`chiro2001/dsh-oc`，npm 包名 `@chiro2001/dsh-oc`（未发布
registry，安装/更新走 GitHub 源）。

## 开发环境

要求：Node.js 22+、pnpm 11.x。

```bash
pnpm install
pnpm build          # 产出 lib/（必须随提交一起推送，GitHub 直装才包含新逻辑）
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest 单测
pnpm run probe      # opencode 1.18.18 协议路由探针
pnpm run perf       # 会话性能压测（临时 DSH_HOME + mock）
pnpm run features:update   # 刷新 docs/FEATURES.md 的自动追踪部分
```

一键自测入口：

```bash
bash scripts/check-all.sh              # typecheck + 单测 + 探针 + 性能冒烟
bash scripts/check-all.sh --e2e        # 加跑全量 e2e（含真实 opencode TUI）
bash scripts/check-all.sh --scale 5000 # 加跑 5000 会话压测
```

本地直连 dsh profile（实时验证，`pnpm build` 后立即生效）：

```bash
dsh plugin --profile oc add .
```

从 GitHub 分支安装（验证远端构建产物）：

```bash
dsh plugin --profile oc add 'github:chiro2001/dsh-oc#<branch>'
```

## 分支策略

- `main`：稳定发布线，README 安装/更新命令默认指向 `#main`。
- `develop`：集成交付线，日常开发与用户实时验证都在这条线；功能稳定后合并回
  `main`。
- 功能分支：从 `develop` 拉出，短生命周期，PR 回 `develop`。命名统一为
  `feat-*` / `fix-*` / `docs-*` / `perf-*` / `test-*` / `chore-*`（小写
  kebab-case）。
- 历史遗留的 `feat-*` 分支已全部并入 `main`，属于可清理分支；用
  `scripts/cleanup-merged-branches.sh` 列出/删除（默认 dry-run）。

e2e 脚本只允许在 `main` / `develop` 与 `chore-*` / `fix-*` / `docs-*` /
`perf-*` / `test-*` / `feat-*` 上运行（与 CI 触发分支一致），防止误在临时
分支上跑出无效结果。

## 提交规范

- 使用 Conventional Commits：`feat` / `fix` / `docs` / `perf` / `test` /
  `chore` / `refactor`。
- `lib/` 是构建产物但必须随源码提交；忘记提交会导致 GitHub 直装跑旧逻辑。
- 提交前检查机器相关绝对路径：
  `rg -n --hidden -g '!node_modules' -g '!.git' 'chiro' . | rg -v 'chiro2001|/home/chiro/'`
- 涉及能力清单时运行 `pnpm run features:update` 并一并提交。

## 自测门槛（PR 前必须）

1. `pnpm typecheck && pnpm test` 全绿。
2. `pnpm run probe` 62/62 通过。
3. 协议/桥接改动：至少跑对应的 `scripts/e2e-api*.sh`。
4. TUI 改动：跑相关 `scripts/e2e-tui-*.sh`（boot/turn/mini/brand/continue 等）；
   完整回归用 `bash scripts/check-all.sh --e2e`。
5. 在 PR 描述里附上测试命令与结果摘要。

## 提交流程

1. 从 `develop` 拉取短生命周期分支。
2. 实现并补齐单测/e2e，按上面门槛自测。
3. `pnpm run features:update`（如涉及能力）并提交。
4. 开 PR 到 `develop`，描述改动、影响面与测试证据。
5. CI 绿、review 通过后合并；需要用户实时验证的改动随 develop 生效。
6. 稳定后由维护者把 `develop` 合并回 `main` 并推送。

## Issue 与 PR 模板

仓库提供 `.github/ISSUE_TEMPLATE/`（bug / feature）与
`.github/pull_request_template.md`，按模板填写即可。

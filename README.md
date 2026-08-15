# dsh-oc

DeepSeek Harness 的 OpenCode TUI 前端（外置 profile bundle）。

方案：薄封装 MVP。`dsh --profile oc` 读取 `llm-deepseek` settings 与 DSH credentials，
生成 `OPENCODE_CONFIG_CONTENT`，并启动 opencode 官方 CLI。

opencode 获取策略：缓存/已装优先，缺失时从官方 GitHub Release 按 pinned 版本 + sha256 惰性下载。

状态：仓库初始化完成，实现待开始。

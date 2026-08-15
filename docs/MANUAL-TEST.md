# dsh-oc 手动测试指引

本文档列出手动验证 dsh-oc 的推荐路径与预期行为，供发布前或升级后快速
回归；自动化覆盖见 [FEATURES.md](FEATURES.md) 与 `scripts/e2e-*.sh`。

前置：`dsh plugin --profile oc add chiro2001/dsh-oc`（或本地
`dsh plugin --profile oc add .` + `pnpm build`），在干净终端执行
`dsh --profile oc`。

## 1. 启动与品牌

- 预期：启动画面显示 **DSH OC** 字符画（不再是 OPENCODE），随后进入
  opencode TUI，底部显示 opencode `1.18.18`。
- 试：`dsh --profile oc`；`dsh --profile oc --help` 显示能力摘要。

## 2. 基础对话

- 新会话输入一句普通文本（如“只回复 OK”）。
- 预期：模型回复正常出现；输入期间有流式效果；状态栏显示模型与耗时。
- 试：会话列表（`ctrl+x l` 打开 Sessions 列表）能看到该会话并显示真实标题（标题 →
  目录名 → id 回退）；`--continue` / `--session <id>` 恢复后历史完整。

## 3. 工具与权限

让模型执行需要提权的命令（如 `ls` 前加“执行命令”），触发
`Permission required` 对话框：

- `Allow once`：仅本次放行；同会话再次触发仍会询问。
- `Allow always`：弹出确认；同会话同工具后续自动放行；新会话仍会询问；
  重启后记忆清空。
- `Reject`：命令不执行，TUI 显示拒绝标记/错误，文件不被写入。
- `Esc`：standard 模式等价 Reject；`--mini` 先弹 “Reject permission”
  确认层，按 Enter 提交。
- 提问对话框（`ask_user_question`）：`Down`/`Up` 切换选项，Enter 提交；
  Esc 取消，`/question` 清空且回合结束。

## 4. 打断与取消

- 模型输出长文本时：全量 TUI 连按两次 Esc、`--mini` 按一次 Esc，应停止
  在途流并回到可输入状态；thinking 指示不应一直转圈。

## 5. 退出提示

- 会话有内容时退出（`exit`）：官方 opencode splash（logo + session id）
  照常显示，其下方 dsh-oc 补一行说明：session id 是 dsh 会话 id，恢复用
  `dsh --profile oc --session <id>`。
- `DSH_OC_DISABLE_EXIT_NOTE=1` 可关闭说明；空白会话退出不显示 splash。

## 6. agent / preset

- 空白会话：`/preset minimal` 或 Tab 切换 agent 生效，新会话继承。
- 已开始回复的会话：切换应被 dsh 锁定，切换后第一条消息出现一次
  “Agent switch locked”提示，而不是静默失败。

## 7. mini 模式

- `dsh --profile oc --mini`：回复只渲染一次（无重复）；Esc 单按打断；
  权限 Esc 多一步确认层；退出同第 5 节。

## 8. 其它入口

- `--dir <path>` 改变工作目录（路径、附件校验基准）；`--fork` 从当前会话
  派生；`--log-level` 透传给 opencode。
- 附件：文本与图片可发送；PDF 等二进制应被拒绝（400）。
- `/goal` 创建/查看/暂停/恢复/完成 goal，sidebar 同步展示。
- `/help` 展示能力摘要；`/preset` 列出 agent preset。

## 9. 协议端点冒烟（可选，开发者）

启动后从 attach 进程参数取 bridge URL（`opencode attach http://127.0.0.1:<port>`）：

```bash
B=http://127.0.0.1:<port>
curl -s $B/api/health                       # {"healthy":true}
curl -s $B/vcs                              # 当前 git 分支/默认分支
curl -s $B/api/fs/read/README.md            # 工作区文件内容
curl -s $B/api/fs/list                      # 工作区目录
curl -s "$B/api/fs/find?query=README"       # 文件查找
curl -s $B/api/permission/request           # 无 pending 时 {"data":[]}
```

## 10. 已知限制复核

- `Allow always` 重启清空；MCP/LSP/formatter/skills/integration 为
  schema-valid stub；opencode 退出 splash 无法替换（只有下方说明）；
  `ask_user_question` 的 `multiple` 选项在官方 TUI 中无可视多选交互。

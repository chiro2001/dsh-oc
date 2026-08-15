import { DSH_OC_VERSION, OPENCODE_VERSION } from "./index.js";
//#region src/help.ts
/**
* `dsh --profile oc --help` and TUI `/help` output; kept deliberately static
* so it works offline and is identical across entry points.
*/
function ocHelp(version = DSH_OC_VERSION) {
	return `dsh-oc ${version} — DeepSeek Harness × OpenCode TUI (opencode ${OPENCODE_VERSION})

用法:
  dsh --profile oc [attach 参数]

支持的 attach 参数:
  --continue/-c, --session/-s, --fork, --dir, --mini, --print-logs, --log-level

核心能力:
  ✅ 会话列表/新建/续聊/fork/compact，SSE 流式消息
  ✅ dsh 模型目录、reasoning effort、agent preset 切换
  ✅ 工具卡片（bash/read/write/edit）、流式工具参数、diff 与 Modified Files
  ✅ 权限/提问流、子代理会话树与后台子代理
  ✅ 自动更新关闭、二进制版本锁定 ${OPENCODE_VERSION}
  ✅ DSH OC 品牌启动 logo
  ✅ 会话列表真实标题（标题 → 目录名 → id 回退）
  ✅ Esc 打断/取消（全量连按两次、--mini 单按），/preset 新会话继承
  🟡 文件附件支持文本/图片；"Allow always" 为会话内内存记忆
  🟡 退出时官方 opencode splash 保留，下方补一行 dsh 恢复说明（可关闭）
  ❌ MCP/LSP/formatter/skills/integration 等外围路由为 stub

完整能力矩阵: docs/FEATURES.md（仓库内）
协议与路由: docs/PROTOCOL.md
下一阶段需求: docs/ROADMAP.md
`;
}
/** Whether the raw dsh args request the dsh-oc help screen. */
function helpRequested(args) {
	return args.includes("--help") || args.includes("-h");
}
//#endregion
export { ocHelp as n, helpRequested as t };

//# sourceMappingURL=help-C-3FRWbU.js.map
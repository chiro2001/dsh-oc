# dsh-oc Round 0002 审阅建议

审阅基线：题设所述 commit `4c43254`，2026-08-17。本文基于指定输入及与恢复、SSE、打包、回放直接相关的实现和测试做静态审阅；按约束未执行安装、构建、测试或 Git 写操作。

标记约定：

- **[事实-题设]**：来自 `context.md` 的运行结果，本次未独立复跑。
- **[事实-静态]**：可由当前代码、脚本或文档直接确认。
- **[推断]**：基于事实作出的工程判断。
- **[需实验]**：现有材料不能定论，给出可证伪方法。

## 一、结论先行

1. **当前对 `v0.1.0-rc.2` 是“条件性 NO-GO”，不是因为已有证据证明代码必然错误，而是主恢复 oracle 名不副实。**
   - **[事实-题设]** 全量 mock 门槛、本地 `check-all.sh --e2e`、双分支 CI 和一次真实模型 smoke 均已通过。
   - **[事实-静态]** `e2e-recovery-consistency.sh` 比较的两侧都来自最终态 `GET /api/session/:id/message`；更准确的名称是“带进程内映射的 warm-history 投影 vs 新进程 cold-history 投影”，不是实时 SSE 图 vs 冷恢复图。
   - **[推断]** 该测试非常有价值，确实能捕获“进程内 id remap 导致 warm/cold 消息数不同”这类回归，应该保留；但它不能单独证明 TUI 已看到的实时状态、SSE 重连状态与持久历史一致。

2. **先不要给该脚本加 `--continue` 图一致性变体；优先做客户端 SSE 断线、底层 mux 重订阅和硬崩溃恢复。**
   - **[事实-静态]** `-c`/`--continue` 只是原样透传给官方 TUI；已有 `e2e-tui-continue.sh` 已验证它会选择较新的会话并显示其内容和真实标题。显式 `--session` 另有目标 history 预取，但选定会话后的消息读取路径相同。
   - **[推断]** `-c` 新变体的新增信息主要是“选中了哪个 session”，不是一种新的持久化/恢复机制；现有 continue e2e 已覆盖其核心风险。断线和崩溃会跨越真正不同的状态边界，信息增益高得多。
   - **[需实验]** 以后可补一个低成本的 `-c` 选择契约：同 cwd/异 cwd、同时间戳、空白会话与最近有内容会话时到底选择谁；不应把它与消息图恢复实验绑在一起。

3. **工具+排队即时错序可以作为 rc 的已知显示限制交付，但“已裁决为上游 TUI”仍缺最后一块可复核证据。**
   - **[事实-题设]** 数据完整、无重复，重新 `--session` 后顺序正确；文档还记录官方 opencode 的同类场景可能丢失工具后文本。
   - **[推断]** 这些证据足以停止 bridge 中无边界地调整事件时序，也足以不让该视觉残余单独阻断 rc.2。
   - **[事实-静态]** 当前仓库没有随版本保存的“官方 1.18.18 + 最小兼容服务 + 确切 HTTP/SSE 序列 + 键盘脚本 + TUI 捕获”证据；文档结论无法让后来维护者排除 bridge 的双协议事件、请求竞态或非法状态转换。
   - **[推断]** 若继续使用“归上游/已裁决”的确定措辞，rc.2 前应补官方最小复现；否则把措辞降为“在官方 TUI 1.18.18 中观察到的即时显示限制，bridge 侧持久数据正确，具体归因待最小复现”。二者任选其一即可，不需要等待上游修复。

4. **“mock 全绿 + 一次真实模型 smoke”是必要但不充分的 rc.2 资格。**
   - **[事实-静态]** 真实模型脚本的排队检查只断言用户消息总数为 3，却输出“in order”；TUI 阶段的文本 grep 带 `|| true`，随后只打印 user count，没有断言该输入完成、顺序正确或只渲染一次。
   - **[推断]** 真实 smoke 能证明凭据、provider、真实 TUI 和一条常规工具路径可以联通；它不能作为 reasoning、多工具、拒绝、错误、中断、compaction、重连和不同持久编码的 oracle。

5. **rc.2 仍应是 RC/canary，而不是稳定版。** 通过本文最小门槛后可以发布 rc.2；稳定版还应等待一段真实 canary 数据和升级 ABI lane 的实际演练。

## 二、现有恢复一致性证据的具体缺口

### 2.1 当前 e2e 实际证明了什么

- **[事实-静态]** `signature()` 在两侧调用 `/api/session/$sid/message`，没有订阅或归约 SSE（`scripts/e2e-recovery-consistency.sh:71-85,116,125`）。
- **[事实-静态]** live 侧的 route 会使用进程内 dsh-id → surface-id 映射，fresh process 侧映射已消失。因此当前测试确实证明：在该固定文本+工具样例中，warm/cold v2 history 投影的消息数、角色序列和简化 part 序列相同。
- **[事实-静态]** 这次重启是通过 `e2e_tui_exit` 正常退出，再启动新 dsh 进程；它证明冷启动重建，不证明 SIGKILL、写入半途、无 `turn/end` 或残留 `running` 状态。

### 2.2 当前断言中有三处实质性盲区

1. **“父链一致”是空断言。**
   - **[事实-静态]** 当前 `convertMessagesV2` 产出的 user/assistant `SessionMessage` 没有 `parentID`；脚本读取 `$msg.parentID`，所以当前样例的 `parent` 全为 `null`。
   - **[事实-静态]** 真正携带 `parentID`、且被官方 TUI 消费的是 v1 `message.updated`/`GET /session/:id/message` 面；当前恢复脚本没有比较它。

2. **part 归属和工具语义被归一化掉了。**
   - **[事实-静态]** 最终断言用 `[$graph[].parts[].type]` 和 `text` 做全局扁平比较，part 从一条 assistant 移到相邻同角色 assistant 时仍可能通过。
   - **[事实-静态]** 工具只抽取 `.state.output // .state.input`，没有比较 `name`、`status`、`content/result/error`、call 关联和完成态；当前 v2 completed tool 的有效输出主要位于 `state.content`，不在该签名内。
   - **[推断]** “内容完整、工具结果相同、part 属于同一消息”尚未由此 e2e 证明。

3. **快照可能在业务完成前取得。**
   - **[事实-静态]** `wait_text` 等待的是用户 prompt 自身出现在 history，该条件可在模型完成前成立；`wait_tool` 只要求某个 tool part 存在。随后是固定 `sleep 3`，没有等待 session idle、tool terminal state 或第二轮 assistant 完成。
   - **[需实验]** 慢 runner 或改变 chunk 延迟时，测试是否可能稳定地比较两个相同但未完成的前缀。

### 2.3 一个当前测试看不到的具体父链风险

- **[事实-静态]** live SSE 的最终 assistant 使用 `state.lastUserMessageId` 作为 parent（`src/bridge/events.ts:994-1001`）。
- **[事实-静态]** v1 history fold 使用 `lastMessageId` 作为 parent，并在每条 assistant 后把它更新为该 assistant id（`src/bridge/convert/message.ts:529-561`）。
- **[需实验]** 在“同一 user turn 的 tool assistant → follow-up text assistant”中，live 图可能是两个 assistant 都指向 user，而 cold v1 history 可能是 follow-up 指向前一 assistant。哪一种符合 opencode 1.18.18 的真实语义也应由黄金轨迹判定；现有 v2 parent 空断言无法发现这一分叉。

结论：**当前测试应降级描述为 warm-history vs cold-history regression，并升级 oracle 后再作为恢复一致性主证据。**

## 三、四类“恢复”不是同一条路径

| 路径 | 已知事实 | 主要风险 | 需要的实验 |
|---|---|---|---|
| `--session <id>` | 显式选定 dsh session；新 bridge 的 `InteractionState` 为空；从 dsh history 冷折叠 | 内存 id、agent/model、队列、权限映射消失；历史页边界可能切开工具回合 | 完成态和崩溃中途两种 cold reattach；同时比较 v1/v2 与真实 SSE reducer |
| `-c`/`--continue` | flag 交给官方 TUI；已有 e2e 证明“较新 B 被选中” | 列表排序、cwd 过滤、并列时间和空白会话的选择歧义 | 独立的小型选择契约即可；消息图无需复制 `--session` 全套 |
| 客户端 SSE 重连 | bridge 会写 SSE `id:`，但 id 是每个翻译事件新生成的 UUID；`startSse` 不消费 `Last-Event-ID`，新 HTTP 连接会新建 mux 与 replay guard | gap 中事件漏掉，或 mux 初始重放导致重复；正确性依赖官方 TUI 是否重拉 history/按稳定 message+part id upsert | 在工具 success、follow-up text、queued user、turn/end 四个 cut point 强制断 TCP；记录重连请求和最终 TUI/API 图 |
| bridge 内 mux 重订阅 | 同一 HTTP SSE 内保留 chunk/approval/question replay guard，但销毁并重建 translator；block/tool/current-assistant 状态不保留 | 已见 chunk 被 guard 跳过，而新 translator 又缺少旧 provisional/tool 状态；或非 chunk 事件被重放两次 | 注入一次 `api.events.mux` throw，分别测试“重放前缀”和“只从新事件继续”两种 dsh 行为 |
| bridge/dsh 硬崩溃重启 | bridge 嵌在 dsh 进程内；所有 `InteractionState` 映射为内存状态 | 最后一条持久事件可能是 chunk/tool call/turn start；没有 final message 或 `turn/end`，会话可能残留 busy/未完成卡片/待回复 permission | 临时 DSH_HOME 中在已确认持久 seq 后 SIGKILL，显式 `--session` 重启；验证终止态、可继续输入和持久前缀 |

**[推断]** 不应再用“重连”一个词覆盖上述故障域。至少要分别命名 `client-sse-reconnect`、`mux-resubscribe`、`process-crash-recovery`，否则一个全绿用例容易被误读成三者都已覆盖。

### 建议先冻结恢复契约

这不是对现状的描述，而是建议的 **[推断/设计契约]**：

- 已完成 durable turn：角色、顺序、文本/reasoning、tool input/output/error、part 归属和引用关系 exactly-once。
- 进程崩溃时的 in-flight turn：至少恢复已经持久化的前缀；不得伪造成功；重启后必须得到一个明确 aborted/idle 终态，且下一条 prompt 可被接受。
- title/goal/todo 等持久 projection：冷启动后恢复。
- queued message、pending permission/question：若 dsh 有权威 snapshot 就重发；没有则明确取消，不能留下不可操作的 TUI 卡片。
- `Allow always`、bridge 合成 command/error 文本等纯内存/临时表面：允许不恢复，但必须明确列为 transient。已知 `Allow always` 重启清空可继续接受。

若团队不先写清这一契约，“live 与 restore 完全相等”在 compaction、host error、命令结果和中断场景中反而可能是错误 oracle。

## 四、已知错序的归因与关闭标准

### 当前可以关闭的部分

- **[事实-题设]** 历史转换已修复重复/错合并，重新进入后内容和顺序正确。
- **[推断]** 可以关闭“继续在 bridge 中试事件时机”的工作项；rc.2 可以携带这个即时显示限制。

### 当前不能严谨关闭的部分

- **[推断]** “官方自身也丢文本”是相关旁证，不是 renderer 归因证明，因为官方 server 可能根本没有发出与 bridge 相同的合法事件序列。
- **[需实验]** 用最小 OpenCode-compatible server 向官方 1.18.18 TUI 喂入与 dsh-oc 完全相同的 HTTP 初始状态和 SSE 序列，并固定 PTY 尺寸、键盘时刻和 cut point：
  1. user message；
  2. incomplete tool assistant；
  3. tool success；
  4. queued user；
  5. 原 turn 的 follow-up text；
  6. assistant completed + turn idle。
- **可证伪断言**：若 wire trace 的因果顺序和引用完整、官方 TUI 仍把 follow-up 放到 queued card 后，才可稳定归因 renderer；若最小服务不复现，bridge 的双 v1/v2 表面、额外 history fetch 或事件合法性仍需检查。

此实验不是 rc.2 的硬 blocker，前提是文档不用确定的“上游已裁决”措辞。若希望保留该措辞，最小复现证据就是门槛。

## 五、“mock 全绿 + 一次真实模型 smoke”仍缺什么

### 现有证据的正确定位

- **[事实-题设]** mock 套件覆盖广，且使用真实 opencode TUI，是当前最强的可重复主路径证据。
- **[事实-静态]** CI 在 checkout 中先 `pnpm build`，随后 e2e 默认从 repo root 安装；它验证“源码构建后的工作树”，不验证 GitHub 下载到的原始包。
- **[事实-静态]** `scripts/replay-session-audit.sh` 只把持久 session event 喂给 `MuxEventTranslator`，主要查 unhandled/error；`audit-local-sessions.sh` 另查 id/role、完成态与 tool pairing。二者都没有生成并对比 v1/v2/history/SSE 的黄金消息图，也不覆盖 host、queue、approval/question 等非 session JSONL 帧。

### rc.2 前仍需补的证据

- 真实持久编码：live `assistant/chunk` 与落盘后的 packed `text-chunks`、`reasoning-chunks`、`tool-call-chunks` 必须归约为同一语义。
- 失败形态：permission reject、tool error、model/host error、interrupt、无 final message、compaction checkpoint。
- 多 step/多 tool：单 turn 中工具 assistant、tool result、follow-up assistant 的引用和分页边界。
- 故障边界：客户端 SSE、mux retry、进程崩溃。
- 发布工件：真实 smoke 必须至少一次从远端候选 full SHA 安装，而不是从 `.` 安装。
- 平台：当前自动 e2e 只有 Ubuntu x64；macOS arm64 若继续在支持面中，应做候选 smoke。

**[推断]** 真实在线模型仍只应承担 smoke：发现 provider/event 新形态并确认整链路可用。桥接正确性应由脱敏、固定、离线 replay corpus 和故障注入承担。

## 六、真实会话回放：脱敏与确定性要求

“10+ 会话”不是合格标准；事件形态覆盖才是。建议建立 feature manifest，每个高风险形态至少被一个 fixture 覆盖，一个会话可覆盖多个形态。

### 脱敏

- **[事实-静态]** session JSONL 可能含 prompt、reasoning、工具命令/参数/输出、文件内容、绝对路径、用户名、host、URL、错误栈、git remote 和 compaction 对旧内容的复述；只做 token regex 不足够。
- **[推断]** 采用字段 allowlist + 结构化替换，而不是 blacklist：保留 `type/seq/turn/step/index`、引用关系、block 类型、chunk 边界和相对时间；文本替换成有唯一标记的合成内容。
- id、call id、session id 用 fixture 内随机映射表做一致替换；不要直接提交低熵原值的普通 hash。
- 路径统一到 `/workspace/...`；命令、tool output、错误和 compaction summary 分别处理；图片/base64/二进制附件替换为合成 fixture。
- 原始文件只在本地临时目录处理，不进入仓库和 CI artifact；脱敏后跑 secret scanner、绝对路径扫描，再人工复核一次。
- 为每个 fixture 提交来源类别、覆盖标签、脱敏器版本和 canonical hash，不提交能反推原文的映射表。

### 确定性 oracle

- 同时保留两种脱敏输入：live mux trace 与 durable session log。不能用落盘 packed 事件冒充 live SSE，因为二者正是需要比较的两个编码。
- 固定 dsh/schema/opencode 版本；时间改成相对时间，随机 surface id 由注入的 deterministic generator 生成。
- 检入人工复核过的 expected canonical graph；测试期间不得从“当前实现输出”现算 expected，否则 oracle 与实现同源。
- canonicalization 只去掉端口、绝对时间和随机名称，必须保留 id 等价类、所有引用是否可解析、message→part 归属、tool call→result 配对、完成态和内容 hash。
- 在同一 fixture 上增加 duplicate-prefix、chunk split/merge、cut-and-resume、分页切点等变形测试；这些变形的语义图应不变。
- approval/question/session queue/host error 若不在 JSONL 中，作为伴随 mux-frame fixture 单独保存。

## 七、GitHub 源安装、升级、回滚和 `lib/` 一致性

- **[事实-静态]** `package.json` 仍是 `0.1.0-rc.1`；exports 只指向 `lib/`，`files` 包含 `lib` 而不含 `src`，且没有 `prepare`。GitHub 用户得到的是提交中已有的构建产物。
- **[事实-静态]** 当前 CI 先 build 再从本地 checkout 安装，可能在测试前修正 stale/missing `lib`，但没有检查 build 后 `lib` 是否与 commit 原样一致。
- **[事实-静态]** `#main`/`#develop` 是可变引用；Git tag 在没有保护规则时技术上也可移动。仅写 `v0.1.0-rc.2` 不等于内容寻址。

rc.2 建议以完整 commit SHA 为真相源：

1. bump package version 到 `0.1.0-rc.2`，在干净 checkout 构建，并要求 rebuild 后 `lib/` 零差异；检查 pack manifest、source map 和机器绝对路径。
2. 在另一干净环境用 `github:chiro2001/dsh-oc#<full-sha>` 安装，不允许指向本地 checkout，也不允许先 build 消费者副本。
3. 记录 full SHA、package tree/tarball hash、opencode 1.18.18 asset hash、Node/pnpm/dsh 版本。
4. 用不可变的前一 RC SHA → 候选 SHA → 前一 SHA 演练；每一步核对 `--help`/package version、`dsh-oc` PATH、旧会话恢复、文本+工具和锁定二进制。
5. 演练通过后再把受保护的 `v0.1.0-rc.2` tag 指到该 SHA；release note 同时写 full SHA。README 的滚动分支命令应明确标为 channel，不作为精确回滚依据。

**[需实验]** pnpm/dsh 对“同版本号 + 可变 Git ref”的缓存刷新行为在不同机器上是否一致。正确规避方式不是继续猜缓存，而是版本号变化 + full SHA 安装。

## 八、把官方二进制当 vendor ABI 的可执行升级机制

版本锁定只是避免无预警漂移；真正的 ABI 门槛应由“同输入、双版本、语义差分”组成。

### 8.1 先在 1.18.18 上冻结基线

- 黄金请求轨迹：method/path/query/body、关键 header、请求顺序/允许并发关系、重连时是否重拉 history。
- 黄金 SSE 轨迹：事件类型、properties/data schema、message/part id 等价类、状态转换和因果偏序；去掉 UUID、端口和绝对时间，但不去掉引用关系。
- 黄金键盘/TUI 轨迹：固定 PTY 尺寸和键盘脚本，覆盖 boot、新会话、`--session`、`-c`、reasoning、multi-step tool、queue、permission/question、abort、compaction、fork、附件、SSE reconnect、exit。
- 每条黄金场景同时有状态机 invariant；截图只做补充，不能替代协议 oracle。

### 8.2 候选版本独立 lane

1. 保留 1.18.18 锁定文件不动，把候选 binary/asset 清单作为第二输入。
2. 同一 deterministic bridge/replay server、同一键盘脚本分别跑 current 和 candidate。
3. 生成机器可读 semantic diff：新增/缺失请求、query/body 变化、SSE 消费变化、完成态/排序/重连/权限回复变化、TUI 可见差异。
4. allowlist 只能容纳已解释的非语义差异，如版本文案或独立 boot probes 的并发顺序；未知差异默认失败，更新 golden 必须附理由。
5. SDK 类型和 62/62 route probe 作为早期告警；真实 binary wire trace 才是 vendor ABI 的最终依据。
6. lane 全绿并通过两平台 smoke 后，才更新 `opencode-version.json` 和默认 asset；不要边改默认版本边逐个修表面现象。

### 8.3 防止 lane 退化成“逐个试”

- 用 canonical reducer 比较完整场景矩阵，而不是看到一个 UI 问题就调整一次 bridge。
- 每个发现的 ABI delta 归类为 `client-request`、`server-schema`、`event-order`、`state-machine`、`terminal-render` 之一，并形成永久 fixture。
- 记录 `{opencode version, asset sha256, trace hash, bridge commit}` 四元组；没有这四项的“升级通过”不可复核。
- 先用最小 wire replay 定位归属，再决定 adapter、版本条件分支或上游 issue；不要直接污染当前 1.18.18 路径。

## 九、flake 统计的成本控制

- **[事实-静态]** `check-all.sh` 对所有失败脚本无条件整脚本重试一次；首败日志会复制到 `/tmp`，但 green CI 不上传它，也没有 pass-after-retry 计数。
- **[推断]** “每项 50 次”适合发现常见 flake，不足以证明首次通过率 ≥98%。若 50 次零失败，失败率的单侧 95% 上界约为 `3/50 ≈ 6%`；要把上界压到 2% 以下，需要约 149 次零失败。
- **[推断]** 50 次完整 permission/TUI 脚本成本很高，而且一个脚本含多个阶段，失败签名难定位。应重复最小场景，不重复整个八分钟套件。

建议两层预算：

1. 候选全套只跑一次，但任何语义首败即视为失败，不能靠 retry 变绿；明确的 runner/连接基础设施签名才允许一次定向 retry。
2. 对 recovery、permission、agent-tab、queue 各拆出 30–60 秒的最小高风险 case：先各跑 10 次；发现一次语义失败立即停止并修；零失败后只把历史高风险项扩到 30–60 次。若目标是以 95% 概率发现发生率 ≥5% 的 flake，需要 59 次。
3. 固定 commit、runner image、PTY 尺寸、mock seed；输出一份小 JSON 汇总（attempt、首次通过、签名、耗时），只保留每个签名的首个完整 artifact。
4. 设 release-lane 总预算 30–45 分钟；超预算优先缩小 case，不扩大 timeout。相同语义签名出现两次，或一次可稳定复现，即开 blocker。

这能把“50 次”从仪式性数字变成明确的发现能力和成本上限。完整 50×全脚本审计可在 rc.2 后继续，不应卡住所有开发资源。

## 十、按信息增益排序的三个下一步动作

### 1. 修正 oracle，并跑三故障域恢复矩阵

- **输入**：固定 opencode 1.18.18；一个 deterministic 场景，包含 reasoning → tool-call chunks → tool result → follow-up text，同时在 busy 中排队第二条 user；另加 permission reject、interrupt 和 tool error 小 fixture。
- **动作**：
  1. 先等权威 idle/tool terminal/第二轮完成，移除固定 `sleep 3`。
  2. 从提交前开始保存原始 SSE，并用独立 reducer 生成 live v1 图；同时保存 warm v1、warm v2、fresh `--session` v1/v2。
  3. 保留 id 等价类和引用，不保留随机字面 id；逐消息比较 part，而非全局扁平比较。
  4. 依次注入客户端 TCP SSE 断开、底层 mux throw、已确认持久 seq 后 SIGKILL；每种只选 2–3 个最高风险 cut point。
  5. 顺带让 `/api/session/:id/history?limit=1/2` 的分页边界切过 tool call/result/follow-up，并在翻页间追加一轮，检查游标契约。
- **可证伪断言**：所有 completed durable 内容 exactly-once；每个引用可解析；message→part 和 call→result 归属不变；tool name/input/output/error/status 不丢；重连后无永久 busy/spinner；硬崩溃不伪造完成且会话可继续；分页无漏页/重页。
- **停止条件**：任一可重复丢失、重复、错 parent/part、悬空 call、无法回 idle 或无法续聊，立即阻断 rc.2，并在首个发生分叉的层修复；不要继续堆更多变体。
- **耗时**：一次性实现约 0.5–1.5 人日；稳定 lane 每次约 6–10 分钟，单 cut point 30–90 秒。

### 2. 用 full SHA 做不可变候选安装/升级/回滚演练

- **输入**：前一 RC 的不可变 SHA、候选 full SHA、全新 DSH_HOME、一个带旧 tool turn 的持久会话；Linux x64 与 macOS arm64；固定 dsh/Node/pnpm 版本。
- **动作**：按第七节从远端 SHA 冷装，检查 manifest/版本/commit/`lib`/binary；执行 previous → candidate → previous；每步运行一个 2 分钟以内的文本+工具+恢复 smoke。候选 SHA 上再跑一次真实 LLM quick smoke。
- **可证伪断言**：同一 SHA 得到相同 package tree hash；包自报 rc.2；不依赖 checkout/build；升级后旧会话图不变；回滚可操作；`dsh-oc` 与 1.18.18 binary 正确；两平台声明与实测一致。
- **停止条件**：stale/missing `lib`、版本仍为 rc.1、Git ref/cache 取错内容、旧会话不兼容、回滚失败或任一声明支持平台启动失败，均阻断 tag。
- **耗时**：脚本化约 0.5 人日；每平台 15–25 分钟，可并行，墙钟控制在 30 分钟左右。

### 3. 建立脱敏真实 corpus，并同时冻结 1.18.18 ABI/错序最小轨迹

- **输入**：按事件形态选择的真实 live trace + durable log，覆盖 reasoning 有/无、单/多工具、拒绝、错误、中断、compaction、插件上下文；已知工具+排队错序 trace。
- **动作**：结构化脱敏、人工复核，生成 feature manifest 和人工审阅的 canonical graph；运行 live/durable 双编码、分页和 cut-and-resume 变形；用同一已知错序 trace 驱动官方 1.18.18 TUI，保存 HTTP/SSE 与终端捕获，作为未来双版本 ABI lane 的 current baseline。
- **可证伪断言**：所有必需事件形态有覆盖；live 与 durable 的 completed graph 等价；无 unhandled/role conflict/悬空引用；fixture 不含 secret/绝对机器路径；最小 trace 能明确复现或否定 TUI 错序归因。
- **停止条件**：脱敏无法可靠证明、golden 由当前输出自动自证、或同一真实事件的 live/durable 图分叉时，不扩大语料数量，先修脱敏/oracle/首个分叉。
- **耗时**：首次 1–2 人日；离线 corpus 每次 2–5 分钟；官方 TUI 黄金轨迹 5–10 分钟。数量从 4–6 个高覆盖 fixture 起步，是否扩到 10+ 由 coverage 缺口决定。

## 十一、rc.2 发布前的最小门槛

以下全部满足后，建议 **GO for rc.2/canary**：

1. **恢复 oracle 可信**：当前 e2e 修正为真实 SSE reducer + warm/cold v1/v2；父链、part 归属、tool terminal data、完成态均为非空断言，并等待权威 idle。
2. **三个故障域通过**：client SSE reconnect、mux resubscribe、process crash 各至少一个关键 active-turn case；崩溃后满足“持久前缀不丢/不伪造完成/回 idle/可续聊”。
3. **history 边界通过**：工具回合跨小页、连续 `after` 和翻页间追加无漏/重；已有 20k 文本型性能基线继续保留。
4. **真实事件不是盲区**：至少一组按 feature manifest 覆盖高风险持久编码的脱敏 fixture 有人工审阅 golden；门槛按覆盖而不是机械的“10 个文件”。
5. **候选工件可复核**：package version 为 rc.2；clean rebuild 后 committed `lib/` 零差异；pack manifest/绝对路径检查通过；full SHA 和 package tree hash 被记录。
6. **真实 GitHub 链路通过**：从远端 full SHA 的 clean install、前版升级、旧会话恢复和回滚通过；至少 Linux x64 + macOS arm64 smoke。若做不到某平台，就在 rc.2 明确收缩支持声明。
7. **候选 commit 全绿**：typecheck、unit、probe、完整 mock e2e、相关恢复 fault e2e 全绿；语义首败不得由无条件 retry 洗绿；一次真实 LLM smoke 从远端候选 SHA 运行。
8. **错序措辞闭合**：要么附官方 1.18.18 最小复现 trace，要么把“已归因上游”降为中性已知限制；内容持久正确仍是硬断言。
9. **发布元数据闭合**：受保护 tag 指向已演练 SHA，CHANGELOG/README/AGENTS 写清 rc.2、full SHA、滚动分支与不可变安装/回滚区别、已知恢复/权限限制和支持矩阵。

任一重复出现的 durable 内容丢失、重复、错引用、工具结果丢失、崩溃后会话不可继续、stale `lib` 或远端 SHA 安装失败，均是 rc.2 blocker。

## 十二、可延后项与投入比例

可延后到 rc.2 之后：

- `--continue` 的完整消息图变体；保留现有“选择最新会话”e2e 即可。
- 全部脚本逐项 50 次；先做预算内的最小高风险 case 统计。
- 把 corpus 机械扩到 10+；先让 feature manifest 无关键空洞。
- 实现 Last-Event-ID ring buffer 或持久 bridge state；先用实验判定官方 TUI 的 refetch/upsert 是否已经满足契约，再决定设计。
- 等待上游修复即时错序；rc 只需要可复核归因或中性文档。
- Windows/ARM、外围 stub、新功能和 opencode 候选升级；按“声明即测”收缩支持面。升级机制的 1.18.18 黄金基线应现在建立，真正双版本 lane 可在下一次升级前完成。

当前 1–2 个迭代建议投入：

- **功能面 5%**：只处理为恢复/可测试性所必需的接口，不扩外围能力。
- **稳定性面 60%**：oracle、SSE/mux/crash、真实 replay、分页边界、flake 定位。
- **流程面 35%**：不可变候选、`lib` provenance、双平台、ABI 黄金轨迹、发布文档。

最终方向：**保留现有 recovery e2e，但纠正其证据等级；不优先做 `-c` 重复变体；用故障注入和远端不可变工件把 rc.2 的“恢复一致性”与“可回滚发布”同时闭合。**

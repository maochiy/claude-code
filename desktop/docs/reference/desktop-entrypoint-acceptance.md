# 桌面功能入口迁移与验收台账

更新时间：2026-09-18

## 范围与判定口径

本轮只按源码调用链和现有测试核对桌面入口，没有启动真实模型、外部机器人、语音服务、更新服务或用户业务项目。`LocalCliRuntimeAdapter` 的 loopback 集成测试使用仓内 fake CLI，因此“源码已接线”不等于真实 CLI、真实渠道或安装包已经通过。

状态含义：

- **已接 Local CLI**：模型执行能从入口追到 `LocalCliRuntimeAdapter`，未发现旧 Provider/Pi 执行分支。
- **部分接通**：主执行链已统一，但附件、MCP、停止、来源归属或失败事务仍有确定缺口。
- **系统服务**：能力本身不是模型执行入口，应继续由 Electron Main/Renderer 负责，不要求绕经 Local CLI。
- **未接通**：可见入口或辅助函数存在，但生产事件没有进入有效执行链。

正式生成入口的统一策略位于 `runtime/executable-runtime-policy.ts`：新执行固定为 `local-cli`。仓内 `@proma/core` Provider 实现仍作为包能力保留；桌面 Main 的生产生成路径未发现直接调用这些 Provider adapter。渠道连通性、模型目录、套餐额度等直接 HTTP 请求属于配置/查询服务，不是模型生成旁路。

## 逐入口台账

| 入口 | 实际调用链 | 状态 | 当前测试证据 | 缺口与验收要求 |
| --- | --- | --- | --- | --- |
| Code / Agent 主界面 | Renderer `AGENT_IPC_CHANNELS.SEND_MESSAGE` → `startAgentRun` → `AgentOrchestrator.sendMessage` → `RuntimeAdapterRouter` → `LocalCliRuntimeAdapter`。Router 默认且唯一执行适配器见 `runtime/runtime-adapters.ts:25-42`。 | **已接 Local CLI，真实 CLI 待验** | `local-service/runtime-adapter.integration.test.ts` 当前 7 项、37 个断言通过，覆盖两轮、权限/取消、队列、服务恢复及物化 MCP 的真实 HTTP 调用和关闭后 404；`client.integration.test.ts` 覆盖游标、重连和代次。这些仍是 loopback/fake CLI 证据。 | 仍需真实 CLI 覆盖六模式、审批、计划、后台任务、子代理和重载恢复，不能以 fake CLI 代替。 |
| Hermes / 动态工作流 | Agent 主链只保留一个 `this.adapter.query()` 调用点；已删除 `HermesTaskScheduler`、`runDispatchContinuation()`、`<hermes_task>` 二次 prompt 以及任务批准/推进写入。旧 `DispatchRun` 仅由 `runtime/hermes-dispatcher.ts` 只读查询。 | **已收敛到 CLI 原生循环，真实 CLI 待验** | `native-orchestration-boundary.test.ts` 覆盖旧 `waiting_user` 多节点 Run 不进入主链、新消息只有一个 query 调用点、CLI 原生父子任务投影保持不变。 | 旧任务图仍可审计，但不会因“批准/按计划执行”等文本恢复执行。Tasks、Subagent、Plan 和 Workflow 的执行权来自 CLI 原生事件/controls。应用定时任务调度是独立系统能力，继续保留。仍需真实 CLI 验证一个用户回合中由 CLI 自己创建子任务时，桌面只投影而不另开宿主 query。 |
| Cowork / Chat | `CHAT_IPC_CHANNELS.SEND_MESSAGE` → `chat-service.sendMessage` → `LocalChatSession(new LocalCliRuntimeAdapter())`，见 `chat-service.ts:28-40,245-323`。图片作为原生 block，文档提取后进入上下文；工具先经本地 HTTP MCP host 物化再交 CLI，见 `chat-tools/chat-tool-mcp.ts:199-212`。 | **已接 Local CLI，代理环境已统一，真实代理待验** | `local-service/chat-session.test.ts` 的 8 项本地测试覆盖自定义指令、图片、多轮、resume、用量、停止以及 Chat/Agent Session ID 隔离；Adapter 集成测试覆盖空内置工具与 strict MCP。所有 Local CLI 消费者现在由 `runtime-adapter` 统一合入应用代理。 | 仍需用真实本地 HTTP 代理验证 Chat 请求经过代理，并覆盖系统代理检测失败与会话重建。 |
| 飞书消息 | `FeishuBridge.handleUserMessage` → 共用 `runExternalHeadlessAgent`/registry → `agent-service.runAgentHeadless` → 同一个 `AgentOrchestrator`/Local CLI，见 `feishu-bridge.ts:1788`、`external-headless-run.ts`、`agent-service.ts:333-475`。 | **主消息来源与权限边界已通过本地 mock，完整 Bridge 待验** | `external-headless-run.test.ts` 证明 `source:'feishu'`、会话既有 Default/Bypass/Plan 权限和 stopper 等待语义原样进入生产共用 registry；卡片渲染、绑定筛选、Session 镜像和防休眠另有测试。 | 尚无完整 `FeishuBridge`→headless→fake Local Service 测试；仍需覆盖群聊自定义工具、附件、流式卡片和批次重试去重，禁止用真实联系人试发。 |
| 钉钉消息 | `DingTalkBridge` → 共用 `BridgeCommandHandler.handleUserMessage` → `runExternalHeadlessAgent(source:'dingtalk')` → agent-service/Local CLI。 | **共用入口与本地隔离已验，真实平台待验** | `bridge-command-handler.integration.test.ts` 使用本地 runner/EventBus mock 覆盖真实来源、会话附件 realpath 授权、跨会话附件拒绝、同会话并发拒绝、等待 stopper 和重复 result/error 终态只回一次。 | 仍需钉钉 SDK 事件/文件下载 fixture 与 fake Local Service 联合验证；不能把共用 handler 测试当作真实平台回包完成。 |
| 微信消息 | `WeChatBridge` → 同一个 `BridgeCommandHandler` → `runExternalHeadlessAgent(source:'wechat')` → agent-service/Local CLI。图片/文件先保存到会话附件目录。 | **共用入口与并发隔离已验，真实平台待验** | 同一 `bridge-command-handler.integration.test.ts` 已验证微信来源和同一外部会话并发只启动一次；共用用例覆盖附件边界、停止等待和终态去重。 | 仍需微信文件下载、大小/类型失败、应用重启绑定恢复和平台回包 fixture。 |
| 应用定时任务 | `automation-scheduler` 创建/复用 Agent Session → `executeAutomationAgentRun` → `agent-service.runAgentHeadless(source:'automation')`；超时后等待同一服务的 `stopAgent(targetSessionId)` 再结算。 | **Scheduler→Agent Service 来源与停止已通过本地 mock，真实 CLI 中止待验** | `automation-scheduler.integration.test.ts` 证明 Scheduler 保留 `triggeredBy/source:'automation'`，超时只调用目标 Session 的 `stopAgent` 一次，且停止期间迟到 complete/error 不改写终态；`automation-run-settlement.test.ts` 另覆盖正常完成、启动拒绝和停止失败。 | 尚需 fake/真实 Local Service 覆盖进程级中止、日切/补跑、重启、失败退避、复用会话上下文和通知只发一次。 |
| 任务看板 | 主按钮 `handleOpenConversation` 只创建 Agent 草稿、预填内容，用户再次发送后才进入正常 Agent/Local CLI，见 `TaskboardView.tsx:198-271`。 | **部分接通** | `taskboard-store.test.ts` 只验证存储；`taskboard-agent.test.ts` 验证纯构造/摘要辅助。 | 右键菜单“在对话中打开”仍是空 handler，见 `TaskContextMenu.tsx:378-383`。`buildTaskRunInput()` 在生产代码无调用者，注释所称“进入处理中自动执行”没有真实接线。需决定产品语义并为打开会话、首次发送后 threadId 绑定、失败保留草稿、自动执行（若保留）建立组件+IPC验收。 |
| 快速任务窗口 | `submitQuickTask` → Main 向主窗口发送 `quick-task:open-session` → `GlobalShortcuts` 创建 Chat/Agent Session、保存附件、写入既有 pending atom → 正常 Chat/Agent Local CLI 发送链，见 `ipc.ts:4918-4937`、`GlobalShortcuts.tsx:195-335`。 | **执行可汇入 Local CLI，提交事务不完整** | 未发现 Quick Task→主窗口→pending queue 的测试。 | Main 在确认主窗口实际接收、创建会话、保存附件前就隐藏窗口并让 IPC 成功返回；主窗口不存在或后续创建失败时，Quick Task 已清空草稿/附件且没有失败 ACK。需改为 accepted/failed 回执或持久队列，并验证 Chat/Agent 两种模式、附件失败与窗口重载。 |
| 内置浏览器（用户手动打开） | Renderer/Browser webview → Main `browser-agent-controller`/webview IPC。 | **系统服务，源码存在** | 页面读取、跨域 iframe、导航策略、任务隔离、点击/输入/滚动等单测较完整。 | 这是 Electron host capability，不应改成 CLI 自己启动浏览器；仍需真实 webview 鼠标验收和安装包权限验证。 |
| 内置浏览器（模型工具） | Agent 编排注册惰性内置定义，`materializeLocalCliMcpServers()` 将函数定义托管为本地 HTTP MCP endpoint，再把可序列化配置交给 Adapter。 | **transport 已接独立 CLI，具体工具真实调用待验** | Adapter loopback 集成已通过真实 HTTP MCP 工具调用并验证 host 关闭后 404；`mcp-transport.test.ts` 覆盖惰性定义、外部 endpoint 与失败清理。 | 仍需用真实 CLI 分别调用 Browser、Collaboration、Web Search 和生图工具，并验证窗口关闭、会话切换与错误回传。 |
| 语音输入 | 独立语音窗口采集麦克风 → Main `doubao-asr-service` WebSocket 转写 → `text-output-service` 或 Renderer 把文本插到当前输入框；用户发送后再走 Chat/Agent Local CLI，见 `ipc.ts:4960-5035`。 | **系统服务，模型发送边界正确** | 未发现 ASR session、窗口提交或插入当前光标的 BDD。 | ASR 不是生成模型入口，直连豆包合理。需使用 fake WebSocket/音频 fixture 验证 start/chunk/stop/cancel、凭据错误、窗口关闭、光标插入；语音提交不应自动绕过用户点击发送。 |
| 桌面通知与角标 | Agent 全局 listener 根据当前 Tab/窗口状态调用 Web Notification、声音和 Main attention；定时任务完成通知由 `automation-notification-service` 发飞书卡片。 | **系统服务** | `agent-completion-presence.test.ts` 覆盖前后台归属；自动任务通知格式有纯函数测试，但没有系统通知/外部投递集成测试。 | 当前自动任务外部通知只实现飞书，服务文件已明确钉钉/微信待接。需验证权限拒绝、Plan/AskUser、成功/错误不混淆、点击导航、drawAttention 不抢焦点，以及外部通知失败不改变任务终态。 |
| 网络代理 | 设置由 `proxy-settings-service` 持久化；`LocalCliRuntimeAdapter` 统一读取有效代理并通过 `buildLocalCliProxyEnvironment()` 合入所有 Local CLI 消费者，因此 Agent、Chat 和 AI commit 共用同一边界。 | **源码与环境测试已接，真实代理流量待验** | MCP/代理相关 5 项测试、21 个断言通过，覆盖 HTTP/HTTPS/ALL_PROXY 大小写、NO_PROXY、显式环境优先级及 MCP transport。 | 尚需本地 HTTP 代理 fixture 证明真实请求经过代理，并覆盖系统检测失败和会话重建。 |
| 自动更新/安装器 | Renderer updater atom → updater IPC → `electron-updater`；安装器下载器、GitHub release 查询也是 Main 系统服务。 | **系统服务** | 覆盖检查节流/重试、版本可用性和 unsigned mac 安装器纯逻辑。 | 不需要经过 Local CLI。仍缺最终品牌/appId/update feed、签名/公证、真实安装包升级、失败回滚和跨架构验证；目录包构建不能代替更新验收。 |
| 会话辅助 CLI | `/` 目录/上下文/自动压缩通过 Local Service control；compact 走同一 Adapter query；fork/rewind、任务图、单任务输出、子代理 transcript 均调用 Adapter control/query，见 `catalog-service.ts:193-220,300-320`、`runtime-adapter.ts:590-709`。Git AI commit message 使用一次性 `LocalCliRuntimeAdapter`，见 `git-ops-service.ts:496-562`。 | **已接 Local CLI，真实 CLI 矩阵待验** | catalog/context、任务输出游标、任务投影、fork/rewind相关 adapter 测试和 git commit fake runner 测试已存在；AI commit 也经统一 Adapter 代理环境。 | Chat/Agent 标题目前使用稳定本地 fallback，不是模型旁路，见 `chat-service.ts:410-412` 和 `agent-orchestrator.generateTitle()`。需真实 CLI 验证 draft catalog 不发消息、session 未打开时报错、compact 后用量、fork 源会话不变、rewind 文件结果、任务单停及 AI commit 代理流量。 |

## 跨入口补充证据

- Home 权限菜单源码和组件 BDD 已覆盖 Manual、Accept edits、Don't ask、Plan、Bypass、Auto 及当前语言说明；图片和文档从 Home 选择后会通过既有附件服务绑定新会话。修复后尚未完成真鼠标复核和固定截图。
- 最新源码的隔离 Electron 真窗口执行 Cmd+Q 后 exit 0，实际 Main PID 与受管 Local Service PID 均消失且未人工 kill。该记录证明空闲服务有序退出，不替代活跃任务和正式安装包退出验收。
- 本轮无外发本地检查同时运行 Scheduler、settlement、Chat、飞书共用边界及钉钉/微信 handler 共 23 项、70 个断言，全部通过；这些是 mock/fake 证据，不等于真实平台或真实 Provider 验收。
- 根 workspace 八个包的 typecheck 已全部通过，记录位于 `/tmp/xcodes-typecheck-final-pass.log`；最终合并后仍需重跑。

## 已确认的优先缺口

1. **P0：具体内置 MCP 工具仍缺真实 CLI 矩阵。** transport 已物化且真实 HTTP 调用通过，但 Browser/协作/Web Search/生图及飞书群聊工具尚未逐项经过真实 CLI 验收。
2. **P1：自动任务仍缺进程级 Scheduler→Local Service 中止验收。** Scheduler→Agent Service 的来源、单次 stopper 和终态竞争已通过本地 mock；仍需证明真实 CLI 中止、重启补跑、失败退避和通知一次性。
3. **P1：真实代理流量尚未验证。** 所有 Local CLI 消费者已统一代理环境，仍需本地代理 fixture 证明请求路径和失败恢复。
4. **P1：任务看板有可见空入口和未使用的自动运行辅助函数。** 主按钮只预填草稿是有效产品路径；右键入口与自动执行需明确补齐或移除承诺。
5. **P1：Quick Task 缺可靠接收确认。** 当前 fire-and-forward 可能在主窗口异常时丢失草稿和附件。
6. **P1：外部渠道仍缺平台适配层到 fake Local Service 的联合验收。** 共用 headless/handler 已证明来源、附件隔离、停止等待、并发和终态去重；飞书群聊工具/流式卡片及钉钉、微信各自的 SDK 下载与回包仍未覆盖。

## 验收顺序

1. 在已物化的 MCP transport 上，用真实 CLI 分别跑 Browser 和 Collaboration 的无外网 fixture 工具。
2. 在现有共用 headless/handler mock 之上，把飞书、钉钉、微信各自的平台 adapter 接入 fake Local Service，覆盖平台文件事件和实际回包序列。
3. 在已验证 Scheduler→Agent Service 单次 stopper 的基础上，补进程级 CLI 中止、自动任务重启补跑、失败退避和通知测试。
4. 以本地 HTTP 代理 fixture 证明 Agent、Chat 和 AI commit 请求确实经过统一代理环境。
5. 补任务看板和 Quick Task 的 Renderer→IPC→pending queue 事务测试，失败时草稿/附件必须保留。
6. 最后在隔离项目和测试机器人上做真实 CLI/外部渠道验收；语音、通知、浏览器 webview、更新继续作为 Electron 系统能力单独验收，不把它们强行改成模型执行链。

## 本轮未执行

- 未向真实模型发送消息。
- 未向飞书、钉钉、微信或通知目标发送消息。
- 未连接麦克风、豆包 ASR、网页、代理服务器或更新源。
- 未以现有单测文件数量宣称真实运行完成。

# 自有 CLI 桌面重做实施状态

日期：2026-09-18。验收基线为 [desktop-rebuild-master-plan-2026-09-18.md](./desktop-rebuild-master-plan-2026-09-18.md)。本文件区分源码接线、离线测试、真实 CLI、真实窗口视觉和安装包五类证据；组件、按钮或测试文件存在不等于功能完成。

## 最新集成复核

本轮进展详见 [integration-recheck.md](./evidence/local-cli-2026-09-18/integration-recheck.md)。以下为最新状态，后文早期验证记录只作为历史证据：

- 桌面 1601 项产品文件已受控同步，含迁移清单共 1602 项已纳入 Git 暂存，尚未提交；原 Proma 目录保留。独立源码目录按两个锁文件重新安装依赖，CLI 与桌面类型检查通过，CLI 构建及 chunk 校验通过。
- 原生任务 controls 3 项、192 断言通过，包含真实 Agent→后台 Bash 的父子关系、任务单停、Unicode 输出、冻结 transcript、跨会话拒绝及恢复后读取。父任务离开实时状态后漏 child 的缺陷已修复。
- 断线恢复以冻结分页读取原生历史，仅幂等补桌面投影；Clear 恢复日志已覆盖原生成功但桌面收尾失败及日志损坏路径。
- 原生只读目录 1 项/19 断言通过，宿主工具策略与原生交互 13 项/126 断言通过；Auto 分类器允许、拒绝、不可用后人工审批三路径已用真实 CLI 与本地模拟 Provider 验证通过。
- 外置 keyring 的桌面打包接线已修复，临时资源先验证再替换；Browser 扩展改为从源码构建，资源复制清除旧 Pi 残留。独立源码目录的 CLI 与 Desktop 完整构建已通过，最终 arm64 安装包正在生成。
- 自动任务和外部桥接边界本地 mock 23 项/70 断言通过；不等于真实平台外发、Scheduler 与实际 CLI 联合验收完成。
- CLI lint 按独立工程边界检查通过。471 个文件逐文件复测中的 3 处 mock 缺失已修复，25 项相关测试均通过；将增加可复用隔离运行入口，避免共享进程 mock 污染。
- README/AGENTS 等待此前文档修改授权；固定场景 UI、官方样本补齐、最终安装包及异平台真实运行仍未通过，十阶段整体不标记完成。

## 状态口径

| 状态 | 含义 |
| --- | --- |
| 实现中 | 源码仍有明确缺口，或对应能力正在并行开发 |
| 离线通过 | 类型检查、构建、单元/组件/隔离 fixture 测试通过；没有据此推断真实 CLI 或真实窗口行为 |
| 真实 CLI 局部通过 | 已用自有 CLI 验证部分协议或模式；未覆盖该阶段完整矩阵 |
| 视觉待验收 | 真实 Electron 窗口可打开，但关键点击、尺寸与截图对照未完成 |
| 安装包待验收 | 有构建产物，不代表签名、安装、无开发环境启动和跨平台通过 |

## 阶段验收矩阵

### 阶段 0：需求与官方行为基线

**状态：实现中。**

- 已有官方只读采样记录和截图，确认了消息操作、计划文档、Plan 与后台任务上下堆叠、消息内后台任务入口及 `/` 目录等行为，见 [claude-code-desktop-ui-evidence-2026-09-18.md](./claude-code-desktop-ui-evidence-2026-09-18.md)。
- 官方样本仍缺结构化 AskUser、正式 ExitPlan 批准/反馈/拒绝、独立 thinking、完整压缩生命周期、权限审批和 worktree 创建/失败/恢复。上述界面只能按真实协议忠实呈现，不能把当前 Proma 样式反推成官方样式。
- 品牌名仍未最终确认；当前源码和打包配置仍混用 `Xcodes`、`Proma` 及 Claude Code 参考文案。

**退出门槛：**补齐缺失样本或明确记录无法采样的协议验收替代方案；给每项用户需求建立可追踪场景。

### 阶段 1：同仓迁移与独立构建

**状态：离线构建与受控同步通过，迁移未达到可交付门槛。**

- `/Volumes/code/code/agent/claude-code/desktop` 已存在，根 `package.json` 已提供 `desktop:dev`、`desktop:build`、`desktop:check` 独立入口；本轮已知 `desktop:check`、CLI 构建和桌面构建通过。
- 最新一次受控同步覆盖 1539 个文件，其中 78 个文件发生复制，零冲突，并完成 hash 核对。该结果证明当前源树同步一致，不等于已经满足版本控制和干净 checkout 的交付门槛。
- **该缺口已修复：**桌面源码及独立锁文件已纳入 Git 暂存区，尚未提交。旧记录中 `ls-files desktop` 为 0 的状态不再适用。
- 当前 CLI 根工作树也有大量未提交改动；因此“干净 checkout 分别构建 CLI 与桌面且 CLI 无回归”的阶段验收尚未成立。

**退出门槛：**把 `desktop/` 和必要根 workspace 变更纳入版本控制，排除依赖/缓存/真实用户数据，重新生成 manifest，并在干净 checkout 运行两套 build/check。

### 阶段 2：本地服务与实时协议

**状态：真实跨进程与原生交互局部通过，端到端覆盖仍不完整。**

- `local-service/runtime-adapter.ts` 已实现会话启动、initialize、实时事件队列、queued run 消费确认、pending control Promise、interrupt 等待终态、任务快照/输出/单停、上下文、压缩、fork/rewind 和非 partial 原生消息 write-through。
- 协议包含 session/run/request/sequence 和进程代次；本地服务与 Electron Main 分层存在。最新 `runtime-adapter.integration.test.ts` 为 **7 项、37 个断言通过**，新增证据包括物化 MCP 的真实 HTTP 工具调用、Host 关闭后 404、断线快照和服务恢复。
- 当前 CLI→host 交互只使用原生 `can_use_tool` control schema，AskUser/ExitPlan 也复用该请求；桌面 responder 与当前协议一致。新增真实 CLI 原生交互套件已有 10 项测试、104 个断言通过，覆盖计划反馈后批准执行、六模式 MCP 门禁、AskUser 多问题取消及 `tools: none`。
- 上述证据仍未覆盖应用重载后的迟到响应、多会话并发恰好结算一次及完整崩溃恢复矩阵。
- 真实隔离 Electron 已验证一次有序退出：Main PID 42208 启动受管 Local Service PID 44249，执行 Cmd+Q 后 Electron exit 0，两个 PID 均消失且未人工 kill。该记录证明空闲受管服务退出路径，不替代活跃任务、CLI 崩溃、NDJSON 半包、Unicode、大输出背压与 stderr 的完整矩阵。

**退出门槛：**隔离项目跑真实 CLI 的消息、工具、审批、任务、崩溃/重连、应用重载和退出矩阵；记录无重复执行与无孤儿进程证据。

### 阶段 3：CLI 能力与六模式

**状态：真实 CLI 局部通过。**

- default/Manual、acceptEdits、bypassPermissions、plan、dontAsk、auto 已有原生类型、选择器和动态 control；Auto classifier、effort 清空、thinking、会话级自动压缩及 context controls 已进入协议。
- 已知原生六模式验证为 **12/12 tests、123 assertions**；这是目前最强的真实内核证据。
- 另有原生交互套件 **10 tests、104 assertions**，补充验证六模式 MCP 门禁、计划反馈/批准执行、AskUser 多问题取消和 `tools: none`；两组测试覆盖面不同，不能相加后当作完整组合矩阵。
- 该结果没有覆盖计划要求的六模式 × Read/Write/Bash/MCP/AskUser/ExitPlan/拒绝完整矩阵，也没有证明切换失败时 UI 保留最后已确认状态。
- Home 权限菜单源码已按 Manual、Accept edits、Don't ask、Plan、Bypass、Auto 顺序补齐，并为 Auto checking/unavailable 与各模式接入当前语言说明；组件 BDD 覆盖 Plan、dontAsk、Auto 和六模式列表。修复后仍待真实鼠标复核，不能仅凭组件测试标记视觉通过。
- 任务 controls、子代理输出和 Skills 新能力仍在并行实现/整合，不能据六模式测试宣称 CLI 能力已补齐。

**退出门槛：**完成上述组合矩阵，验证 Auto checking/allowed/blocked/unavailable/error、动态 model/effort/thinking、MCP、任务日志游标/单停及 Skills 真实调用。

### 阶段 4：会话、消息和执行展示

**状态：离线接线较完整，真实流与视觉待验收。**

- 当前投影已区分用户消息、助手过程/最终正文、thinking、工具分组/单次调用/结果、系统状态和压缩；运行时长、Token、Copy、Fork、Pin、Rewind、长输出滚动及任务入口均有源码实现。
- Pin 已有独立 Main JSON 持久化服务、IPC、Renderer 列表与原生 UUID 跳转；`auto_mode_classifier` 已作为真实系统事件渲染，没有伪造 thinking。
- 图片附件已转换为原生 Anthropic content blocks 并透传 Local CLI；Chat Session 与消息构造测试覆盖真实 base64 image block，Home 附件 BDD 覆盖图片/文档选择后经现有附件服务绑定新会话。文档正文、排队、重载、fork 后附件可读性的完整矩阵尚未验证。
- 仍缺真实交错流、并行工具、失败/中断、长输出、历史重放、连续追问的同序列对账；官方 thinking 样本缺失，因此 thinking 的最终视觉和结束行为不能标记视觉通过。

**退出门槛：**用固定协议夹具和真实 CLI 逐项对账增量/快照/result，确认展开状态不因流更新重置，并完成官方/本桌面同尺寸截图对照。

### 阶段 5：审批、计划、后台任务和子代理

**状态：原生交互局部通过，完整生命周期仍待验收。**

- Permission、AskUser、ExitPlan 已分成独立服务和结构化 UI；待处理请求按 session 隔离，已有 snapshot/取消/已结算历史接线。
- Plan 文档、Proposed/Approved/Feedback 状态和右侧完整面板已分开；Plan 与后台任务可上下堆叠，入口按当前会话数据动态显示，蓝色任务标签可以打开面板。
- Runtime 已接 `get_tasks`、`get_task_output`、`stop_task`、`get_subagent_transcript`；输出读取固定快照边界，避免持续任务令一次读取永不返回。
- 新增真实 CLI 原生交互测试已覆盖“计划反馈后重新提交、批准并执行”、AskUser 多问题取消及每类 control 的基础结算，共 10 项测试、104 个断言通过。
- **仍在实现：**任务 controls、Skills 和子代理图的 CLI 端能力还在并行整合，当前桌面组件与 fake 数据测试不能证明真实任务可恢复、可单停或 transcript 完整。
- 官方证据仅确认已有计划文档与后台面板，没有正式 AskUser/ExitPlan 审批像素样本。

**退出门槛：**真实 CLI 覆盖反馈后重新提出计划、批准目标 mode、拒绝/取消/重载、两个后台任务只停一个、前台结束后后台继续、任务清理和子代理 transcript，且每个交互只结算一次。

### 阶段 6：上下文、压缩和统计

**状态：离线接线，真实计量待验收。**

- `get_context_usage` 已通过 typed IPC 接入 AgentView，归一化器要求真实 totals/capacity，缺失字段不会填假零，并保留 cache/model 等可选字段。
- 用量累计差额账本、进程代次、分类归一化和 usage 页面图表/hover 已有实现；manual compact、auto compact control 和 compact metadata 已接线。
- 仍未证明两轮/多模型/分类器/子代理/压缩/重试统计准确且不重复，也未证明模型窗口缩小、重放、重启和 compact 前后 context/累计用量关系正确。
- 服务商额度没有可由本地 Token 推导的依据，验收时必须显示“不可用/读取失败”，不得补 0 或估算余额。

**退出门槛：**用可计算 token 的固定夹具和真实 CLI 对账各来源增量、重放、压缩前后、时间范围/图表 hover，并核对失败与缺失态。

### 阶段 7：项目、Git、worktree 和独立面板

**状态：隔离 Git 离线通过，真实窗口/PTY/CLI 待验收。**

- 新会话项目、分支与 worktree 草稿已接线；首次发送由 Main 准备 Git 目录，失败保留草稿/队列；CLI、文件、Diff、终端共同使用会话 cwd。
- worktree 创建/清理和 dirty 保留使用临时隔离仓库验证；相关 Git、queue、terminal utility、side-panel 分组已有 **61 项通过**的既有整合证据，Electron typecheck 同轮通过。
- 文件、终端、改动、Plan、后台任务是独立面板类型；终端面板 X 仅隐藏，PTY 生命周期在工具/状态层有测试。
- 尚未用真实 Electron 鼠标验证首次发送准备、失败重试、多终端实例、隐藏再开内容保留、拖动宽度/全屏、切会话收面板不杀 PTY；也未真实验证 CLI fork/rewind 与 worktree/base branch 一致。

**退出门槛：**在临时仓库完成真实 CLI + Electron 场景，核对物理目录、dirty 保留、会话 cwd、PTY 进程与面板尺寸，不触碰业务仓库。

### 阶段 8：命令、配置、应用任务和其他入口

**状态：主要执行入口已收敛，外部入口与真实运行矩阵仍在实现。**

- `/` 已从 initialize 的 `commands`/`supported_commands` 读取原生命令并合并 Skills；本地动作与待发送命令分路由，选择候选不会自动发送。
- 设置导航已移除隐私、协作、导入导出、插件的可见入口；模型配置/连接器入口已保留。`SettingsModal.tsx` 仍保留旧深链兼容页面，这不等于可见导航恢复，也不能算这些旧页面已重做。
- 宿主 Hermes 模型执行环已移除：主链只保留一个 Adapter query 调用点，旧 `DispatchRun` 仅供只读审计；`native-orchestration-boundary.test.ts` 已覆盖旧 waiting_user 多节点不会恢复宿主二次执行。CLI 原生 Tasks/Subagent/Workflow 的真实矩阵仍待完成。
- 惰性内置 MCP 已经本地 HTTP Host 物化后交给独立 CLI；Adapter loopback 集成真实调用工具成功并验证关闭后 404。Browser、Collaboration、Web Search、生图等具体工具仍需真实 CLI 逐项验收。
- 普通 Chat 已使用 `LocalCliRuntimeAdapter`；飞书和定时任务通过 `agent-service`/`runAgentHeadless` 共用 Agent 执行链。定时任务、钉钉、微信已分别使用 `automation`、`dingtalk`、`wechat` 来源；定时任务超时会等待真实 `stopAgent(sessionId)`，完成/超时竞争由单次结算 helper 收敛。外部入口仍缺完整本地 mock 集成。
- 所有 Local CLI 消费者现由 Adapter 统一读取应用代理并合入 HTTP/HTTPS/ALL_PROXY 与 NO_PROXY；MCP/代理相关 5 项测试、21 个断言通过。真实代理流量与系统代理失败恢复仍待验收。
- 任务 controls 与 Skills 新能力正在实现，动态目录、作用域、安装/移除后刷新和真实调用尚未达到阶段出口。

#### 设置消费者接线状态

设置控件、持久化和消费者正在分项收口，当前状态如下。已接线项目不能再归类为假开关，但真实窗口与完整运行语义仍需验收。

| 字段 | 当前状态 | 剩余验收 |
| --- | --- | --- |
| `dynamicWorkflowsEnabled` | 已映射为当前 CLI 进程的 `CLAUDE_CODE_DYNAMIC_WORKFLOWS_ENABLED` | workflow 开关、失败态与真实 CLI 调用 |
| `outputStyle` | Main 消费者已接线 | 真实 CLI 动态切换与失败恢复 |
| `localSandboxEnabled` | Main 消费者已接线 | 各平台 sandbox 可用/不可用路径 |
| `strictSandboxMode` | Main 消费者已接线 | strict sandbox 拒绝与错误态 |

`outputStyle`、`localSandboxEnabled`、`strictSandboxMode` 与 `dynamicWorkflowsEnabled` 已由同一桌面偏好构建器进入 CLI system prompt/settings/environment，Main 消费共有 4 项 BDD；相关 hooks 已覆盖 argv、持久化和 UI，共 13 项 BDD。真实 CLI 动态工作流和失败态仍未达到阶段出口。

本轮已为 `transcriptWidth` 接入消息与输入列共享 CSS 宽度，为 `drawAttentionOnNotifications` 接入仅在窗口失焦且出现阻塞交互时触发的非抢焦 attention，并为 `keepAwakeOnBattery` 接入执行期、电源状态与偏好联动的 powerSaveBlocker 策略。三项均有 BDD 与类型/构建证据，真实 Electron 窗口与电源切换仍需阶段 9 验收。

作为对照，`allowBypassPermissionsMode`、`keepAwakeWhileWorking`、`archiveAfterDays`、`worktreeLocation` 已能找到实际消费者，不列为假开关。

**退出门槛：**完成动态工作流与上述入口的真实运行验收；完成每个旧能力的“新实现/用户明确取消”映射，并用本地 mock 验证外部入口不会启动另一条旧执行链。

### 阶段 9：全局视觉与交互一致性

**状态：核心点击已局部真机验证，固定截图仍待验收。**

- 主题 token、浅/深色、语言状态、浮动右侧面板、侧栏更多菜单和搜索/侧栏控件已有源码与组件测试。
- 已在真实 Electron 窗口用鼠标验证侧栏收起后再次展开、侧栏 More 菜单仅含两项、用户菜单的模型配置不再显示“查看更多”、设置导航删除项，以及浅/深主题和中/英文切换。
- Home 权限菜单已在源码和组件 BDD 中补齐六模式、Plan 入口及多语言说明；尚未在修复后的真实窗口重新点击并形成固定截图，因此只标记离线接线通过。
- **未验证门槛：**固定窗口正式截图、sidebar draggable 区域、搜索图标像素对齐、独立面板拖拽尺寸、全屏、高 DPI、长中文/英文、焦点、菜单遮挡及失败/空/加载态。
- 已验证的中英切换只覆盖本次真鼠标经过的可见路径，不能据此宣称全局所有 Agent、Diff、设置和任务文案均已覆盖。
- 官方 AskUser、ExitPlan、thinking、压缩和权限样本仍缺，不得以当前视觉宣布复刻完成。

**退出门槛：**固定窗口与数据夹具，用真实鼠标完成核心路径并逐场景截图对照；中英、浅深色和失败/空/加载态分别验收。

### 阶段 10：数据、清理、打包与交付

**状态：三目标目录包资源局部通过，正式安装包待验收。**

- 正式执行路由已统一为 `LocalCliRuntimeAdapter`；正式 Pi worker/资源已从执行路径移除，仓内仅保留 `frakio*` 旧配置字段作兼容读取，以及防回归测试中的禁用名称。
- source mac arm64 `--dir` 目录包已构建。包内 Bun 直接执行自有 CLI `--help` 和会话辅助 CLI `--help` 均 exit 0；成品 Electron 39.5.1 已真实加载 node-pty ABI 140，并在临时 cwd 启动 PTY 输出 `pty-abi-ok`。这些证据仍不是已签名 DMG、Finder 安装或完整应用流程验收。
- macOS x64 `--dir` 目录包已构建并通过静态 Runtime 完整性校验：CLI 模块图含 644 个 JS 文件，App、Bun 和 keyring 均为 x86_64。该异架构包未在当前 arm64 主机执行。
- Windows x64 的标准资源编辑流程受当前 macOS/Wine 宿主 `wineserver: bind: Operation not permitted` 阻塞；关闭 `signAndEditExecutable` 后生成了仅用于资源校验的 `win-unpacked`，其 App、Bun、keyring 均为 PE x86-64，644 个 CLI JS 文件完整。未执行 Windows 应用或二进制，不能标记 Windows 运行通过。
- arm64 成品 Local Service 已加载到 `startLocalService`，但当前打包检查通道禁止绑定本地 socket，因此尚无该目录包的 `service.health` 实测。另有最新源码的隔离 Electron 真窗口记录：Cmd+Q 后 Main 与实际启动的 Local Service PID 均消失、exit 0；这证明源码退出链，不等于目录包或安装包退出验收。
- 当前打包品牌仍为 `productName: Xcodes`、`appId: com.proma.app`，更新脚本还存在 Proma 命名；品牌、appId、数据根和旧数据迁移策略未定稿。
- 上述三个目录包均早于最终 CLI 与 Main 收口，只能作为阶段性资源证据。签名/公证、自动更新、旧数据只读、安装环境启动、Local Service 健康退出及无孤儿进程仍未形成完整验收记录。

**退出门槛：**使用最终源码重打 macOS arm64、macOS x64 与 Windows x64 目标；至少完成 macOS 正式安装环境的启动、对话、审批、worktree、任务、恢复和退出，并在 Windows x64 环境独立验证资源、启动与退出，不用 macOS 静态结果推断 Windows 运行。

## 优先待办

### P0：影响可交付与真实执行

1. `claude-code/desktop` 已纳入 Git 暂存且 manifest 已更新；完成最新源码独立目录 Desktop build 与安装包验证，不能以先前产物替代。
2. 完成任务 controls、Skills 和子代理出口的真实 CLI 审批、计划、任务单停/输出/恢复矩阵。
3. 做 Local Service 崩溃/重连/半包/大输出/取消竞态/有序退出的真实跨进程测试，确认不重复执行、无孤儿进程。
4. 对已接线的 dynamic workflows、output style、sandbox 与 strict sandbox 做真实 CLI 失败态验收。

### P1：影响用户要求是否真正成立

5. 在修复后的真实 Electron 中复核 Home 六模式、Plan 与中文说明；继续验收搜索、各下拉选择语义、独立右侧面板、PTY 隐藏重开和会话切换，并产出固定尺寸正式截图。
6. 跑真实 CLI 的正文/工具交错、AskUser、ExitPlan、Auto、压缩、fork/rewind、附件及 context/usage 对账；保留官方样本缺口标记。
7. 建立 Chat、飞书/钉钉/微信、定时任务、任务看板、浏览器、语音、通知、更新、代理和会话辅助 CLI 的逐入口迁移/验收表，先用本地 mock，不向真实联系人试发。
8. 在已通过浅深色和中英切换的基础上，清理剩余硬编码文案并完成全局语言、固定尺寸截图及失败/空/加载态验收。

### P2：发布门槛

9. 确定品牌、appId、更新源和数据迁移；验证旧 Pi 历史只读可查但不伪装原生 resume。
10. 完成 macOS arm64/x64 与 Windows x64 的最终安装包和独立启动验证，核对签名、node-pty、CLI 资源、无开发依赖和正常退出。

## 已有验证记录与本轮边界

- 自有 CLI 六模式原生测试：12/12 tests，123 assertions。
- 自有 CLI 原生交互测试：10 tests，104 assertions，覆盖计划反馈批准执行、六模式 MCP 门禁、AskUser 多问题取消和 `tools: none`。
- Local Service adapter loopback 集成：7 tests、37 assertions；其中 MCP endpoint 经真实 HTTP 调用成功，Host 关闭后返回 404。它仍使用 fake CLI，不冒充真实 CLI 全矩阵。
- MCP/代理边界：5 tests、21 assertions；覆盖 MCP transport 与统一代理环境，尚未连接真实代理服务器。
- 自动任务单次结算和调度回归：17 tests、33 assertions；覆盖超时调用目标 Session stopper、竞争只结算一次和停止失败语义，尚未跑 Scheduler→真实 Local Service 超时。
- 同仓入口：`desktop:check` 已通过；CLI 与 desktop build 已通过。
- 最新受控同步：1539 个文件，78 个文件复制，零冲突，hash 核对通过。
- Git/worktree/queue/terminal/side-panel 相关既有整合记录：61 项通过，Electron typecheck 同轮通过。
- 设置 hooks 的 argv/持久化/UI 共 13 项 BDD；output style、sandbox、strict sandbox Main 消费共 4 项 BDD。
- 真实 Electron 鼠标已验证侧栏收放、More 两项、用户模型设置无“查看更多”、设置删除入口、浅深主题和中英切换；另一次隔离窗口验证 Cmd+Q 后 Main 与受管 Local Service PID 均消失。Home 六模式修复后尚未真鼠标复核，也尚无正式固定截图。
- 根 workspace 八个包的 typecheck 全部通过，记录见 `/tmp/xcodes-typecheck-final-pass.log`；最终合并后仍需重跑。
- mac arm64 目录包已真实运行包内 CLI、会话 CLI 与 PTY；mac x64 和 Windows x64 只完成目录包静态资源检查，异架构均未执行。没有据此标记安装包通过。
- 本次状态更新只整理现有实现、测试、真鼠标和目录包证据，没有操作真实模型、业务仓库、外部消息或用户数据。
- README/AGENTS 未修改。由于实现仍在并行变化，以上“已通过”只对应记录时的源码；最终合并后仍需按阶段出口重跑。

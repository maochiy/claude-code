# Proma 自有 CLI 完整 Local 接入方案

日期：2026-09-17。

**2026-09-18 范围修正：** 原 Proma 功能按用户要求重做，不能把保留旧编排层、仅替换 Runtime 作为最终方案。本文保留协议/能力审计事实；正式计划以 [桌面端完整重做计划](./desktop-rebuild-master-plan-2026-09-18.md) 为准。

状态：源码审计与接入设计。本文不表示功能已经实现或联调通过。未运行真实模型请求，未修改 CLI 或 Proma 执行代码。

更新：用户后续选择同仓迁移与独立本地服务。部署目录与服务边界以 [同仓迁移审计](./desktop-monorepo-audit-2026-09-17.md) 为准；本文保留完整功能语义与验收要求，下面 Electron 直连 CLI 的部署图是此前方案。

## 目标与范围

以 `/Volumes/code/code/agent/claude-code` 为正式本地执行内核，替换用于验证的 Pi。Proma 保留桌面交互与应用服务，完整接入 CLI 执行能力；验收覆盖模式、实时消息、工具、审批、计划、后台任务、会话管理及现有应用能力。下文阶段仅表示实施顺序，不能以首段链路通畅宣布整体完成。

Local 指执行进程在用户本机；模型仍可使用模型中心配置的远端或本地渠道。工作区本地目录和本机 worktree 均属于 Local。首期不新增远程执行服务、云端会话或远程连接 UI。

## 架构决定

```text
React / Jotai / 右侧面板
          ↕ Electron IPC
Proma 会话服务、应用功能、持久化、全局事件订阅
          ↕ 通用 Runtime 接口
ClaudeCodeCliAdapter + 会话进程管理 + 双向控制协议
          ↕ stdin / stdout NDJSON
自有 CLI（每个活跃会话独立进程）
          ↕
模型、原生工具、MCP、Skills、子代理、后台任务
```

- CLI 源码含进程级全局会话状态，因此不复用 Pi 的单 Worker 多会话实现。
- CLI 保留自己的模型循环、工具执行与原生会话；Adapter 负责协议转换和进程生命周期。Proma 负责桌面交互、项目与应用服务。不能叠加两套工具执行循环、计划循环或重复审批。
- 保留现有 `SDKMessage` / `AgentEvent` 展示链路，但补齐无法表达的新模式、请求和任务事件。适配边界不等于承诺现有 Orchestrator 完全无需修改。
- 将 `PiAgentQueryOptions` 泛化，解除 Runtime 注册、Dispatch、Context Packet 对 Pi 的硬编码。旧 Pi 数据读取与新的可执行 Runtime 身份分开。
- CLI 使用明确的版本、构建标识和协议能力；不能让桌面静默使用任意系统安装的 CLI。
- 不把 CLI UI 模块导入 Electron 渲染进程，不解析终端 ANSI 画面作为执行状态。

## 全模式契约

CLI 协议枚举包含 `default`、`acceptEdits`、`bypassPermissions`、`plan`、`dontAsk`、`auto`。六种模式需要逐项接入实际规则、持久化、动态切换及错误反馈，不能用现有三档权限做有损映射。

| 模式 | 桌面语义与验收要求 |
| --- | --- |
| default | 遵守已配置规则；需要审批的操作进入桌面审批队列 |
| acceptEdits | 自动允许规则覆盖的文件编辑，其他操作仍按 CLI 规则处理 |
| bypassPermissions | 明确的绕过权限模式；与 Auto 独立，不自动作为失败回退 |
| plan | 原生计划模式；允许范围以实际工具策略为准，不能仅改变标签或只靠提示词限制写入 |
| dontAsk | 无交互权限策略；不允许的操作按规则拒绝，不能等同于“全部允许” |
| auto | 使用 CLI 的真实自动判断机制；接入可用性检查、判断结果和需要用户处理的状态 |

模式、Local/worktree、模型与思考等级是独立维度。UI 请求切换 → 控制请求 → CLI 确认/状态事件 → 更新有效模式；失败展示原因并保留旧有效值。计划批准后的执行模式按用户选择恢复，不能固定切到 bypass。CLI 主动进入/退出计划时也必须反向同步桌面。

Auto 的构建开关、运行时门槛与完整执行链必须单独验收；字段存在不等于可运行。如果自有 CLI 有实现缺口，应列为本次接入需要补齐的内核工作，不能仅隐藏菜单后宣称完成。

### Auto 的已核实实现与必修项

- 自有 CLI 已实现独立 classifier 模型调用：只对原本需要 ask 的操作做自动判断；AskUser/ExitPlan 等要求用户交互的操作保留交互。Auto 不是 allow-all，也不是 acceptEdits 的别名。
- Auto 会产生额外模型请求、耗时和 token。现有 classifier 检查信号仅在进程内部，没有专门推送给宿主的 checking 事件；完整桌面需要补结构化 checking/decision/unavailable 事件及可用用量归属，UI 显示真实待判断状态，不暴露内部推理正文。
- 默认构建已包含 `TRANSCRIPT_CLASSIFIER`，但 `modelSupportsAutoMode()` 仅依据编译开关对模型返回支持，不证明具体渠道能完成 forced tool use/XML 分类。各渠道必须验证 classifier 路径；不能把所有模型的 Auto 都标成已验证。
- **必须修复可用性门禁不一致**：`permissionSetup.ts:1271` 的 `isAutoModeGateEnabled()` 当前硬编码返回 true。启动后的异步检查可能让 Auto 退出到 default，但运行中再次切 Auto 使用这个同步门禁，可能重新进入。应统一启动与动态切换的可用性判断，在 CLI 修复后完成开关变化、禁用、重入和 resume 的回归验收。
- 模式以 `system/status.permissionMode` 回报为实际值；control_response 表示切换请求结果，不能覆盖随后发生的 Auto 退出事件。恢复会话后同样以 init/status 校准。
- 保留分类器不可用时的 fail-closed 语义；需要用户决定时走桌面交互，不能静默改成 bypass。修复期间的显式不可用状态是过渡措施，不构成完整接入验收通过。
- 内部 `bubble` 不属于 SDK 对外模式集合，不作为第七种桌面模式。

证据：CLI `src/utils/permissions/permissions.ts:473-705`、`src/utils/permissions/yoloClassifier.ts:1321`、`src/utils/permissions/permissionSetup.ts:1066-1273`、`src/utils/betas.ts:160`、`src/cli/print.ts:1076-1103,4837-4855`。上述均为只读源码结论，尚未执行模型验证。

## 实时响应契约

1. **常驻会话事件通道**：主进程持续读取 CLI 消息，Renderer 页面或右侧面板是否挂载不影响接收。前台一轮 `result` 不能切断随后到达的任务事件。
2. **增量展示**：正文、思考、工具参数和结果按协议增量更新。完整消息到达后合并同一消息/内容块，不追加一份重复正文；按批次刷新 UI，但不等待整轮结束。
3. **可确认的控制**：审批、模式切换、停止与模型配置更新携带请求 ID，跟踪 pending/acknowledged/failed/cancelled；“已写入 stdin”不能代表操作完成。
4. **状态分层**：分别管理进程、会话、前台 turn、后台 task 和面板显示状态。前台 idle、后台 running 是合法组合；关闭面板只改变最后一层。
5. **排队与立即改向**：排队消息有独立消息 ID 和接受状态。当前 CLI 正常追加输入是下一轮队列；立即改向要确认中断完成后再执行新消息。不能把本地标签当作原生 steering。
6. **恢复与去重**：Renderer 重载先恢复快照再接增量，使用会话、运行代际、消息/工具/任务 ID 去重。旧进程迟到事件不能污染新进程；重连不能自动重发可能已执行的工具操作。
7. **通信健壮性**：处理 NDJSON 半包、多包、UTF-8 分片、背压、协议错误与 stderr 分离。工具输出按边界截取展示，保留可获取的完整内容，不把诊断日志混入模型正文。
8. **资源回收**：有后台任务或待审批时不能按普通空闲会话回收。应用退出显式清理进程树；崩溃后区分可恢复的历史与无法保证继续运行的系统进程。

现有 Orchestrator 在普通 result 后有 2 秒 drain 保护，并用 `_keepChannelOpenForTasks` 维持特殊会话。接入时应明确长期事件流的所有权，不能只让新 Adapter 输出 result 而沿用默认关闭路径。

## 全功能接入与验收矩阵

所有项目当前状态均为“待实现或待联调”，不得将源码存在作为验收通过。

| 能力域 | 完整交付行为 |
| --- | --- |
| 用户消息与附件 | 当前 Agent 附件以受控本地路径和读取授权传递，先保证路径、内容与消息关联可用；原生图片内容块需要新增桥接并按模型多模态能力验收，不能声称当前已支持原生图片传输 |
| 模型回复 | 流式正文、思考、过程说明、最终答复、停止与错误正确区分；历史重载后显示一致 |
| 工具调用 | 参数增量、执行中、耗时、成功/失败、输出、文件链接和改动统计；保留父子调用关联 |
| 权限审批 | 一次允许、会话规则、拒绝、取消；按请求 ID 结算并处理并发、超时、会话切换和页面重载 |
| AskUser | 单选、多选、自由输入、跳过/取消按协议表达；答案交回原始请求，不能用普通聊天消息冒充 |
| Plan | 原生模式、完整计划内容、自动打开右侧面板、历史入口、批准/反馈/修订、执行模式衔接 |
| 后台任务 | 开始/进度/结束事件、真实日志、单任务停止、父子任务关系、终态保留；蓝色标签打开对应任务 |
| 原生子代理 | 子代理身份、工具父子关系、运行状态、输出与可用 transcript；不能只展示一条普通工具卡 |
| Proma 协作 | 保留已有应用协作能力，与 CLI 原生子代理使用明确的 ID/来源，不重复派发同一任务 |
| 多会话 | 并发隔离、当前与后台状态、未处理请求提示、会话切换后面板默认关闭且执行继续 |
| 输入队列 | 正常追加、立即改向、待发送取消、停止竞态与失败恢复；消息不重复落盘或执行 |
| 会话恢复与分叉 | 原生 session ID 映射、重启恢复、从指定消息分叉；分叉不改变源会话 |
| 回退 | 对齐消息截断与文件检查点恢复，清楚区分支持范围；不能只删 UI 消息假装完成文件回退 |
| 压缩 | 原生自动/手动 compact、进度、结果与失败反馈、压缩后继续会话；不以普通提示词模拟 |
| 模型配置 | 现有渠道、模型、思考等级、上下文与凭证变更；按明确 provider/apiMode 路由，验证不支持项并补齐 |
| 用量 | CLI 实际 input/output/cache/模型等可用指标进入现有聚合；实时增量与终态合并，避免重复累计 |
| Skills 与 `/` | 合并 CLI 命令和配置的 Skills，区分选择/执行；终端专用 local-jsx 命令提供桌面动作桥接 |
| MCP | 外部 stdio/http 与 Proma 内置 MCP；配置作用域、连接状态、审批、断连与重连 |
| Hooks 与项目配置 | 核对自有 CLI 项目/用户设置、Hooks、指令文件等现有来源及其作用域，不重复注入或擅自扩大加载范围 |
| Local/worktree | 分支选择、勾选模式、真实隔离目录、准确 cwd、分叉与恢复；终端/文件/Diff 使用同一会话目录 |
| 终端 | 按会话保留 PTY 与内容，关闭面板不重置；与 Agent 的 Bash 工具和后台任务分开管理 |
| 文件与 Diff | 工具修改实时刷新文件和 Diff，点击文件/改动进入右侧独立面板；Git 操作继续走明确操作入口 |
| 面板布局 | 文件、终端、改动、计划、任务独立；Plan/任务入口由会话内容决定，上下堆叠与关闭后高度重分配 |
| 定时任务与任务看板 | 复用同一正式 Runtime 入口与模型路由；无人值守时仍遵守权限策略，待处理请求有明确状态 |
| 现有消息入口 | 核对已有集成、快捷任务等发起路径，全部复用会话、权限与落盘逻辑，不残留偷偷启动 Pi 的路径 |
| 展示一致性 | 中英文、浅色/深色主题、模型与模式标签保持现有视觉要求，不重新引入此前要求删除的菜单 |
| 打包与升级 | 开发环境和正式安装包均能启动锁定版本的 CLI；按支持平台带齐运行时、资源和进程清理能力 |

## 必须处理的接入缺口

- **后台输出接口**：目前有 task 事件与 `stop_task`，没有 host `get_task_output`。完整方案应补任务输出读取/订阅；过渡读取只能接受当前进程上报并校验归属的 output_file，做规范化路径校验、有界读取和增量游标。
- **命令分类**：CLI init 给出 slash_commands，但 local-jsx 依赖终端 UI。逐项归类到 headless 可执行、桌面原生动作、项目命令/Skill；使用能力元数据，避免硬编码一份长期漂移的列表。
- **控制能力补齐**：已有 initialize、interrupt、模式/模型控制、stop_task 等。任务日志、执行图、transcript、完整配置更新、队列撤回与回退的实际支持需要按接口与 handler 核对；缺口需在 CLI 或 Adapter 中实现真实能力，不能返回空列表或静默成功充数。
- **模型、effort 与压缩的细分语义**：`set_model` 有控制确认；思考 budget 使用 `set_max_thinking_tokens`，不能代替 effort。当前 effort 可通过 `apply_flag_settings` 修改并用 `get_settings.applied.effort` 回读，但清空值未同步清空顶层 effortValue，需要修 CLI。自动压缩有 compacting/compact_boundary 事件，手动 `/compact` 支持 headless；会话级动态自动压缩开关仍需补控制接口，不能将启动环境变量当作运行中切换已生效。
- **权限唯一决策链**：CLI 管原生规则与 Auto 判断；Proma 桌面响应需要人的控制请求并承接应用工具权限。梳理现有 canUseTool 硬限制，避免 Pi 时代的默认批准抢先绕过 CLI Auto 或 Plan。
- **内置 MCP**：Proma 的惰性内置 MCP 对象不能直接 JSON 传给子进程；使用已有 HTTP materializer，生命周期随会话管理，保留外部 MCP 定义。
- **历史迁移**：原样保留旧 Pi 文件和 Proma JSONL。新 CLI session 使用独立命名空间；旧历史作为引用上下文迁移，不伪造原生 resume，不把历史中的指令提升成系统指令。旧审批和工具调用不自动重放执行。
- **协议覆盖**：不得根据模型名或 URL 猜测模型协议。现有 OpenAI Chat Completions、Responses、OAuth、Anthropic、Google 等路线分别验收；兼容缺口纳入 CLI 适配工作。

### Proma 侧容易遗漏的实际工作

- **终态顺序**：主进程串行归并来自流与控制回调的状态更新，设置会话内序号和运行代际。result 是原生一轮边界，宿主仍需结算已有工具/请求和落盘后才能发布自己的 turn 完成；不能等待该 CLI 未提供的旧 CCB `turn.completed` 消息，也不能因 result 关闭整个会话事件通道。
- **所有入口的 Runtime 身份**：当前新建会话默认写 Pi，fork 又依赖该默认值；创建、分叉、协作、自动任务和外部入口都必须进入正式 Local Runtime。旧会话身份不能批量改写伪装成原生 CLI 历史。
- **协作继续**：当前 Proma 协作 continue 会清空 runtimeSessionId，依赖历史重放。需明确保留原生 ID 的 resume 与显式新建会话两种路径；子代理模型、模式、effort、工具策略和轮次限制一并传递。
- **原生操作不是空方法**：当前 legacy native API 禁用；会话列表、执行图、transcript、分叉、回退等需按实际 CLI 能力实现 service + IPC，不能只加可选 Adapter 签名。旧代码的 canRewind 恒真不能延用，文件恢复成功后才处理对应历史截断，并报告部分失败。
- **自动任务用量依赖**：已有日切/复用/毕业逻辑依赖 result usage 和 modelUsage.contextWindow，只有 assistant usage 不足。增加日切、上下文阈值、超时、失败暂停与应用重启中断验收。
- **命令目录服务**：现有本地 Skills 扫描不能替代 CLI commands；增加主进程 catalog 与能力更新通道。内核 session cron 与 Proma 定时任务标记各自来源，核对结果中的调度信息是否进入任务投影。
- **资源与交互结算**：permission、AskUser、ExitPlan 是三类待结算请求；stop/delete/crash 时逐一完成或取消且仅结算一次。Renderer reload 恢复 pending 快照，迟到回应不重复执行。
- **MCP 生命周期**：内置 HTTP MCP 按 session/server 管理引用，关闭会话、删除与应用退出均释放；认证值不得进入日志或消息 JSONL。工具名与只读 annotation 保留。
- **渠道动态变更**：区分 CLI 原生 set_model 与协议/渠道/凭证变更；后者需要受控刷新或重建并正确恢复原生会话。OAuth 更新如需接入由主进程处理，不将凭据推到 Renderer、argv 或诊断日志。
- **附件专项**：验收空格/Unicode/大文件、读取授权、排队、重载及 fork 后路径重写。原生多模态与文件读取是两个能力，不相互冒充。
- **能力来源**：协商得到的真实能力进入会话运行态，UI 和 API 使用同一能力信息。暂不支持时明确失败并进入待补工作，不以空结果、隐藏入口或“成功”消息替代完整交付。

上述补充来自对当前 `agent-session-manager.ts`、`agent-collaboration-tools.ts`、`automation-scheduler.ts`、`agent-session-usage.ts`、`legacy-ccb-api.ts`、`builtin-mcp/http-host.ts` 等服务的只读核查。

## 实施与验收顺序

1. 固化六种模式、事件与控制请求契约；补 Runtime 能力类型和离线协议测试夹具。
2. 实现进程管理、双向 stdio、长连接事件分发和模型路由；接入现有 IPC/消息投影。
3. 完成模式、审批、询问、计划、工具、任务、子代理与所有动态操作，补 CLI 缺口。
4. 接入会话恢复/分叉/回退/压缩、Skills/命令、MCP、worktree、用量与应用任务入口。
5. 处理历史迁移、安装包、崩溃和重载恢复；清理 Pi 可执行依赖、资源与调度残留。
6. 在独立测试目录完成端到端验收；只读场景验证消息与询问，写入/回退场景仅操作隔离 fixture 仓库。真实业务项目不承担测试写入。

BDD 必测组合：六模式 × 普通消息/读工具/写工具/拒绝；Plan → 修改 → 批准；前台完成后后台继续；多任务单独停止；流式中切换模式/模型；队列与中断竞态；会话切换/页面重载/应用重启；worktree 分叉与回退；命令本地执行与模型执行；每类现有模型协议；权限请求取消后迟到响应。具体可用性以运行时能力为前提，必要能力缺失必须补齐后才完成验收。

性能记录至少包括 CLI 事件到主进程、主进程到首帧、控制发起到确认、任务输出到显示四段延迟；使用持续增量和大输出测试，确认没有整轮缓冲或 UI 阻塞。记录实测分布后设定门槛，不预先把未经测量的毫秒数作为成果。

## 审计依据

- Proma `packages/shared/src/types/agent-provider.ts`：适配接口。
- Proma `apps/electron/src/main/lib/runtime/runtime-adapters.ts`、`pi-query-options.ts`：当前 Pi 委托和类型耦合。
- Proma `apps/electron/src/main/lib/agent-orchestrator.ts`：模式、权限、消息、result/drain 与后台等待。
- Proma `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts`：全局实时投影。
- CLI `src/entrypoints/sdk/controlSchemas.ts`、`coreSchemas.ts`：控制协议、六种模式与任务事件。
- CLI `src/cli/structuredIO.ts`、`src/cli/print.ts`：双向交互及 headless 执行。
- CLI `src/services/acp/bridge/forwarding.ts`：当前 ACP 对后台 system 事件的过滤；首接采用直接协议。
- [cc-haha 会话服务](https://github.com/NanmiCoder/cc-haha/blob/f2bfaab50f3be908f548245a74fdaa3ca2c71a95/src/server/services/conversationService.ts)：每会话 CLI 子进程、SDK WebSocket 与控制协议参考。Proma Local 采用现有 Electron IPC + stdio，无需照搬其服务器拓扑。
- [Craft Agents](https://github.com/craft-ai-agents/craft-agents-oss)：SDK 与桌面应用适配参考。不同开源项目接法不同，不据此声称全部项目采用同一种传输。

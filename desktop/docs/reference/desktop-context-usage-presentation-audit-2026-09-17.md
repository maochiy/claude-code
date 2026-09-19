# 桌面统计、上下文、压缩与执行展示专项审计

日期：2026-09-17。补充 [同仓迁移与完整能力审计](./desktop-monorepo-audit-2026-09-17.md)。这是源码审计及实现契约，不是功能完成或官方视觉验收报告。

**2026-09-18 范围修正：** 本文“已有实现/可复用”仅表示参考资产；原 Proma 功能需要重新设计实现与验收。正式实施以 [桌面端完整重做计划](./desktop-rebuild-master-plan-2026-09-18.md) 为准。

目标是完整接入自有 CLI，并复刻官方 Claude Code 桌面端的交互和执行展示。统计、上下文、压缩、正文、思考、工具、计划、后台任务均是正式范围；不能以“能发消息、能返回文字”作为完成标准。

本轮主代理审计统计服务、首页与设置用量页，三个只读子任务分别审计 CLI 协议、桌面上下文/压缩链路、执行展示与既有官方采样。未运行模型、修改运行代码、迁移仓库或操作真实用户数据。

## 1. 三种数字必须分别处理

| 数据 | 含义 | 数据来源与更新方式 |
| --- | --- | --- |
| 历史用量 | 一段时间内实际模型调用消耗；可按模型、渠道、用途、会话聚合 | CLI 调用用量事件/终态对账 → 桌面 JSONL；不可重复累计恢复重放事件 |
| 当前上下文 | 本轮实际携带上下文占模型窗口的比例，压缩后会下降 | CLI 当前上下文快照和压缩边界；不能使用会话累计用量替代 |
| 服务商额度 | 订阅或渠道的限额、剩余量、重置时间 | 对应服务商支持的额度接口；不能从本地 Token 统计推算 |

没有数据和真实为零必须区分。模型/渠道切换后，容量、用量归属与可用能力必须重新确认；Local/worktree 不改变上述口径。

## 2. 统计：现有实现与明确缺口

| 项目 | 当前源码事实 | 完整接入要求 |
| --- | --- | --- |
| 数据采集 | 扫描 Agent JSONL 的 result；整会话没有 result 才退回旧 assistant.usage。Chat 只参与会话数量统计 | 保留旧格式读取；新记录按调用/轮次 ID 去重并逐轮兼容，不用一个 result 排除整个会话的旧用量 |
| Chat 用量 | chat-service 保存正文、reasoning、工具和附件，没有保存 usage | 如保留 Chat 入口，补其真实模型用量；没有历史数据时明确缺失，不虚构回填 |
| 模式分组 | UsageQuery 有 mode，但 result/legacy 解析未赋值，聚合默认计入 Code；Cowork 卡片附“历史用量尚未记录” | 写入真实来源和模式，不能将所有执行都默认归入 Code |
| 首页消息数 | Messages 展示 rangedRequests，即完成结果的请求次数 | 明确用户消息、助手消息、轮次、模型调用的独立计数；按目标 UI 选择口径 |
| 时间范围 | 首页仅 Token、请求数、活跃天数按范围过滤；模型榜、峰值、会话数、连续天数与热力图仍全量 | 为每项指标明确范围；与官方对照确认后统一实现，避免局部切换造成误解 |
| 缓存 Token | sumUsageTokens 相加 input/output/cacheRead/cacheCreation | 按 CLI/provider 的字段语义归一化；缓存可能是输入子集，不能跨协议盲目相加 |
| 多模型 | 以 modelId 聚合，model 用量为零时回退整轮 tokens | 用渠道/provider/model 联合身份；零值和缺失分别处理，不把整轮用量分配给每个零值模型 |
| 更新 | 首页和设置页挂载时读取一次；后端有短缓存 | 调用结算后发变更通知，Jotai 共享状态刷新；正在显示页面也能更新 |
| 图表交互 | 7/30/90 天、图表/表格、按天补位、鼠标/键盘提示已有代码 | 复用组件并接真实分类数据，验证悬浮定位、日期、总数和暗色主题 |
| 读取失败 | 会话读取失败跳过；整体异常返回空统计 | 提供完整/部分/不可用状态；读取失败不能显示为确定的零消耗 |

必须单独处理：Auto 分类器、压缩调用、后台子代理和重试。它们有实际消耗，但不等于新的用户消息。分类器若未提供可归属统计，要补 CLI 事件，而非桌面估算。父调用与子调用若存在汇总关系，需标记包含关系，不能再次相加。

**新增关键核实：result 内也不能假设所有字段同一口径。** CLI `QueryEngine.totalUsage` 从本次 engine 的 EMPTY_USAGE 累加，而 `result.modelUsage` 来自进程级 `getModelUsage()`，`total_cost_usd` 也是累计状态。连续追问时直接把每个 result.modelUsage 相加会重复统计。必须保留累计基线并计算差额，按 session、进程代次和原生恢复基线处理重启；不能仅做事件 UUID 去重。证据：CLI `src/QueryEngine.ts:214,642,844,1319`、`src/cost-tracker.ts:250-285`、`src/bootstrap/state.ts:812`。

建议持久化的用量记录包含：唯一事件/调用 ID、桌面和原生 sessionId、runId、父任务 ID、渠道/provider/model、Code/Cowork/Chat 来源、用途（主执行/子代理/压缩/自动审批等）、输入输出与缓存明细、时间、终态和计数语义版本。成本和额度字段只有数据来源可靠时才提供。

### 统计源码证据

- `apps/electron/src/main/lib/user-usage-service.ts:1`：范围说明；`:76`：索引缓存与扫描；`:109`：汇总。
- `apps/electron/src/main/lib/user-usage-aggregator.ts:73`：Token 求和；`:232`：result 解析；`:322`：整会话回退；`:387`：模式默认值；`:399`：模型零值回退；`:450`：请求数。
- `apps/electron/src/main/lib/chat-service.ts:426`：Chat assistant 持久化字段。
- `apps/electron/src/renderer/components/home/HomeStatsPanel.tsx:100`：范围过滤；`:126`：热力图；`:134`：统计指标。
- `apps/electron/src/renderer/components/home/HomeView.tsx:45`、`settings/modal/UsagePage.tsx:229`：一次性加载。
- `apps/electron/src/renderer/components/settings/modal/UsagePage.tsx:111`：交互图表。

## 3. 官方参考证据边界

已采集的官方界面行为见 [2026-09-17 执行 UI 观察记录](./claude-execution-ui-observations-2026-09-17.md)。本轮使用该记录和用户截图对照源码，没有重新操作官方应用。

- 已有实际观察：用户气泡、过程文字与工具交错、两层工具展开、权限卡片、后台任务蓝色标签和 Running/Finished、计划全文与历史批准卡片、计划与后台面板上下堆叠、worktree 勾选、斜杠命令列表。
- 未完成官方样本验证：独立思考内容的全部状态、真实 AskUser 多问题交互、一次完整的结构化 ExitPlan 审批；不能用模型返回的模拟文字当成这些样本。
- “列计划”须区分 Todo/任务清单与可批准的计划文档；“任务”须区分原生后台进程、子代理和应用定时任务。
- 官方采样只看到四种权限菜单，不证明自有 CLI 的 Auto/dontAsk 不应接入。完整内核能力按源码实际支持范围另行验收。

## 4. 上下文管理：可以接出分类，不限于 Used/Free

旧研究文档把分类判断为“私有服务数据、只能做 Used/Free”，对当前自有 CLI 已不成立。当前已有 `get_context_usage` control 的 schema、实际 handler 和数据采集器，桌面应直接接它，不解析终端 ANSI 或 `/context` 的 Markdown。

| 能力 | CLI 当前实现 | 桌面处理 |
| --- | --- | --- |
| 实际上下文 | collector 应用 compact boundary、context collapse、microcompact 后分析消息 | 用 runtime 的快照更新 UI；历史 JSONL 只恢复显示，不代替原生 resume |
| 分类 | System prompt/System tools/MCP/Agents/Memory/Skills/Messages/压缩缓冲/Free | 分类弹层、图例和明细按实际返回项渲染；缺失项不伪造 |
| 总量与容量 | totalTokens 优先最近真实 API 输入及缓存 usage；无值才估算。rawMaxTokens/model 一并返回 | 显示数据来源/估算标记；不能使用累计请求 tokens 作为占用 |
| 明细 | Memory、MCP、Skills、消息/工具/附件拆分已有 | 复用结构化明细；System prompt sections 和逐内置工具受 USER_TYPE gate 限制，如需要则在自有 CLI 明确开放公开能力 |
| 一致性 | 分类多为估算，总量可来自实际 API；分类与总量不一定严格相加 | 不强制伪造一致；总量和估算拆分分别表达 |
| 刷新 | 当前只有请求响应，无 context push；采集可能触发 token-count API 或模型估算 fallback | 打开弹层、轮次结束、压缩/模型/MCP/Skills 变化后合并刷新；不能每个 token 增量轮询。需要更强实时性时补变更事件和缓存 |
| 自动压缩阈值 | context 响应固定减 13k，而实际压缩大窗口减 30k/50k | 修正 CLI 使显示和执行调用同一阈值函数，再作为权威值 |

桌面现有不足：`ContextUsageBadge` 只有 Used/Free 与部分 Token 字段；容量初始值仍依赖 Pi/宿主配置。`usage_update` 将每次更新累加到 cumulative，并对容量取 max；接新 CLI 时必须拆分 `current snapshot`、`usage delta` 和 `cumulative snapshot`，且模型切到更小窗口后允许容量正确降低，不能永久保留历史最大值。

需补 schema 的已有运行时字段包括 `cacheHitRate/cacheThreshold`，避免实际返回与强类型契约不一致。Auto 分类器用量当前只进入内部遥测、不进入 result 累计，需要新增公开事件才能准确统计。

证据（CLI 根 `/Volumes/code/code/agent/claude-code`）：

- `src/cli/print.ts:3166`：get_context_usage 真实 handler。
- `src/entrypoints/sdk/controlSchemas.ts:174`：请求与响应 schema。
- `src/commands/context/context-noninteractive.ts:34`：真实上下文投影与采集。
- `src/utils/analyzeContext.ts:1023`：阈值；`:1029`：分类；`:1183`：真实 usage 优先；`:1365`：结构结果与字段限制。
- `src/services/compact/autoCompact.ts:62`：实际动态缓冲；`src/utils/permissions/yoloClassifier.ts:1178`：分类器用量。
- 桌面 `renderer/lib/agent-context-usage.ts:140`、`renderer/atoms/agent-atoms.ts:2003`、`components/agent/ContextUsageBadge.tsx:355`。

## 5. 压缩、清空与回退是三个操作

### 压缩完整链

桌面已有手动压缩、进行中状态、历史边界、success/noop/failed/stopped 的表示；实际执行仍依赖 Pi。当前 `/compact` 通过隐藏乐观消息与普通发送链转为 Pi compact，并非现成 Local CLI 接线。

CLI 的 `/compact [instruction]` 已支持 noninteractive，命令调度器会执行原生压缩，不是普通模型提示词。服务对桌面提供显式 `session.compact` 操作即可，内部优先复用这条原生命令；无需为了接口形式再复制一套压缩器。必须确认没有把未经解析的 `/compact` 当成普通正文发给模型。

原生已有 `system/status: compacting` 与 `system/compact_boundary`，实现携带 `post_tokens` 和摘要，但公开 schema 未完整声明。服务需统一产生：

1. 配置：实际启用状态、窗口、阈值、压缩保留空间。
2. 开始：manual/auto、preTokens、操作 ID。
3. 完成：success/noop、pre/post、摘要、估算标记与边界 ID。
4. 失败/停止：明确终态，原有上下文不被误清空。

成功有 postTokens 时立即刷新占用，下一次真实 usage 替换估算；没有 postTokens 时刷新原生 context，不长期显示压缩前值。统计不得把压缩完成结果覆盖到“当前上下文”；压缩实际消耗也不能因为过滤合成结果而全部漏记。

**需要补的真实功能**：

- 桌面没有完整的会话自动压缩开关；`agent-auto-compact-settings.ts` 只清理旧配置，没有生产调用。
- Pi 策略默认 80%，ratio=0 会退回默认，并不表示关闭；不能套到 CLI 的实际阈值规则上。
- CLI 全局 autoCompactEnabled 不是普通 SettingsSchema 字段，`apply_flag_settings` 不能实现动态切换。新增会话级 control/override 及实际状态回报，避免修改其他会话的全局策略。
- 中断、空操作、失败、子进程崩溃、切换页面和重启恢复都须结束或恢复压缩状态，不能遗留永久 spinner。
- 旧 CCB 压缩规范化函数目前仅有测试引用；必须接入生产事件入口，不能用辅助文件存在证明已支持。

### 清空与回退

- `/clear`、`/rewind` 的 TUI 命令当前不支持 noninteractive，不能直接像 `/compact` 一样接。
- `rewind_files` control 只回退文件，不回退对话；完整 UI 需分别确认两部分结果。
- 启动参数 `--resume-session-at` 可恢复到指定消息，`--fork-session` 决定是否另建原生会话。首版可由服务有序关闭并重启进程完成；若要求进程内完成，则补 conversation reset/rewind control。
- 清空、压缩、分支、回退都要同步 context、待审批请求、计划/任务状态和原生 session 映射；不能只删除界面消息或重置圆环。

证据：桌面 `AgentView.tsx:2369`、`agent-orchestrator.ts:1622`、`runtime/proma-runtime-compaction.ts:11`、`useGlobalAgentListeners.ts:334`、`agent-atoms.ts:2044`；CLI `src/commands/compact/index.ts:4`、`compact/compact.ts:42`、`src/cli/print.ts:2266,3202,5343`、`src/QueryEngine.ts:610`、`src/services/compact/compact.ts:653`、`src/entrypoints/sdk/coreSchemas.ts:1516`、`src/services/compact/autoCompact.ts:176`。

## 6. 正文、思考、工具、计划与后台任务

实际活跃展示链为：`SDKMessageRenderer → buildCursorTurnPresentation → AgentTurnTimeline → AgentActivityTimeline`。`ThinkingStreamPanel` 虽存在，当前没有生产调用；不能用旧组件和旧文档来判断当前视觉。关于思考的固定高度常显描述与当前折叠实现不一致，需在获得官方样本后确定最终行为；本轮未修改需要用户允许的 AGENTS.md/README.md。

| 展示域 | 已有的可复用实现 | 尚需接入或补齐 |
| --- | --- | --- |
| 用户消息 | 右侧气泡、长文折叠、Copy/Fork | 对照已观察的用户 Rewind、Pin 操作；当前 Rewind 在 assistant 操作行，归属需调整验证 |
| 等待与执行状态 | 首事件前立即显示状态占位 | startedAt 未消费，缺等待时长、Token 等状态；不能把实际无 thinking 的等待伪造成思考内容 |
| 过程与最终正文 | 正文和活动按序，尾部连续文本作为 final；无头像卡片 | 服务必须保留消息 ID、顺序、增量/完整标识、活动阶段和终态，避免最终正文重复或过程文字错位 |
| 思考 | ThinkingActivity 平滑流、默认折叠、展开状态存于 Jotai | 官方各状态尚缺真实采样；按内核实际公开内容渲染，不能拼接正文/工具摘要伪造 thinking |
| 工具聚合 | 连续 Read/command/edit/search 聚合；展开组再展开单项结果 | 当前明细容器与参考视觉不同；Bash 缺命令 Copy/语法展示/底部渐隐；工具行缺 View live output 入口 |
| 工具结果 | 输入、结果、失败和展开状态已有表示 | 稳定 tool_use.id/tool_use_id、父任务关系、拒绝/取消、实时输出；没有匹配 tool_use 时活跃投影可能丢工具行 |
| Plan 文档 | 文档提取、自动打开、完整 Markdown、历史 approved 行内展开 | 文档更新与审批请求分别传输；匹配 requestId/toolUseId 的结算；补 Open in/Copy/新窗口/展开等工具栏，计划评论交互另行补齐 |
| Plan 审批 | 文档状态与 interaction_settled 分离；独立输入框上方卡片 | 批准目标模式、反馈、拒绝、重新提出与恢复；不能仅靠“模型说已批准”更新状态。官方真实 ExitPlan/AskUser 样本仍待采集 |
| 后台任务 | 蓝色摘要标签、Running/Finished、输出读取、Stop/Clear、快照恢复 | 新内核任务启动/进度/终态、完整日志和单停；当前 Pi 不具备完整链路。foreground result 不得终止仍运行的任务 |
| 双面板 | Plan/Tasks 独立上下布局和关闭 | 实测面板高度、关闭后占满、阴影与工具栏；会话切换隐藏视图，但不误停进程 |
| 压缩行 | 生命周期投影、历史/实时去重 | 文案仍有硬编码中文；官方压缩视觉样本不足；新内核完整终态是正确显示的前提 |
| 阻塞交互 | 权限/AskUser/ExitPlan 分队列与 pending 快照恢复 | 新服务保持请求关联和 settlement；切页面/切会话/重连后不会丢审批，拒绝后可按原生规则继续 |

`_promaNativeMessage`、`_partial`、`_promaActivityPhase` 是当前桌面的适配元数据，不应强迫 CLI 生成桌面专属字段。服务/适配器从原生消息映射，保留源字段并形成一个有测试的桌面投影，后续产品改名不改变协议含义。

后台任务不应靠读取完整 transcript 重绘来“伪实时”；消息使用常驻事件流，任务日志使用可续读的游标/流。面板关闭只影响视图订阅，任务继续；停止按钮通过真实 taskId 操作单个任务并等待终态。

### 展示源码证据

以下路径均相对于桌面 `apps/electron/src/renderer/`：

- `components/agent/SDKMessageRenderer.tsx:586`：活跃投影入口；`:752`：assistant 操作；`:1173`：用户气泡。
- `lib/agent-cursor-turn.ts:203`、`components/agent/AgentTurnTimeline.tsx:22`：过程与 final 分段。
- `components/agent/AgentActivityTimeline.tsx:69`：真实 thinking；`:135`：工具组。
- `components/agent/AgentRunningIndicator.tsx:6`：未使用 startedAt 的等待行。
- `components/agent/tool-result-renderers/bash-result.tsx:33`：Bash 结果现状。
- `lib/plan-document.ts:104`、`components/agent/ProposedPlanCard.tsx:30`：文档和批准状态。
- `components/agent/BackgroundTasksSummary.tsx:31`、`BackgroundTasksPanel.tsx:42`：蓝色标签、日志与停止。
- `components/agent/SidePanel.tsx:472`、`components/diff/DiffPanelTabBar.tsx:180`：上下布局及面板标题栏。
- `hooks/useGlobalAgentListeners.ts:334,482,577,875,1238`：压缩、恢复、计划打开、交互结算与任务终态。

## 7. 实施顺序与验收场景

保持既定同仓方案：桌面迁入 CLI 仓库 desktop/；Electron Main 经独立本地服务与每会话 CLI 子进程双向通信。业务持久化仍使用现有 JSON/JSONL，不新增第二套数据库。

1. **冻结语义和事件样本**：先明确 usage 增量/累计、context 快照、工具匹配、审批/计划/任务/压缩终态；补缺失官方样本。原生数据与显示文案分离，按能力回报状态。
2. **同仓与服务链路**：按主审计方案完成迁入、独立构建、生命周期和消息控制；现有桌面模块经统一适配器接入，不逐页面各连 CLI。
3. **贯通完整能力**：六模式与 Auto、权限/询问/计划、正文/思考/工具、任务日志/单停、用量/context/compact/reset/rewind、worktree 与应用功能。
4. **行为和视觉一起验收**：协议 fixture 和真实隔离项目分别测试；对照官方样本检查同一事件序列的 UI，不以字段存在或构建成功代替完成。

| Given / When | Then 验收 |
| --- | --- |
| 同会话连续两轮，多模型、缓存与重放 result | 日统计只增加新消耗；modelUsage 累计快照不被重复相加；用户消息数不随内部调用增加 |
| Auto 判断和后台子代理也调用模型 | 消耗可归属且无父子重复；缺来源时标明未计入，不能假装全量 |
| 模型从大窗口切到小窗口、MCP/Skills 改变 | 原生确认后容量和分类刷新；分类标估算；不保留历史最大容量 |
| 手动/自动压缩成功、无操作、失败或停止 | 过程与历史仅一个正确终态；成功后上下文下降；失败保留原值；累计历史用量不随压缩减少 |
| 清空/回退/分叉 | 原生消息与文件恢复语义明确，context、pending、任务和文档同步；源会话不被意外改写 |
| 一轮正文→思考→Read/Bash/Edit→最终正文 | 顺序正确、流式无重复；工具和输出可分别展开，展开状态与滚动位置不随增量重置 |
| 生成计划→用户反馈→再次提出→批准 | 文档与审批状态独立；自动开面板、正文可打开；批准模式按选择生效，恢复后状态一致 |
| 两个后台任务，前台已完成，停止其中一个 | 蓝色标签和 Running/Finished 准确，另一个继续；日志可续读，关闭面板不杀任务 |
| Plan 与任务面板同时打开后关闭一个 | 剩余面板自动占满；切会话隐藏面板且不串内容；返回后可打开该会话真实内容 |
| 等待审批期间切页面、重连或恢复会话 | pending 和已结算状态正确恢复，不重复执行已批准的请求 |
| 页面保持打开，完成新调用并切换语言/主题 | 用量更新；等待/压缩/任务/审批和图表文案主题一致，图表悬浮可读 |

现有 usage/context/compaction/消息组件测试可复用，但它们不证明 Local CLI 已接通。本轮仅做源码审查和文档一致性检查，未执行运行测试。尚待实际实现、隔离项目联调与官方缺失样本采集。

# Claude Code 桌面端执行展示：实机采样记录

日期：2026-09-17。通过当前运行中的 Claude.app 原生可访问性树与截图观察，未读取或复制官方前端源码。

## 采样边界

- 用户确认 Proma 就是当前仓库 `/Volumes/code/code/agent/Proma`；桌面端历史项目标签仍显示 Xcode。
- 新建参考会话「只读采样与展示选择」，本地会话标识 `local_538d9041-09a7-465d-8e06-bac634d56ba0`。
- 模型沿用 `glm-5.3-flash`，Effort 为 High。当前分支控件显示 `ccx-dektop`，worktree 未勾选（用户调整后的状态）。
- 发送内容明确禁止修改或创建仓库文件、提交、安装依赖、联网、启动服务、读取凭据；计划只允许会话内部文档，不允许执行代码变更。
- 已运行采样仅为读取 package.json、`ls -la` 和 `sleep 45; printf "UI_SAMPLE_DONE\n"`。后台命令有有限生命周期，不写项目文件。
- 临时权限请求最终已拒绝，临时文件不存在。采样产生的计划文件仅位于 `~/.claude/plans/`，不在项目内。
- 参考采样阶段仅新增这份观察文档，两个子 Agent 均只读；后续经用户要求继续，已开展下述 Proma 源码实施。
- 以下“实测”指画面/AX 已确认，“待采集”不代表已实现或已验证。

## 1. 模式选择（实测）

新会话与已有会话菜单相同，由底部模式按钮打开原生浮层。四个互斥选项有当前勾选与说明：

| 模式 | 原版说明 | 已观察行为 |
| --- | --- | --- |
| Manual | Always ask before making changes | 只读 Read、ls 及采样 sleep/printf 未弹审批，不能据此推断所有命令自动放行 |
| Accept edits | Automatically accept all file edits | 本次只观察菜单，未激活、未写文件 |
| Plan | Create a plan before making changes | 选择后底部标签变 Plan；仅切换模式不会立即打开计划面板 |
| Bypass permissions | Accepts all permissions | 新会话初始偏好；采样主动改为 Manual，未扩大权限 |

模式选择只改变会话模式，不发送输入框内容。权限请求与拒绝样本见下节。Accept edits、Bypass 的真实写入执行未测试，避免影响代码。


### Manual 写权限审批与拒绝（实测）

使用 Write 请求在 `/tmp/claude-desktop-ui-permission-probe-20260917.txt` 写入一行测试文本。没有要求写入任何仓库路径，最终点击 Deny；已通过文件存在性检查确认该临时文件也未创建。

- 侧栏会话状态从 Running/Idle 变为 `Awaiting input`，左侧黄色圆点。
- 消息工具行显示 `Creating <filename>`，pending/running 状态；普通过程正文继续保留。
- **审批卡在消息列底部、Git操作条和输入框上方，输入框并未被替换。** 卡片为白色大圆角细边框/轻阴影。
- 标题 `Allow Claude to write <filename>?`，随后显示绝对路径、`Path is outside allowed working directories`，再显示路径条与绿色逐行拟写入 diff。
- 按钮顺序：左侧 `Deny 1`（Esc），右侧 `Always allow 2` 与黑色主按钮 `Allow once 3`；界面同时有组合键提示。
- 点击 Deny 后审批卡消失；原工具行变为红色动词 `Failed to write`，文件名仍在同行。
- 展开失败工具可见拒绝原因：用户不希望继续此工具，拟写内容未写入；底部还可查看实际输入参数。
- 本次没有点击 Always allow/Allow once，也没有授予新权限。阻塞解除后模型继续接收拒绝结果，不能把“拒绝工具”直接当作整个会话错误。

## 2. 用户消息与执行流（实测）

- 用户正文右侧浅灰气泡，宽度受限、正文左对齐，长段落自然换行。
- 助手过程正文与最终正文均使用主消息列，无头像卡片框；正文可穿插多个工具聚合行。
- 首个模型输出前：橙色标识 + `4s · Waiting for Claude…`；开始输出后可出现 `46s · 842 tokens · Waiting for Claude…`。
- 执行中输入区可继续编辑，发送按钮位置变为 Stop。结束后恢复 Send。
- 历史消息操作有 Copy、Fork from here、Pin as chapter；用户消息另有 Rewind to here；旁边显示相对时间。
- 采样长请求曾触发正文折叠/历史可见范围变化，不能把 AX 中的消息标题当作第二份正文渲染。

## 3. 工具调用：两级展开（实测）

1. 连续 Read + Bash 默认是一行：`Read package.json, ran a command`，末尾小箭头。
2. 点聚合行后出现一个轻边框圆角容器，里面两条紧凑工具行：`Read package.json`、`Ran a command`。
3. 再点具体命令行，原地展开带语法着色的命令框（前置 `$`、右侧复制）与独立等宽输出区。
4. 长输出有自己的滚动条和下缘渐隐，不把所有日志无限撑开。
5. 正常执行状态为 `Running a command`；后台执行多出 `View live output`；结束后原位变 `Ran a command`。
6. 参考旧会话观察到聚合统计 `Ran 5 commands, edited 2 files +4 -3` 和失败后缀 `used 5 tools (2 failed)`。

不能直接把内部 tool name / JSON input 作为一级显示；需有“聚合摘要 → 单次调用 → 实际输入输出”的分层。展开状态不应因新 token 或后台更新重置。

## 4. 后台任务（实测）

- `sleep 45; printf "UI_SAMPLE_DONE\n"` 实际进入后台，任务 ID `bpxj1scri`。
- 模型仍在回复时，底部状态行嵌入蓝色 `1 running task` toggle；模型回复结束、任务继续时，底部仍保留此入口。
- 右侧为独立浮动 `Background tasks` 面板：白色底、细边框/圆角/轻阴影，顶部新窗口、展开、关闭。
- Running 分组中一张浅灰任务块：命令作为标题，下方 `Bash 04s`、`Bash 20s` 等计时；右侧方形 Stop this task。
- 展开任务块显示命令代码条，下方开始为 `No output yet`，待任务真实产生输出后更新。
- 45 秒命令完成后 Running 分组消失，出现折叠的 `Finished 1` 与 `Clear finished tasks`。消息工具行变为 `Ran a command`。
- 模型随后追加任务完成说明（退出码 0）；这与最初“后台任务已启动”属于不同时间的更新。
- 另在历史会话实测 `Finished 5`，各任务为 `Bash Stopped`，停止任务并不从历史列表消失。

实现约束：回复完成不等于后台任务完成；Stop this task 必须真正停止对应任务，不能只改 UI；隐藏面板不能停止任务。Finished 历史默认折叠与可清理需独立状态。

## 5. 计划与结构化询问（实测与限制）

- Manual 模式请求 AskUserQuestion 后，当前模型明确说明工具不可用，并退化为正文选项列表；该列表不是结构化询问 UI，不能用来复刻 AskUser 交互。
- Plan 模式下生成了 `/Users/qianmeng/.claude/plans/ui-20-3-git-virtual-bonbon.md`，已在工具展开区域核实实际路径，位于仓库外；工具行是 `Created … +17 -0`，展开为绿色新增 diff、行号、文件路径及 Copy。
- 当前新会话模型再次说明没有 ExitPlanMode，也没有 tool_search/延迟发现能力；没有采到新计划的正式待批准面板。不能把其正文中“请批准”当成真正审批。
- 新会话即便没有 ExitPlanMode，More → Plan 仍可以打开刚生成的完整计划文件。这说明计划文档与计划审批是不同数据源，不能只等待 ExitPlanMode 才展示计划。
- 新会话 Plan 模式的面板提示为 `Select any text to leave a comment for Claude`；切回 Manual 后原位改为 `You can comment on the plan in plan mode, or when Claude asks you to approve it.`。
- 只读打开已有「推送链路重构与重新派单推送」会话，点历史 `Proposed plan`：**批准后的这一条展开为消息内的绿色 `Plan approved` + 原始计划文本**，本次并未直接打开右侧面板。More → Plan 才打开完整渲染的右侧 Markdown 文档。需按计划阶段分别建模，不应把所有 Proposed plan 永远绑定为同一种动作。
- 独立 Plan 面板工具栏依次包含 Open in、Copy plan、Open in new window、Expand、Close；全文包含标题、列表、表格、代码与可点击文件链接。
- 有 Background tasks 面板时再点 Plan，会新增一个独立面板，本次自动上下排列。二者有各自关闭/展开按钮，**不是一个面板内的混合 Tab**。这还原要求超出简单的 activeTab 替换。
- 为保护其他正在运行的任务，只浏览既有历史和面板，未发送消息、批准或中止其任务；观察后关闭新打开的 Plan 并恢复历史折叠。

## 6. Worktree（选择界面实测，实际创建未执行）

新会话输入框上方顺序为 Local、项目、分支组合框、worktree 复选框、Add another folder。worktree 与分支并列，说明为 `Work in an isolated copy of the repository`。点击项目下的新会话不会立即创建真正会话；首次发送才生成会话。

- 在空的新会话草稿中勾选 worktree，基准分支从 `ccx-dektop` 变为 `main`；取消勾选后回到 `ccx-dektop`。这仅是本机实测，不推断所有仓库默认分支均为 main。
- 已勾选与未勾选时都可打开分支下拉；列表有当前勾选、分支名称，底部 Search branches… 输入框。输入 ccx 后仅保留匹配分支。
- 关闭下拉不提交选择；本次没有选择其他分支，也没有发送 worktree 任务。已恢复 worktree=false、分支显示 ccx-dektop。
- 实际创建时的进度、失败、物理目录、初始化命令和 fork 语义尚未在参考程序实测。不能用我们当前实现来反向当作参考行为。

## 下一步的实现原则（根据已确认画面）

- 以统一的运行状态/事件投影作为显示层输入，区分用户消息、助手过程正文、工具组、最终正文、阻塞交互、后台任务以及计划文档。
- 权限请求、结构化询问、计划审批是不同的阻塞状态，不混为一个通用消息卡片。
- 计划文档、运行中的任务清单、后台任务列表是三个不同概念。
- 先补真实事件和生命周期，之后再还原字号、边距、聚合文案、折叠、状态栏与独立面板；不靠展示层伪造任务完成或权限结果。

## 7. Proma 当前数据链路的只读审查

两位原生 `fix-executor` 子 Agent 分别审查执行状态与 worktree，均未修改代码。以下是本地实现事实，非对官方内部实现的推测。

### 执行展示需要先修的数据基础

| 缺口 | 影响 | 主要入口 |
| --- | --- | --- |
| renderer 未调用现有 getPendingRequests | 页面重载后主进程还在等待，界面却没有可点击请求 | useGlobalAgentListeners、preload/main pending 接口 |
| permission_resolved / exit_plan_mode_resolved 未在全局状态处理 | 其他窗口响应、停止和清理后可能残留旧审批 | useGlobalAgentListeners、三个 request service |
| 独立请求 Map 固定 permission > askUser > exitPlan 优先级 | 不能可靠重放事件发生顺序 | agent-interaction-panel、agent-atoms |
| Request 缺 toolUseId / run / sequence | 审批难以绑定到具体工具行，并行时会错配 | shared agent types、agent-orchestrator canUseTool |
| 交互结果没有独立持久记录 | 历史无法可靠显示批准、拒绝、已回答或反馈 | agent-session-manager、request/resolved 事件 |
| 活跃后台任务缺主进程 snapshot | renderer 重载后仍运行的任务可能消失 | background-task-presentation、useBackgroundTasks |
| GET_TASK_OUTPUT / STOP_TASK 仍为空实现 | 仅加按钮无法复刻真实输出和停止 | main/ipc.ts |
| Task system 消息持久化不完整 | 任务历史的类型、输出、所属轮次易丢失 | isPersistableSDKSystemMessage、task_* 映射 |

AskUser 当前 X 实际是空答案跳过并继续，Permission/ExitPlan 的 X 则是拒绝，不能为了统一样式抹掉不同语义。

### Worktree 需要修的数据基础

| 缺口 | 影响 | 主要入口 |
| --- | --- | --- |
| fork meta 未继承/创建 worktree | runtime fork 来源在 worktree，后续界面/运行却落回主项目 | createForkedAgentSessionProjection、agent-orchestrator |
| 在新会话继续等入口未传 gitContext | 主目录与隔离目录混用 | AgentView、Quick task、Taskboard、collaboration |
| 路径尚未加载即开终端，cwd 为 undefined | 主进程退回 Home，与会话目录不一致 | AgentView、RightSidePanel、integrated-terminal-manager |
| Git 状态未就绪时仍可发送 | getHomeAgentGitContext 返回 undefined，静默退回主项目 | HomeComposer、HomeGitControls |
| Diff 浏览 worktree 基准硬编码 origin/main | 忽略会话实际 base branch，且会触发 fetch | DiffChangesList、git-diff-service |
| 删除 dirty worktree 仅保留并写日志 | 用户看不到残留目录或清理状态 | agent-session-worktree |

已正确实现的基础：主页 worktree 为 checkbox；只在创建会话时运行 Git；正常新建路径中 runtime/files/diff 共用会话目录；worktree 丢失会报错而不回退主项目；终端面板 X 只收起，进程与会话关联。

## 8. 重做顺序与验收矩阵

1. **事件/会话层**：统一 toolUseId、runId、交互顺序与结果；pending snapshot + resolved reconcile；后台 snapshot/output/stop；会话 cwd 的单一可信来源。
2. **执行投影层**：一个事件只能归属一条时间线记录；区分 foreground completion 与 background completion；文件计划全文与提出计划/批准结果分开；历史与实时共用同一投影规则。
3. **展示层**：用户气泡、连续助手正文、两级工具展开、底部运行状态、三类阻塞交互、计划文件 diff、完整计划面板、Running/Finished 后台面板。
4. **面板布局层**：独立面板可共存、关闭不销毁任务；terminal 内部可有多个 terminal tab，跨功能不混用一条 tab bar。具体是否优先只保留单个可见面板，按用户最终产品要求落实。
5. **Worktree入口层**：模式勾选与基准分支分别保存；输入参数就绪再创建；新建/fork/继续/终端/文件/改动/Runtime 全部使用明确会话路径。

必要行为验收：

- 生成输出前 → 过程文字 → 工具开始 → 工具结果 → 最终正文；每一步准确变更且不重复正文。
- 并行工具、工具失败、手动停止、用户继续；工具组展开与滚动位置保持。
- 权限/问答/计划批准请求跨会话隔离；重载可恢复；异窗或取消事件能关闭等待状态。
- 计划写入文件 → 显示完整文档 → 正式提出计划 → 反馈或批准 → 后续执行记录，阶段不混淆。
- 前台回答完成而后台仍跑；单任务停止；输出更新；自然完成；Finished 折叠；重载协调真实运行态。
- worktree 勾选只更新草稿；未发送不创建；fork/继续保持明确目录；终端在路径未就绪时不会落到 Home；改动比较遵循会话基准分支。

## 补充：斜杠菜单与多面板

- 在只读采样会话输入 `/`，实际候选同时包含命令和 Skills。可见命令包括 `schedule`、`btw`、`rewind`、`fork`、`mcp`、`plugin`、`model`、`plan`、`output-style`、`rename`、`cd`、`workflows`、`status`、`usage`、`config`、`sandbox`、`resume`、`agents`，随后显示 `anthropic-skills:*` 项。仅观察候选，没有执行命令；退出菜单后已清空 `/`。
- 命令目录包含界面动作，不能仅依据模型内核是否接受对应文本判断是否可支持。Proma 应将已实现的界面动作与真实内核命令纳入统一候选，未接入能力不能显示成可用动作。
- 用户补充确认：顶部更多菜单中的 Plan、后台任务入口按当前会话内容动态出现。此处的 Plan 指查看计划面板，切换计划模式的操作仍须始终可用。
- Plan 与后台任务可同时上下展示，各自关闭；关闭一个后剩余面板占满可用高度。正文中的蓝色任务标签也是后台任务面板入口。

### Proma 本轮落地与验收

- 右侧计划与后台任务已拆成独立的上下悬浮面板，按打开顺序排列，各自关闭，剩余面板自动占满；会话切换收起可见面板，保留会话缓存。
- 顶部更多菜单根据当前会话的计划文档、可见计划 Todo、后台任务数据决定入口；正文后台任务摘要使用蓝色可点击标签。
- `/` 合并已接入的三个命令与可调用 Skills：`/compact` 选择后插入待发送文本；`/plan` 开启已有计划模式；`/model` 打开模型选择器。无对应界面处理器的输入框不展示本地界面命令。其它 Claude 命令暂未接入，不在候选中冒充可用。
- 原生 Proma 已验证空会话数据时不显示 Plan/后台任务菜单项；斜杠菜单、`/comp` 过滤、Enter 只插入 `/compact`、`/model` 打开真实选择器均符合预期。采样后清空输入，没有发送命令，也没有更换模型。
- 双面板的顺序、独立关闭、高度分配样式、浏览器实例唯一性及会话隔离通过组件渲染和状态测试；没有在真实模型请求中额外启动后台任务来验证。

### 继续实施：请求生命周期与目录绑定

- 三类待处理请求在全局监听器挂载、窗口恢复焦点时读取主进程快照；快照与实时事件协调，避免旧结果复活已处理请求或丢弃新请求。结算清理不受旧模型回合正文的丢弃规则影响。
- 权限、询问、计划审批记录请求序号、创建时间、工具 ID、运行 ID，按发生顺序展示；允许、拒绝、回答、反馈、中止、取消等结算保存为结构化历史。结算记录不复制答案或工具输入。
- 审批卡保留在输入框上方，草稿仍可编辑；待处理交互期间禁止发送，Enter 与 Git 操作入口遵循相同约束。
- 历史计划区分文档、提出、批准、要求修改、拒绝。批准后的入口支持原地展开和打开完整计划；依据工具 ID 在完整会话消息中查找结算，兼容结算先于批量工具正文落盘的情况。
- 后台任务增加主进程注册表、列表/输出/停止/清理接口；当前会话常驻恢复，面板尚未打开时也能取得入口数据。快照保留请求期间到达的新任务、进度与终态，关闭面板不停止任务。
- **当前 Pi 能力边界**：现有 worker 不产生原生后台任务事件，也没有单任务停止、完整任务日志读取协议。仅当 Runtime 提供真实能力时开放停止按钮；已有事件摘要可显示，只有输出文件路径但不支持读取时明确提示。未用整轮取消冒充单任务停止，未把摘要宣称为完整输出。
- 新会话继续与 fork 保持源 worktree/base branch，主进程校验同项目和目录存在；缺失目录明确失败。共享 worktree 的会话删除时保留仍被引用的目录。
- 删除会话或项目时，存在未提交改动、状态检查失败或清理失败的 worktree 会保留，并通过结构化结果向界面报告原因和目录；单删、级联及归档批量删除入口都显示保留提示。
- 首页 Git 参数未就绪时禁止发送；终端路径为空时前后端均拒绝创建，避免落到 Home；Diff 使用会话基准分支且查看时不再隐式 fetch。
- Git 行为测试只使用临时仓库，未在真实 Proma 项目创建 worktree 或切换分支。真实模型下的 AskUser/ExitPlan 像素验收和 Pi 后台任务完整执行仍未完成。
- 本次由四个原生 `fix-executor` 子代理分别实施请求服务、交互卡片/计划、后台任务、worktree；主代理负责全局状态恢复、编排层结算持久化、历史渲染接入和整合验证。
- 验证采用独立进程运行相关分组，避免既有 Electron module mock 在合并测试时互相污染：会话管理 47 项、展示/交互/计划/分组 102 项、后台任务 19 项均通过；权限服务及临时 Git 仓库行为检查也通过。全仓 TypeScript 检查及主进程、Preload、Renderer 构建通过；构建仍提示既有大体积 chunk 警告。

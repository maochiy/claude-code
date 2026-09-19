# 同仓桌面迁移、本地服务与完整能力接入审计

日期：2026-09-17。本文是只读源码审计与实施方案，不是迁移完成报告。

**2026-09-18 范围修正：** 用户明确要求原 Proma 功能重做。本文中“保留应用编排/业务服务，只替换执行适配”的策略已经失效；现有实现仅作为源码审计资产。正式范围、实施顺序和验收以 [桌面端完整重做计划](./desktop-rebuild-master-plan-2026-09-18.md) 为准，下文保留历史审计快照。

专项补充：[统计、上下文、压缩与执行展示审计](./desktop-context-usage-presentation-audit-2026-09-17.md)。包含 CLI 已有的上下文分类接口、统计累计口径、动态压缩缺口和官方展示证据边界；这些能力全部属于迁移验收范围。

## 1. 当前决定

以 `/Volumes/code/code/agent/claude-code` 作为目标仓库，将当前 `/Volumes/code/code/agent/Proma` 的桌面项目及其共享包迁入 `desktop/`，保留已完成的桌面 UI。使用独立本地服务管理 CLI 子进程，完成双向实时交互。新的产品名称尚未指定，本文不代替用户决定名称。

本方案取代先前“两个仓库长期独立维护、Electron 主进程直接管理 CLI”的部署建议。前一份 [完整能力清单](./claude-local-runtime-integration-plan.md) 中的功能语义、Auto 缺口和验收要求仍有效，执行职责按本文重新分配。

本轮没有搬迁仓库、修改执行代码、运行模型、启动服务、安装依赖或读写真实用户配置。扫描和新文档位于当前桌面工作区；没有修改 CLI 仓库。采用主代理与三个可用只读子任务分别检查合仓/打包、CLI 服务、桌面主进程和 UI 接线；原 issue-diagnoser 因模型不受账号支持启动失败，已由 fix-executor 承担同一只读任务。

### 审计快照

| 仓库 | HEAD | 工作树情况（扫描时） |
| --- | --- | --- |
| 当前桌面 | `08980444` | 1418 个跟踪文件；159 项跟踪改动、67 项未跟踪状态记录 |
| CLI | `b3af7db7` | 3610 个跟踪文件；0 项跟踪改动、2 项未跟踪状态记录 |

状态记录可能代表目录，不等于文件数。迁移必须包含经确认属于产品源码的未跟踪内容与未提交修改；`git archive HEAD` 或只导入已提交分支会漏掉当前成果。禁止搬入 `.git`、node_modules、dist/out、真实配置、凭据、缓存与运行时会话文件。

## 2. 目标目录与迁移映射

建议先保留当前桌面的内部目录布局，避免把合仓同时变成一次全仓改路径工程。

```text
claude-code/                         # 目标仓库
├── src/                             # 现有 CLI 内核、协议和终端入口
├── packages/                        # 现有 CLI workspace packages
├── scripts/                         # CLI 构建 + 顶层桌面启动/构建协调
├── desktop/
│   ├── apps/
│   │   ├── electron/                # 当前桌面的 apps/electron
│   │   ├── cli/                     # 当前会话读取辅助 CLI，非执行内核
│   │   └── local-service/           # 新增：服务入口、进程管理、API/WS
│   ├── packages/
│   │   ├── shared/                  # 当前共享类型，逐步拆出传输契约
│   │   ├── core/                    # 当前 provider、highlight 等复用代码
│   │   ├── ui/                      # 当前 React 18 UI 组件
│   │   ├── session-core/            # 当前会话读取/搜索核心
│   │   ├── desktop-protocol/        # 新增：无 Electron/React 的服务契约
│   │   └── desktop-services/        # 按需提取纯逻辑；首轮不整体搬走应用服务
│   ├── tutorial/                    # 保持安装包教程资源路径
│   ├── docs/
│   ├── tsconfig.json               # 桌面独立类型配置
│   └── package.json                # 桌面任务组织；统一 workspace 时不重复管理依赖
├── .github/workflows/
│   ├── cli-check.yml               # CLI 原有检查/发布职责
│   ├── desktop-check.yml           # 桌面与本地服务检查
│   └── desktop-release.yml         # 桌面安装包发布
└── package.json / bun.lock          # 目标：明确的 workspace 与锁文件策略
```

| 现有路径 | 目标路径 | 处理 |
| --- | --- | --- |
| 桌面 `apps/electron` | `desktop/apps/electron` | 保留 main/preload/renderer；逐项替换执行接口 |
| 桌面 `apps/cli` | `desktop/apps/cli` | 保留 session list/info/outline/search/export；避免与根 CLI 命令冲突 |
| 桌面四个 `packages/*` | `desktop/packages/*` | 保留现有 workspace 引用，命名统一单独处理 |
| 桌面 `tutorial`、默认 Skills、资源、测试 | 对应 `desktop/` 内位置 | 保留依赖链和资源引用，不只搬 renderer |
| 桌面 `.github/workflows` 与脚本 | 合并到目标根 `.github`，桌面脚本设独立目录 | 嵌套 `.github` 不会作为目标仓库 workflow 执行 |
| 桌面 root tsconfig、测试配置、忽略规则 | `desktop/` 子配置 + 根级排除/入口 | CLI 测试 preload 不能污染桌面测试 |
| 品牌名、appId、更新源、配置目录 | 独立迁移项 | 不靠全局文本替换完成；旧数据位置保留兼容 |

已有源码包名称未发现与 CLI workspace 名称相同的直接冲突。第一步不必立即改 `@proma/*` 内部包名；用户可见品牌最终统一更换，避免将品牌替换和接口迁移耦合为不可定位的大改动。

## 3. 服务与进程架构

```text
Renderer / Jotai / 现有 UI
        ↕ 现有 preload + Electron IPC
Electron Main
  ├─ ServiceSupervisor / ServiceClient
  ├─ 现有应用编排、桌面 JSONL、自动任务、协作与外部入口
  ├─ 窗口、托盘、系统通知、文件对话框、更新
  ├─ safeStorage 凭据代理、PTY、内嵌浏览器、麦克风
  └─ 受控的系统能力回调
        ↕ loopback HTTP + 常驻双向 WebSocket
Local Service（应用启动一个服务进程）
  ├─ 原生会话/任务运行态、进程容量与事件回放
  ├─ 模式、审批、AskUser、Plan 控制请求关联
  ├─ CLI 进程管理、命令/能力目录、模型配置应用
  ├─ 原生操作与消息/用量事件转发
  └─ 每个活跃会话一个独立 CLI 子进程
        ↕ 双向 stream-json/control
CLI 内核：模型循环、工具、Auto、计划、后台任务、原生会话
```

服务与 CLI 之间首选已审过的双向 stdio NDJSON。若实施时选用 CLI 已有 `--sdk-url` WebSocket，须补连接认证、重放去重和重连测试；两种传输承载相同执行语义，不需要为了形式一致复制 cc-haha 的每层网络拓扑。桌面与本地服务保持常驻事件通道，不以轮询完整 transcript 获取流式内容。

### 职责与数据所有权

| 数据/能力 | 唯一写入/执行主体 | 其他层作用 |
| --- | --- | --- |
| 原生模型会话、工具执行、CLI 检查点 | CLI | 服务保存映射并投影，桌面不直接改原生 transcript |
| 桌面会话索引、消息投影、任务快照、用量、应用定时任务 | Electron 中已有应用服务 | 服务提供原生事件与状态；保留已有 JSON/JSONL 唯一写入路径，避免引入第二套业务索引 |
| CLI 运行态、控制请求、事件序号与短期回放 | Local Service | Main 订阅并落盘；服务故障后依据原生会话与桌面检查点恢复，丢失状态明确报告 |
| 凭据加解密 | Electron safeStorage 代理 | 服务按需取得执行所需凭据；不把 Electron 依赖打包进服务 |
| 终端 PTY、窗口、内嵌浏览器、系统权限 | Electron Main | 服务通过受控 host capability 请求调用 |
| 面板开关、高度、页面导航等展示状态 | Renderer/Jotai | 不决定 CLI 是否存活 |
| 模型渠道与配置 | 一个明确的配置服务 | 模型协议仍由显式 provider/apiMode 确定，不从名称或 URL 猜测 |

当前 `agent-orchestrator.ts` 已设计为不直接依赖 Electron，可提取复用；但其依赖链里的配置和渠道服务仍需注入。`agent-service.ts`、`automation-scheduler.ts`、`channel-manager.ts`、`config-paths.ts` 含 BrowserWindow/safeStorage/app 依赖，不能整个目录复制到 Bun 服务后直接运行。

第一轮保留上述应用编排与业务存储，通过 `LocalServiceRuntimeAdapter` 将其底层执行委托给独立服务。服务是真实、独立的 CLI 宿主，不是 HTTP 代理 Pi；也不再实现一遍桌面自动任务、协作和会话索引。后续是否抽离更多纯应用服务，不影响本轮完整功能对接。

应用普通 Chat 功能的 provider 服务同样纳入服务边界审计，但不强制把普通 Chat 的行为改成 Agent 工具循环。既有浏览器工具、语音、系统工具使用 Main 的能力代理，不要求 CLI 导入 Electron API。

### 本地服务启动与恢复

1. Main 定位随安装包提供的服务/CLI/运行时产物，启动服务并通过专用通道获得 ready 信息：端口、协议版本、构建 ID 与能力。
2. 仅监听本机回环，使用本次启动生成的认证凭据；服务客户端保留在 Main，不把管理凭据交给网页或模型正文。
3. Main 连接 WS，完成版本/能力检查并恢复会话快照；服务对每个会话维护进程代际与事件序号。
4. CLI 由服务传入准确 cwd、模式、模型路由与设置作用域；进程崩溃、挂起审批、后台任务与普通 idle 分开处理。
5. UI 重载不重发已提交执行；从 snapshot + sequence 增量恢复。暂停/停止等待实际控制结算，不能以 socket.send 成功当作执行成功。
6. 退出应用明确关闭服务与受管进程。Local-only 首版不承诺应用退出后任务继续运行；若将来需要另做常驻 daemon 生命周期。

## 4. 服务契约（拟新增，非现有 API）

| 契约组 | 必须提供的操作和事件 |
| --- | --- |
| bootstrap/health | 服务状态、版本、能力、运行产物校验；区分服务在线与模型可用 |
| sessions | list/create/open/resume/delete/fork/rewind/compact；project/worktree/原生 ID 映射 |
| turns/messages | send/queue/cancelQueued/interrupt；accepted、started、delta、tool、result、failed |
| interactions | permission/AskUser/ExitPlan 的请求、响应、取消、状态恢复；按 requestId 结算 |
| runtime config | 六模式、模型、effort、thinking、自动压缩；确认与实际状态回读 |
| tasks | snapshot/progress/output cursor/stop；前台结束后仍推事件；父子任务与来源 |
| plans | 全文、修订、提出/批准/反馈状态；完整计划面板与消息入口一致 |
| capabilities/catalog | commands、Skills、MCP、模型能力；动态变化推送 |
| usage | token/cache/contextWindow 与终态对账；Auto 额外判断调用需纳入可用统计 |
| app services 接入边界 | 协作、自动任务、看板、现有外部入口在 Main 复用，统一经本地服务执行；不重复建立另一套服务端业务调度 |
| host capabilities | 受控请求 Main 的 PTY/browser/dialog/系统权限等；明确 session 与取消语义 |

请求包含 requestId、sessionId、操作名、参数及可选幂等标识；事件包含 sessionId、进程代际、序号、事件类型和关联 turn/tool/task/request ID。不得因重连自动重放有副作用的发送/审批/工具操作。控制与 stream 顺序由服务归并，不要求 CLI 产生它当前没有的旧 CCB 自定义终态事件。

## 5. 合仓与打包的确定差异

| 项目 | 当前桌面 | CLI | 实施处理 |
| --- | --- | --- | --- |
| React | 18.3；共享 UI peer 也限制 18 | 19.2 | 第一轮保持各自版本，Renderer 必须只解析一份 React 18；不为合仓强升 UI |
| Vite | 6 | 8 | 使用各 workspace 的构建入口和插件版本 |
| TypeScript | 5 | 6 | 分离配置/类型作用域和检查命令，验证工具实际解析来源 |
| Bun 测试 | 当前项目测试集合 | 根级 preload 注入 MACRO | 分进程测试入口，禁止根级递归测试把两套环境混跑 |
| 依赖 workspace | apps/* + packages/* | packages/* + scoped packages | 根增加 desktop/apps/* 与 desktop/packages/*；验证 peer 解析后统一锁文件 |
| 构建目录 | 各应用 dist | 根 dist 会先清空 | CLI/service/desktop 各自输出，脚本必须固定 cwd |
| 原生模块 | node-pty 与 Electron ABI | 音频、图像等 native/vendor | 分平台打包，不复制开发机 node_modules 充当产物 |
| 发布 | 桌面 v* tag、Xcodes appId/更新源 | CLI npm/其他发布任务 | 独立发布触发与版本校验，防止同一 tag 同时误发布两产品 |

同仓不强制第一步合并依赖安装树。若统一 Bun workspace 无法稳定隔离 React/原生依赖，可暂时保留 root 与 desktop 两个明确的安装边界，但不能同时让两套锁文件管理同一批包。最终选型以干净环境安装和构建验证为依据，不手工拼接 bun.lock。

当前 `apps/electron/scripts/build-cli.ts` 构建的是会话读取辅助 CLI，不是自有执行内核。应保留该能力或显式迁移命令，另设 `build:engine` 与 `build:service`。CLI 的现行构建会生成 JS chunks、wrapper 和 vendor 资源；不能只复制 cli-node.js，也不能假设 Node shebang 代表用户机器一定能运行全部能力。

首个可发布版本优先携带经过验证的 Bun 运行时 + CLI 完整构建目录 + 本地服务产物，均置于 ASAR 外。cc-haha 的合并 sidecar 二进制可作为后续打包优化；在自有 CLI 的动态资源/native 依赖通过验证前，不把“单文件编译成功”当作完整功能可用。

安装包资源清单需替换当前 Pi worker/dependencies 检查、afterPack guard 与 ASAR 规则，加入服务/CLI/hash/协议版本检查；保留 node-pty 重建与 macOS 签名。无系统 Bun/Node、无开发目录的干净安装环境必须能启动和运行。

现有数据目录由源码解析为 `~/xcodes` / `~/xcodes-dev`，还有旧 `.proma` 迁移逻辑。产品改名与配置迁移需单独设计；Local Service 必须显式接收数据根，不能在非 Electron 环境下因 `app.isPackaged` 不可用而误用正式目录。测试仅使用临时数据目录。

## 6. 现有服务能否直接复用

| 现有模块 | 静态核实结果 | 本次处理 |
| --- | --- | --- |
| CLI `packages/remote-control-server` | Hono HTTP/WS 远程中继；会话/work item/event 使用内存 Map，服务端不直接 spawn 本机 CLI；默认监听 0.0.0.0。不是 SQLite，但也不是桌面的持久化宿主 | 不整包嵌入。借鉴路由/事件组织；本地服务另外实现进程管理与应用协议 |
| CLI `src/server/server.ts` 与 sessionManager | 明确 auto-generated stub；startServer 返回只有空 stop 的对象，destroyAll 为空 | 不能当作现成本地服务。需实现新的桌面服务入口 |
| CLI bridge/sessionRunner | 有真实独立 CLI spawn、stdio/readline、停止流程，但外层耦合远程注册与 work polling | 可提取独立进程管理思想和无副作用模块，不启动整个 bridge |
| CLI `--sdk-url` | 将 StructuredIO 换为 RemoteIO，并引入 WS/SSE/POST、认证、心跳与重连 | 可选的服务到 CLI 传输，非完整桌面能力的前提；初期优先 stdio |
| CLI daemon / bg | 远控 worker 或 tmux/detached 会话，依赖独立状态目录、远程授权或交互会话 | 不作为桌面默认会话宿主，不自动启用 |
| CLI ACP | 部分会话/模式能力存在；AskUser 答案通道和后台 task system 事件不完整 | 暂不作为本次完整桌面主协议 |
| 桌面旧 `ccb-runtime` | 只剩协议/校验/顺序/投影等辅助代码，原 transport/client 已删除，并有 Pi-only 测试约束 | 复用纯工具并迁入协议/服务包；重新实现 transport，不宣称旧入口可直接复活 |

依据：CLI `packages/remote-control-server/src/index.ts:31`、`config.ts:1-10`、`store.ts:61-71`、`services/work-dispatch.ts:27-81`、`src/server/server.ts:1-6`、`src/server/sessionManager.ts:1-7`、`src/bridge/sessionRunner.ts:287-340`；桌面 `ccb-runtime/legacy-ccb-api.ts:1-8`、`pi-only-entrypoints.test.ts:13-19`。

用户选择的是“同仓 + 独立本地服务”，因此进程管理模块放入 local-service，而不是回退为 Electron 自己直接 spawn CLI。Electron 仅启动服务进程并通过客户端请求执行。

## 7. 当前桌面功能扫描矩阵

标记说明：**已有链路**表示找到 UI/IPC/服务实现，通常仍由 Pi 执行；**部分**表示存在确定缺口；**空/禁用**表示源码直接返回占位结果或拒绝。所有条目都尚未完成新 CLI 的运行验收。

本轮按功能入口和依赖链抽查，涉及 Agent、Settings、Taskboard/Automation、Diff/File browser、Hooks/Atoms 和 preload。相关目录分别约有 132、56、15、29、78 个 TS/TSX 文件，preload 约 396 个桥接方法；这些是目录规模，不代表逐行审完全部文件或每个方法均已实测。表内确定缺口均有具体调用链或空实现证据。

| 功能域 | 当前源码状态 | 新内核对接/补齐内容 | 主要证据（桌面仓库） |
| --- | --- | --- | --- |
| 回复、思考、工具活动 | 已有链路 | 持续接入增量、终态、父子工具 ID、错误与停止，不重复正文 | `AgentView.tsx`、`AgentMessages.tsx`、`hooks/useGlobalAgentListeners.ts` |
| 模式 | 部分，实际只有 default/acceptEdits/bypass/plan | 新增真实 Auto/dontAsk；以 CLI ack/status 为有效值；修订历史迁移规则 | `packages/shared/src/types/agent.ts:1849-1903` |
| Auto 历史值 | 确定的语义缺口 | 当前 migratePermissionMode 对 auto 回退默认 bypass；新接入不得将 Auto 静默提升为绕过权限 | 同上 `migratePermissionMode` |
| 权限、AskUser、计划阻塞 | 已有 pending/abort/恢复链路 | 三种控制请求逐一关联，回答回传 updatedInput，stop/crash/delete 仅结算一次 | `agent-permission-service.ts:203-281`、`agent-ask-user-service.ts:58-195`、`agent-exit-plan-service.ts:61-213` |
| 计划批准选项 | 部分 | 现有共享 action 为 approve_bypass/deny/feedback；需表达批准后目标模式，不能统一切 bypass | `packages/shared/src/types/agent.ts:1834-1846` |
| 计划面板/历史 | 已有提取和打开链路 | 接完整原生计划、版本、审批状态，保留自动打开与内容入口 | `hooks/useGlobalAgentListeners.ts:577-580`、`agent-runtime-plan-service.ts` |
| 后台任务 | 部分 | 已有快照/终态/面板；runtime control 只接 stop，缺 readTaskOutput；需真实日志游标、单停和 result 后事件 | `agent-service.ts:54-62`、`background-task-service.ts` |
| 原生执行图 | 空实现 | 新服务提供真实节点、父子 ID 与状态 | `runtime/runtime-adapters.ts:105-110` |
| 原生子代理 transcript | 明确不支持 | 新服务提供 transcript；与应用协作 child 区分来源 | `runtime/runtime-adapters.ts:112-116` |
| 模型/effort 热切换 | UI 已调用，runtime 部分 | runtime updateRuntimeConfig 当前固定 false；接真实控制、确认和实际配置回读 | `AgentView.tsx:2020-2042,2858-2882`、`runtime-adapters.ts:90-103` |
| 原生模型配置接口 | 禁用 | IPC 三个 native model API 直接抛旧 CCB 停用错误；应明确由模型中心配置映射取代或补真实 API | `main/ipc.ts:2469-2488` |
| 渠道/Provider | 已有链路 | 保留渠道管理、safeStorage、明确 apiMode；验证 CLI 每种协议，处理配置 revision/OAuth 更新 | `channel-manager.ts`、`proma-runtime-model-gateway.ts:55-92` |
| Runtime 能力 | 部分，当前按安装 ready 全标 supported | 改真实 CLI handshake + 实测能力；不能依据安装存在判断 Auto/rewind/task output 可用 | `runtime-registry.ts:479-491` |
| 会话创建/恢复/分叉 | 应用历史已有链路，仍 Pi 绑定 | 创建/fork/委派/自动任务统一新 Runtime ID，原生恢复单独映射，旧 Pi 不假装 resume | `agent-session-manager.ts:398-433,1698-1818` |
| 回退 | 部分 | 返回 canRewind 固定 true，缺真实文件恢复结果；在原生成功后处理历史，报告统计/部分失败 | `agent-orchestrator.ts:3308-3321` |
| 压缩 | 有应用事件链路 | 原生 manual/auto compact、状态与边界，补动态自动压缩设置 | `agent-orchestrator.ts`、`useGlobalAgentListeners.ts:357-379` |
| `/` 与 Skills | 部分 | 固定 compact/plan/model 三命令+Skills；需 CLI catalog、headless/桌面动作分类、动态更新 | `renderer/lib/agent-slash-commands.ts:29-47` |
| MCP | 已有内置/外部配置链路 | 将 lazy builtin materialize 后传服务/CLI；token与会话生命周期；去掉 Pi MCP gateway | `builtin-mcp/http-host.ts:52-105`、`registry.ts:127-168` |
| Hooks/项目指令 | 当前依赖 Runtime 原生发现，未见桌面执行器 | CLI 负责发现/执行，服务发状态；不在 Electron 再做一套 Hooks 执行 | `agent-orchestrator.ts:1516-1517`、`ccb-runtime/protocol.ts:139-155` |
| 应用协作 | 有委派/继续链路 | continue 当前清 runtimeSessionId；明确原生续接或新建重放，保留权限/模型/工具策略 | `agent-collaboration-tools.ts:688-759,1089-1093` |
| 定时任务 | 已有调度/超时/复用/暂停实现 | 统一经新服务；用量含 contextWindow；补日切、阈值、失败与重启验收；修正来源标记 | `automation-scheduler.ts:106-221`、`agent-session-usage.ts:45-103` |
| CLI 会话内 cron | 未见应用投影 | session_crons 仅在 shared 类型；需与桌面定时任务区分来源并接状态 | `packages/shared/src/types/agent.ts:476,553` |
| 任务看板 | 部分 | “在对话中打开”点击目前是空函数，需接绑定会话导航；现有管理操作逐项保留 | `renderer/components/taskboard/TaskContextMenu.tsx:378-383` |
| 用量 | 已有 JSONL 聚合链路 | 接 result/modelUsage/cache/contextWindow，流式与终态去重，考虑 Auto 和子代理 | `user-usage-service.ts:58-118`、`user-usage-aggregator.ts:160-257` |
| 附件 | 已有受控路径机制 | 当前 Agent 主要传本地路径与授权；原生图片内容块另外适配，测 fork/queue/reload 可读性 | `AgentView.tsx`、`agent-orchestrator.ts`、`attachment-service.ts` |
| worktree/分支/Git/Diff | 已有应用链路 | cwd 作为强约束交给服务；CLI 不二次创建；所有面板使用相同目录 | `main/ipc.ts:1254-1315,2376-2412`、`agent-session-worktree.ts` |
| 终端 | 已有 PTY 链路 | Main 保留；面板关闭只隐藏，单终端 tab 关闭会销毁是不同操作，不能混同 | `RightSidePanel.tsx:139-160`、`integrated-terminal-manager.ts` |
| 右侧面板 | 有会话切换收起、独立内容与计划/任务堆叠 | 保留状态和布局，接真实内容；视觉一致性仍需运行截图验收 | `agent-atoms.ts:347-356,1406-1423` |
| 侧栏收起/搜索/更多 | 有源码 handler；更多为右侧 Dropdown | 真实点击与参考图一致性待运行核验；不把 Dropdown 或终端 tab 关闭本身误判为空实现 | `AppShell.tsx:205-209,418-429`、`SidebarMoreMenu.tsx:12-32` |
| 主题/语言 | 主题有设置/DOM链路；语言仍有硬编码缺口 | 执行面板等仍有直接写入的中英文和 Pi 文案；补全翻译及新服务错误映射，视觉另行验收 | settings/atoms/i18n/ThemeInitializer、`RuntimeExecutionPanel.tsx:92-97` |
| 8 项设置偏好 | 只找到类型、atom、UI 保存，未见行为消费 | 见下表，分别接内核、系统行为或布局 | `settings-preferences.ts`、`settings/modal/ClaudeCodePage.tsx` |
| 浏览器/语音/快捷窗口 | Electron 实现须保留 | CLI/应用工具通过已有或提取的 Main host 能力调用，服务不导入 Electron | `main/lib/browser/*`、`voice-dictation-window.ts`、`quick-task-window.ts` |
| 飞书/钉钉/微信等入口 | 已收敛到 headless 执行 | 复用入口→Service，验证 stop/权限/附件/任务回包，不为每种入口重接 CLI | `bridge-command-handler.ts:670-749`、`feishu-bridge.ts:1743-1782` |
| 普通 Chat | 独立功能域，不能随删除 Pi 一起删除 | 保留 provider/消息链路，核对共用渠道与设置；不强制变成 Agent 会话 | `main/lib/chat-service.ts`、`renderer/components/chat/*` |

八项未见消费链的设置：

| 字段 | 应接入的位置 |
| --- | --- |
| transcriptWidth | 消息区域布局与宽度选择 |
| responseCompletionNotification | 实际完成通知策略 |
| dynamicWorkflowsEnabled | 明确定义的工作流能力和运行入口 |
| drawAttentionOnNotifications | Dock/系统注意提示 |
| keepAwakeOnBattery | 系统保持唤醒与电源状态策略 |
| outputStyle | CLI 对应设置/提示配置，而非仅保存 UI 值 |
| localSandboxEnabled | CLI 实际 sandbox 可用性与启用配置 |
| strictSandboxMode | CLI 实际隔离失败策略与确认状态 |

定位：`apps/electron/src/types/settings.ts:235-255`、`renderer/atoms/settings-preferences.ts:18-72`、`settings/modal/GeneralPage.tsx:212`、`ClaudeCodePage.tsx:235-363`。本轮检索范围内这些键只出现在定义、偏好保存与设置 UI；新增消费链后必须验证设置确实改变行为。

## 8. 实施顺序与完成门槛

建议新增或替换的具体模块（名称为方案，不表示文件已存在）：

| 位置 | 模块 | 工作内容 |
| --- | --- | --- |
| desktop/apps/local-service/src | bootstrap/server | loopback HTTP/WS、启动握手、版本、健康、退出 |
| 同上 runtime/ | cli-process-manager、stdio-transport | 一会话一进程、NDJSON、背压、stderr、进程树回收 |
| 同上 runtime/ | control-router、session-state、event-replay | 请求关联、有效模式、任务/会话状态、序号与重连 |
| 同上 runtime/ | native-session-service、task-output-service、capability-catalog | resume/fork/rewind/compact、任务日志、命令/模式/模型能力 |
| desktop/packages/desktop-protocol | contracts/schemas/fixtures | Main↔Service 的唯一协议定义与兼容测试；不导入 CLI UI/全局状态 |
| desktop/apps/electron/src/main/lib | local-service-supervisor、local-service-client | 启停服务、恢复连接、转发事件、系统能力与凭据边界 |
| 同上 runtime/ | local-service-runtime-adapter | 实现现有 AgentProviderAdapter 并补真实扩展能力；替换 Pi 委托 |
| CLI 现有 src/ | headless/control/permissions/settings | Auto gate、分类器事件、任务日志协议、effort 清空、动态压缩等缺口 |

CLI 现有协议可作为服务到 CLI 的真源；桌面应用协议与它不必字段完全相同，但只允许一个有测试的映射层。旧 CCB 工具函数按实际协议重用，不能让新 CLI 等待未实现的旧消息。

1. **冻结迁移清单**：记录两仓版本和当前源码工作树，校验未跟踪文件归属，准备迁移分支与可核对 manifest。保留原桌面目录作为迁移期间的恢复来源。
2. **同仓可构建**：桌面整体导入 desktop/，合并 workspace/忽略规则/CI，CLI 和桌面各自构建与测试独立通过。此时尚不宣称功能已接入。
3. **本地服务基础**：进程监管、协议、健康、事件序号、认证、快照、数据根、主进程 facade；CLI 与 service 版本锁定。
4. **完整执行能力**：消息/工具、六模式、审批/询问/计划、任务输出/停止、子代理、队列、模型/effort/压缩；补 CLI 缺口。
5. **应用功能贯通**：会话操作、Skills/命令、MCP、worktree、终端/文件/Diff、用量、协作、自动任务、看板、Chat 与现有外部入口。
6. **数据与正式包**：旧 Pi 历史只读保留并显式迁移上下文，移除 Pi 可执行依赖和入口，完成品牌、数据兼容与更新源调整；通过完整安装包验收。

完整验收须覆盖：六模式×读/写/Bash/MCP/询问/计划；Auto 不可用与动态重入；正文与工具增量去重；result 后后台继续；两个任务只停其中一个；审批时页面重载；会话切换不串状态；fork 源会话不变；rewind 文件与历史一致；worktree cwd 一致；queue 中断竞态；每类模型协议与凭据更新；自动任务日切与上下文阈值；无开发环境安装包启动。

扫描只能证明源码与接线情况。本轮未执行构建、自动化或真实 UI 操作，不能将下列清单解释为功能验收通过。

## 9. 已有测试与新增验收

仅确认测试文件和断言存在，本轮未运行任何测试。

| 域 | 已有可复用覆盖 | 本次必须增加 |
| --- | --- | --- |
| Runtime/打包 | Pi-only route/registry、packaged-runtime guard | 独立服务启动、CLI spawn/握手/崩溃、真实能力、安装包内核启动；更新 Pi-only 预期 |
| 协议 | 旧 CCB schema、partial/normalization/compact/turn 工具测试 | fake CLI 的 NDJSON 半包/UTF-8/大输出/背压、请求关联、乱序/去重、stderr 分离 |
| 消息/会话 | JSONL 去重、分叉投影、worktree 隔离 fixture | Service→CLI 原生 resume/fork/rewind/compact，与应用历史一致性 |
| 审批/计划/任务 | pending/cancel/abort、任务快照和 unsupported 行为 | 六模式控制往返、Auto gate、问题答案/计划反馈、result 后任务继续、日志游标与单停 |
| 模型/用量 | 渠道映射、纯 usage 聚合 | 每 apiMode 的真实请求、动态配置确认、上下文/缓存统计、自动任务阈值联动 |
| 自动任务/协作 | manager CRUD、headless 队列、Agent 注册 | 调度日切/失败/重启；delegate→blocked→answer→complete；原生子代理与应用 child 隔离 |
| Skills/MCP/附件 | Skill 激活、builtin MCP host、附件路径检查 | CLI catalog与Hooks、跨进程 MCP调用/释放、图片与受控路径、fork 后附件 |
| 桌面操作 | 部分组件和 atoms BDD | 真鼠标侧栏恢复、分支/worktree、模式切换、主题语言、8项设置真实生效、看板会话导航 |

至少建立完整离线 E2E：Electron 应用 fixture → Local Service → fake CLI → 流式工具/审批/result/后台事件 → JSONL 与 Renderer 事件。随后在隔离 fixture 项目验证真实 CLI；写入/回退测试仅作用于该 fixture，不操作正在使用的业务项目。

## 10. 源码与参考定位

- 当前桌面 `apps/electron/package.json:18-28,142-157`：构建、React/Vite/TypeScript。
- 当前桌面 `packages/ui/package.json:15-23`：React peer 版本。
- 当前桌面 `apps/electron/scripts/build-cli.ts:34-42`：辅助 CLI 路径。
- 当前桌面 `apps/electron/electron-builder.yml:19-105`、`scripts/packaged-runtime-guard.ts:21-37`：Pi 产物与资源检查。
- 当前桌面 `apps/electron/src/main/lib/config-paths.ts:19-75`：真实数据目录与 Electron 环境差异。
- 当前桌面 `apps/electron/src/main/lib/channel-manager.ts:10`、`agent-service.ts:15`、`automation-scheduler.ts:17`：Electron 依赖边界。
- CLI `package.json:32-42,187-205`、`tsconfig.json:37-43`、`bunfig.toml:1-4`、`build.ts:6-24,86-120`：workspace、类型/测试作用域和产物。
- [cc-haha 同仓 desktop 目录](https://github.com/NanmiCoder/cc-haha/tree/main/desktop)。
- [cc-haha ConversationService](https://github.com/NanmiCoder/cc-haha/blob/f2bfaab50f3be908f548245a74fdaa3ca2c71a95/src/server/services/conversationService.ts)：每会话 CLI 进程和 SDK WebSocket。
- [cc-haha sidecar 入口](https://github.com/NanmiCoder/cc-haha/blob/f2bfaab50f3be908f548245a74fdaa3ca2c71a95/desktop/sidecars/claude-sidecar.ts)：同一个产物按 server/cli 模式启动不同进程，不等于把所有会话放在一个进程。

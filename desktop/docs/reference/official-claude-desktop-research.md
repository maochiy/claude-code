# 官方 Claude Code 桌面端调研笔记

> 调研日期：2026-09-16。目的：为 Proma 桌面端复刻提供 UI / 协议参考。
> 本文只记录结论与获取方法，不复制官方代码。

## 1. 官方桌面端 UI 代码能否获取？

**结论：Code 标签页的 UI 不在本地 app 包内，运行时从 claude.ai 远程加载，本地拿不到源码。**

验证过程：

```bash
# 解包官方应用（117MB），全文搜索特征字符串 "Ultracode"（Effort 弹层最高档文案）
cd /tmp && npx asar extract /Applications/Claude.app/Contents/Resources/app.asar .
grep -rl "Ultracode" .   # 无结果 → Code UI 确实不在包内
```

asar 里有什么（仍有参考价值）：

| 路径 | 内容 |
|------|------|
| `.vite/build/mainView.js`（136KB） | 主窗口主进程代码：窗口管理、IPC 注册、会话生命周期，可读性尚可 |
| `.vite/build/index.chunk-*.js` | 主进程功能 chunk（文件索引、PTY、MCP host 等 worker） |
| `.vite/renderer/main_window/` | 主窗口壳（MainWindowPage 仅 8KB，组件来自 `globalThis["claude.internal.ui"]` 注入） |
| `node_modules/@ant/claude-native` | macOS 原生绑定 |

提取命令：

```bash
npx asar extract-file /Applications/Claude.app/Contents/Resources/app.asar \
  .vite/build/mainView.js mainView.js
```

已解到仓库外参考目录：`/Volumes/code/code/agent/_reference/claude-app/`（mainView.js、main-CHHeeRxf.js、MainWindowPage-*.js）。

## 1.1 外壳还原工程（用户此前还原）

`/Volumes/code/codes.zip` 解到 `/Volumes/code/code/agent/_reference/codes-restored/codes/`。
这是官方桌面端 **Electron 外壳的 TypeScript 还原**（从 asar 反混淆回源码）：

- `src/main/` — 窗口管理（window-manager、quick-entry、tray）、服务（auth、mcp-manager、auto-updater、session-security、protocols）、deployment/features/settings 等
- `src/preload/` — 各窗口的 contextBridge（mainView、mainWindow、coworkArtifact…）
- `src/shared/ipc-channels.ts` — 官方 IPC 通道清单
- `src/workers/` — transcript 搜索、shell 环境探测 worker

**用途**：做主进程架构（会话生命周期、IPC 分组、MCP 管理）时直接对照。
Code 标签页 UI 仍是远程加载，此还原不含会话界面 React 代码。

## 2. 模型交互逻辑在哪里？

**完整可得** —— 本地反编译内核项目 `/Volumes/code/code/agent/claude-code`（Bun + Ink CLI）：

- Effort 面板：`src/components/EffortPanel/`（含 ultracode 视觉占位逻辑）
- 档位定义：`src/utils/effort.ts`（low/medium/high/xhigh/max，按模型能力过滤）
- Skills：`src/skills/bundled/`
- 桌面运行时产物：`dist-desktop/`（entry.js、session-worker.js、protocol.schema.json）——即 Proma `ccb-runtime` 对接的内核

**会话交互的真实记录**：`~/.claude/projects/<工作目录转义>/<sessionId>.jsonl`，每行一条消息：

```jsonc
// 队列操作
{"type":"queue-operation","operation":"enqueue","timestamp":"...","sessionId":"...","content":"继续呢"}
// 用户消息（注意 permissionMode / entrypoint / gitBranch 字段）
{"parentUuid":null,"type":"user","message":{"role":"user","content":"..."},
 "uuid":"...","permissionMode":"acceptEdits","origin":{"kind":"human"},
 "entrypoint":"claude-desktop-3p","version":"2.1.260","gitBranch":"ccx-dektop", ...}
```

官方桌面端的默认审批模式即 `acceptEdits`（界面显示 "Accept edits"）。

## 3. 从官方 UI 截图确认的档位/文案事实

- **Effort 滑杆**：5~6 个停靠点，按模型能力取子集 + 末尾 ultracode 视觉占位。
  显示名：Low / Medium / High / **Extra（= xhigh）** / Max / **Ultracode**。
  标题随档位变化（"Effort High"），Ultracode 档滑轨为紫色渐变填充。
- **审批模式菜单** 4 档：Manual（Always ask before making changes）/
  Accept edits（Automatically accept all file edits）/ Plan（Create a plan before
  making changes）/ Bypass permissions（Accepts all permissions），行尾数字 1-4。
- **上下文弹层**：彩色堆叠条 + 图例（Messages / System tools / MCP tools /
  Memory files / System prompt / Skills / Free space）。2026-09-17 源码复核纠正：
  当前自有 CLI 已有 `get_context_usage` 结构化 control，可以提供分类与明细，
  不限于 Used/Free。部分分类是估算，逐 System prompt section/内置工具明细仍有输出限制。
  详见 [上下文专项审计](./desktop-context-usage-presentation-audit-2026-09-17.md)。
- **会话 ⋯ 菜单**：Files / Open in / Rename R / Transcript view / Output style /
  Fork F / Keep computer awake for this session / Archive A / Delete D。
- **Git 坞**：有未推送提交时主按钮为 "Create PR ⌄"，否则 "Commit changes"；
  右侧 X 关闭；悬停统计出 "View diff" 提示。

## 4. SSE 抓包建议

桌面端 ↔ 内核的 SSE 流可由内核侧落盘：在 `claude-code` 项目的
`dist-desktop/entry.js` 包一层 tee，或在本项目 `ccb-runtime` 的进程桥接处把
每条 protocol envelope 追加到 `~/.proma/debug/sse-<sessionId>.jsonl`，
即可逐帧研究官方协议（`dist-desktop/protocol.schema.json` 是其 schema）。

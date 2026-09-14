# Browser Use — 自研浏览器后台控制（feature `BROWSER_USE`）

ccx 自研的浏览器控制工具链路：会话在**后台**驱动用户已打开的 Chrome，不启动
独立浏览器、不开 CDP 端口、不抢焦点。一个会话对应一个以会话名命名的 Chrome
标签组，任务运行期间用户可以继续正常使用浏览器。

## 与官方 Claude in Chrome 的关系

- 官方链路（`packages/@ant/claude-for-chrome-mcp/`、`src/utils/claudeInChrome/`）
  **保留不动**，默认休眠（`--chrome` 启用）。
- 推荐日常使用 `Browser*` 工具：标签组隔离、后台执行、与 ccx 会话/子代理
  生命周期绑定。
- 两者可并存；扩展 ID 与 native host 名不同，互不干扰。

## 架构

```
ccx 会话 (Browser* 工具)
   │  unix socket client (~/.claude/browser-use/<pid>.sock)
   ▼
Native Host 进程（Chrome 通过 native messaging 拉起，stdio）
   │  多 client 按请求 ID 路由
   ▼
Chrome 扩展 (MV3 service worker, CCB Browser Use)
   │  chrome.debugger (CDP) / chrome.scripting 降级
   ▼
会话标签组（后台标签，active:false）
```

细节见 `packages/browser-use/README.md`（帧协议 `ccb-browser/1`、socket 路由、
`host-created` / `user-owned` 归属模型、错误码排查表）。

## 工具列表

13 个工具，**不进 `CORE_TOOLS`**，走 SearchExtraTools 延迟发现：

| 工具 | 只读 | 说明 |
|------|------|------|
| `BrowserAttach` | 否 | 复用/新建会话后台标签并绑定任务；显式 `tabId` 可附加用户标签 |
| `BrowserNavigate` | 否 | 后台标签打开 URL（无任务时自动 attach，`taskId` 默认 `main`） |
| `BrowserGetState` | 是 | URL/标题/正文/带 ref 的可交互元素 |
| `BrowserClick` | 否 | 按 ref 真实鼠标事件（CDP Input.\*） |
| `BrowserType` | 否 | 按 ref 输入，回读校验，失败回退脚本写入 |
| `BrowserPress` | 否 | 受限按键表 |
| `BrowserScroll` | 否 | direction up/down + amount |
| `BrowserScreenshot` | 是 | 后台 CDP 截图 → image block（超 8MB 报 `MESSAGE_TOO_LARGE`） |
| `BrowserHistory` | 否 | `action: back\|forward\|reload` |
| `BrowserClose` | 否 | host-created 关标签；user-owned 只 detach |
| `BrowserListTasks` | 是 | 当前浏览器会话的任务表 |
| `BrowserListTabs` | 是 | 扩展可见标签摘要 |
| `BrowserListSessions` | 是 | 会话分组状态（诊断） |

## 会话归属

- `browserSessionId = context.agentId ?? getSessionId()`——子代理各拿各的标签组，
  多会话并行互不串扰。
- 标签组名（sessionTitle）：首条用户消息截 60 字符，缺省回退
  `会话 <sessionId 前 8 位>`。不读 sessionStorage 的 /rename 标题（会把
  commands.js 循环拖进 builtin-tools）。

## 权限

- 非只读工具 `checkPermissions` 返回 `ask`（如「Browser: 在后台标签打开 <url>」）。
- 只读工具（GetState/Screenshot/ListTasks/ListTabs/ListSessions）allow 且
  concurrency-safe。
- 涉及登录、支付、发送等敏感操作时，模型会在执行前向用户确认（workflow prompt
  内置该约束）。

## 快速开始

1. 加载扩展：`chrome://extensions` 开发者模式 → 加载
   `packages/browser-use/extension/dist`（先 `node build.mjs`；发布产物在
   `dist/extension/`），校验扩展 ID `gbdgipjmibglhghpmhfflcmiogahjagd`。
2. 首次调用 `BrowserAttach` / `BrowserNavigate` 时 CLI 自动幂等安装 native host
   wrapper 与各浏览器 manifest（macOS/Linux；Windows 二期）。
3. 直接让模型执行：attach → navigate → get_state → click/type → screenshot → close。

## 范围与二期

- 一期仅 macOS/Linux；Windows native messaging manifest 安装二期
  （可参考官方 `registerWindowsNativeHosts` 先例）。
- 不发布 Chrome Web Store；不做 console/network 读取扩展工具（官方那组有，
  二期按需补）。

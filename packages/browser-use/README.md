# @claude-code-best/browser-use

ccx 自研浏览器控制链路：让 Claude Code 会话在**后台**驱动用户已打开的 Chrome ——
不启动独立浏览器、不开 CDP 端口、不抢焦点。一个会话对应一个以会话名命名的
Chrome 标签组，用户可以在任务运行期间继续正常使用浏览器。

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

- **Native host 拥有 socket**：每个 host 进程监听 `~/.claude/browser-use/<pid>.sock`
  （win32 用命名管道 `\\.\pipe\ccb-browser-use`），所有 ccx 会话作为 client 连入，
  响应按「连接前缀 + 请求 ID」路由回来源连接，支持多会话并发。
- **帧协议 `ccb-browser/1`**：4 字节小端长度前缀 + JSON 信封（`src/protocol.ts`）。
- **扩展归属模型**：`host-created`（插件创建的后台标签，close 时关闭）与
  `user-owned`（用户自己的标签，close 只 detach 调试器）。

## 目录

| 路径 | 说明 |
|------|------|
| `src/protocol.ts` | 帧编解码 + BrowserError（code/retryable） |
| `src/paths.ts` | socket 目录/路径约定 |
| `src/socket-client.ts` | 会话侧 client（id 匹配、30s 超时、EXTENSION_OFFLINE 可重试） |
| `src/host-bridge.ts` | `--browser-native-host` 入口（`runBrowserNativeHost()`） |
| `src/task-registry.ts` | (sessionId, taskId) → 标签任务表 |
| `src/backend.ts` | attach/navigate/getState/action/close 等扩展后端 |
| `extension/` | Chrome 扩展（load unpacked） |

## 安装

### 1. 加载扩展

1. 打开 `chrome://extensions`，开启「开发者模式」
2. 「加载已解压的扩展程序」选择 `packages/browser-use/extension/dist`
   （先在 `extension/` 下执行 `node build.mjs` 生成；发布产物在仓库 `dist/extension/`）
3. 校验扩展 ID 为 `gbdgipjmibglhghpmhfflcmiogahjagd`（由 manifest `key` 固定；
   native host 白名单按此 ID 放行）

### 2. Native host 安装

无需手动操作：首次调用 `BrowserAttach` / `BrowserNavigate` 时，CLI 会幂等安装
- wrapper 脚本 `~/.claude/browser-use/browser-native-host`
- 各浏览器 `NativeMessagingHosts/com.claudecodebest.browser.json`
  （host 名只能用 [a-z0-9._]，不能带连字符——Chrome 会拒绝）
  （macOS/Linux；Windows 二期）

也可以手动触发：`claude --browser-native-host` 直接以 host 模式运行（一般由
Chrome 调起，不需要手动跑）。

## 故障排查

按阶段报告错误码与非敏感标识：

| 阶段 | 错误码 | 处理 |
|------|--------|------|
| 连接 | `EXTENSION_OFFLINE` | Chrome 未启动 / 扩展未启用 / native host 未安装；确认后重试（可重试） |
| 路由 | `TARGET_NOT_AUTHORIZED` | 标签不属于当前会话；重新 attach |
| 页面 | `DEBUGGER_UNAVAILABLE` | 该标签打开了 DevTools（互斥）；关闭 DevTools 后重试 |
| 页面 | `STALE_REF` | 页面已变化；重新 `BrowserGetState` 获取新 ref |
| 页面 | `UNSUPPORTED_PAGE` | `chrome://`、Web Store 等页面无法注入 |
| 输入 | `REQUEST_TIMEOUT` | 扩展 30s 未响应；重试 |

「正在调试此浏览器」提示条是 `chrome.debugger` 的正常表现；标签关闭自动清理。

## 测试

```bash
bun test packages/browser-use
```

覆盖：协议帧编解码/超限/坏 JSON、任务表会话隔离、backend 语义（注入内存
client）、host-bridge 多 client 请求 ID 路由（真实 unix socket）。

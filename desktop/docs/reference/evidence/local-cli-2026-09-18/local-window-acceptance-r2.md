# 本地窗口验收 R2（进行中）

用户已明确暂停提交、推送和 GitHub Actions，先做本地验收。当前未提交、未推送。

## 版本与环境

- Desktop 0.0.8 / CLI 2.8.22 / Bun 1.3.14。
- 从独立源码目录完成八包 typecheck、renderer、Main/preload、CLI、Service 和资源构建。
- 新目录包输出 `apps/electron/out/local-cli-20260918-r2`，不覆盖正在运行的 0.0.7 窗口。
- 验收使用新的临时 HOME、桌面数据根与隔离 Git 项目；模型协议固定夹具仅访问 loopback，不读取真实用户凭据。

## 当前结果

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 首开 Local 无账号门禁 | 实际通过：隔离包未登录账号也能进入引导并打开桌面主界面 | 实际隔离窗口；专项 BDD 19/19、33 断言 |
| 首次引导及教程中英切换 | 实际通过：英文切换后侧栏、Home 输入区、权限项与教程同步更新 | [r2-light-english.png](./r2-light-english.png)；OnboardingView.test.tsx 2/2、20 断言 |
| 独立源码桌面 typecheck 与 build | 通过 | `/tmp/xcodes-clean-r2-types.log`、`/tmp/xcodes-clean-r2-build.log` |
| CLI 全量回归 | 471 文件中 462 通过、9 冷加载/超时失败，不能记全绿 | `/tmp/xcodes-cli-test-all-confirm.log`；失败文件低并发复测中 |
| 实际鼠标操作 | 已完成下列 R2 范围；执行与模型场景仍待 R3 复测 | 下方“实际窗口验收” |
| 真实服务商模型 | 未验证 | loopback 模拟 Provider 不等于真实服务商验收 |

## 实际窗口验收

以下项目均在隔离 HOME、隔离桌面数据根和隔离 Git 项目中完成；没有读取真实账号配置，也没有向真实服务商发送请求。

| 场景 | R2 结果 | 边界与证据 |
| --- | --- | --- |
| 侧栏收起与恢复 | 通过 | 收起左侧面板后，再次点击侧栏按钮可正常展开 |
| “更多”入口 | 通过 | 只显示 Task board 与 Scheduled tasks |
| 用户菜单 | 通过 | 显示“模型配置”，不再显示“查看更多” |
| 设置导航精简 | 通过 | 隐私、协作、导入导出、插件入口均已移除 |
| 语言切换 | 通过 | 切换英文后，侧栏、Home 输入区、权限项与教程即时更新；见 [r2-light-english.png](./r2-light-english.png) |
| 主题切换 | 通过 | Dark 切换为 Light 后持久化并生效。验收工具必须先将窗口 Raise 到前台再读取画面 |
| 新会话 Branch | 通过选择交互 | Branch 菜单可打开并选择 `master`；未发送消息，未验证创建后运行路径 |
| 新会话 Worktree | 通过选择交互 | Worktree 可在 `true` / `false` 间勾选；未发送消息，未创建实际 worktree |
| 切换会话 | 通过 | 切换会话时已打开的右侧面板自动收起 |
| Terminal cwd | 通过 | 真实 PTY 位于隔离 fixture 工作目录 |
| Terminal 隐藏后恢复 | 通过 | 首个终端设置 `XCODES_ACCEPTANCE_MARKER=terminal-retained`，点击 X 隐藏后重开输出 `REOPEN:terminal-retained`，说明 PTY 未被销毁；见 [r2-terminal-retained.png](./r2-terminal-retained.png) |
| 多终端隔离 | 通过 | 第二个独立终端输出 `SECOND:unset`，没有继承首个 PTY 的 shell 变量；见 [r2-terminal-retained.png](./r2-terminal-retained.png) |

## 已纠正的验收误报

`r2-theme-live-failure.png` 已废弃，不再作为缺陷证据。该截图是在窗口未置前时读取到的旧合成画面；设置文件和渲染状态实际上已经完成主题切换与关闭弹窗，窗口 Raise 后立即显示正确 Light 主界面。后续窗口验收统一先 Raise，再点击并读取最终状态。

## R3 待复测

R2 实际窗口验收发现以下问题，相关实现和测试已由其他工作分支修复，但本报告尚未记录 GUI 通过，必须等待 R3 新包实际复测：

- 首次发送前的预热控制冲突。
- Auto 模式被过滤。
- 英文错误卡片仍显示中文。

正文与工具调用、AskUser、Plan 审批、后台任务单停、文件与 Diff 等执行场景也仍需在 R3 隔离窗口中验证。当前 Provider 仅为 loopback fixture，以上结果不能外推为真实服务商兼容性通过。

用户已暂停提交、推送与 GitHub Actions；本地验收完成前不恢复这些操作。

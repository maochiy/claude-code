# 本地窗口验收 R3（进行中）

用户要求先本地验证，未提交、未推送，未触发 GitHub Actions。R3 不覆盖先前 R2 目录包。

## 当前版本

- Desktop 0.0.8、CLI 2.8.22、Bun 1.3.14。
- 包目录：`claude-code/desktop/apps/electron/out/local-cli-20260918-r3/mac-arm64/Xcodes.app`。
- 本轮重建 Main 与 Renderer，打包后 643 个 CLI JS 资源校验通过。
- 加入首发送与预热控制竞争修复、Auto 可用性显示、英文错误卡静态文案修复。对应专项测试通过，GUI 复测未完成。

## 目录包实测

`r3-packaged-runtime-smoke.json` 记录 5 项通过：资源 hash、包内 Bun 版本、执行 CLI help、会话辅助 CLI help、本地服务启动与受管 CLI 退出。

- Local Service 协议 1 / 版本 0.1.1。
- 服务退出码 0；退出后 Service 与其 CLI PID 均不存在。
- 该检查不发送模型请求，不代表正文、权限、计划或后台任务已通过。

## GUI 阻塞

独立测试副本使用专用 bundle ID、临时 HOME/数据根和 loopback Provider。启动后 CUA 多次读取窗口超时，macOS 进程采样明确显示主线程停在 `SecItemAdd → makeLoginAuthUI` 系统钥匙串路径（`/tmp/xcodes-r3-main-sample.txt`）。电脑操作工具拒绝访问 SecurityAgent，已请求用户在本机处理提示，未操作或绕过系统凭据保护。

GUI 首发、Auto 菜单、工具、AskUser、Plan、后台任务单停、worktree 实际运行均仍待完成；先前已验证的侧栏/主题/语言/终端结果见 R2 记录。

## 后续独立测试

包内真实 CLI + loopback 模型交互、桌面逐文件回归与 CLI 失败文件低并发复测正在执行。结果未产生前不标记通过。真实服务商调用、macOS x64、Windows x64 仍未验证。

## CLI 失败文件复测完成

首轮 471 文件中 462 通过、9 失败；本轮仅对这 9 个文件采用单进程、180 秒上限复测，9/9 通过（`cli-failed-files-rerun.json`）。这是两次运行的合并覆盖，不是一次全量全绿。runner 默认上限已调为 180 秒，且完成超时失败路径检查。Windows 正常退出父进程后若产生脱离的后代，仍需 Job Object 完整收口与 Windows 原生验证，不标记已完成。

## 包内执行与文件工具

真实包内 Bun 启动包内 Service，再启动包内 CLI，模型为 loopback 固定夹具，未调用真实服务商：

- 正文：1 次发送、1 次 Provider 请求、3 个增量，首段 273ms，终态 595ms，事件序号 12 < 21，无整轮缓冲。
- Read：真实隔离文件只调用 1 次，工具结果含目标 marker，2 次 Provider 请求包含工具结果后续调用；终态 777ms，无待审批挂起。
- 退出：Service exit 0，两个受管 CLI PID 均已结束。
- 证据：`r3-package-loopback-initial.json`。这部分不含 Renderer 点击/滚动/展示验收；Permission、AskUser、Plan 包内专项正在补跑。

## 包内交互验收完成

第二轮扩展验收实际使用同一 R3 包内运行时，证据 `r3-package-interactions.json`：

- Permission default：拒绝目标文件不存在；允许后目标内容正确，结算各 1 次，重复结算均被拒绝。
- AskUser：2 个结构化问题回答回模型；取消原因也回模型，重复结算均被拒绝。
- Plan：反馈后重提计划，两次批准前检查目标文件均不存在；批准切到 acceptEdits 后 Write 恰好 1 次，4 轮 Provider 调用，内容正确。
- 本轮正文首段 223ms、终态 541ms；7 个受管 CLI 在 Service exit 0 后均不存在。
- 测试命令为 `bun test /tmp/xcodes-r3-package-loopback.test.ts`。所有模型请求仍为 loopback fixture，不是服务商实测；不包含 Electron Main 配置和 Renderer 点击链路。

## 包内后台任务单停

证据 `r3-package-background.json`：前台 96ms 完成时两个任务均 running；A 的 stop 27ms 结算后 killed，未写完成 marker；B 在 A 停止后仍 running，输出游标 0→13→27→41 对应 START/MIDDLE/FINISH，最终 completed 并写 marker。Service exit 0，CLI PID 不再存在。此项不证明 Renderer 蓝色标签、双面板或鼠标停止按钮。所有受管进程均在 OS spawn 时注入临时 HOME/XDG/配置目录，不继承真实模型凭据。

## 验收环境发现的问题

- GUI fixture 用 dev Electron 加密渠道，而打包 app 使用不同 safeStorage 身份。已确认 helper 缺陷；R3 专用测试实例已停止，不继续让用户处理该实例的钥匙串提示。将修为打包验收时不由 dev seed 创建加密渠道，目标 app 通过正常 UI 创建测试渠道；不新增产品后门或绕过钥匙串。
- 桌面全量第二轮在 220/310 停止：进程启动后 preload 才修改 HOME，无法保证 node:os homedir 已隔离，搜索测试读到了本机登录态并发出搜索服务请求，返回 401。已立即中止并告知用户，该轮作废；不得用其中通过数作为最终全量结论。后续必须在 OS spawn 前隔离 HOME/USERPROFILE/XDG，并通过纯假 sentinel 验证，不读取真实用户配置来验证隔离。

意外请求复核（只读测试源码及测试日志，未再读取真实配置）：固定 `searchWeb({ query: 'test' })` 1 次，返回 HTTP 401；该路径未调用模型。测试源码不包含业务文件写入，日志未观察到配置写入证据，但没有以日志缺失证明 OS 层绝对零写入。后续测试增加非 loopback fetch 阻断，并继续检查配置从进程启动时就已隔离。

## GUI 实际操作（后续 R3 独立窗口）

已换成临时数据根 XwjSls，在目标 app 正常 UI 创建 loopback fake 渠道，未导入 dev 加密凭据。此前钥匙串 helper 阻塞已解除，不需要用户处理旧测试实例的提示。

实际鼠标/键盘验证：
- 六模式均可见；Auto 不可用时显示禁用原因（`r3-auto-visible.png`）。
- Files 单独打开；点击 fixture-note.txt 展示正文，编辑并保存追加测试行成功。Git 真实 numstat 为 1 增 0 删。
- Git 增量数字点击打开独立 Diff；文件条目可展开。
- Git 动作下拉只变更选择，没有发送；无 remote 的隔离项目 Create PR 主按钮禁用。
- `/comp` 筛选显示 CLI 原生命令与 Skills；点击 `/compact` 仅填充 `/compact ` 草稿，未发送。发现同名 Skill 同时来自 CLI 目录和 workspace 列表，重复显示，正在修复。
- 上下文按钮可打开用量和自动压缩控件；尚未完成压缩执行与统计一致性验收。

实际发现的失败（不能以底层通过替代 GUI）：
1. 首次发送仍在准备阶段失败，Provider 请求数为 0（`r3-first-send-still-fails.png`）。Service journal 显示两个 get_tasks 只读预热未结算时配置准备被拒绝；修复中。
2. Retry 可显示流式正文，但末尾误报空回复，并重复用户消息（`r3-reply-false-empty-error.png`）。Main 对 partial 正文计数及 Retry 边界需修复，等待新包复验。
3. Diff 显示虚假删除及 No newline at end of file（`r3-diff-whitespace-bug.png`）。git show 结果被 trim。已改为保留正文空白，真实 Git 回归 3 pass / 6 assertions；待新包 GUI 复验。
4. 当前特殊 bundle 测试实例 safeStorage 不可用，已有产品逻辑回退明文，仅保存 fake key；不能据此声明凭据加密验收通过，正在只读核查。

本报告仍为进行中。未提交/推送，不把 R3 失败窗口作为可交付的最终验证版本。

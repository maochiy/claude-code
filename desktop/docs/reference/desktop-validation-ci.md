# Desktop 原生目录包验证 CI

## 目的

根仓 `.github/workflows/desktop-validation.yml` 在三个独立原生宿主上验证 Desktop，不发布、不创建 Release：

- GitHub `macos-latest`：macOS arm64。
- GitHub `macos-15-intel`：macOS x64。
- GitHub `windows-latest`：Windows x64。

GitHub 官方 workflow 语法文档将 `macos-latest` / `macos-15` 列为 arm64，将 `macos-15-intel` 列为 Intel；workflow 仍会用 `process.arch` 做运行时断言，runner 标签漂移时直接失败。Action 版本复用根仓已固定的 checkout/setup-bun 提交，证据上传固定为官方 `actions/upload-artifact` v4.6.2 提交。Bun 固定为 `1.3.14`，与包内 Runtime 版本一致。

## 门槛

每个宿主按以下顺序执行：

1. 分别以根 `bun.lock` 和 `desktop/bun.lock` 执行两次 `bun install --frozen-lockfile`，不混用锁文件。
2. CLI 根工程执行 typecheck、build、bundle 完整性检查。
3. Desktop 执行 typecheck、目录包 smoke BDD 和完整 Electron build。
4. electron-builder 只生成当前宿主架构的 `--dir` 目录包，显式 `--publish never`，关闭签名自动发现。
5. `packaged-runtime-smoke.ts` 从目录包定位 `Resources`，复用生产静态完整性校验，并实际执行：
   - 包内 Bun `--version`；
   - 自有执行 CLI `--help`；
   - 会话辅助 CLI `--help`；
   - 包内 Local Service 的 ready/health RPC；
   - 由 Local Service 启动一个隔离、未发送模型请求的包内 CLI 子进程；
   - `service.shutdown` 后确认 Service PID 和受管 CLI PID 均已退出。
6. smoke 仅使用临时 HOME、`CLAUDE_CONFIG_DIR` 和 Service state，不读取用户配置，不发送模型/API 请求。

每个矩阵任务上传 JSON 证据以及 electron-builder 的有效配置/调试清单（若生成）。JSON 包含宿主/目标架构、各检查耗时、包内 Bun 版本、关键入口 SHA-256、服务协议版本和退出后 PID 状态；不记录 token、用户内容或临时配置内容。目录包本身体积大且未签名，不作为验证证据上传。

## 结果边界

本文件只定义 CI 门槛。2026-09-18 本地没有执行 workflow，也没有重新打包；macOS x64 和 Windows x64 必须等各自 GitHub runner 首次运行后才有可执行证据。smoke 覆盖 Runtime、CLI 和 Local Service 的受管进程退出，不替代签名/公证、安装器、自动更新和实际 GUI 退出验收。

参考：

- [GitHub 托管 runner 标签](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [actions/upload-artifact](https://github.com/actions/upload-artifact/tree/v4.6.2)

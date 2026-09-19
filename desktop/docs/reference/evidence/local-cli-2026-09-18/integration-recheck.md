# 集成复核记录（2026-09-18）

本记录对应重做中的源码工作树，不代表十阶段全部验收完成。测试均不向真实模型或联系人发送请求；真实 CLI 集成使用隔离目录和本地模拟 Provider。

## 已核实

| 范围 | 结果 | 证据与边界 |
| --- | --- | --- |
| CLI 全量单进程测试 | 6,123 通过、22 跳过、16 失败 | 失败集中三个文件，分别单跑通过；存在全局 mock 污染，不能记全绿 |
| CLI 逐文件隔离复测 | 471 文件中 468 通过、3 失败 | 三个其他文件缺少独立 mock 导出，已修复且对应 25 项/63 断言隔离复测通过；首次完整扫描结果仍保留 |
| 桌面逐文件复测 | 首轮 273 文件、262 通过 | 8 个 Main 文件纠正隔离 HOME 与数据根冲突后通过；3 个 UI 文件修正后通过。新增测试另列，不能将首轮当最终全量结果 |
| 桌面全部包 typecheck | 8 个包通过 | `/tmp/xcodes-desktop-final-types.log` |
| CLI typecheck / build | 通过 | `/tmp/xcodes-native-family-types.log`、`/tmp/xcodes-native-family-build.log` |
| 原生任务 controls | 3 项、192 断言通过 | `apps/local-service/test/native-task-controls.integration.ts`：双 Bash 单停、Unicode 字节游标、冻结 transcript 分页、Agent→Bash 父子关系、子代理记录、跨会话拒绝、close/resume |
| Local Service BDD | 17 项、127 断言通过 | `apps/local-service/test/local-service.test.ts`，含事件排序传递性、队列、回收与状态 |
| Adapter 恢复集成 | 7 项、38 断言通过 | `/tmp/xcodes-adapter-recovery-final.log`；fake CLI，不冒充原生完整矩阵 |
| 原生目录只读 | 1 项、19 断言通过 | `native-catalog.integration.ts`：目录启动不运行 Hooks/MCP/模型，拒绝非目录 controls |
| 原生交互/宿主边界 | 13 项、126 断言通过 | `native-interactions.integration.ts`；宿主工具限制不可被 Bypass 绕过 |
| 原生 Auto 分类器 | 3 项通过 | `native-auto-classifier.integration.ts`：允许、拒绝、不可用转人工；checking 状态与独立 classifier 用量 |
| Runtime 产物提升 | 19 项、30 断言通过 | 临时校验失败、备份失败、提升失败都保留/恢复旧产物；keyring 随包加载 |
| 安装包 smoke 边界 | 5 项、16 断言通过 | 凭据白名单、隔离 HOME、显式目录、孤儿进程清理；未据此宣称成品 Service 运行通过 |
| 任务关系存储 | 3 项、9 断言通过 | CLI `src/tasks/__tests__/sdkTaskOwnership.test.ts`；父任务退出实时状态后，子任务仍补齐双向关系 |
| 清空事务 | 最后 P0 回归 11 项通过 | 原生 clear 成功后桌面写入失败仍保留恢复日志；损坏/未来版本日志拒绝覆盖 |

## 本轮定位并修复

- 恢复时只读取原生会话的冻结分页快照，以 native UUID 幂等补回桌面投影，不重放发送或操作原生 transcript。
- Clear 在重建进程之前持久化目标原生 ID 和存档 ID，成功后的本地收尾失败由日志恢复，不能回退到旧原生会话。
- 后台任务归属单独保存到原生会话 sidecar；已完成父任务与后续子任务合并时重建关系。恢复后只允许读取该会话持有的任务。
- 宿主工具白名单在原生权限以及 hook 强制决策之前执行，非法策略闭合拒绝。
- 目录查询有独立 catalog-only 路径，不再为获取 `/` 列表启动模型执行或项目 hook。

## 尚未通过的交付门槛

1. 独立源码目录中的 CLI 与 Desktop 完整 build 已通过，外置 keyring 依赖已随包复制并可加载。当前正在生成 arm64 DMG；尚不代表安装与应用行为通过。
2. 桌面源码已受控同步并纳入暂存，独立源码目录使用两个 frozen lockfile 安装、两套 typecheck 和 build 均通过。尚未提交；后续新增修改仍须同步。
3. 固定场景截图、真实 Electron 完整交互仍未齐全。之前 UI fixture 的 listen EPERM 未通过更换工具或代理绕过。
4. 三平台 CI 工作流已写入但未执行；macOS x64 / Windows x64 运行及最终安装包验收不能由 arm64 静态检查替代。
5. README/AGENTS 仅准备审查草稿，等待此前已发出的文档修改授权。

既有功能和早期目录包证据见 `desktop-interaction-checks.md` 与 `desktop-rebuild-implementation-status.md`。不因代码已写入而标记阶段出口完成。

## 独立源码构建

源码导出位置：`/var/folders/rq/vmkb4phx4xdghf18387qj8540000gn/T/xcodes-clean-source-ixwgp292/repo`。由 Git 本地 clone 加本次工作树产品文件重建，未复制 node_modules、dist、out 或真实用户数据。根 CLI 与 desktop 分别 `bun install --frozen-lockfile` 成功；CLI postinstall 明确关闭 Chrome 配置写入。

- CLI typecheck / build / check:bundle：通过，日志 `/tmp/xcodes-clean-cli-{typecheck,build,bundle}.log`。
- Desktop typecheck：八包通过，日志 `/tmp/xcodes-clean-desktop-typecheck.log`。
- 根入口 `bun run desktop:build`：通过，日志 `/tmp/xcodes-clean-desktop-build.log`。Runtime 含 643 个 JS 文件、固定 Bun 1.3.14、CLI 2.8.21；会话 CLI --help 通过。
- CLI lint：通过且无警告，`/tmp/xcodes-native-isolated-lint.log`。桌面工程维持独立检查边界。

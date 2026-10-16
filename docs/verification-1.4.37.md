# 1.4.37 文末卡片冷启动加载验证

本地更新版，未公开发布、未安装、未自动重载。原生 PI-Desktop 冷启动端到端延迟尚未实测；浏览器测试使用模拟宿主，不承诺固定毫秒数。

## 安装与验收

在当前 Agent 任务安全结束后，通过插件页手动安装 `plugin/dist/local.diff-view-1.4.37.piplug` 并重新加载。

1. 打开已有完整修改记录的长会话，重启 PI-Desktop，再点击文末卡片。
2. 已保存且已完成、原生回复绑定明确的目标轮次应先以只读方式显示文件和差异，不等待整段历史同步。
3. 后台同步完成后，界面应自动刷新，保持文件选择和折叠状态；正常撤销/重做仍须授权、内容核验和确认。
4. 缺失、冲突、运行中或未绑定证据不走此快路径，继续原恢复和未知状态逻辑。

## 最小修改边界

- `src/main.ts`：卡片及确切历史轮次增加受清理/卸载屏障保护的只读旁路；同会话/项目合并后台刷新，恢复仍在原串行队列执行。`recordedReview` 在同步结束后记录时间，避免慢同步返回即过期。
- `src/core/review-service.ts`：临时审查缓存带永久只读标记，不修改共享工作区授权；首次读取和后续文件 hydration 均禁止产生写操作。快路径卡片查询不回写旧轮次，避免覆盖并发恢复结果。
- `src/core/jobs.ts`、`src/view/transport.ts`：确切历史读取与卡片读取不等待证据发布响应；普通写任务的顺序、后台任务数量上限和每滚动秒 6 次桥接请求限制不变。
- `src/core/contracts.ts`、`src/view/ReviewApp.tsx`：只有显式 `sync.saved` 的已保存只读结果可在同步期间展示，继续轮询；15 秒未完成仍提供重试。
- 未修改历史导入算法、文件采集、Git 实现、路径/哈希检查、容量限制或权限清单。

工作区另有 1.4.36 的“使用默认应用打开文件、移除内置文件页签专用链路”修改。本轮保留其已落盘内容，未回滚；这些删除不是冷启动修复的一部分。测试与安装包基于两项修改合并后的当前工作区。

## 证据与验证结果

| 验证 | 结果 | 证据路径 |
| --- | --- | --- |
| 历史同步故意挂起，卡片和固定轮次先返回，121 文件分页及选定差异可读取 | 通过；不调用工作区授权，临时缓存无写动作 | `tests/integration/saved-read-main.test.ts` |
| 快读重建卡片摘要但不写回旧轮次 | 通过；存储中的 `cardPreview` 仍缺省 | 同上 |
| 同步完成后正常审查可恢复写动作，旧只读缓存不能升级写权限 | 通过 | 同上 |
| 模拟同步经历 5 秒，多次冷读取合并，结束后不立即重复同步 | 通过 | 同上 |
| 读取尚未结束时清空历史 | 通过；清理等待只读任务，旧结果拒绝，缓存不复活 | 同上 |
| 缺上下文恢复、真实缺失、歧义 inbox 修复、会话隔离、导航持久化 | 原有回归通过 | `tests/integration/cold-review-main.test.ts`、`review-navigation-main.test.ts` |
| 证据上传挂起时只读请求仍可发出；普通写任务和导航名额保持约束 | 通过 | `tests/unit/transport-performance.test.ts`、`jobs.test.ts` |
| 同步中显示已保存差异，完成后保持选择、折叠和 DOM；分页、会话切换、卡片样式 | 43 项浏览器测试通过 | `tests/e2e/review-readiness.spec.ts`、`renderer.spec.ts`、`sidebar-stability.spec.ts` |

执行结果：

- 类型检查、正式生产构建、`git diff --check` 通过。
- 完整 Vitest：58 个文件，485 通过、1 个原有跳过（Windows 不适用的 POSIX FIFO 用例）。此完整运行在最后补充清理竞态用例之前。
- 补充用例后最终定向复测：6 个文件、33 项全部通过；生产源码未再变更。
- 一次限定范围的只读代码复核未发现可具体证明的本轮缺陷。
- 根 package、lock 两处、运行时 package、manifest 均为 1.4.37，无新增依赖或权限。

浏览器首次运行复用了被另一会话关闭的测试服务，出现连接拒绝；未放宽断言。重建资源并使用 `CI=1` 独占测试服务后，43 项全部通过。

## 复跑命令

在项目根目录运行；`E2E_BROWSER` 应指向本机 Chrome，`PI_SCRATCH_DIR` 为现有临时目录。

```bash
npm run typecheck
npm test -- --maxWorkers=1
npm run build
CI=1 E2E_BROWSER='C:/Program Files/Google/Chrome/Application/chrome.exe' npm run test:e2e -- tests/e2e/review-readiness.spec.ts tests/e2e/renderer.spec.ts tests/e2e/sidebar-stability.spec.ts
git diff --check
```

最终定向命令：

```bash
npm test -- tests/integration/saved-read-main.test.ts tests/integration/cold-review-main.test.ts tests/integration/reply-cards.test.ts tests/integration/review-navigation-main.test.ts tests/unit/transport-performance.test.ts tests/unit/jobs.test.ts --maxWorkers=1
```

本轮只消除已有可靠记录的前台阻塞，未实施增量 JSONL 导入或持久化消息索引；首次缺少插件证据的会话仍可能等待原恢复流程。

## 安装包校验

- PluginCheck / PluginPack 通过；仅原有 `agent.extension` / `renderer.extension` 高风险权限提示，无新增权限。
- 文件：`plugin/dist/local.diff-view-1.4.37.piplug`，2,914,760 字节，86 个文件。
- SHA-256：`63eaa0df2b82e7dcbb279ff19f764ec34c0e1632889739ffb1dc7837ad1a1c2d`。
- 全部条目为 ZIP_STORED，CRC 正常；逐文件与本轮构建目录一致，manifest/package 均为 1.4.37，未嵌入旧安装包或数据目录。
- 版本与验证元数据：`release-1.4.37.json`。

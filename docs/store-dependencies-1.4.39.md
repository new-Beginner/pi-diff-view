# 无 store 会话跟随与审查导航（1.4.39）

> 两个入口已去除宿主 store 调用，但插件整体尚未去除私有动态导入。DOM 兼容不是公开稳定 SDK。尚未安装/重载本轮产物，模拟宿主测试不等于原生客户端或市场审核验收。

## 使用与限制

- 在当前唯一会话点击文末卡片或文件，原生工作面板打开/激活 Diff view，插件桥接投递经后台校验的轮次和文件定位。
- 工作面板中已打开的审查页通过插件桥接跟随会话，不再需要宿主更新 `location` 或发出 `view:open`。
- 没有公开的窗口身份供两个进程配对。本实现仅在一个活跃 renderer 和一个活跃审查视图时投递；多个窗口、独立 Panel 与停靠 View 同时活跃时显示歧义提示，停止定位，不猜最后会话。关闭多余实例后重新检查；崩溃/失联登记 15 秒过期。
- 会话身份缺失、DOM 控件变化、目标不唯一或安全暂停导致控件不可用时停止；不会改用私有 store 导航或反复盲点。
- 不改变文件系统打开、路径权限、会话文件校验、可执行类型确认、历史恢复队列或每秒六次桥接限额。

## 实现证据与路径

| 证据 | 结论 | 实现路径 |
| --- | --- | --- |
| 宿主 `SessionPane.tsx` 的 `data-session-pane/data-visible`，Sidebar 的 `data-sidebar-session-row` | 可独立读取唯一可见会话；Pane/Sidebar 冲突及重复节点拒绝 | `src/renderer/plugin-review-adapter.ts`：`domSession/subscribeSession` |
| `AppShell.tsx` 的 `.app-work-panel-toggle`，`WorkPanel.tsx` 的页签/启动器标记 | DOM 点击原生控件只解决打开 UI，不负责传数据 | 同文件 `open`：展开→已有精确页签→新建→精确启动器项，4 秒有界等待，每个控件最多点击一次 |
| 启动器创建 View 不保证带会话 URL，激活已有页签不保证触发打开事件 | 必须自有跨进程握手，不能依赖全局最后选择 | `src/core/review-surfaces.ts`、`src/renderer/review-surface-client.ts`、`src/main.ts` 的 `reviewSurface` |
| 后台 `selectTurn/readTurnSelection` 已校验会话、轮次和文件归属 | 复用既有校验，不把 DOM 属性当授权 | `src/core/review-navigation.ts`、`src/main.ts`、`src/view/index.tsx` |

实例采用随机 ID、递增顺序号、短期登记和严格唯一配对。导航使用已有 nonce/revision；后台验证版本后投递。审查页确认身份/版本并应用导航，下一次轮询返回精确 key；renderer 等待确认，不把页签激活当作定位成功。切换会话会清除投递，旧顺序号拒绝；本地会话代次同时阻断切走再返回后的旧点击。卸载停止观察/定时器并尽力注销，重载不重放导航。

新实现独立编写，未复制 GPL 项目代码。所用官方宿主源码核对版本为 `3a2aa0cd8e1cc60e0428b2c775578e4bfde88e8c`；官方贡献视图与 `plugin.call` 可用，但 renderer action 白名单未提供等价的原生工作面板导航操作。

## 剩余宿主依赖清单

| 功能 | 仍依赖什么 | 是否生产路径 |
| --- | --- | --- |
| 输入框上方运行浮窗 | `host-state-adapter.ts` 的 `subscribeActivity` 读取 `runningSessions`、用户消息时间/ID、`agentStatuses.currentTurnId`、保留转录及委派生命周期 | 是；浮窗点击打开页签本身已改走 DOM/桥接 |
| 会话项目路径、精确任务身份、实时工具/委派证据 | 同文件 `subscribeEvidence` 读取 `sessions.projectPath`、`messages/retainedTranscripts`，交给 `session-context-publisher.ts` 去正文、有界上传 | 是；与 DOM 会话身份订阅分离，证据读取失败不阻断跟随与已有快照导航 |
| 私有 store 加载 | 同文件 `loadPinned/resolvePluginReviewModules` 动态导入唯一宿主入口，读取混淆导出 `R/r` 并校验 React/store 形状 | 是，仅上面两类读取触发；不再包含 `openWorkPanelTabForSession` 或页签状态写入 |
| 历史恢复 | `host-history.ts` 读取授权会话 JSONL 与 `review-changes`，`main.ts` 从数据目录结构定位宿主数据根 | 是；不是 store，但仍是私有磁盘格式依赖，不等同公开 API |
| 构建探测 | `nativeProbeInfo`、`native-host-build.ts` 读取 ASAR 与固定构建指纹 | RPC 仍保留；当前两入口不调用 |
| 旧原生审查适配器 | `native-review-adapter.ts` 内的私有 store、组件和动态模块导入 | 仅源码/测试保留，生产 renderer 入口未引用，不进入该构建 |
| 输入框定位、卡片折叠适配 | `RunningChangePill.tsx` 测量 composer/task dock；`entry-extra-layout.ts` 适配宿主 slot viewport | 是；DOM 兼容依赖，不是 store |

`SnapshotStore`、`ReviewNavigationStore`、新 `ReviewSurfaces`、插件 Map/缓存和 React state 都是插件自身状态，不属于宿主 store。官方 `desktop.invoke(session/get)` 可读取原生会话消息，但需要额外 `desktop.control` 授权；它不提供原生 before/after 快照或等价的选择/运行订阅，本轮没有将其加入权限。

## 复现验证

```bash
npm run check
E2E_BROWSER='C:/Program Files/Google/Chrome/Application/chrome.exe' npx playwright test tests/e2e/renderer.spec.ts tests/e2e/running.spec.ts tests/e2e/panel.spec.ts tests/e2e/review.spec.ts
```

最后对 `plugin/` 执行 PI-Desktop 的 `PluginCheck`。不要用安装或真实外部应用启动来替代测试；本轮没有自动安装、重载、打包或提交。

## 本轮验证结果

- `npm run check`：60 个测试文件通过，495 项通过、1 项既有跳过；TypeScript 与四个入口构建成功。
- 上述四组 Playwright（本机 Chrome）：93 项全部通过，包括首次无 URL 参数、复用页签、更换轮次、会话切换/返回、自动跟随、多视图歧义、运行浮窗和系统文件打开回归。
- 源码/构建依赖扫描：DOM 适配器无 `getState/store` 访问或动态导入；生产 renderer 无 `openWorkPanelTabForSession`，旧 `native-review-adapter.ts` 不在 esbuild 输入中；仍包含 `host-state-adapter.ts`，与上面剩余依赖清单一致。四处版本均为 1.4.39，`git diff --check` 通过。
- 回归中复现并修复了同会话定位导致的多余列表刷新，以及延迟初始化设置覆盖用户布局的竞态；新增受控迟到响应测试。保留同会话 React 实例、选中文件、布局和缓存。
- 独立只读复核未报告可复现缺陷；不据此替代测试或原生客户端验收。

本轮日志位于会话 scratch 的 `dom-1.4.39-check.log` 与 `dom-1.4.39-browser.log`。

`PluginCheck(plugin/)` 通过，86 个文件；仅既有 `agent.extension/renderer.extension` 高风险权限需用户明确授权的提示。

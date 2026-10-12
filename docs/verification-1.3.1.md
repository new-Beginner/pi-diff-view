# Diff view 1.3.1 交付与验收记录

> **结论：代码、浏览器回归和安装包已交付；完整目标尚未全部验收。** 真实 PI-Desktop 中胶囊出现及点击右侧审查的现场验收受工具和批准边界阻塞。下列浏览器结果不能代替原生验收。本次没有安装、重载、批准权限、发送聊天、修改宿主数据库或操作真实项目 Git。

## 交付与复跑

安装包：`plugin/dist/local.diff-view-1.3.1.piplug`，使用官方 PluginCheck / PluginPack 校验与打包；包内产物与本次构建逐文件核对。版本、哈希和校验结果见项目根 `release-1.3.1.json`。项目、锁文件、manifest 和 runtime package 均为 `1.3.1`。

```bash
npm run typecheck
npm test
npm run build
E2E_BROWSER='C:/Program Files/Google/Chrome/Application/chrome.exe' npm run test:e2e
```

实际结果：类型检查通过；单元/集成 **26 个文件、222 通过、1 跳过**；构建通过；浏览器 **80/80 通过**。唯一跳过是 Windows 不适用的 POSIX FIFO / `mkfifo`，位于 `tests/integration/safety.test.ts`；没有跳过业务失败。日志和浏览器中间工件位于本会话 `PI_SCRATCH_DIR`。

## 按批准合同逐项验收

| 项 | 状态 | 已观察证据与限制 |
|---|---|---|
| 1 差异与轮次一致 | **已满足（自动化）** | `host-history.test.ts` 验证 CRLF、空文件、末尾换行、历史哈希互证和拒绝错误证据；`modified-turns.test.ts` 验证当前 run 不在 bootstrap 页内时仍返回其元数据。`round-consistency.spec.ts` 3 项验证空启动列表被当前审查证据补齐、刷新一致、迟到审查不能覆盖另一会话。 |
| 2 缺失证据不冒充零改动 | **已满足** | `ReviewFile.statsKnown` 和完整汇总的 `unknownFileCount` 标出未知文件；文件行及汇总显示“行数未知/部分统计”。二进制、缺失、损坏及归属不明不贡献确定行数。`task-capture.test.ts`、`modified-turns.test.ts` 及浏览器未知统计用例通过。可验证净零仍显示真实零值，历史事件不会丢弃。 |
| 3 统一主题与布局 | **已满足（浏览器）** | `theme.spec.ts` 9 项覆盖 360/600/1100px 亮暗 fallback、宿主 token、动态切换、迟到 appearance、长路径、禁用、键盘焦点和确认框。18 张截图覆盖会话/Git/确认框；实际目检窄屏浅色 Git、宽屏深色会话和中屏浅色确认框。受保护文件后置为中文折叠组，仍不可操作。 |
| 4 运行悬浮框行为 | **未满足完整原生验收** | `running.spec.ts` 14 项连接真实 SnapshotStore/ReviewService 与最终 renderer ESM，验证单胶囊、三宽度亮暗、净统计更新、右侧精确轮次只读 diff、草稿不变、完成/停止/切换隐藏、新任务隔离、迟到响应、重复插槽、定位失败恢复和卸载清理。主进程/采集身份桥也有集成回归。真实宿主出现和点击尚无 1.3.1 现场证据。 |
| 5 定位现场原因 | **未满足完整现场验收** | 已只读核对本机 0.18.0 安装源码、插件版本、renderer-status 与采集元数据：composer 插槽确实挂载，部分实际运行记录是 uncertain 且缺 userMessageId，会被旧运行筛选拒绝；仅看可见消息窗口也可能缺当前身份。新增细分诊断与身份桥。直接导致每次截图症状的全部运行时因果仍不能靠静态核对证明；原生出现/点击被边界阻塞。 |
| 6 回归验证 | **已满足** | 上述四个指定命令全部实际执行并通过；222 项单元/集成、80 项浏览器。首次 E2E 失败源于新增统计提示的多 status 定位及测试菜单/刷新触发；修正定位但保留业务断言后全量通过。一次限定复核发现的诊断 undefined 匹配与无效时间戳排序问题已修复并新增回归，不重启广泛复审。 |
| 7 版本交付一致 | **已满足** | 四类版本元数据为 1.3.1；官方校验/打包和安装包文件哈希、版本、包含构建产物的核对见 `release-1.3.1.json`。未自动安装。 |

## 问题的证据、结论与修复

### 历史内容缺失与“暂无修改记录”矛盾

- **证据**：宿主历史通常保存 `before` 和 `meta.json`，不一定保存 `after`。旧重建对 CRLF 和空文件边界处理不足；审查结果能更新，轮次控件却只用早期 bootstrap 列表。
- **结论**：能恢复的内容因重建不兼容变成 unavailable；已经返回的文件不一定对应启动列表中的选项。不能因此使用当前文件或 Git 补造旧内容。
- **修复路径**：仅使用同会话历史字节、成功 Write 参数或结构化 Edit hunks 重建，最终 SHA-256 必须匹配记录 afterHash；用审查返回的 run 补足轮次列表，校验会话、scope、root 和 runId，并使旧请求失效。

### 全黑、默认按钮和重复英文警告

- **证据**：旧 Git CSS 使用 `var(--bg, #161a22)` / `var(--fg, #dbe2ed)` 等固定深色 fallback，顶层切换按钮没有共享主题体系。
- **结论**：宿主浅色主题不等于插件 Git 浅色，且保护文件的每行长警告挤占可操作文件。
- **修复路径**：共享 `--ds-*` token 与明暗 fallback，动态 appearance 事件优先于迟到初始响应；长路径换行、顶层网格防撑宽；原生 dialog 保留主题、取消焦点恢复和键盘行为；保护项中文分组并折叠，操作过滤不放宽。

### 实际运行胶囊不出现

- **证据**：已安装 1.3.0 的诊断显示 entry-loaded、session-ready、composer-mounted。只读采集元数据存在 running + boundary=uncertain + 缺用户消息 ID 的记录。宿主 0.18.0 仍有 `composerControl[left]`、`.composer-shell`、本会话 `runningSessions` 和 `retainedTranscripts` 元数据；before_agent_start 不提供稳定用户 ID，不能依赖该 ID 必然存在。
- **结论**：插槽挂载不代表存在可验证当前轮次；缺任务边界的记录会被筛选拒绝。未原生重现前，不能断言所有现场失败都已消除。
- **修复路径**：元数据读取合并当前会话可见/保留窗口，不读取正文，不忽略身份未知的最新用户。主进程授权项目根后将短时 session/root/taskId/since/generation 写入插件自身 `capture-contexts.json`，仅在采集开始前消费；6 秒 TTL、代际/会话/根路径不符或停止均拒绝。迟到身份不追认旧 uncertain 记录。接口订阅失败后重试，epoch 作废迟到响应；插件自身 portal 测量所属输入框、单实例显示，不移动宿主 DOM，不读写聊天草稿。

## 如何看诊断

在插件自身数据目录读取 `renderer-status.json`，不需要修改宿主数据库。诊断只保留状态、会话标识和时间，不保留聊天正文。

| 字段/阶段 | 含义 |
|---|---|
| entry-loaded / composer-mounted | renderer 已加载 / 公开插槽已挂载；缺失时先核对手动授权与扩展加载 |
| session-source-error / composer-source-error | 宿主模块、React/store 或订阅接线失败；组件会重试 |
| running-identity-missing | 正在运行，但当前用户身份或有效时间不足；不借旧轮次显示 |
| running-query-error | 统计接口/桥接请求失败 |
| runningDiagnostic.reason=capture-boundary-unknown | 已有记录但任务边界不确定，不能当作当前用户修改 |
| capture-missing-or-task-mismatch / capture-generation-mismatch | 没有匹配任务 / 记录来自不匹配的插件代际 |
| capture-settled / no-net-changes | 任务已结束 / 已验证净零，隐藏属于正常行为 |
| capture-ownership-unknown | 修改归属不明，不伪造确定行数 |
| composer-anchor-missing / composer-anchor-offscreen | 所属输入框结构缺失 / 无可用可见定位区域 |
| running-visible / composer-positioned | 有可验证摘要 / 已取得输入框定位；不是原生点击验收凭据 |

## 截图

所有截图都是**模拟宿主 UI**，不是原生 PI-Desktop。主题回归使用源 Panel；运行胶囊回归使用最终 ESM 和真实插件快照服务。

- [360px 浅色 Git](screenshots/theme-git-360-light.png)
- [1100px 深色会话](screenshots/theme-session-1100-dark.png)
- [600px 浅色确认框](screenshots/theme-confirm-600-light.png)
- [360px 浅色运行胶囊](screenshots/running-pill-360-light.png)
- [600px 深色运行胶囊](screenshots/running-pill-600-dark.png)
- [1100px 浅色运行胶囊](screenshots/running-pill-1100-light.png)

## 剩余阻塞与手工原生验收

当前 Computer Use 技能和工具禁止操控 PI-Desktop 本身；批准合同也禁止自动安装、重载、授权、发送消息或操控宿主。未尝试用其他工具绕开限制，因此验收 4、5 的原生部分未完成，**不能标记完整目标通过**。

需要由用户在隔离项目手动安装/重载并授权 1.3.1，开始新的任务而非要求旧 uncertain 轮次继承统计，然后核对：

1. 运行中产生已捕获净变更后输入框上方恰好一个胶囊；行数未知时标签准确。
2. 点击胶囊仅打开右侧本会话、本轮次差异，草稿不变、运行期间只读。
3. 输入增高、窗口变窄、结束、停止、切换会话和新任务时正确跟随/隐藏，不继承旧数字。
4. 对照上述诊断确定实际身份、采集和定位链路；未取得现场证据前不宣称原生修复已经验收。

有界 Shell/Task 采集、私有路径/凭据/链接排除、未知并发归属、安装前缺失内容等原有限制继续存在，不扩展为完整进程修改审计。保留全部原有未提交改动，未 reset、commit 或 push。

# 当前版本 v1.2.0

2026-10-11：typecheck、build 通过；后端 159 通过、1 个 Windows 不适用 FIFO 测试跳过；浏览器 57/57 通过，含最终 ESM＋真实 SnapshotStore/ReviewService 的运行任务浮窗验收。四种布局截图、逐项验收和兼容边界见 [v1.2.0 说明](running-changes.md)，安装包校验见项目根 `release-1.2.0.json`。一次有限代码复核无具体发现。

本机宿主 0.18.0 仅做资源只读核对；未自动安装、操作权限弹窗或执行真实 GUI 点击。浏览器宿主 UI 仍为模拟，不将其结果当作原生联调通过。

---

下方保留 v0.1.0 的历史记录，不作为当前版本数字或使用说明。

# v0.1.0 验证记录

> **源码、自动化测试和可安装构建已交付；完整原生联调尚未验收。** 初始官方脚手架曾成功加载，但当时只授予 `ui.panel`。扩展到完整 Agent/renderer/view 权限必须由用户在插件页显式重新加载并批准，不能由自动化代替。模拟测试、静态契约核对和官方包校验不等于真实宿主联调通过。

## 已执行检查

环境：Windows、Node v24.19.0、Git 2.55.0.windows.3，目标宿主 PI-Desktop 0.17.0。依赖版本见锁文件。

| 证据 | 结果 | 覆盖和边界 |
|---|---|---|
| `npm run typecheck` | 通过 | 全部 TypeScript 源码和测试 |
| `npm test` | 60 通过，1 跳过 | 6 个测试文件；Git 28、快照 9、服务 10、安全 6、diff 5、jobs 2；Windows 跳过 POSIX FIFO |
| `npm run build` | 通过 | main CJS、Agent ESM、离线视图、宿主 React renderer ESM；复制许可和文档 |
| `npm run test:e2e` | 17/17 通过 | 真 Chromium、模拟后端；范围/文件切换、评论增改删和失效、确认/取消、冲突、批量结果、80 行分页、长行、上下文、主题/语言、360/760/1280px、键盘、共享限速、后台慢任务、草稿保留和会话切换、卸载清理 |
| 官方 `PluginCheck` | 已通过、零错误零警告 | manifest、入口、权限、文件/资源边界；最终打包工具会再次执行相同校验 |
| 官方 `PluginScaffold` | 成功 | 初始 panel-basic 开发插件已加载；这不是完整权限授权后的验收 |
| 本机 0.17.0 SDK/桥接实现只读核对 | 完成 | panel 默认分发到 onPanelInvoke；renderer 方法精确白名单、2 秒/64 KiB 限制、openLayer().close、composer.subscribeDraft、外部 React import map |
| 浏览器截图 | 已查看 | [宽屏](screenshots/review-wide.png)、[360px](screenshots/review-narrow.png)，均为明确标记的演示数据 |
| 构建主入口模拟生命周期 | 通过 | 连续 load/unload/reload、作业、设置、拒绝非法通道、事件/locator 清理；插件根独立 CommonJS 声明。模拟 host API，不计为原生宿主验收 |

Git 和文件测试均在 session scratch/系统临时目录建立独立夹具，未对旧插件项目执行破坏性测试。

### 复跑

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
E2E_BROWSER='C:/Users/32057/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe' npm run test:e2e
```

其他机器将 `E2E_BROWSER` 替换为本机 Chromium/Chrome/Edge 路径，或使用匹配 Playwright 的已安装浏览器。临时仓库、测试日志和 traces 不纳入安装包。

## 安全修正的证据链

| Evidence → Finding | 修正路径及验证 |
|---|---|
| 最终指纹检查后出现外部保存/新文件可能被 rename 覆盖 | `rollback.ts` 先移走实际目标并校验，再独占安装；`safety.test.ts` 注入最后时刻保存和新目标，确认外部内容/实际原文件保留 |
| 历史清理与独立 Agent 快照写入竞争 | `storage.ts` captureLock 保护 inbox 写入、导入和清理；安全测试确认清理完成后新采集才写入完整 blobs；活跃记录拒绝清理 |
| 超长评论总量超过读取预算 | 写入前以 16 MiB 序列化字节限制拒绝；安全测试确认之前评论仍可读 |
| POSIX 非普通文件可能在 open 前阻塞 | 打开前 lstat 类型核对；POSIX 非阻塞/no-follow 打开。普通目录拒绝用例本机通过，FIFO 用例在 Windows 跳过 |
| Git 内容回退可能扩大 POSIX 权限 | 保留实际工作文件 mode，不用索引的 0644 覆盖私有 mode；本机 Windows，不宣称 POSIX 系统实测 |
| 批量中一个文件冲突 | `service.test.ts` 确认失败文件不写、另一个成功恢复；浏览器测试展示逐文件成功/失败，不假定跨文件原子 |

独立只读审查只执行一次；具体问题已修正并回归测试，没有启动循环复审。

## 权限与原生待验收

安装时高风险权限 `agent.extension`、`renderer.extension` 表示代码运行在可信 Node/宿主界面中，不提供 OS 沙箱。快照、Git 索引与恢复使用内部 Node/Git 适配器，不受宿主 fs 网关逐次授权。`clipboard.write` 只用于显式复制；`ui.view`/`ui.panel` 提供界面。无网络、模型调用、自动发送、Git commit/push 或宿主数据库访问。

**需用户手动完成**：安装包或重新加载开发目录 `plugin/`，阅读 safetyNotes 并批准上述新增权限。不要只保存文件期待 hot reload 自动授权。

批准后在新的隔离测试项目中执行以下原生验收；当前均未宣称完成：

1. 检查右侧 Diff view 页签、独立审查窗口及输入区入口；中英文/明暗主题跟随宿主。
2. 新会话仅用 Write/Edit 修改一个普通文本文件；确认最近轮次真实 before/after、运行状态和唯一关联回复卡片。Bash/子代理不完整时恢复必须禁用。
3. 添加行评论，经用户按钮加入已有草稿，不自动发送；切换会话或关闭审查层后旧回填必须取消。
4. 确认撤销、重新应用及 Git 文件/hunk 暂存/取消暂存；加入外部编辑验证拒绝冲突；不要用原插件工程测试恢复。
5. disable/enable、关闭窗口和重载；确认 renderer 注册、计时器和自身 locator 清理，历史保留，旧 generation 不继续写入。
6. 在安装包安装后重复上述流程，验证真实剪贴板与宿主 React import map。

没有自动点击原生权限弹窗，没有修改安装包/数据库或旧工程。在线文档重新下载曾因 DNS 不可解析失败，本次后续核对使用安装包的只读桥接代码，不绕过宿主权限。

## 包与 Git 检查点

使用官方 PluginPack 生成 `plugin/dist/local.diff-view-0.1.0.piplug`；包 SHA-256、大小与 store-only 内容检查结果记录在项目根 `release-0.1.0.json`（不嵌入包，避免哈希自引用）。安装包不包含源码仓库、依赖目录、快照或测试夹具。

- `4bfcc86`：官方脚手架、开发依赖与测试基础。
- `38ed776`：Git/轮次数据链、私有存储和有冲突保护的操作。
- `425aeff`：评论/聊天入口、异步桥接、批量结果、界面与安全回归。
- 最终交付提交：运行 `git log --oneline -1` 查看，包含构建产物和文档。

未配置远程、未推送、未修改 Git 身份。原生权限与真实宿主联调是本次剩余验收阻碍；自动化结果不可替代它。
